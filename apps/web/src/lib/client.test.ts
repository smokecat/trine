/**
 * TrineClient 的单元测试：假 socket + 拨表时钟，只验门面自己的逻辑
 * （同步范围、request 关联/离线拒绝、parked 映射、刷新后游标取 max）。
 * 真链路（真服务端 + echo agent）见 e2e.test.ts。
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPair, openJson, sodiumReady, type BoxKeyPair } from '@trine/core/crypto';
import type { ClientToAgentEvent, TransportFrame } from '@trine/core';
import { MemoryDocStore, MemoryKv } from './adapters.ts';
import {
  CLAUDE_UPDATE_TIMEOUT_MS,
  MUTATE_TIMEOUT_HINT,
  REMOVED_SESSION_TTL_MS,
  RequestTimeoutError,
  SessionMutateError,
  TrineClient,
} from './client.ts';
import { ensureIdentity } from './identity.ts';
import { emptyTimeline, type UserEntry } from './reducer.ts';
import { KV_PEER, saveTimeline, type PeerState } from './storage.ts';
import { FakeClock, FakeSocketFactory, flushMicrotasks, sealA2c, type A2cBody } from './test-utils.ts';

let agent: BoxKeyPair;

beforeAll(async () => {
  await sodiumReady();
  agent = generateKeyPair();
});

const stubFetch = (async (input: unknown) => {
  const path = new URL(String(input)).pathname;
  if (path === '/auth/challenge') return Response.json({ challenge: 'c', expiresAt: 1 });
  if (path === '/auth/verify') return Response.json({ token: 'tok', expiresAt: 9e15 });
  return new Response('not found', { status: 404 });
}) as unknown as typeof fetch;

function peerWith(machines: PeerState['machines']): PeerState {
  return { v: 1, serverUrl: 'http://localhost:5173', machines };
}

async function makeClient(kv: MemoryKv, docs: MemoryDocStore, clock: FakeClock, sockets: FakeSocketFactory) {
  // 身份先建好，uuid 桩从 u1 起全留给 reqId / clientMsgId
  ensureIdentity(kv, () => 'dev');
  let n = 0;
  const client = await TrineClient.create({
    kv,
    docs,
    createSocket: sockets.create,
    clock,
    uuid: () => `u${++n}`,
    random: () => 0,
    fetchImpl: stubFetch,
    persistDebounceMs: 10,
  });
  return client;
}

/** 起一个已配对（mbp）的 client 并让连接 open */
async function connected(over: Partial<PeerState['machines'][string]> = {}, prepDocs?: (docs: MemoryDocStore) => Promise<void>) {
  const kv = new MemoryKv();
  const docs = new MemoryDocStore();
  const clock = new FakeClock();
  const sockets = new FakeSocketFactory();
  kv.set(KV_PEER, JSON.stringify(peerWith({ mbp: { agentBoxPubKey: agent.publicKey, pairedAt: 1, outSeq: {}, inCursors: {}, sessions: {}, ...over } })));
  if (prepDocs) await prepDocs(docs);
  const client = await makeClient(kv, docs, clock, sockets);
  const events: string[] = [];
  client.on('event', (_m, e) => void events.push(e.type));
  client.start();
  await flushMicrotasks(10);
  sockets.last.emitOpen();
  // 真服务端会紧跟着回机器级流的 sync.done（onOpen 对它发了 sinceSeq 0）
  sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', upTo: 0 });
  const a2c = (body: A2cBody, seq: number) =>
    sealA2c(body, seq, { agentSecretKey: agent.secretKey, clientPublicKey: client.publicKeys.box }, 'mbp', client.deviceId);
  return { kv, docs, clock, sockets, client, events, a2c };
}

describe('client · 同步范围', () => {
  test('onOpen 同步栈内发 sync.request：机器级一律发；会话按游标/时间线/活跃判定；空时间线游标>0 走回填', async () => {
    const now = new FakeClock().now();
    const h = await connected(
      {
        inCursors: { '': 3, withTl: 5, emptyTl: 7, never: 0, stale: 2 },
        sessions: {
          withTl: { lastActivityAt: now },
          emptyTl: { lastActivityAt: now },
          never: { lastActivityAt: now },
          stale: { lastActivityAt: now - 40 * 24 * 3600_000 },
        },
      },
      async (docs) => {
        await saveTimeline(docs, 'mbp/withTl', { ...emptyTimeline(), lastAppliedSeq: 5, entries: [{ kind: 'run_state', id: 'run.state:5', state: 'idle', seq: 5, ts: 1 }] });
      },
    );
    const frames = h.sockets.last.sentFrames;
    expect(frames[0]?.type).toBe('hello');
    const syncs = frames.filter((f): f is Extract<TransportFrame, { type: 'sync.request' }> => f.type === 'sync.request');
    expect(syncs.map((s) => [s.sessionId, s.sinceSeq])).toEqual([
      [undefined, 3],
      ['withTl', 5],
      ['emptyTl', 0], // 回填
      // never：游标 0 无时间线 → 不发；stale：无时间线且 40 天没活跃 → 不发
    ]);
    // 回填模式：seq ≤ 游标的帧在 sync.done 前放行
    h.sockets.last.emitMessage(h.a2c({ type: 'run.state', sessionId: 'emptyTl', state: 'idle' }, 2));
    h.sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', sessionId: 'emptyTl', upTo: 2 });
    expect(h.client.timeline('mbp', 'emptyTl').entries).toHaveLength(1);
    // 用户打开一个游标 0 无时间线的会话 → 立刻 sinceSeq 0 同步
    h.client.openSession('mbp', 'never');
    expect(h.sockets.last.sentFrames.at(-1)).toEqual({ type: 'sync.request', machineId: 'mbp', sessionId: 'never', sinceSeq: 0 });
  });
});

describe('client · request 关联', () => {
  test('按 reqId 关联（session.create.response 是机器级）；机器离线时本地立即失败不发帧', async () => {
    const h = await connected();
    // 还没收到 machine.status（online=null）→ 允许发
    const p = h.client.createSession('mbp', { cwd: '/tmp', model: 'm', permissionMode: 'default' });
    const relay = h.sockets.last.sentFrames.at(-1) as Extract<TransportFrame, { type: 'relay' }>;
    expect(relay.type).toBe('relay');
    expect(relay.sessionId).toBeUndefined();
    const meta = { sessionId: 'new', title: '', state: 'idle' as const, lastActivityAt: 1, cwd: '/tmp', model: 'm', permissionMode: 'default' as const, costUsd: 0 };
    // reqId 是 uuid 桩生成的 u1
    h.sockets.last.emitMessage(h.a2c({ type: 'session.create.response', reqId: 'u1', session: meta }, 1));
    expect((await p).sessionId).toBe('new');
    expect(Object.keys(h.client.sessions('mbp'))).toEqual(['new']);
    // 新会话已登记到 peer 且被打开
    expect(h.client.peer?.machines['mbp']?.sessions['new']).toBeDefined();

    h.sockets.last.emitMessage({ type: 'machine.status', machineId: 'mbp', online: false, lastSeenAt: 1 });
    const before = h.sockets.last.sent.length;
    await expect(h.client.listSessions('mbp')).rejects.toThrow(/离线/);
    expect(h.sockets.last.sent.length).toBe(before);
    // 未配对机器
    await expect(h.client.listSessions('ghost')).rejects.toThrow(/未配对/);
  });

  test('超时 → reject；迟到的应答被静默忽略', async () => {
    const h = await connected();
    const p = h.client.request('mbp', { type: 'session.status.request', sessionId: 's1' }, { timeoutMs: 1_000 });
    await h.clock.advance(1_000);
    await expect(p).rejects.toThrow(/超时/);
    h.sockets.last.emitMessage(
      h.a2c({ type: 'session.status.response', sessionId: 's1', reqId: 'u1', model: 'm', cwd: '/', permissionMode: 'default', costUsd: 0, contextUsedTokens: 0, contextLimitTokens: 1, agentVersion: 'a', claudeVersion: 'c' }, 1),
    );
    expect(h.events).toContain('session.status.response');
  });
});

describe('client · 本地消息与 parked', () => {
  const localEntry = (h: Awaited<ReturnType<typeof connected>>, sid: string, id: string) =>
    h.client.timeline('mbp', sid).entries.find((e): e is UserEntry => e.kind === 'user' && e.id === id)!;

  test('sendInput 立即 sending；input.parked 按 seq 关联 → parked；到 expiresAt 本地转 expired', async () => {
    const h = await connected();
    const id = h.client.sendInput('mbp', 's1', 'hello');
    expect(localEntry(h, 's1', id)).toMatchObject({ status: 'sending', text: 'hello' });
    const relay = h.sockets.last.sentFrames.at(-1) as Extract<TransportFrame, { type: 'relay' }>;
    expect(relay.sessionId).toBe('s1');
    const expiresAt = h.clock.now() + 60_000;
    h.sockets.last.emitMessage({ type: 'input.parked', machineId: 'mbp', sessionId: 's1', seq: relay.seq, expiresAt });
    expect(localEntry(h, 's1', id)).toMatchObject({ status: 'parked', parkedSeq: relay.seq, expiresAt });
    await h.clock.advance(59_999);
    expect(localEntry(h, 's1', id).status).toBe('parked');
    await h.clock.advance(1);
    expect(localEntry(h, 's1', id).status).toBe('expired');
  });

  test('撤回 parked → park.recall 帧 + 本地条目删除；park.expired → expired，重发换新 clientMsgId', async () => {
    const h = await connected();
    const restored: string[] = [];
    h.client.on('restoreDraft', (_m, _s, text) => restored.push(text));
    const id = h.client.sendInput('mbp', 's1', 'a');
    const seq = (h.sockets.last.sentFrames.at(-1) as { seq: number }).seq;
    h.sockets.last.emitMessage({ type: 'input.parked', machineId: 'mbp', sessionId: 's1', seq, expiresAt: h.clock.now() + 9e9 });
    expect(h.client.recallParked('mbp', 's1', id)).toBe(true);
    expect(h.sockets.last.sentFrames.at(-1)).toEqual({ type: 'park.recall', machineId: 'mbp', sessionId: 's1', seq });
    expect(localEntry(h, 's1', id)).toBeUndefined();
    expect(restored).toEqual([]);

    const id2 = h.client.sendInput('mbp', 's1', 'b');
    const seq2 = (h.sockets.last.sentFrames.at(-1) as { seq: number }).seq;
    h.sockets.last.emitMessage({ type: 'input.parked', machineId: 'mbp', sessionId: 's1', seq: seq2, expiresAt: h.clock.now() + 9e9 });
    h.sockets.last.emitMessage({ type: 'park.expired', machineId: 'mbp', sessionId: 's1', seq: seq2 });
    expect(localEntry(h, 's1', id2).status).toBe('expired');
    expect(h.client.resendPending('mbp', 's1', id2)).toBe(true);
    expect(localEntry(h, 's1', id2)).toBeUndefined();
    const resent = h.client.timeline('mbp', 's1').entries.filter((e): e is UserEntry => e.kind === 'user');
    expect(resent.map((e) => [e.text, e.status])).toEqual([['b', 'sending']]);
    expect(resent[0]!.id).not.toBe(id2);
  });

  test('撤回 agent 队列：input.cancelled(recalled) → 条目删除；为编辑撤回的放回输入框', async () => {
    const h = await connected();
    const restored: string[] = [];
    h.client.on('restoreDraft', (_m, _s, text) => restored.push(text));
    const a = h.client.sendInput('mbp', 's1', '撤掉');
    const b = h.client.sendInput('mbp', 's1', '改一下');
    h.sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', sessionId: 's1', upTo: 0 });
    h.sockets.last.emitMessage(h.a2c({ type: 'input.queued', sessionId: 's1', clientMsgId: a }, 1));
    h.sockets.last.emitMessage(h.a2c({ type: 'input.queued', sessionId: 's1', clientMsgId: b }, 2));

    h.client.recallQueued('mbp', 's1', a);
    h.client.recallQueued('mbp', 's1', b, { edit: true });
    expect(localEntry(h, 's1', a).recallingAt).toBe(h.clock.now());
    expect(localEntry(h, 's1', b).recallForEdit).toBe(true);

    h.sockets.last.emitMessage(h.a2c({ type: 'input.cancelled', sessionId: 's1', clientMsgId: a, reason: 'recalled' }, 3));
    h.sockets.last.emitMessage(h.a2c({ type: 'input.cancelled', sessionId: 's1', clientMsgId: b, reason: 'recalled' }, 4));
    expect(localEntry(h, 's1', a)).toBeUndefined();
    expect(localEntry(h, 's1', b)).toBeUndefined();
    expect(restored).toEqual(['改一下']);
  });

  test('撤回 5s 内没有任何答复：恢复按钮，不猜成撤回成功；回执迟到仍放回输入框', async () => {
    const h = await connected();
    const id = h.client.sendInput('mbp', 's1', 'hi');
    h.sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', sessionId: 's1', upTo: 0 });
    h.sockets.last.emitMessage(h.a2c({ type: 'input.queued', sessionId: 's1', clientMsgId: id }, 1));
    h.client.recallQueued('mbp', 's1', id, { edit: true });

    // 空闲会话里 ChatView 的 1s tick 没挂，靠 client 自己的定时器结算
    await h.clock.advance(4_999);
    expect(localEntry(h, 's1', id).recallingAt).toBeDefined();
    await h.clock.advance(1);
    const settled = localEntry(h, 's1', id);
    expect(settled.status).toBe('queued');
    expect(settled.recallingAt).toBeUndefined();

    const restored: string[] = [];
    h.client.on('restoreDraft', (_m, _s, text) => restored.push(text));
    h.sockets.last.emitMessage(h.a2c({ type: 'input.cancelled', sessionId: 's1', clientMsgId: id, reason: 'recalled' }, 2));
    expect(localEntry(h, 's1', id)).toBeUndefined();
    expect(restored).toEqual(['hi']);
  });

  test('停止任务丢弃的排队消息 → cancelled；可放回输入框或以新 clientMsgId 重发', async () => {
    const h = await connected();
    const restored: string[] = [];
    h.client.on('restoreDraft', (_m, _s, text) => restored.push(text));
    const a = h.client.sendInput('mbp', 's1', '一');
    const b = h.client.sendInput('mbp', 's1', '二');
    h.sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', sessionId: 's1', upTo: 0 });
    h.sockets.last.emitMessage(h.a2c({ type: 'input.queued', sessionId: 's1', clientMsgId: a }, 1));
    h.sockets.last.emitMessage(h.a2c({ type: 'input.queued', sessionId: 's1', clientMsgId: b }, 2));
    h.sockets.last.emitMessage(h.a2c({ type: 'input.cancelled', sessionId: 's1', clientMsgId: a, reason: 'stopped' }, 3));
    h.sockets.last.emitMessage(h.a2c({ type: 'input.cancelled', sessionId: 's1', clientMsgId: b, reason: 'closed' }, 4));
    expect(localEntry(h, 's1', a)).toMatchObject({ status: 'cancelled', failReason: '已停止，未发送' });
    expect(localEntry(h, 's1', b)).toMatchObject({ status: 'cancelled', failReason: '会话关闭，未发送' });

    expect(h.client.discardPending('mbp', 's1', a, { edit: true })).toBe(true);
    expect(localEntry(h, 's1', a)).toBeUndefined();
    expect(restored).toEqual(['一']);

    expect(h.client.resendPending('mbp', 's1', b)).toBe(true);
    const sent = h.sockets.last.sentFrames.at(-1) as { seq: number };
    expect(localEntry(h, 's1', b)).toBeUndefined();
    const users = h.client.timeline('mbp', 's1').entries.filter((e): e is UserEntry => e.kind === 'user');
    expect(users.map((e) => [e.text, e.status])).toEqual([['二', 'sending']]);
    expect(users[0]!.id).not.toBe(b);
    expect(sent.seq).toBeGreaterThan(0);
  });

  test('撤回没赶上（回显先到）：条目升 confirmed，结算定时器不把它改回去', async () => {
    const h = await connected();
    const id = h.client.sendInput('mbp', 's1', 'hi');
    h.sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', sessionId: 's1', upTo: 0 });
    h.sockets.last.emitMessage(h.a2c({ type: 'input.queued', sessionId: 's1', clientMsgId: id }, 1));
    h.client.recallQueued('mbp', 's1', id);
    // 撤回没赶上：消息已经执行，回显到达
    h.sockets.last.emitMessage(
      h.a2c({ type: 'user.message', sessionId: 's1', messageId: 'm', clientMsgId: id, text: 'hi' }, 2),
    );
    expect(localEntry(h, 's1', id).status).toBe('confirmed');
    await h.clock.advance(10_000);
    expect(localEntry(h, 's1', id).status).toBe('confirmed');
  });

  test('user.message 回显命中本地条目 → confirmed；stop 时待发队列里的消息 failed', async () => {
    const h = await connected();
    const id = h.client.sendInput('mbp', 's1', 'hi');
    // 首次打开 s1 触发了 sinceSeq 0 同步：回显先进暂存，sync.done 后放行
    h.sockets.last.emitMessage(h.a2c({ type: 'user.message', sessionId: 's1', messageId: 'm', clientMsgId: id, text: 'hi' }, 1));
    expect(localEntry(h, 's1', id).status).toBe('sending');
    h.sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', sessionId: 's1', upTo: 0 });
    expect(localEntry(h, 's1', id)).toMatchObject({ status: 'confirmed', seq: 1 });

    h.sockets.last.emitClose(1006);
    const id2 = h.client.sendInput('mbp', 's1', 'offline');
    expect(h.client.queuedCount).toBe(1);
    h.client.stop();
    expect(localEntry(h, 's1', id2).status).toBe('failed');
    expect(h.client.queuedCount).toBe(0);
  });

  test('pair.confirm / pair.abort 到 client 连接上静默忽略；未配对机器的 machine.status 忽略', async () => {
    const h = await connected();
    h.sockets.last.emitMessage({ type: 'pair.confirm', pairingToken: 't', clientDeviceId: 'd', clientSignPubKey: 'k' });
    h.sockets.last.emitMessage({ type: 'pair.abort', pairingToken: 't' });
    h.sockets.last.emitMessage({ type: 'machine.status', machineId: 'ghost', online: true, lastSeenAt: 1 });
    expect(h.client.machines().map((m) => m.machineId)).toEqual(['mbp']);
  });
});

describe('client · 刷新后', () => {
  test('新实例复用同一存储：历史仍在，游标 := timeline.lastAppliedSeq（doc 领先 peer 时同样采纳），残留 sending 转 failed', async () => {
    const kv = new MemoryKv();
    const docs = new MemoryDocStore();
    kv.set(KV_PEER, JSON.stringify(peerWith({ mbp: { agentBoxPubKey: agent.publicKey, pairedAt: 1, outSeq: { s1: 4 }, inCursors: { s1: 5 }, sessions: { s1: { lastActivityAt: 1 } } } })));
    await saveTimeline(docs, 'mbp/s1', {
      ...emptyTimeline(),
      lastAppliedSeq: 9,
      entries: [
        { kind: 'run_state', id: 'run.state:9', state: 'idle', seq: 9, ts: 1 },
        { kind: 'user', id: 'c1', text: 'x', local: true, status: 'sending', seq: 0, ts: 2 },
      ],
    });
    const clock = new FakeClock();
    const sockets = new FakeSocketFactory();
    const client = await makeClient(kv, docs, clock, sockets);
    const tl = client.timeline('mbp', 's1');
    expect(tl.entries).toHaveLength(2);
    expect((tl.entries[1] as UserEntry).status).toBe('failed');
    expect(client.peer?.machines['mbp']?.inCursors['s1']).toBe(9);
    expect(client.peer?.machines['mbp']?.outSeq['s1']).toBe(4);
    // 落盘也已更新
    expect(JSON.parse(kv.get(KV_PEER)!).machines.mbp.inCursors.s1).toBe(9);
    client.start();
    await flushMicrotasks(10);
    sockets.last.emitOpen();
    const sync = sockets.last.sentFrames.find((f) => f.type === 'sync.request' && f.sessionId === 's1');
    expect(sync).toMatchObject({ sinceSeq: 9 });
  });

  test('未配对：start 不建连接；completePairing 后写 peer 并接入', async () => {
    const kv = new MemoryKv();
    const docs = new MemoryDocStore();
    const clock = new FakeClock();
    const sockets = new FakeSocketFactory();
    const client = await makeClient(kv, docs, clock, sockets);
    expect(client.isPaired).toBe(false);
    client.start();
    await flushMicrotasks(10);
    expect(sockets.sockets).toHaveLength(0);
    const machineId = await client.completePairing({
      serverUrl: 'http://localhost:5173',
      agentBoxPubKey: agent.publicKey,
      machineId: 'mbp',
      token: { token: 't', expiresAt: 9e15 },
    });
    expect(machineId).toBe('mbp');
    await flushMicrotasks(10);
    expect(sockets.sockets).toHaveLength(1);
    sockets.last.emitOpen();
    expect(sockets.last.sentFrames.map((f) => f.type)).toEqual(['hello', 'sync.request']);
    expect(JSON.parse(kv.get(KV_PEER)!).machines.mbp.agentBoxPubKey).toBe(agent.publicKey);
    // 第二个服务端拒绝
    await expect(
      client.completePairing({ serverUrl: 'https://other', agentBoxPubKey: 'k', machineId: 'x', token: { token: 't', expiresAt: 1 } }),
    ).rejects.toThrow(/单服务端/);
    // 重置本地状态：peer 清空、identity 保留
    const deviceId = client.deviceId;
    await client.resetLocalState();
    expect(kv.get(KV_PEER)).toBeNull();
    expect(client.isPaired).toBe(false);
    const again = await makeClient(kv, docs, clock, sockets);
    expect(again.deviceId).toBe(deviceId);
  });
});

describe('client · A1 时间线落后于持久化游标（评审阶段 1）', () => {
  test('有 doc 时游标 := doc.lastAppliedSeq（不取 max）；sinceSeq 用它；重放 6..9 后时间线完整无重复', async () => {
    const kv = new MemoryKv();
    const docs = new MemoryDocStore();
    // 流式期间刷新：peer 游标已落到 9，时间线 doc 最后一次落盘停在 5
    kv.set(KV_PEER, JSON.stringify(peerWith({ mbp: { agentBoxPubKey: agent.publicKey, pairedAt: 1, outSeq: {}, inCursors: { s1: 9 }, sessions: { s1: { lastActivityAt: 1 } } } })));
    await saveTimeline(docs, 'mbp/s1', {
      ...emptyTimeline(),
      lastAppliedSeq: 5,
      entries: [{ kind: 'run_state', id: 'run.state:5', state: 'running', seq: 5, ts: 1 }],
    });
    const clock = new FakeClock();
    const sockets = new FakeSocketFactory();
    const client = await makeClient(kv, docs, clock, sockets);
    expect(client.peer?.machines['mbp']?.inCursors['s1']).toBe(5);
    // 落盘也回拨了（force 写，不被取 max 合回）
    expect(JSON.parse(kv.get(KV_PEER)!).machines.mbp.inCursors.s1).toBe(5);
    client.start();
    await flushMicrotasks(10);
    sockets.last.emitOpen();
    sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', upTo: 0 });
    const sync = sockets.last.sentFrames.find((f) => f.type === 'sync.request' && f.sessionId === 's1');
    expect(sync).toMatchObject({ sinceSeq: 5 });
    const a2c = (body: A2cBody, seq: number) =>
      sealA2c(body, seq, { agentSecretKey: agent.secretKey, clientPublicKey: client.publicKeys.box }, 'mbp', client.deviceId);
    // 服务端按 sinceSeq 5 补发 6..9（含一条 delta 与 done）
    sockets.last.emitMessage(a2c({ type: 'assistant.delta', sessionId: 's1', messageId: 'm', text: 'hel' }, 6));
    sockets.last.emitMessage(a2c({ type: 'assistant.delta', sessionId: 's1', messageId: 'm', text: 'lo' }, 7));
    sockets.last.emitMessage(a2c({ type: 'assistant.done', sessionId: 's1', messageId: 'm', text: 'hello' }, 8));
    sockets.last.emitMessage(a2c({ type: 'run.state', sessionId: 's1', state: 'idle' }, 9));
    sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', sessionId: 's1', upTo: 9 });
    const tl = client.timeline('mbp', 's1');
    expect(tl.entries.map((e) => [e.kind, e.seq])).toEqual([['run_state', 5], ['assistant', 6], ['run_state', 9]]);
    expect(tl.entries[1]).toMatchObject({ text: 'hello', done: true });
    expect(tl.lastAppliedSeq).toBe(9);
    expect(client.peer?.machines['mbp']?.inCursors['s1']).toBe(9);
    // 没有倒退探测误报
    expect(sockets.last.sentFrames.filter((f) => f.type === 'sync.request' && f.sessionId === 's1')).toHaveLength(1);
  });

  test('流式 delta 密集时时间线仍按 maxWait 周期落盘', async () => {
    const h = await connected({ inCursors: {}, sessions: { s1: { lastActivityAt: 1 } } });
    h.client.openSession('mbp', 's1');
    h.sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', sessionId: 's1', upTo: 0 });
    // 每 5ms 一条 delta（< debounce 10ms），持续 2s
    let seq = 0;
    for (let t = 0; t < 2_000; t += 5) {
      h.sockets.last.emitMessage(h.a2c({ type: 'assistant.delta', sessionId: 's1', messageId: 'm', text: 'x' }, ++seq));
      await h.clock.advance(5);
    }
    const doc = (await h.docs.get('timeline:mbp/s1')) as { lastAppliedSeq: number } | undefined;
    expect(doc).toBeDefined();
    // 至少落过盘，且落盘的进度不落后当前超过一个 maxWait（默认 1s = 200 帧）
    expect(doc!.lastAppliedSeq).toBeGreaterThan(seq - 210);
  });
});

describe('client · B1 重置后重新配对', () => {
  test('resetLocalState → completePairing：无需 start()/刷新即自动建连并在线', async () => {
    const h = await connected();
    expect(h.client.connection.status).toBe('open');
    await h.client.resetLocalState();
    expect(h.client.isPaired).toBe(false);
    expect(h.client.connection.status).toBe('stopped');
    const before = h.sockets.sockets.length;
    await h.client.completePairing({
      serverUrl: 'http://localhost:5173',
      agentBoxPubKey: agent.publicKey,
      machineId: 'mbp',
      token: { token: 't2', expiresAt: 9e15 },
    });
    await flushMicrotasks(10);
    expect(h.sockets.sockets.length).toBe(before + 1);
    h.sockets.last.emitOpen();
    expect(h.client.connection.status).toBe('open');
    expect(h.sockets.last.sentFrames.map((f) => f.type)).toEqual(['hello', 'sync.request']);
    h.sockets.last.emitMessage({ type: 'machine.status', machineId: 'mbp', online: true, lastSeenAt: 1 });
    expect(h.client.machine('mbp')?.online).toBe(true);
    h.client.stop();
  });
});

describe('client · B2 旧 QR 无 machineId 的回落', () => {
  test('completePairing 不带 machineId：接入后首条在线 machine.status 定 machineId，随后该机器被同步', async () => {
    const kv = new MemoryKv();
    const docs = new MemoryDocStore();
    const clock = new FakeClock();
    const sockets = new FakeSocketFactory();
    const client = await makeClient(kv, docs, clock, sockets);
    const pending = client.completePairing(
      { serverUrl: 'http://localhost:5173', agentBoxPubKey: agent.publicKey, token: { token: 't', expiresAt: 9e15 } },
      { machineWaitMs: 1_000 },
    );
    await flushMicrotasks(10);
    sockets.last.emitOpen();
    // 服务端 onClientOnline 推全部 agent 的状态：先来一台离线的，再来在线的
    sockets.last.emitMessage({ type: 'machine.status', machineId: 'other', online: false, lastSeenAt: 1 });
    sockets.last.emitMessage({ type: 'machine.status', machineId: 'mbp', online: true, lastSeenAt: 2 });
    expect(await pending).toBe('mbp');
    expect(client.peer?.machines['mbp']?.agentBoxPubKey).toBe(agent.publicKey);
    expect(client.machines().map((m) => m.machineId)).toEqual(['mbp']);
    // 补上机器级同步请求
    expect(sockets.last.sentFrames.filter((f) => f.type === 'sync.request')).toEqual([{ type: 'sync.request', machineId: 'mbp', sinceSeq: 0 }]);
    // 超时路径
    const c2 = await makeClient(new MemoryKv(), new MemoryDocStore(), clock, sockets);
    const p2 = c2.completePairing({ serverUrl: 'http://localhost:5173', agentBoxPubKey: agent.publicKey, token: { token: 't', expiresAt: 9e15 } }, { machineWaitMs: 500 });
    await flushMicrotasks(10);
    sockets.last.emitOpen();
    await clock.advance(500);
    await expect(p2).rejects.toThrow(/没有看到在线的 agent/);
    client.stop();
    c2.stop();
  });
});

describe('client · B3 放弃自愈 / scope fatal 时本地条目不卡在 sending', () => {
  const status = (h: Awaited<ReturnType<typeof connected>>, id: string) =>
    (h.client.timeline('mbp', 's1').entries.find((e) => e.kind === 'user' && e.id === id) as UserEntry).status;

  test('缺 expectedAfter 的 reject → 条目 failed（可用同 clientMsgId 重发）+ notice', async () => {
    const h = await connected();
    const notices: string[] = [];
    h.client.on('notice', (n) => void notices.push(n.kind));
    const id = h.client.sendInput('mbp', 's1', 'hi');
    const seq = (h.sockets.last.sentFrames.at(-1) as { seq: number }).seq;
    h.sockets.last.emitMessage({ type: 'relay.reject', machineId: 'mbp', sessionId: 's1', seq, reason: 'seq_not_monotonic' });
    expect(status(h, id)).toBe('failed');
    expect(notices).toContain('outbox_gave_up');
    expect(h.client.retryInput('mbp', 's1', id)).toBe(true);
    expect(status(h, id)).toBe('sending');
    const relay = h.sockets.last.sentFrames.at(-1) as Extract<TransportFrame, { type: 'relay' }>;
    expect(relay.type).toBe('relay');
  });

  test('seq_too_far_ahead → 条目 failed；fatal scope 上新消息不发帧直接 failed；resetOutSeq 后可发', async () => {
    const h = await connected({ outSeq: { s1: 2_000_000 } });
    const id = h.client.sendInput('mbp', 's1', 'a');
    const seq = (h.sockets.last.sentFrames.at(-1) as { seq: number }).seq;
    h.sockets.last.emitMessage({ type: 'relay.reject', machineId: 'mbp', sessionId: 's1', seq, reason: 'seq_too_far_ahead', expectedAfter: 3 });
    expect(status(h, id)).toBe('failed');
    expect(h.client.isScopeFatal('mbp', 's1')).toBe(true);
    const before = h.sockets.last.sent.length;
    const id2 = h.client.sendInput('mbp', 's1', 'b');
    expect(status(h, id2)).toBe('failed');
    expect(h.sockets.last.sent.length).toBe(before);
    expect(h.client.send('mbp', { type: 'run.stop', sessionId: 's1' })).toBe(false);
    h.client.resetOutSeq('mbp', 's1');
    expect(h.client.retryInput('mbp', 's1', id2)).toBe(true);
    expect(status(h, id2)).toBe('sending');
    expect((h.sockets.last.sentFrames.at(-1) as { seq: number }).seq).toBe(1);
  });
});

describe('client · 会话元数据命令与永久删除清理（session-list-v2 §4.1 / 评审 B4）', () => {
  const meta = (sessionId: string) => ({
    sessionId,
    title: sessionId,
    state: 'idle' as const,
    lastActivityAt: 1_700_000_000_000,
    cwd: '/tmp',
    model: 'm',
    permissionMode: 'default' as const,
    costUsd: 0,
  });

  /** 解开最后一条发出的 relay（拿 reqId） */
  const lastC2a = (h: Awaited<ReturnType<typeof connected>>): ClientToAgentEvent => {
    const relay = h.sockets.last.sentFrames.filter((f) => f.type === 'relay').at(-1) as Extract<TransportFrame, { type: 'relay' }>;
    return openJson({ nonce: relay.nonce, ciphertext: relay.ciphertext }, h.client.publicKeys.box, agent.secretKey) as ClientToAgentEvent;
  };
  const reqIdOf = (e: ClientToAgentEvent): string => (e as { reqId: string }).reqId;

  test('session.removed：sessions / 时间线（内存+文档）/ peer.sessions / inCursors（含落盘）/ capabilities 全清，只报一次', async () => {
    const h = await connected(
      { inCursors: { '': 0, gone: 3, keep: 1 }, sessions: { gone: { lastActivityAt: 1_700_000_000_000 }, keep: { lastActivityAt: 1_700_000_000_000 } } },
      async (docs) => {
        await saveTimeline(docs, 'mbp/gone', { ...emptyTimeline(), lastAppliedSeq: 3, entries: [{ kind: 'run_state', id: 'run.state:3', state: 'idle', seq: 3, ts: 1 }] });
        await saveTimeline(docs, 'mbp/keep', { ...emptyTimeline(), lastAppliedSeq: 1, entries: [{ kind: 'run_state', id: 'run.state:1', state: 'idle', seq: 1, ts: 1 }] });
      },
    );
    for (const sid of ['gone', 'keep']) h.sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', sessionId: sid, upTo: 0 });
    h.sockets.last.emitMessage(h.a2c({ type: 'session.list.response', reqId: 'x', sessions: [meta('gone'), meta('keep')] }, 1));
    h.sockets.last.emitMessage(h.a2c({ type: 'session.capabilities', sessionId: 'gone', slashCommands: [], models: [], mcpServers: [] }, 4));
    h.client.openSession('mbp', 'gone');
    expect(h.client.capabilities('mbp', 'gone')).toBeDefined();
    const removed: string[] = [];
    h.client.on('sessionRemoved', (_m, sid) => void removed.push(sid));

    h.sockets.last.emitMessage(h.a2c({ type: 'session.removed', targetSessionId: 'gone' }, 2));
    await flushMicrotasks(10);

    expect(Object.keys(h.client.sessions('mbp'))).toEqual(['keep']);
    expect(h.client.timeline('mbp', 'gone').entries).toHaveLength(0);
    expect(await h.docs.get('timeline:mbp/gone')).toBeUndefined();
    expect(await h.docs.get('timeline:mbp/keep')).toBeDefined();
    expect(h.client.capabilities('mbp', 'gone')).toBeUndefined();
    const mp = h.client.peer!.machines['mbp']!;
    expect(mp.sessions['gone']).toBeUndefined();
    expect(mp.inCursors['gone']).toBeUndefined();
    expect(mp.inCursors['keep']).toBe(1);
    // 落盘的 peer 也没有（取 max 合并不会把旧游标合回来）
    const stored = JSON.parse(h.kv.get(KV_PEER)!) as PeerState;
    expect(stored.machines['mbp']!.inCursors['gone']).toBeUndefined();
    expect(stored.machines['mbp']!.sessions['gone']).toBeUndefined();
    expect(removed).toEqual(['gone']);

    // 重复广播（墓碑命中时 agent 还会再报）：幂等，不再发事件
    h.sockets.last.emitMessage(h.a2c({ type: 'session.removed', targetSessionId: 'gone' }, 3));
    expect(removed).toEqual(['gone']);
    // 之后的全量刷新不含它，时间线也不会因为 openSessions 残留被重新同步
    expect(h.client.timeline('mbp', 'keep').entries).toHaveLength(1);
  });

  test('rename / archive / delete 走 request：ok resolve；业务拒绝以 agent 原话 reject；delete 成功本地即清', async () => {
    const h = await connected();
    h.sockets.last.emitMessage(h.a2c({ type: 'session.list.response', reqId: 'x', sessions: [meta('a'), meta('b')] }, 1));

    const pRename = h.client.renameSession('mbp', 'a', '新名字');
    const rename = lastC2a(h);
    expect(rename).toMatchObject({ type: 'session.rename', sessionId: 'a', title: '新名字' });
    h.sockets.last.emitMessage(h.a2c({ type: 'session.mutate.response', reqId: reqIdOf(rename), targetSessionId: 'a', ok: true }, 2));
    await pRename;

    const pArchive = h.client.archiveSession('mbp', 'a', true);
    const archive = lastC2a(h);
    expect(archive).toMatchObject({ type: 'session.archive', sessionId: 'a', archived: true });
    h.sockets.last.emitMessage(
      h.a2c({ type: 'session.mutate.response', reqId: reqIdOf(archive), targetSessionId: 'a', ok: false, error: { code: 'busy', message: '会话运行中' } }, 3),
    );
    const err = await pArchive.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionMutateError);
    expect((err as SessionMutateError).code).toBe('busy');
    expect((err as SessionMutateError).message).toBe('会话运行中');
    expect(Object.keys(h.client.sessions('mbp'))).toEqual(['a', 'b']);

    const removed: string[] = [];
    h.client.on('sessionRemoved', (_m, sid) => void removed.push(sid));
    const pDelete = h.client.deleteSession('mbp', 'b');
    const del = lastC2a(h);
    expect(del).toMatchObject({ type: 'session.delete', sessionId: 'b' });
    // 广播没到（只来了应答）也要清
    h.sockets.last.emitMessage(h.a2c({ type: 'session.mutate.response', reqId: reqIdOf(del), targetSessionId: 'b', ok: true }, 4));
    await pDelete;
    expect(Object.keys(h.client.sessions('mbp'))).toEqual(['a']);
    expect(removed).toEqual(['b']);
  });

  test('墓碑命中：任意带 reqId 的请求收到 deleted → reject 且视同 removed', async () => {
    const h = await connected();
    h.sockets.last.emitMessage(h.a2c({ type: 'session.list.response', reqId: 'x', sessions: [meta('a')] }, 1));
    h.client.openSession('mbp', 'a');
    const p = h.client.request('mbp', { type: 'session.status.request', sessionId: 'a' });
    const req = lastC2a(h);
    h.sockets.last.emitMessage(
      h.a2c({ type: 'session.mutate.response', reqId: reqIdOf(req), targetSessionId: 'a', ok: false, error: { code: 'deleted', message: '该会话已被永久删除' } }, 2),
    );
    const err = await p.catch((e: unknown) => e);
    expect((err as SessionMutateError).code).toBe('deleted');
    expect(h.client.sessions('mbp')).toEqual({});
  });

  test('超时：旧 agent 静默丢弃新帧 → RequestTimeoutError，文案提示 agent 版本过旧或离线', async () => {
    const h = await connected();
    const p = h.client.renameSession('mbp', 'a', 'x').catch((e: unknown) => e);
    await h.clock.advance(10_000);
    const err = await p;
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect((err as Error).message).toBe(MUTATE_TIMEOUT_HINT);
    expect(MUTATE_TIMEOUT_HINT).toContain('agent 版本过旧或离线');
  });

  test('删除时丢掉该会话 outbox 里的待发帧（断线积压），排队计数随之更新', async () => {
    const h = await connected();
    h.sockets.last.emitMessage(h.a2c({ type: 'session.list.response', reqId: 'x', sessions: [meta('a')] }, 1));
    h.sockets.last.emitClose();
    await flushMicrotasks(10);
    const queue: number[] = [];
    h.client.on('queue', (n) => void queue.push(n));
    h.client.sendInput('mbp', 'a', 'hi');
    h.client.send('mbp', { type: 'cwd.list.request', reqId: 'c' });
    expect(h.client.queuedCount).toBe(2);
    // 直接往（已断的）假 socket 注入一帧：只为触发清理路径，验的是队列而不是时序
    h.sockets.last.emitMessage(h.a2c({ type: 'session.removed', targetSessionId: 'a' }, 2));
    expect(h.client.queuedCount).toBe(1);
    expect(queue.at(-1)).toBe(1);
  });

  // ---- 评审 CM1：删掉的会话不许被回放 / 迟到帧 / 深链复活 ----

  test('removed 之后同会话的回放帧（sync 回放、迟到帧）丢弃：不重建时间线 / peer.sessions，游标照推', async () => {
    const h = await connected({ inCursors: { gone: 3 }, sessions: { gone: { lastActivityAt: 1_700_000_000_000 } } });
    h.sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', sessionId: 'gone', upTo: 0 });
    h.sockets.last.emitMessage(h.a2c({ type: 'session.list.response', reqId: 'x', sessions: [meta('gone')] }, 1));
    h.sockets.last.emitMessage(h.a2c({ type: 'session.removed', targetSessionId: 'gone' }, 2));
    await flushMicrotasks(10);
    const timelines: string[] = [];
    h.client.on('timeline', (_m, sid) => void timelines.push(sid));

    // 同一栈里紧跟着到达的会话 scope 回放（服务端先回放机器流、再回放会话流）
    h.sockets.last.emitMessage(h.a2c({ type: 'run.state', sessionId: 'gone', state: 'running' }, 4));
    h.sockets.last.emitMessage(h.a2c({ type: 'assistant.done', sessionId: 'gone', messageId: 'm', text: '正文' }, 5));
    await flushMicrotasks(10);

    expect(timelines).toEqual([]);
    expect(h.client.timeline('mbp', 'gone').entries).toHaveLength(0);
    expect(await h.docs.get('timeline:mbp/gone')).toBeUndefined();
    const mp = h.client.peer!.machines['mbp']!;
    expect(mp.sessions['gone']).toBeUndefined();
    expect(mp.inCursors['gone']).toBe(5);
    expect(mp.removedSessions?.['gone']).toBe(h.clock.now());
    // 迟到的机器级 updated / 列表里带着它，也不许回来
    h.sockets.last.emitMessage(h.a2c({ type: 'session.updated', session: meta('gone') }, 3));
    h.sockets.last.emitMessage(h.a2c({ type: 'session.list.response', reqId: 'y', sessions: [meta('gone'), meta('keep')] }, 4));
    expect(Object.keys(h.client.sessions('mbp'))).toEqual(['keep']);
    expect(mp.sessions['gone']).toBeUndefined();
    // 已删记忆落了盘
    const stored = JSON.parse(h.kv.get(KV_PEER)!) as PeerState;
    expect(stored.machines['mbp']!.removedSessions?.['gone']).toBeDefined();
  });

  test('深链 / 后退回到已删会话：openSession 返回 false，不加回 peer.sessions、不发 sync；sendInput 不入队', async () => {
    const h = await connected();
    h.sockets.last.emitMessage(h.a2c({ type: 'session.removed', targetSessionId: 'gone' }, 1));
    const sentBefore = h.sockets.last.sentFrames.length;
    expect(h.client.openSession('mbp', 'gone')).toBe(false);
    expect(h.client.peer!.machines['mbp']!.sessions['gone']).toBeUndefined();
    h.client.sendInput('mbp', 'gone', 'zombie');
    expect(h.client.timeline('mbp', 'gone').entries).toHaveLength(0);
    expect(h.client.queuedCount).toBe(0);
    expect(h.sockets.last.sentFrames.length).toBe(sentBefore);
    // 别的会话照常
    expect(h.client.openSession('mbp', 'alive')).toBe(true);
  });

  test('重连时 #syncMachine 跳过已删会话（即使 peer.sessions 残留）', async () => {
    const now = new FakeClock().now();
    const h = await connected({
      inCursors: { gone: 4, keep: 2 },
      sessions: { gone: { lastActivityAt: now }, keep: { lastActivityAt: now } },
      removedSessions: { gone: now - 1_000 },
    });
    const syncs = h.sockets.last.sentFrames.filter((f): f is Extract<TransportFrame, { type: 'sync.request' }> => f.type === 'sync.request');
    expect(syncs.map((f) => f.sessionId)).toEqual([undefined, 'keep']);
  });

  test('已删记忆 TTL 8 天：加载时清过期的（连同残留游标），未过期的保留', async () => {
    const now = new FakeClock().now();
    const h = await connected({
      inCursors: { old: 9, fresh: 3 },
      removedSessions: { old: now - REMOVED_SESSION_TTL_MS - 1, fresh: now - REMOVED_SESSION_TTL_MS + 60_000 },
    });
    const mp = h.client.peer!.machines['mbp']!;
    expect(mp.removedSessions).toEqual({ fresh: now - REMOVED_SESSION_TTL_MS + 60_000 });
    expect(mp.inCursors['old']).toBeUndefined();
    expect(mp.inCursors['fresh']).toBe(3);
    // 落盘是 force 写：取 max 合并不会把 old 的游标合回来
    const stored = JSON.parse(h.kv.get(KV_PEER)!) as PeerState;
    expect(stored.machines['mbp']!.inCursors['old']).toBeUndefined();
    // 已删判断经 openSession 观察（它是唯一的对外入口）：未过期的打不开
    expect(h.client.openSession('mbp', 'fresh')).toBe(false);
    // 运行中跨过 TTL 也自然失效；过期的本来就能打开
    await h.clock.advance(60_000);
    expect(h.client.openSession('mbp', 'fresh')).toBe(true);
    expect(h.client.openSession('mbp', 'old')).toBe(true);
  });
});

describe('client · 远程更新 claude（claude-update）', () => {
  const lastC2a = (h: Awaited<ReturnType<typeof connected>>): ClientToAgentEvent => {
    const relay = h.sockets.last.sentFrames.filter((f) => f.type === 'relay').at(-1) as Extract<TransportFrame, { type: 'relay' }>;
    expect(relay.sessionId).toBeUndefined();
    return openJson({ nonce: relay.nonce, ciphertext: relay.ciphertext }, h.client.publicKeys.box, agent.secretKey) as ClientToAgentEvent;
  };
  const base = { fromVersion: '2.1.251 (Claude Code)', toVersion: '2.1.282 (Claude Code)', output: 'done' };

  test('发机器级请求；ok 与业务失败都 resolve 原样应答（不抛）', async () => {
    const h = await connected();
    const p1 = h.client.updateClaude('mbp');
    const req = lastC2a(h);
    expect(req.type).toBe('machine.claude.update.request');
    h.sockets.last.emitMessage(
      h.a2c({ type: 'machine.claude.update.response', reqId: (req as { reqId: string }).reqId, ok: true, ...base }, 1),
    );
    expect(await p1).toMatchObject({ ok: true, toVersion: '2.1.282 (Claude Code)' });

    const p2 = h.client.updateClaude('mbp');
    const req2 = lastC2a(h);
    h.sockets.last.emitMessage(
      h.a2c(
        {
          type: 'machine.claude.update.response',
          reqId: (req2 as { reqId: string }).reqId,
          ok: false,
          ...base,
          error: { code: 'busy', message: '已有一次 claude 更新在进行中' },
        },
        2,
      ),
    );
    expect(await p2).toMatchObject({ ok: false, error: { code: 'busy' } });
  });

  test('超时给宽（6 分钟），到点才报「agent 版本过旧或离线」', async () => {
    const h = await connected();
    const p = h.client.updateClaude('mbp').catch((e: unknown) => e);
    await h.clock.advance(5 * 60_000);
    let settled = false;
    void p.then(() => (settled = true));
    await flushMicrotasks(5);
    expect(settled).toBe(false);
    await h.clock.advance(CLAUDE_UPDATE_TIMEOUT_MS - 5 * 60_000);
    const err = await p;
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect((err as Error).message).toBe(MUTATE_TIMEOUT_HINT);
  });
});

describe('client · 子 agent 过程回看（subagent.history.request）', () => {
  test('发会话级请求（带 toolUseId），应答挂到父工具条目下；同一调用并发复用 promise', async () => {
    const h = await connected();
    h.sockets.last.emitMessage({ type: 'machine.status', machineId: 'mbp', online: true, lastSeenAt: 1 });
    h.sockets.last.emitMessage(h.a2c({ type: 'tool.start', sessionId: 's1', toolUseId: 'P', toolName: 'Agent', argSummary: 'd' }, 1));
    h.sockets.last.emitMessage(
      h.a2c({ type: 'tool.end', sessionId: 's1', toolUseId: 'P', status: 'ok', durationMs: 5, resultSummary: '✓ 1 次工具调用 · 5ms' }, 2),
    );
    const relays = () => h.sockets.last.sentFrames.filter((f) => f.type === 'relay') as Extract<TransportFrame, { type: 'relay' }>[];
    const p = h.client.loadSubagentHistory('mbp', 's1', 'P');
    const before = relays().length;
    expect(h.client.loadSubagentHistory('mbp', 's1', 'P')).toBe(p);
    expect(relays().length).toBe(before);
    const relay = relays().at(-1)!;
    const req = openJson({ nonce: relay.nonce, ciphertext: relay.ciphertext }, h.client.publicKeys.box, agent.secretKey) as ClientToAgentEvent;
    expect(req).toMatchObject({ type: 'subagent.history.request', sessionId: 's1', toolUseId: 'P' });
    h.sockets.last.emitMessage(
      h.a2c(
        {
          type: 'subagent.history.response',
          sessionId: 's1',
          reqId: (req as { reqId: string }).reqId,
          toolUseId: 'P',
          items: [{ kind: 'tool', id: 'c1', toolName: 'Bash', argSummary: 'echo SUB1', status: 'ok', ts: 1 }],
        },
        3,
      ),
    );
    await p;
    const parent = h.client.timeline('mbp', 's1').entries[0];
    expect(parent).toMatchObject({ kind: 'tool', id: 'P', childrenLoaded: true, children: [{ id: 'c1', toolName: 'Bash' }] });
  });
});

describe('client · 斜杠命令补拉（session.commands.request）', () => {
  const lastSessionC2a = (h: Awaited<ReturnType<typeof connected>>): ClientToAgentEvent => {
    const relay = h.sockets.last.sentFrames.filter((f) => f.type === 'relay').at(-1) as Extract<TransportFrame, { type: 'relay' }>;
    return openJson({ nonce: relay.nonce, ciphertext: relay.ciphertext }, h.client.publicKeys.box, agent.secretKey) as ClientToAgentEvent;
  };
  const relayCount = (h: Awaited<ReturnType<typeof connected>>) => h.sockets.last.sentFrames.filter((f) => f.type === 'relay').length;
  const info = (agentVersion: string) => ({
    name: 'mbp',
    platform: 'darwin',
    osVersion: '25',
    agentVersion,
    claudeVersion: '2.1',
    activeSessionCount: 0,
  });
  async function online(agentVersion: string) {
    const h = await connected();
    h.sockets.last.emitMessage({ type: 'machine.status', machineId: 'mbp', online: true, lastSeenAt: 1 });
    h.sockets.last.emitMessage(h.a2c({ type: 'machine.info', info: info(agentVersion) }, 1));
    return h;
  }
  const commandsResponse = (reqId: string, slashCommands: { name: string; description?: string; source: 'project' }[]) => ({
    type: 'session.commands.response' as const,
    sessionId: 's1',
    reqId,
    slashCommands,
  });

  test('agent ≥ 0.5.0：发会话级请求，应答写入 capabilities 并 emit；models / mcpServers 缺省空数组', async () => {
    const h = await online('0.5.0');
    const emitted: unknown[] = [];
    h.client.on('capabilities', (_m, sid, caps) => void emitted.push([sid, caps]));
    const p = h.client.loadCommands('mbp', 's1');
    const req = lastSessionC2a(h);
    expect(req).toMatchObject({ type: 'session.commands.request', sessionId: 's1' });
    // 同会话并发：复用同一个 promise，不再发帧
    const before = relayCount(h);
    expect(h.client.loadCommands('mbp', 's1')).toBe(p);
    expect(relayCount(h)).toBe(before);
    const cmds = [{ name: 'babysit-pr', description: 'Monitor a PR', source: 'project' as const }];
    h.sockets.last.emitMessage(h.a2c(commandsResponse((req as { reqId: string }).reqId, cmds), 1));
    await p;
    expect(h.client.capabilities('mbp', 's1')).toEqual({ slashCommands: cmds, models: [], mcpServers: [] });
    expect(emitted).toHaveLength(1);
    // 已有命令：不再请求
    const n = relayCount(h);
    await h.client.loadCommands('mbp', 's1');
    expect(relayCount(h)).toBe(n);
  });

  test('agent 版本过旧 / 未知 / 离线：不发请求', async () => {
    const h = await online('0.4.0');
    const n = relayCount(h);
    await h.client.loadCommands('mbp', 's1');
    expect(relayCount(h)).toBe(n);
    h.sockets.last.emitMessage(h.a2c({ type: 'machine.info', info: info('garbage') }, 2));
    await h.client.loadCommands('mbp', 's1');
    expect(relayCount(h)).toBe(n);
    h.sockets.last.emitMessage(h.a2c({ type: 'machine.info', info: info('0.5.1') }, 3));
    h.sockets.last.emitMessage({ type: 'machine.status', machineId: 'mbp', online: false, lastSeenAt: 1 });
    await h.client.loadCommands('mbp', 's1');
    expect(relayCount(h)).toBe(n);
  });

  test('init 只有空命令清单时仍补拉；保留已有 models / mcpServers', async () => {
    const h = await online('0.5.0');
    h.sockets.last.emitMessage(
      h.a2c({ type: 'session.capabilities', sessionId: 's1', slashCommands: [], models: ['opus'], mcpServers: [{ name: 'fs', state: 'connected', toolCount: 2 }] }, 1),
    );
    const p = h.client.loadCommands('mbp', 's1');
    const req = lastSessionC2a(h);
    h.sockets.last.emitMessage(h.a2c(commandsResponse((req as { reqId: string }).reqId, [{ name: 'x', description: 'X', source: 'project' }]), 2));
    await p;
    expect(h.client.capabilities('mbp', 's1')).toEqual({
      slashCommands: [{ name: 'x', description: 'X', source: 'project' }],
      models: ['opus'],
      mcpServers: [{ name: 'fs', state: 'connected', toolCount: 2 }],
    });
  });

  test('之后 SDK init 覆盖：以 init 的命令名为准，按 name 并回已知描述', async () => {
    const h = await online('0.5.0');
    const p = h.client.loadCommands('mbp', 's1');
    const req = lastSessionC2a(h);
    h.sockets.last.emitMessage(
      h.a2c(
        commandsResponse(
          (req as { reqId: string }).reqId,
          [
            { name: 'babysit-pr', description: 'Monitor a PR', source: 'project' },
            { name: 'gone', description: 'removed later', source: 'project' },
          ],
        ),
        1,
      ),
    );
    await p;
    h.sockets.last.emitMessage(
      h.a2c(
        {
          type: 'session.capabilities',
          sessionId: 's1',
          slashCommands: [
            { name: 'babysit-pr', source: 'project' },
            { name: 'new-one', source: 'project' },
          ],
          models: ['opus'],
          mcpServers: [],
        },
        2,
      ),
    );
    expect(h.client.capabilities('mbp', 's1')?.slashCommands).toEqual([
      { name: 'babysit-pr', description: 'Monitor a PR', source: 'project' },
      { name: 'new-one', source: 'project' },
    ]);
    expect(h.client.capabilities('mbp', 's1')?.models).toEqual(['opus']);
  });

  test('请求期间 init 先到：命令名以 init 为准，只并描述', async () => {
    const h = await online('0.5.0');
    const p = h.client.loadCommands('mbp', 's1');
    const req = lastSessionC2a(h);
    h.sockets.last.emitMessage(
      h.a2c({ type: 'session.capabilities', sessionId: 's1', slashCommands: [{ name: 'a', source: 'project' }], models: ['m'], mcpServers: [] }, 1),
    );
    h.sockets.last.emitMessage(
      h.a2c(
        commandsResponse(
          (req as { reqId: string }).reqId,
          [
            { name: 'a', description: 'A', source: 'project' },
            { name: 'b', description: 'B', source: 'project' },
          ],
        ),
        2,
      ),
    );
    await p;
    expect(h.client.capabilities('mbp', 's1')).toEqual({
      slashCommands: [{ name: 'a', description: 'A', source: 'project' }],
      models: ['m'],
      mcpServers: [],
    });
  });

  test('超时 reject；inflight 清掉，之后可重试', async () => {
    const h = await online('0.5.0');
    const p = h.client.loadCommands('mbp', 's1');
    await h.clock.advance(30_000);
    await expect(p).rejects.toThrow(/超时/);
    const n = relayCount(h);
    void h.client.loadCommands('mbp', 's1').catch(() => {});
    expect(relayCount(h)).toBe(n + 1);
  });
});

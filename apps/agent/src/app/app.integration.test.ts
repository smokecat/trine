import { createInvitation } from '../../../server/src/auth/invitations.ts';
/**
 * 集成测试（方案 §7）：进程内真服务端 + 真 AgentNode + 真 SessionManager（假
 * ClaudeSession）+ 模拟 client，走完整条链：
 *
 *   a. input.send → 假会话吐 assistant.done → client 解密收到
 *   b. 重启 agent（同 home）→ 再发帧不被拒，且对 **sid=X** 的 sync.request 带 sinceSeq>0
 *   c. 删掉 state.json 再重启 → 首帧被拒 → 自愈重发 → client 收到且 seq 单调
 *   d. 断线重连 → client 收到 run.state 重放 + pending permission.request 重发
 *   e. 服务端 sweep 清空留存后继续发 → 不出现 seq_too_far_ahead
 *   f. 归档 → 永久删除 → list 不再出现、input.send 不复活（含重启后）（session-list-v2 ③）
 *   g. 已归档会话被 run.resumeAt 唤醒 → 自动取消归档（session-list-v2 ④）
 *   h. 远程 claude update → machine.info 刷新版本先于应答到达（claude-update）
 *
 * 假会话只模拟「收到消息就回一句」与「权限请求挂起直到应答」两种行为——
 * SDK 相关逻辑在 bridge 层自己的测试里。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sodiumReady } from '@trine/core/crypto';
import type { getSessionMessages, SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentToClientEvent, ClientToAgentEvent } from '@trine/core';
import { startServer, type TrineServer } from '../../../server/src/server.ts';
import { startEchoAgent } from '../testing/echo-session.ts';
import { FakeTranscripts } from '../testing/fake-transcripts.ts';
import { MockClient } from '../testing/mock-client.ts';
import type { AgentApp } from './app.ts';
import type { SpawnedProcess, SpawnFn } from './claude-cli.ts';
import { agentPaths } from './config.ts';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let server: TrineServer;
let home: string;
let logs: string[];
let app: AgentApp;
/** 模拟 client 的 c2a seq（每 scope 一条；服务端 c2a 流跨 agent 重启持久） */
let c2aSeq: Map<string, number>;
/** 内存版转录目录：跨 agent 重启保留（相当于磁盘上的 ~/.claude/projects） */
let transcripts: FakeTranscripts;
/** 假本机转录：任何 sessionId 都返回它（session.history.request 用例设置） */
let transcript: SessionMessage[];

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'trine-app-'));
  logs = [];
  c2aSeq = new Map();
  transcripts = new FakeTranscripts();
  transcript = [];
  server = await startServer({
    port: 0,
    hostname: '127.0.0.1',
    dbPath: ':memory:',
    allowOpenRegistration: false,
    heartbeatIntervalMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  app = await createApp();
});

afterEach(async () => {
  await app.stop();
  await server.stop();
  await rm(home, { recursive: true, force: true });
});

/** 起一个假会话 agent（不自动接入——多数用例要自己控制 start 的时机） */
async function createApp(
  extra: { whichFn?: (cmd: string) => string | null; spawnFn?: SpawnFn } = {},
): Promise<AgentApp> {
  const { app: created } = await startEchoAgent({
    ...extra,
    serverUrl: `http://127.0.0.1:${server.port}`,
    getInvitation: async () => createInvitation(server.store).token,
    home,
    machineId: 'mbp',
    log: (l) => logs.push(l),
    autoStart: false,
    transcripts,
    getSessionMessagesFn: (async () => transcript) as typeof getSessionMessages,
  });
  return created;
}

/** 重启 agent：优雅停掉当前实例，同 home 起一个新的并接入 */
async function restartAgent(): Promise<void> {
  await app.stop();
  app = await createApp();
  await app.start();
  await waitFor(() => app.node.online, '重启后接入');
  await settle(80);
}

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待「${label}」超时`);
    await Bun.sleep(10);
  }
}

/** 模拟 client 侧：解出全部 a2c 事件（按接收顺序） */
function eventsOf(client: MockClient): AgentToClientEvent[] {
  return client.ofType('relay').map((f) => client.openRelay(f));
}

function nextSeq(scope: string | undefined): number {
  const key = scope ?? '';
  const seq = (c2aSeq.get(key) ?? 0) + 1;
  c2aSeq.set(key, seq);
  return seq;
}

/** 分配式 Omit：直接对联合用 Omit 会把判别式合并成一个大交集，丢掉各成员的字段 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** client → agent：自动补 seq / ts / dir */
function send(
  client: MockClient,
  body: DistributiveOmit<ClientToAgentEvent, 'ts' | 'seq' | 'dir'>,
): void {
  const event = {
    ...body,
    ts: Date.now(),
    seq: nextSeq(body.sessionId),
    dir: 'c2a',
  } as ClientToAgentEvent;
  client.sendEvent(event, 'mbp');
}

/** 配对一台设备并以 client 角色接入 */
async function pairAndConnect(deviceId = 'phone'): Promise<MockClient> {
  // 第二台设备配对时 agent 已接入，不能再 start 一次（connect 不幂等）
  if (!app.node.online) await app.start();
  await waitFor(() => app.node.online, 'agent 接入');
  const session = app.node.startPairing();
  const pairing = new MockClient(deviceId, server.port);
  await pairing.connectForPairing();
  await settle();
  const scanned = pairing.scan(session.payload);
  pairing.sendPairBegin(scanned.pairingToken);
  await waitFor(() => app.node.pairing.get(scanned.pairingToken)?.pending !== null, 'pair.begin 到达');
  await app.confirmPairing(scanned.pairingToken);
  await pairing.wait('pair.confirm');
  pairing.close();
  await settle();

  const client = new MockClient(deviceId, server.port);
  Object.assign(client, {
    signKeys: pairing.signKeys,
    boxKeys: pairing.boxKeys,
    agentBoxPubKey: pairing.agentBoxPubKey,
  });
  await client.connectAsClient();
  // 真实 client 接入后会对每条流发 sync.request（见 client-demo / 方案 §4.2）。
  // 这里补上机器级那条：配对确认时补发的 machine.info 是在本连接建立**之前**
  // 发出的，只能靠补发拿到——MockClient 不会自己发，测试替它发。
  client.send({ type: 'sync.request', machineId: 'mbp', sinceSeq: 0 });
  await settle();
  return client;
}

/** 让 client 新建一个会话，返回 sessionId */
async function createSession(client: MockClient): Promise<string> {
  send(client, { type: 'session.create', reqId: 'q-create', cwd: '/tmp', model: 'test-model', permissionMode: 'default' });
  await waitFor(
    () => eventsOf(client).some((e) => e.type === 'session.create.response' && e.reqId === 'q-create'),
    'session.create.response',
  );
  const resp = eventsOf(client).find((e) => e.type === 'session.create.response');
  if (resp?.type !== 'session.create.response') throw new Error('unreachable');
  return resp.session.sessionId;
}

/** 发一句话，等 echo 回来 */
async function chat(client: MockClient, sessionId: string, text: string): Promise<AgentToClientEvent> {
  const clientMsgId = `c-${text}-${Date.now()}`;
  send(client, { type: 'input.send', sessionId, clientMsgId, text });
  const match = (e: AgentToClientEvent) =>
    e.type === 'assistant.done' && e.sessionId === sessionId && e.text === `echo: ${text}`;
  await waitFor(() => eventsOf(client).some(match), `echo: ${text}`);
  return eventsOf(client).find(match)!;
}

/** 该 sid 子流上 client 收到的全部 seq（含重启前后） */
function seqsOf(client: MockClient, sessionId: string | undefined): number[] {
  return client
    .ofType('relay')
    .filter((f) => f.sessionId === sessionId)
    .map((f) => f.seq);
}

function isStrictlyIncreasing(seqs: number[]): boolean {
  return seqs.every((s, i) => i === 0 || s > seqs[i - 1]!);
}

// ---------------------------------------------------------------------------

describe('agent 接线 · 端到端', () => {
  test('a. 配对 → 新建会话 → input.send → client 解密收到 assistant.done（含 machine.info 广播）', async () => {
    const client = await pairAndConnect();
    // 配对确认时 app 已经补发过 machine.info（见下面那个专门的用例），
    // 所以这里**不需要**重连就能拿到
    await waitFor(() => eventsOf(client).some((e) => e.type === 'machine.info'), 'machine.info');
    const info = eventsOf(client).find((e) => e.type === 'machine.info');
    expect(info).toMatchObject({ info: { name: 'Test MBP', claudeVersion: 'test', activeSessionCount: 0 } });

    const sid = await createSession(client);
    // 发起端两帧都会收到：response（reqId）与 created 广播，按 sessionId 幂等
    expect(eventsOf(client).filter((e) => e.type === 'session.created')).toHaveLength(1);

    const done = await chat(client, sid, 'hello');
    expect(done.sessionId).toBe(sid);
    const types = eventsOf(client)
      .filter((e) => e.sessionId === sid)
      .map((e) => e.type);
    expect(types).toEqual(['user.message', 'run.state', 'assistant.done', 'run.done', 'run.state']);
    // 推送提示：run.done 走了 run_done（服务端可见、脱敏）
    const runDoneFrame = client.ofType('relay').find((f) => f.pushHint === 'run_done');
    expect(runDoneFrame).toBeDefined();
    expect(isStrictlyIncreasing(seqsOf(client, sid))).toBe(true);
    client.close();
  });

  test('a2. 配对确认即补发 machine.info：新设备不必等 agent 重连就有机器卡', async () => {
    // 回归点：machine.info 只在 #onOpen 广播一次，而 publish 按**当时**的
    // 名册 seal。新设备是配对成功才进名册的，那一发早过去了——修复前它的
    // 机器卡要一直空到 agent 下次重连（可能几天后）。断线补发也救不了：
    // 服务端留存里根本没有发给这个新 deviceId 的帧。
    const client = await pairAndConnect('fresh-phone');
    try {
      // 全程没有 disconnect/connect，agent 连接自始至终没动过
      expect(app.node.online).toBe(true);

      await waitFor(
        () => eventsOf(client).some((e) => e.type === 'machine.info'),
        'machine.info（无需重连）',
      );
      const info = eventsOf(client).find((e) => e.type === 'machine.info');
      expect(info).toMatchObject({
        info: { name: 'Test MBP', claudeVersion: 'test' },
      });
      // 机器级帧：信封不带 sessionId
      expect(info?.sessionId).toBeUndefined();
    } finally {
      client.close();
    }
  });

  test('b. 重启 agent（保留 state.json）→ 续发不被拒；对 sid 的 sync.request 带 sinceSeq>0', async () => {
    const client = await pairAndConnect();
    const sid = await createSession(client);
    await chat(client, sid, 'first');
    const before = Math.max(...seqsOf(client, sid));
    // state.json 已落盘（stop 里 flush）
    await restartAgent();
    await stat(agentPaths(home).state);

    // 断言落到具体 sid：服务端处理 sync.request 时把 sinceSeq 记进 stream_cursors
    expect(server.store.getCursor('mbp', 'mbp', sid)).toBe(c2aSeq.get(sid)!);
    expect(server.store.getCursor('mbp', 'mbp', undefined)).toBe(c2aSeq.get('')!);
    // 只对确有往来的流发，别的 sid 不发
    expect(server.store.getCursor('mbp', 'mbp', 'never-seen')).toBeNull();

    const done = await chat(client, sid, 'second');
    // 续发的 seq 接在重启前之后（+RESTART_GAP 余量），没有一次 reject
    expect(done.seq).toBeGreaterThan(before);
    expect(isStrictlyIncreasing(seqsOf(client, sid))).toBe(true);
    expect(logs.some((l) => l.includes('[outbox]'))).toBe(false);
    // 重启后首次接入对 state 里记着的会话发了 run.state idle（崩溃重启对齐）
    const idleReplay = eventsOf(client).filter(
      (e) => e.type === 'run.state' && e.sessionId === sid && e.state === 'idle',
    );
    expect(idleReplay.length).toBeGreaterThanOrEqual(2);
    client.close();
  });

  test('c. 删掉 state.json 再重启 → 首帧被拒 → 自愈重发 → client 收到且 seq 单调', async () => {
    const client = await pairAndConnect();
    const sid = await createSession(client);
    await chat(client, sid, 'first');
    const before = Math.max(...seqsOf(client, sid));
    const machineBefore = Math.max(...seqsOf(client, undefined));

    await app.stop();
    await rm(agentPaths(home).state, { force: true });
    app = await createApp();
    await app.start();
    await waitFor(() => app.node.online, '重启后接入');

    // 会话参数也随 state.json 丢了：真实场景下 resolveSession 会走 listSessions
    // 兜底查到它；本测试的假 listSessions 是空的，直接把参数塞回 state 等价
    app.state.rememberSession(sid, { cwd: '/tmp', model: 'test-model', permissionMode: 'default' });

    // 机器级流：onOpen 的 machine.info 从 seq 1 发出 → 被拒 → 自愈重发
    await waitFor(() => Math.max(...seqsOf(client, undefined)) > machineBefore, 'machine.info 自愈送达');

    // 会话级五帧从 1 重来，全部撞上留存里的老 seq（字节不同）→ reject → 自愈。
    // 这是比「留存被清空后撞单调校验」更常见的重启场景：留存 7 天，几乎总在
    const done = await chat(client, sid, 'healed');
    expect(done.seq).toBeGreaterThan(before);
    expect(isStrictlyIncreasing(seqsOf(client, sid))).toBe(true);
    expect(isStrictlyIncreasing(seqsOf(client, undefined))).toBe(true);
    // 确实走了自愈路径
    expect(logs.some((l) => l.includes('[outbox] seq 失配自愈'))).toBe(true);
    // 自愈没有放弃
    expect(logs.some((l) => l.includes('放弃自愈'))).toBe(false);
    // 重发帧绕过 sink，但出站 seq 仍要记进 state（否则下次重启起点落后）
    await app.state.flush();
    const stateFile = await Bun.file(agentPaths(home).state).json();
    expect(stateFile.outSeq[sid]).toBe(Math.max(...seqsOf(client, sid)));
    // 会话级五帧都到齐（user.message / running / done / run.done / idle）
    const afterHeal = eventsOf(client).filter((e) => e.sessionId === sid && e.seq > before);
    expect(afterHeal.map((e) => e.type)).toEqual([
      'user.message',
      'run.state',
      'assistant.done',
      'run.done',
      'run.state',
    ]);
    client.close();
  });

  test('d. 断线重连 → client 收到 run.state 重放 + pending permission.request 重发', async () => {
    const client = await pairAndConnect();
    const sid = await createSession(client);
    send(client, { type: 'input.send', sessionId: sid, clientMsgId: 'c-perm', text: 'perm:touch /tmp/x' });
    await waitFor(() => eventsOf(client).some((e) => e.type === 'permission.request'), 'permission.request');
    const first = eventsOf(client).find((e) => e.type === 'permission.request')!;
    if (first.type !== 'permission.request') throw new Error('unreachable');

    const countBefore = client.ofType('relay').length;
    app.node.disconnect();
    await settle();
    await app.node.connect();
    await waitFor(() => client.ofType('relay').length >= countBefore + 3, '重连重放');
    const replayed = eventsOf(client).slice(countBefore);
    expect(replayed.map((e) => e.type)).toEqual(['machine.info', 'run.state', 'permission.request']);
    expect(replayed[1]).toMatchObject({ sessionId: sid, state: 'waiting_permission' });
    // 同 requestId、同 input——client 按 requestId 幂等
    expect(replayed[2]).toMatchObject({
      requestId: first.requestId,
      toolName: 'Bash',
      input: { command: 'touch /tmp/x' },
    });
    // 重放帧的 pushHint 仍是 permission_pending
    expect(client.ofType('relay').at(-1)!.pushHint).toBe('permission_pending');

    // 应答 → resolved 带 resolvedBy=phone → 完成
    send(client, { type: 'permission.respond', sessionId: sid, requestId: first.requestId, verdict: 'allow' });
    await waitFor(() => eventsOf(client).some((e) => e.type === 'run.done'), 'run.done');
    expect(eventsOf(client).find((e) => e.type === 'permission.resolved')).toMatchObject({
      requestId: first.requestId,
      verdict: 'allow',
      resolvedBy: 'phone',
    });
    expect(isStrictlyIncreasing(seqsOf(client, sid))).toBe(true);
    client.close();
  });

  test('d2. plan 模式 ExitPlanMode：推送提示 plan_pending、waitingFor=plan；批准并切 acceptEdits 后广播并落盘新模式', async () => {
    const client = await pairAndConnect();
    send(client, { type: 'session.create', reqId: 'q-plan', cwd: '/tmp', model: 'test-model', permissionMode: 'plan' });
    await waitFor(
      () => eventsOf(client).some((e) => e.type === 'session.create.response' && e.reqId === 'q-plan'),
      'session.create.response',
    );
    const created = eventsOf(client).find((e) => e.type === 'session.create.response' && e.reqId === 'q-plan');
    if (created?.type !== 'session.create.response') throw new Error('unreachable');
    const sid = created.session.sessionId;

    send(client, { type: 'input.send', sessionId: sid, clientMsgId: 'c-plan', text: 'plan:# 计划\n1. 写 hi.txt' });
    await waitFor(() => eventsOf(client).some((e) => e.type === 'permission.request'), 'permission.request');
    const req = eventsOf(client).find((e) => e.type === 'permission.request')!;
    if (req.type !== 'permission.request') throw new Error('unreachable');
    expect(req.toolName).toBe('ExitPlanMode');
    const reqFrame = client.ofType('relay').find((f) => f.pushHint !== undefined && f.sessionId === sid);
    expect(reqFrame?.pushHint).toBe('plan_pending');
    expect(
      eventsOf(client).some(
        (e) => e.type === 'session.updated' && e.session.sessionId === sid && e.session.waitingFor === 'plan',
      ),
    ).toBe(true);

    send(client, {
      type: 'permission.respond',
      sessionId: sid,
      requestId: req.requestId,
      verdict: 'allow',
      updatedInput: req.input,
      setMode: 'acceptEdits',
    });
    await waitFor(() => eventsOf(client).some((e) => e.type === 'permission.resolved'), 'permission.resolved');
    expect(eventsOf(client).find((e) => e.type === 'permission.resolved')).toMatchObject({
      requestId: req.requestId,
      verdict: 'allow',
      setMode: 'acceptEdits',
    });
    await waitFor(
      () =>
        eventsOf(client).some(
          (e) => e.type === 'session.updated' && e.session.sessionId === sid && e.session.permissionMode === 'acceptEdits',
        ),
      'session.updated(acceptEdits)',
    );
    // 离开等待态后的广播不再带 waitingFor
    const lastUpdated = eventsOf(client).filter((e) => e.type === 'session.updated' && e.session.sessionId === sid).at(-1);
    expect(lastUpdated?.type === 'session.updated' && lastUpdated.session.waitingFor).toBeFalsy();
    // 持久化：下次 resume 按新模式起，而不是又回到 plan
    expect(app.state.sessionParams(sid)?.permissionMode).toBe('acceptEdits');
    client.close();
  });

  test('d3. 「继续规划」：deny 的附言原样回报，模式仍是 plan', async () => {
    const client = await pairAndConnect();
    send(client, { type: 'session.create', reqId: 'q-plan2', cwd: '/tmp', model: 'test-model', permissionMode: 'plan' });
    await waitFor(
      () => eventsOf(client).some((e) => e.type === 'session.create.response' && e.reqId === 'q-plan2'),
      'session.create.response',
    );
    const created = eventsOf(client).find((e) => e.type === 'session.create.response' && e.reqId === 'q-plan2');
    if (created?.type !== 'session.create.response') throw new Error('unreachable');
    const sid = created.session.sessionId;
    send(client, { type: 'input.send', sessionId: sid, clientMsgId: 'c-plan2', text: 'plan:# 计划' });
    await waitFor(() => eventsOf(client).some((e) => e.type === 'permission.request'), 'permission.request');
    const req = eventsOf(client).find((e) => e.type === 'permission.request')!;
    if (req.type !== 'permission.request') throw new Error('unreachable');
    send(client, {
      type: 'permission.respond',
      sessionId: sid,
      requestId: req.requestId,
      verdict: 'deny',
      message: '文件名改成 hi.txt',
    });
    await waitFor(() => eventsOf(client).some((e) => e.type === 'permission.resolved'), 'permission.resolved');
    expect(eventsOf(client).find((e) => e.type === 'permission.resolved')).toMatchObject({
      verdict: 'deny',
      message: '文件名改成 hi.txt',
    });
    expect(app.state.sessionParams(sid)?.permissionMode).toBe('plan');
    client.close();
  });

  test('e. 服务端 sweep 清空留存后继续发 → 不出现 seq_too_far_ahead', async () => {
    const client = await pairAndConnect();
    const sid = await createSession(client);
    await chat(client, sid, 'before-sweep');
    // 把全部 relay 留存清掉（相当于 7 天后）：基线在 stream_hwm 里，不受影响
    const purged = server.hub.sweep(Date.now() + server.config.relayRetentionMs + 1).relayPurged;
    expect(purged).toBeGreaterThan(0);
    expect(server.store.framesSince('mbp', sid, 'a2c', 0, 1000, 'phone')).toHaveLength(0);

    await chat(client, sid, 'after-sweep');
    expect(isStrictlyIncreasing(seqsOf(client, sid))).toBe(true);
    expect(logs.some((l) => l.includes('[outbox]'))).toBe(false);

    // 再叠一次「重启 + 丢 state」：seq 从 1 起、留存为空——旧实现里 MAX 归零后
    // 首帧 1 会被接受成新基线，续帧反而正常；真正致命的是 seq 已过万的老流。
    // 这里用服务端基线断言直接钉住性质：hwm 没有随 sweep 归零
    expect(server.store.maxSeq('mbp', sid, 'a2c', 'phone')).toBe(Math.max(...seqsOf(client, sid)));
    client.close();
  });

  test('f. session.history.request：只回请求方设备；另一台的子流跳号后照常收帧、不被拒', async () => {
    const phone = await pairAndConnect('phone');
    const tablet = await pairAndConnect('tablet');
    const sid = await createSession(phone);
    transcript = [
      {
        type: 'user',
        uuid: 'u-old',
        session_id: sid,
        message: { role: 'user', content: '终端里问过的' },
        parent_tool_use_id: null,
        parent_agent_id: null,
        timestamp: '2026-09-01T00:00:00.000Z',
      } as unknown as SessionMessage,
    ];
    send(phone, { type: 'session.history.request', sessionId: sid, reqId: 'h1' });
    await waitFor(() => eventsOf(phone).some((e) => e.type === 'session.history.response'), 'history 响应');
    const res = eventsOf(phone).find((e) => e.type === 'session.history.response');
    expect(res).toMatchObject({ reqId: 'h1', sessionId: sid, hasMore: false, items: [{ kind: 'user', id: 'u-old', text: '终端里问过的' }] });
    // 没有拉起会话进程之外的副作用：活跃会话数不变（create 那一个）
    expect(app.manager.activeCount).toBe(1);

    // 之后的会话帧两台都收到；tablet 那条子流缺了 history 那一号，服务端不拒
    await chat(phone, sid, 'after');
    await waitFor(
      () => eventsOf(tablet).some((e) => e.type === 'assistant.done' && e.sessionId === sid),
      'tablet 收到 assistant.done',
    );
    await settle(80);
    expect(eventsOf(tablet).some((e) => e.type === 'session.history.response')).toBe(false);
    expect(isStrictlyIncreasing(seqsOf(tablet, sid))).toBe(true);
    const historySeq = phone.ofType('relay').find((f) => f.sessionId === sid && phone.openRelay(f).type === 'session.history.response')!.seq;
    expect(seqsOf(tablet, sid)).not.toContain(historySeq);
    expect(logs.some((l) => l.includes('seq 失配自愈') || l.includes('放弃自愈'))).toBe(false);
    phone.close();
    tablet.close();
  });

  test('优雅退出：关会话时 pending 权限作废帧在断连前发出，state.json 落盘', async () => {
    const client = await pairAndConnect();
    const sid = await createSession(client);
    send(client, { type: 'input.send', sessionId: sid, clientMsgId: 'c-perm', text: 'perm:rm x' });
    await waitFor(() => eventsOf(client).some((e) => e.type === 'permission.request'), 'permission.request');
    // EchoSession.close 不发 invalidated（真 ClaudeSession 会）；这里验证的是
    // stop() 的顺序保证：会话已关、状态已写、连接才断
    await app.stop();
    // 服务端侧的 close 事件是异步到达的
    await waitFor(() => !server.registry.isAgentOnline('mbp'), 'agent 离线');
    const stateFile = await Bun.file(agentPaths(home).state).json();
    expect(stateFile.sessions[sid]).toEqual({
      cwd: '/tmp',
      model: 'test-model',
      permissionMode: 'default',
      started: true,
    });
    expect(stateFile.outSeq[sid]).toBe(Math.max(...seqsOf(client, sid)));
    // 重复 stop 幂等
    await app.stop();
    client.close();
  });

  test('f. 归档 → 永久删除：list 不再出现，对它的 input.send 不复活（重启后同样）', async () => {
    const client = await pairAndConnect();
    const sid = await createSession(client);
    await chat(client, sid, 'hello');
    expect(transcripts.has(sid)).toBe(true);

    send(client, { type: 'session.archive', sessionId: sid, reqId: 'q-arch', archived: true });
    await waitFor(
      () => eventsOf(client).some((e) => e.type === 'session.mutate.response' && e.reqId === 'q-arch'),
      '归档应答',
    );
    const archivedResp = eventsOf(client).find((e) => e.type === 'session.mutate.response' && e.reqId === 'q-arch');
    expect(archivedResp).toMatchObject({ ok: true, targetSessionId: sid });
    expect(archivedResp?.sessionId).toBeUndefined();
    expect(
      eventsOf(client).some(
        (e) => e.type === 'session.updated' && e.session.sessionId === sid && e.session.archived === true,
      ),
    ).toBe(true);

    // 刚跑过的会话转录 mtime 是「刚刚」：删除要求 60s 内没写过
    send(client, { type: 'session.delete', sessionId: sid, reqId: 'q-del-early' });
    await waitFor(
      () => eventsOf(client).some((e) => e.type === 'session.mutate.response' && e.reqId === 'q-del-early'),
      '过早删除的应答',
    );
    expect(
      eventsOf(client).find((e) => e.type === 'session.mutate.response' && e.reqId === 'q-del-early'),
    ).toMatchObject({ ok: false, error: { code: 'busy' } });

    transcripts.backdate(sid, 120_000);
    send(client, { type: 'session.delete', sessionId: sid, reqId: 'q-del' });
    await waitFor(
      () => eventsOf(client).some((e) => e.type === 'session.mutate.response' && e.reqId === 'q-del'),
      '删除应答',
    );
    expect(eventsOf(client).find((e) => e.type === 'session.mutate.response' && e.reqId === 'q-del')).toMatchObject({
      ok: true,
    });
    expect(transcripts.has(sid)).toBe(false);
    const removed = eventsOf(client).filter((e) => e.type === 'session.removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ targetSessionId: sid });
    expect(removed[0]!.sessionId).toBeUndefined();

    const listed = async (reqId: string) => {
      send(client, { type: 'session.list.request', reqId });
      await waitFor(
        () => eventsOf(client).some((e) => e.type === 'session.list.response' && e.reqId === reqId),
        reqId,
      );
      const resp = eventsOf(client).find((e) => e.type === 'session.list.response' && e.reqId === reqId);
      if (resp?.type !== 'session.list.response') throw new Error('unreachable');
      return resp.sessions.map((x) => x.sessionId);
    };
    expect(await listed('q-list-1')).not.toContain(sid);

    // 另一台设备（或 park 队列里的旧帧）照旧发 input.send：不复活、不回 echo
    const zombie = () => {
      send(client, { type: 'input.send', sessionId: sid, clientMsgId: `z-${Date.now()}`, text: 'zombie' });
    };
    zombie();
    await settle(120);
    expect(eventsOf(client).some((e) => e.type === 'assistant.done' && e.text === 'echo: zombie')).toBe(false);
    expect(app.manager.has(sid)).toBe(false);
    expect(eventsOf(client).filter((e) => e.type === 'session.removed')).toHaveLength(2);

    // 重启后：墓碑与 state 清理都落了盘
    await restartAgent();
    expect(app.state.sessionParams(sid)).toBeUndefined();
    zombie();
    await settle(120);
    expect(app.manager.has(sid)).toBe(false);
    expect(eventsOf(client).some((e) => e.type === 'assistant.done' && e.text === 'echo: zombie')).toBe(false);
    expect(await listed('q-list-2')).not.toContain(sid);
    const flagsFile = await Bun.file(agentPaths(home).sessions).json();
    expect(Object.keys(flagsFile.deleted)).toEqual([sid]);
    expect(flagsFile.archived).toEqual({});
    client.close();
  });

  test('f2. 启动 / 每日 sweep 复查墓碑：窗口内的残影删掉；删除后本机续聊过的保留并撤墓碑（N1）', async () => {
    const deletedAt = Date.now() - 3_600_000;
    const shapes = () => {
      // 真实残影：只有 custom-title 行（无 cwd / firstPrompt），mtime ≈ 删除后几秒
      transcripts.write('ghost', { customTitle: '残影', lastModified: deletedAt + 3_000 });
      // 删除后半小时用户在本机终端又用了这个 sid：带真实对话
      transcripts.write('resumed', { cwd: '/tmp', firstPrompt: '接着聊', lastModified: deletedAt + 1_800_000 });
    };
    await app.flags.markDeleted('ghost', deletedAt);
    await app.flags.markDeleted('resumed', deletedAt);
    await app.flags.flush();
    shapes();

    // 启动路径：start() 里不 await 地跑一次 sweepFlags
    await restartAgent();
    await waitFor(() => !transcripts.has('ghost') && !app.flags.isDeleted('resumed'), '启动复查');
    expect(transcripts.has('resumed')).toBe(true);
    expect(app.flags.isDeleted('ghost')).toBe(true);
    expect((await app.manager.list()).map((s) => s.sessionId)).toEqual(['resumed']);
    expect(logs.some((l) => l.includes('resumed') && l.includes('撤掉墓碑'))).toBe(true);
    await app.flags.flush();
    const flagsFile = await Bun.file(agentPaths(home).sessions).json();
    expect(Object.keys(flagsFile.deleted)).toEqual(['ghost']);

    // 每日 sweep 路径：同样的两种形状
    await app.flags.markDeleted('resumed', deletedAt);
    transcripts.write('ghost', { customTitle: '残影', lastModified: deletedAt + 3_000 });
    await app.sweepFlags();
    expect(transcripts.has('ghost')).toBe(false);
    expect(transcripts.has('resumed')).toBe(true);
    expect(app.flags.isDeleted('resumed')).toBe(false);
  });

  test('g. 已归档会话被 run.resumeAt 唤醒 → 自动取消归档并广播', async () => {
    const client = await pairAndConnect();
    const sid = await createSession(client);
    await chat(client, sid, 'before-quota');
    send(client, { type: 'session.archive', sessionId: sid, reqId: 'q-arch', archived: true });
    await waitFor(
      () => eventsOf(client).some((e) => e.type === 'session.mutate.response' && e.reqId === 'q-arch'),
      '归档应答',
    );
    expect(app.flags.archivedAt(sid)).toBeDefined();
    const updatesBefore = eventsOf(client).filter((e) => e.type === 'session.updated').length;

    send(client, { type: 'run.resumeAt', sessionId: sid, at: Date.now() });
    await waitFor(
      () =>
        eventsOf(client).some(
          (e) => e.type === 'assistant.done' && e.sessionId === sid && e.text.includes('自动续跑'),
        ),
      '自动续跑',
    );
    expect(app.flags.archivedAt(sid)).toBeUndefined();
    const updates = eventsOf(client)
      .filter((e) => e.type === 'session.updated')
      .slice(updatesBefore)
      .map((e) => (e.type === 'session.updated' ? e.session : null));
    const running = updates.find((u) => u?.state === 'running');
    expect(running).toBeDefined();
    // 进入 running 的那一帧里就已经不是归档态（同一次广播）
    expect(running!.archived).toBeUndefined();
    // 归档时子进程已回收，唤醒先 resume（广播 live，此时仍是归档态），进入 running 起不再归档
    expect(updates.slice(updates.indexOf(running!)).every((u) => u?.archived === undefined)).toBe(true);
    await app.flags.flush();
    const flagsFile = await Bun.file(agentPaths(home).sessions).json();
    expect(flagsFile.archived).toEqual({});
    client.close();
  });

  test('h. 远程 claude update：用解析出的路径跑 update，先广播新版本 machine.info 再回应答', async () => {
    const commands: string[][] = [];
    const versions = ['2.1.251 (Claude Code)', '2.1.282 (Claude Code)'];
    const procOf = (stdout: string, code: number): SpawnedProcess => ({
      stdout: new Response(stdout).body!,
      stderr: new Response('').body!,
      exited: Promise.resolve(code),
      kill: () => {},
    });
    await app.stop();
    app = await createApp({
      whichFn: (cmd) => (cmd === 'claude' ? '/home/u/.local/bin/claude' : null),
      spawnFn: (cmd) => {
        commands.push(cmd);
        return cmd[1] === 'update'
          ? procOf('Successfully updated from 2.1.251 to version 2.1.282\n', 0)
          : procOf(`${versions.shift() ?? ''}\n`, 0);
      },
    });
    const client = await pairAndConnect();
    send(client, { type: 'machine.claude.update.request', reqId: 'q-upd' });
    await waitFor(
      () => eventsOf(client).some((e) => e.type === 'machine.claude.update.response'),
      'claude update 应答',
    );
    const events = eventsOf(client);
    const respIdx = events.findIndex((e) => e.type === 'machine.claude.update.response');
    const resp = events[respIdx];
    expect(resp).toMatchObject({
      reqId: 'q-upd',
      ok: true,
      fromVersion: '2.1.251 (Claude Code)',
      toVersion: '2.1.282 (Claude Code)',
      output: 'Successfully updated from 2.1.251 to version 2.1.282',
    });
    expect(resp?.sessionId).toBeUndefined();
    const infoIdx = events.findIndex(
      (e) => e.type === 'machine.info' && e.info.claudeVersion === '2.1.282 (Claude Code)',
    );
    expect(infoIdx).toBeGreaterThanOrEqual(0);
    expect(infoIdx).toBeLessThan(respIdx);
    expect(commands).toEqual([
      ['/home/u/.local/bin/claude', '--version'],
      ['/home/u/.local/bin/claude', 'update'],
      ['/home/u/.local/bin/claude', '--version'],
    ]);
    expect(app.machineInfo()).toMatchObject({ agentVersion: '0.11.0', claudeVersion: '2.1.282 (Claude Code)' });
    client.close();
  });
});

import { createInvitation } from '../../../server/src/auth/invitations.ts';
/**
 * in-process e2e：真 `startServer` + 真 `startEchoAgent`（假 ClaudeSession）+ 本 lib
 * （内存适配器、真 WebSocket、真时钟）。验的是「服务端 + agent + web 协议层」
 * 这条链的行为，而不是单个模块。
 *
 *   ① 配对 → 换 token → hello → 收 machine.info
 *   ② input.send → user.message 回显命中本地条目 + assistant.done
 *   ③ 权限往返（EchoSession 的 perm: 前缀）
 *   ④ 断线重连补发且 live 帧抢先：不丢不重、顺序正确
 *   ⑤ 刷新（新实例复用存储）后历史仍在，游标 := 时间线 lastAppliedSeq
 *   ⑥ reject 自愈：outSeq 人为归零 → not_monotonic → 跳号重发 → agent 收到
 *   ⑦ 两个实例共用存储只有一个成为主
 *   ⑪–⑬ 会话元数据命令（session-list-v2）：rename / 归档跨设备同步 / 永久删除级联清理
 *
 * @trine/agent / @trine/server 以 devDependency 引入（无 exports 字段，直接引源文件路径）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sodiumReady } from '@trine/core/crypto';
import type { TransportFrame } from '@trine/core';
import { startEchoAgent, type EchoAgent, type StartEchoAgentOptions } from '@trine/agent/src/testing/echo-session.ts';
import { FakeTranscripts } from '@trine/agent/src/testing/fake-transcripts.ts';
import { startServer, type TrineServer } from '@trine/server/src/server.ts';
import {
  MemoryChannelHub,
  MemoryDocStore,
  MemoryKv,
  MemoryLockRegistry,
  systemClock,
  type SocketFactory,
  type SocketLike,
} from './adapters.ts';
import { DEFAULT_LIST_QUERY, filterSessions } from '../components/list/filtering.ts';

// 会话 cwd 在系统临时目录下（测试约定），默认会被当成临时会话隐藏
const LIST_QUERY = { ...DEFAULT_LIST_QUERY, showTemp: true };
import { supportsSessionMutations } from '../components/list/session-actions.ts';
import { SessionMutateError, TrineClient } from './client.ts';
import { LeaderElector } from './leader.ts';
import { shouldAutoLoadHistory, type PermissionEntry, type TimelineEntry, type UserEntry } from './reducer.ts';
import { KV_PEER, type PeerState } from './storage.ts';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let server: TrineServer;
let home: string;
let agent: EchoAgent;
let agentLogs: string[];
let kv: MemoryKv;
let docs: MemoryDocStore;
let clientLogs: string[];
let client: TrineClient;
let sockets: ControlledSockets;
// web 不直接依赖 SDK：转录行类型从 echo agent 的注入点推出来
type GetSessionMessages = NonNullable<StartEchoAgentOptions['getSessionMessagesFn']>;
type SessionMessage = Awaited<ReturnType<GetSessionMessages>>[number];
/** 假本机转录（agent 的 getSessionMessages 读它）：sessionId → 行 */
let transcripts: Record<string, SessionMessage[]>;
type CommandsQuery = NonNullable<StartEchoAgentOptions['commandsQueryFn']>;
/** 假斜杠命令探测：记下每次探测的 cwd 与是否被关闭 */
let probes: { cwd: string | undefined; closed: boolean }[];
const fakeCommandsQuery = ((params: { options?: { cwd?: string } }) => {
  const probe = { cwd: params.options?.cwd, closed: false };
  probes.push(probe);
  return {
    supportedCommands: async () => [
      { name: 'babysit-pr', description: 'Monitor a GitHub PR', argumentHint: '' },
      { name: 'compact', description: '', argumentHint: '' },
    ],
    close: () => {
      probe.closed = true;
    },
  };
}) as unknown as CommandsQuery;

/**
 * 包一层真 WebSocket：记录每条连接、允许测试主动切断、允许按谓词扣住出站帧
 * （构造「live 帧先于 sync 补发到达」的时序）。
 */
class ControlledSockets {
  readonly connections: WebSocket[] = [];
  /** 返回 true 的帧被扣住，直到 release() */
  hold: ((frame: TransportFrame) => boolean) | null = null;
  #held: { ws: WebSocket; data: string }[] = [];

  readonly create: SocketFactory = (url) => {
    const ws = new WebSocket(url);
    this.connections.push(ws);
    const wrapper: SocketLike = {
      send: (data) => {
        const frame = JSON.parse(data) as TransportFrame;
        if (this.hold?.(frame)) {
          this.#held.push({ ws, data });
          return;
        }
        ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
      addEventListener: (type: string, fn: (ev: never) => void) => {
        ws.addEventListener(type, fn as never);
      },
    };
    return wrapper;
  };

  get current(): WebSocket {
    return this.connections[this.connections.length - 1]!;
  }

  release(): void {
    for (const item of this.#held.splice(0)) {
      if (item.ws.readyState === WebSocket.OPEN) item.ws.send(item.data);
    }
    this.hold = null;
  }

  get heldCount(): number {
    return this.#held.length;
  }
}

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'trine-web-e2e-'));
  agentLogs = [];
  clientLogs = [];
  transcripts = {};
  probes = [];
  server = await startServer({
    port: 0,
    hostname: '127.0.0.1',
    dbPath: ':memory:',
    allowOpenRegistration: false,
    heartbeatIntervalMs: 60_000,
    sweepIntervalMs: 60_000,
    blobDir: join(home, 'relay-blobs'),
  });
  agent = await startEchoAgent({
    serverUrl: `http://127.0.0.1:${server.port}`,
    getInvitation: async () => createInvitation(server.store).token,
    home,
    machineId: 'mbp',
    log: (l) => agentLogs.push(l),
    getSessionMessagesFn: (async (sid: string) => transcripts[sid] ?? []) as GetSessionMessages,
    commandsQueryFn: fakeCommandsQuery,
  });
  await waitFor(() => agent.app.node.online, 'agent 接入');
  kv = new MemoryKv();
  docs = new MemoryDocStore();
  sockets = new ControlledSockets();
  client = await newClient();
});

afterEach(async () => {
  client.stop();
  await agent.stop();
  await server.stop();
  await rm(home, { recursive: true, force: true });
});

async function newClient(
  store: { kv: MemoryKv; docs: MemoryDocStore; sockets: ControlledSockets } = { kv, docs, sockets },
): Promise<TrineClient> {
  return TrineClient.create({
    kv: store.kv,
    docs: store.docs,
    createSocket: store.sockets.create,
    clock: systemClock,
    random: () => 0, // 退避固定 1s
    persistDebounceMs: 20,
    log: (l) => clientLogs.push(l),
    // bun 里没有 XMLHttpRequest：附件上传换成 fetch
    uploadBlob: async ({ url, token, body }) => {
      const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
  });
}

/** 轮询到谓词为真；谓词可以是异步的（等落盘这类要 await 的判据） */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待「${label}」超时`);
    await Bun.sleep(10);
  }
}

const settle = (ms = 60) => Bun.sleep(ms);

/** 走完整配对：QR → SAS → agent 确认 → authenticate → completePairing → 接入 */
async function pair(c: TrineClient = client, s: ControlledSockets = sockets): Promise<string> {
  const session = agent.app.node.startPairing();
  const flow = c.createPairingFlow({
    createSocket: s.create,
    clock: systemClock,
    retryMs: 100,
  });
  const snap = flow.prepare(session.payload);
  expect(snap.phase).toBe('ready');
  expect(snap.machineId).toBe('mbp');
  flow.start();
  await waitFor(() => agent.app.node.pairing.get(session.pairingToken)?.pending !== null, 'pair.begin 到达 agent');
  // agent 侧比对 SAS：两端必须一致
  const peer = agent.app.node.pairing.get(session.pairingToken)!.pending!;
  expect(peer.sas).toEqual(snap.sas!);
  await agent.app.confirmPairing(session.pairingToken);
  await waitFor(() => flow.phase === 'done', 'pairing done（authenticate 成功）');
  const result = flow.snapshot().result!;
  expect(result.token.token).toBeTruthy();
  const machineId = await c.completePairing(result);
  c.start();
  await waitFor(() => c.connection.status === 'open', 'client open');
  return machineId;
}

async function createSession(): Promise<string> {
  const meta = await client.createSession('mbp', { cwd: '/tmp', model: 'test-model', permissionMode: 'default' });
  return meta.sessionId;
}

function entries(sid: string): TimelineEntry[] {
  return client.timeline('mbp', sid).entries;
}

function userEntry(sid: string, clientMsgId: string): UserEntry | undefined {
  return entries(sid).find((e): e is UserEntry => e.kind === 'user' && e.id === clientMsgId);
}

/** 发一句话并等 echo 回来 */
async function chat(sid: string, text: string): Promise<string> {
  const id = client.sendInput('mbp', sid, text);
  await waitFor(
    () => entries(sid).some((e) => e.kind === 'assistant' && e.done && e.text === `echo: ${text}`),
    `echo: ${text}`,
  );
  return id;
}

function isStrictlyIncreasing(seqs: number[]): boolean {
  return seqs.every((s, i) => i === 0 || s > seqs[i - 1]!);
}

// ---------------------------------------------------------------------------

describe('web lib · in-process e2e', () => {
  test('① 配对 → 换 token → hello → 收 machine.info 与在线状态', async () => {
    const machineId = await pair();
    expect(machineId).toBe('mbp');
    expect(client.isPaired).toBe(true);
    // machine.info 是配对确认时补发的，靠机器级 sinceSeq 0 同步拿到
    await waitFor(() => client.machine('mbp')?.info !== null, 'machine.info');
    expect(client.machine('mbp')).toMatchObject({ online: true, info: { name: 'Test MBP', claudeVersion: 'test' }, name: 'Test MBP' });
    // peer 已落盘（token + 机器 + 机器级游标；落盘有 20ms 去抖）
    await settle(100);
    const stored = JSON.parse(kv.get(KV_PEER)!) as PeerState;
    expect(stored.machines['mbp']?.agentBoxPubKey).toBeTruthy();
    expect(stored.authToken?.token).toBeTruthy();
    expect(stored.machines['mbp']?.inCursors['']).toBeGreaterThan(0);
  }, 15_000);

  test('② input.send → user.message 回显命中本地条目 + assistant.done + run.done', async () => {
    await pair();
    const sid = await createSession();
    expect(Object.keys(client.sessions('mbp'))).toEqual([sid]);
    const id = await chat(sid, 'hello');
    // `chat()` 只等到 assistant.done，而 `run_done` 与收尾的 `run_state` 是
    // **后续独立帧**——它们还没到时直接断言数组就会短一截（既有 flake，
    // 评审 N14）。等齐再断言，不用 sleep 赌时序。
    await waitFor(() => entries(sid).some((e) => e.kind === 'run_done'), 'run_done');
    await waitFor(() => client.timeline('mbp', sid).state === 'idle', '收尾 run_state → idle');
    const kinds = entries(sid).map((e) => e.kind);
    expect(kinds).toEqual(['user', 'run_state', 'assistant', 'run_done', 'run_state']);
    expect(userEntry(sid, id)).toMatchObject({ status: 'confirmed', local: true, text: 'hello' });
    expect(entries(sid).filter((e) => e.kind === 'user')).toHaveLength(1); // 回显没变成第二条
    expect(client.sessions('mbp')[sid]?.state).toBe('idle');
    // 时间线已落盘（落盘有 20ms 去抖；等落到位而不是 sleep 一个余量）
    const lastAppliedSeq = client.timeline('mbp', sid).lastAppliedSeq;
    await waitFor(
      async () => ((await docs.get(`timeline:mbp/${sid}`)) as { lastAppliedSeq?: number } | undefined)?.lastAppliedSeq === lastAppliedSeq,
      '时间线落盘到最新 seq',
    );
  }, 15_000);

  test('③ 权限往返：permission.request 卡 → allow → resolved（resolvedBy=本设备）→ 完成', async () => {
    await pair();
    const sid = await createSession();
    client.sendInput('mbp', sid, 'perm:touch /tmp/x');
    await waitFor(() => entries(sid).some((e) => e.kind === 'permission'), 'permission.request');
    const perm = entries(sid).find((e): e is PermissionEntry => e.kind === 'permission')!;
    expect(perm).toMatchObject({ state: 'pending', toolName: 'Bash', input: { command: 'touch /tmp/x' } });
    expect(client.timeline('mbp', sid).state).toBe('waiting_permission');
    client.respondPermission('mbp', sid, perm.id, 'allow');
    await waitFor(() => entries(sid).some((e) => e.kind === 'assistant' && e.text === 'echo: permission allow'), '权限后的 echo');
    expect(entries(sid).find((e) => e.kind === 'permission')).toMatchObject({
      state: 'resolved',
      verdict: 'allow',
      resolvedBy: client.deviceId,
    });
    expect(entries(sid).filter((e) => e.kind === 'permission')).toHaveLength(1);
  }, 15_000);

  test('③b 改参数后批准：实际批准的参数落进条目，刷新后仍在（验收 5）', async () => {
    await pair();
    const sid = await createSession();
    client.sendInput('mbp', sid, 'perm:rm -rf /tmp/x');
    await waitFor(() => entries(sid).some((e) => e.kind === 'permission'), 'permission.request');
    const perm = entries(sid).find((e): e is PermissionEntry => e.kind === 'permission')!;
    expect(perm.input).toEqual({ command: 'rm -rf /tmp/x' });

    // 用户改参数后批准——真正执行的是改后的值
    const approved = { command: 'ls -la /tmp/x' };
    client.respondPermission('mbp', sid, perm.id, 'allow', { updatedInput: approved });
    await waitFor(
      () => entries(sid).find((e): e is PermissionEntry => e.kind === 'permission')?.state === 'resolved',
      'permission.resolved',
    );

    // 早先 permission.resolved 帧里根本没有 updatedInput，条目上也没处放——
    // 卡片显示的「编辑后的值」只是编辑期间的本地组件 state，刷新即丢，
    // 别的设备更是从来看不到实际批准了什么（验收 5）
    const resolved = entries(sid).find((e): e is PermissionEntry => e.kind === 'permission')!;
    expect(resolved.approvedInput).toEqual(approved);
    expect(resolved.input).toEqual({ command: 'rm -rf /tmp/x' }); // 原始请求原样保留

    // 刷新（新实例复用存储）后仍在
    const lastAppliedSeq = client.timeline('mbp', sid).lastAppliedSeq;
    await waitFor(
      async () => ((await docs.get(`timeline:mbp/${sid}`)) as { lastAppliedSeq?: number } | undefined)?.lastAppliedSeq === lastAppliedSeq,
      '时间线落盘',
    );
    client.stop();
    const fresh = await newClient();
    try {
      const after = fresh
        .timeline('mbp', sid)
        .entries.find((e): e is PermissionEntry => e.kind === 'permission')!;
      expect(after.approvedInput).toEqual(approved);
      expect(after.input).toEqual({ command: 'rm -rf /tmp/x' });
    } finally {
      fresh.stop();
    }
  }, 15_000);

  test('④ 断线重连补发且 live 帧抢先：时间线不丢不重、顺序正确', async () => {
    await pair();
    const sid = await createSession();
    await chat(sid, 'before');
    const before = entries(sid).length;
    const seqBefore = client.timeline('mbp', sid).lastAppliedSeq;

    // 切断 client 连接；期间 agent 产出 3 帧（服务端只留存，投不出去）
    sockets.current.close();
    await waitFor(() => client.connection.status === 'backoff', '进入退避');
    for (let i = 0; i < 3; i++) agent.app.emitter.emit({ type: 'run.state', state: 'idle', detail: `offline-${i}` }, sid);
    await settle();
    expect(entries(sid).length).toBe(before);

    // 重连时扣住对 sid 的 sync.request，让一条 live 帧先到
    sockets.hold = (f) => f.type === 'sync.request' && f.sessionId === sid;
    await waitFor(() => client.connection.status === 'open', '重连 open', 5_000);
    await waitFor(() => sockets.heldCount === 1, 'sync.request 被扣住');
    agent.app.emitter.emit({ type: 'run.state', state: 'idle', detail: 'live-first' }, sid);
    await settle(150);
    // live 帧到了但该 scope 在同步中：暂存，时间线未动、游标未动
    expect(entries(sid).length).toBe(before);
    expect(client.timeline('mbp', sid).lastAppliedSeq).toBe(seqBefore);
    // 放行 sync.request → 服务端补发 3 帧 + sync.done → 合并放行
    sockets.release();
    await waitFor(() => entries(sid).length === before + 4, '补发 + live 合并到齐');
    const details = entries(sid)
      .slice(before)
      .map((e) => (e.kind === 'run_state' ? e.detail : e.kind));
    expect(details).toEqual(['offline-0', 'offline-1', 'offline-2', 'live-first']);
    const seqs = entries(sid).map((e) => e.seq).filter((s) => s > 0);
    expect(isStrictlyIncreasing(seqs)).toBe(true);
    // 同步结束后 live 帧直通
    agent.app.emitter.emit({ type: 'run.state', state: 'idle', detail: 'after' }, sid);
    await waitFor(() => entries(sid).length === before + 5, 'after');
    expect(entries(sid).filter((e) => e.kind === 'run_state' && e.detail === 'live-first')).toHaveLength(1);
  }, 20_000);

  test('⑤ 刷新：新实例复用同一存储后历史仍在；游标 := 时间线 lastAppliedSeq；重同步不重复', async () => {
    await pair();
    const sid = await createSession();
    await chat(sid, 'persist-me');
    const snapshot = entries(sid);
    const lastSeq = client.timeline('mbp', sid).lastAppliedSeq;
    client.stop(); // 落盘

    // 模拟「旧主标签最后一笔落了个偏低游标」：把存储里的会话游标改小
    const stored = JSON.parse(kv.get(KV_PEER)!) as PeerState;
    stored.machines['mbp']!.inCursors[sid] = 1;
    kv.set(KV_PEER, JSON.stringify(stored));

    const fresh = await newClient();
    try {
      expect(fresh.timeline('mbp', sid).entries).toEqual(snapshot);
      expect(fresh.peer?.machines['mbp']?.inCursors[sid]).toBe(lastSeq);
      fresh.start();
      await waitFor(() => fresh.connection.status === 'open', '刷新后 open');
      await settle(200);
      // 按时间线游标同步，服务端无新帧 → 一条都不重复
      expect(fresh.timeline('mbp', sid).entries).toEqual(snapshot);
      // 会话列表已落盘（machine 快照），刷新后先出持久化的，再被 session.list.response 覆盖
      expect(Object.keys(fresh.sessions('mbp'))).toEqual([sid]);
      await fresh.listSessions('mbp');
      expect(Object.keys(fresh.sessions('mbp'))).toEqual([sid]);
      // 刷新后继续聊仍正常（outSeq 也持久化了，不撞 not_monotonic）
      const id = fresh.sendInput('mbp', sid, 'again');
      await waitFor(() => fresh.timeline('mbp', sid).entries.some((e) => e.kind === 'assistant' && e.text === 'echo: again'), 'echo: again');
      expect(fresh.timeline('mbp', sid).entries.find((e) => e.kind === 'user' && e.id === id)).toMatchObject({ status: 'confirmed' });
      expect(clientLogs.some((l) => l.includes('[outbox]'))).toBe(false);
    } finally {
      fresh.stop();
    }
  }, 20_000);

  test('⑥ reject 自愈：outSeq 人为归零 → seq_not_monotonic → 跳号重发成功且 agent 收到', async () => {
    await pair();
    const sid = await createSession();
    await chat(sid, 'one');
    const hwm = server.store.maxSeq('mbp', sid, 'c2a', undefined)!;
    expect(hwm).toBeGreaterThan(0);

    client.resetOutSeq('mbp', sid);
    expect(client.peer?.machines['mbp']?.outSeq[sid]).toBe(0);
    const id = await chat(sid, 'healed');
    expect(userEntry(sid, id)).toMatchObject({ status: 'confirmed' });
    expect(clientLogs.some((l) => l.includes('[outbox] seq 失配自愈'))).toBe(true);
    expect(clientLogs.some((l) => l.includes('放弃自愈'))).toBe(false);
    // 重发帧的 seq 接在服务端高水位之后，且只有一份 user.message 回显
    expect(server.store.maxSeq('mbp', sid, 'c2a', undefined)).toBe(hwm + 1);
    expect(entries(sid).filter((e) => e.kind === 'user' && e.text === 'healed')).toHaveLength(1);
    // 之后不再撞
    const before = clientLogs.length;
    await chat(sid, 'two');
    expect(clientLogs.slice(before).some((l) => l.includes('[outbox]'))).toBe(false);
  }, 20_000);

  test('⑦ 两个实例共用存储：只有一个成为主，只有主建连接', async () => {
    await pair();
    const locks = new MemoryLockRegistry();
    const hub = new MemoryChannelHub();
    const states = new Map<string, string>();
    const mk = (id: string) =>
      new LeaderElector({
        locks: locks.adapter(),
        channel: hub.channel(),
        clock: systemClock,
        instanceId: id,
        onChange: (s) => void states.set(s.instanceId, s.state),
      });
    // 第一个标签页（已在跑的 client）
    const a = mk('tab-a');
    a.start();
    await settle();
    expect(a.state).toBe('leader');
    // 第二个标签页：同一份存储、自己的 client 实例——只有当选才 start
    const b = mk('tab-b');
    const second = await newClient();
    const connectionsBefore = sockets.connections.length;
    b.start();
    await settle();
    expect(b.state).toBe('follower');
    expect(second.isPaired).toBe(true); // 状态可读
    if (b.state === 'leader') second.start(); // 不会执行
    expect(sockets.connections.length).toBe(connectionsBefore);
    // 接管：a 让位、b 上位；应用层据此 stop 旧 client、start 新 client
    b.takeOver();
    await waitFor(() => b.state === 'leader' && a.state === 'follower', '接管');
    client.stop();
    second.start();
    await waitFor(() => second.connection.status === 'open', '新主 open');
    expect(sockets.connections.length).toBe(connectionsBefore + 1);
    second.stop();
    a.stop();
    b.stop();
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 机器快照落盘（machine.info + SessionMeta）
//
// 两者是同一个缺陷的两面：机器级快照只活在内存里，而机器级游标已经越过了
// 携带它们的那几帧。刷新页面后 client 以新游标重新同步，服务端「你已是最新」
// 什么也不补，于是 info 永远是 null（机器卡「agent 未知」）、会话列表 0 行——
// 直到 agent 下次重连在 #onOpen 重新广播一遍。真链路上表现为「重启 agent 才正常」。
// ---------------------------------------------------------------------------
describe('web lib · 机器快照落盘', () => {
  test('⑧ 刷新后 machine.info 仍在（游标已越过该帧，服务端不会再补）', async () => {
    await pair();
    await waitFor(() => client.machine('mbp')?.info != null, 'machine.info 到达');
    const info = client.machine('mbp')!.info;
    // 机器级游标已越过 machine.info 那一帧：重新同步不会再补
    const cursor = client.peer?.machines['mbp']?.inCursors[''] ?? 0;
    expect(cursor).toBeGreaterThan(0);
    client.stop();
    await settle(100);

    const fresh = await newClient();
    try {
      // 加载即有（不依赖任何网络）
      expect(fresh.machine('mbp')?.info).toEqual(info);
      expect(fresh.machine('mbp')?.name).toBe('Test MBP');
      fresh.start();
      await waitFor(() => fresh.connection.status === 'open', '刷新后 open');
      await settle(200);
      // 重新同步一无所获，但 info 没被冲掉
      expect(fresh.machine('mbp')?.info).toEqual(info);
    } finally {
      fresh.stop();
    }
  }, 20_000);

  test('⑨ 刷新后会话列表仍在且按活跃度降序；机器离线也照常渲染', async () => {
    await pair();
    const a = await createSession();
    await chat(a, 'first');
    const b = await createSession();
    await chat(b, 'second');
    const listed = await client.listSessions('mbp');
    expect(listed.length).toBe(2);
    client.stop();
    await settle(100);

    // agent 离线：刷新后拉不到 session.list，只能靠落盘
    await agent.stop();
    const fresh = await newClient();
    try {
      const sessions = fresh.sessions('mbp');
      expect(Object.keys(sessions).sort()).toEqual([a, b].sort());
      // 元信息完整（不是只剩 lastActivityAt）
      expect(sessions[b]).toMatchObject({ sessionId: b, cwd: '/tmp', model: 'test-model', permissionMode: 'default' });
      // 排序：b 后活跃，应排在 a 前
      const byActivity = Object.values(sessions).sort((x, y) => y.lastActivityAt - x.lastActivityAt);
      expect(byActivity[0]?.sessionId).toBe(b);
      // 离线机器仍可进会话看历史
      expect(fresh.timeline('mbp', a).entries.length).toBeGreaterThan(0);
    } finally {
      fresh.stop();
    }
  }, 25_000);
});

describe('web lib · 重置机器游标（M7）', () => {
  test('⑩ 按「持久化会话 ∪ 已加载时间线」迭代，刷新后（store 为空）也全覆盖', async () => {
    await pair();
    const a = await createSession();
    await chat(a, 'one');
    const b = await createSession();
    await chat(b, 'two');
    await client.listSessions('mbp');
    // 两条会话流与机器级流的游标都已推进
    const mp0 = client.peer!.machines['mbp']!;
    expect(mp0.inCursors[a]).toBeGreaterThan(0);
    expect(mp0.inCursors[b]).toBeGreaterThan(0);
    expect(mp0.inCursors['']).toBeGreaterThan(0);
    client.stop();
    await settle(100);

    // 「服务端库被删 → 用户刷新页面」：新实例没有拉过 session.list。
    // 这正是这个按钮的适用场景，早先 UI 按 store.sessions 迭代会漏掉会话流。
    const fresh = await newClient();
    try {
      const mp = fresh.peer!.machines['mbp']!;

      // 造出三个**互不重合**的来源（评审 N6 附带：早先只迭代 mp.sessions
      // 一样能过，因为 #loadTimelines 会把时间线回填进 mp.sessions）：
      //   - a：只在 mp.sessions 里（把它的时间线从内存里摘掉）
      //   - b：只在已加载的时间线里（把它从 mp.sessions 里摘掉）
      //   - c：只在 #openSessions 里（openSession 之后再从 mp.sessions 摘掉，
      //        它既没有时间线 doc 也不在持久化的 sessions 里）
      const c = 'sess-open-only';
      fresh.openSession('mbp', c);
      delete mp.sessions[c];
      delete mp.sessions[b];
      // a 留在 mp.sessions 里（同时也有时间线）；靠「b 只在时间线、
      // c 只在 openSessions」两条就足以钉住并集——漏掉任何一个来源，
      // count 与游标断言都会掉下来。
      expect(mp.sessions[a]).toBeDefined();
      expect(fresh.timeline('mbp', b).entries.length).toBeGreaterThan(0);
      expect(mp.sessions[b]).toBeUndefined();
      expect(mp.sessions[c]).toBeUndefined();

      // 落盘次数：循环内逐 scope 全量序列化 PeerState 是 O(n) 次同步写，
      // 真机 339 会话时主线程冻结数秒（评审 N6）。批量之后应当是常数次。
      const writesBefore = kv.writes;
      const count = fresh.resetMachineCursors('mbp');
      const writes = kv.writes - writesBefore;

      expect(count).toBe(4); // a（peer.sessions）+ b（时间线）+ c（openSessions）+ 机器级
      expect(mp.inCursors[a]).toBe(0);
      expect(mp.inCursors[b]).toBe(0);
      expect(mp.inCursors[c]).toBe(0);
      expect(mp.inCursors['']).toBe(0);
      // 旧纪元条目会与新序号撞车，会话时间线一并清空
      expect(fresh.timeline('mbp', a).entries).toEqual([]);
      expect(fresh.timeline('mbp', b).entries).toEqual([]);
      // #savePeerNow(true) 是 clear + set 两次 kv 操作，批量后只做一轮
      expect(writes).toBeLessThanOrEqual(2);
    } finally {
      fresh.stop();
    }
  }, 25_000);
});

// ---------------------------------------------------------------------------
// 会话元数据命令（session-list-v2 §4.7：① rename、② 归档跨设备、③ 删除级联）
// ---------------------------------------------------------------------------

describe('web lib · 会话重命名 / 归档 / 永久删除（session-list-v2）', () => {
  let transcripts: FakeTranscripts;
  /** 第二台模拟设备（独立存储、独立连接） */
  let other: TrineClient | null;

  beforeEach(async () => {
    // 换一个带内存转录目录的 agent：rename / delete 要作用在「转录」上
    await agent.stop();
    transcripts = new FakeTranscripts();
    agent = await startEchoAgent({
      serverUrl: `http://127.0.0.1:${server.port}`,
      getInvitation: async () => createInvitation(server.store).token,
      home,
      machineId: 'mbp',
      log: (l) => agentLogs.push(l),
      transcripts,
    });
    await waitFor(() => agent.app.node.online, 'agent（带转录）接入');
    other = null;
  });

  afterEach(() => {
    other?.stop();
  });

  async function pairOther(): Promise<TrineClient> {
    const otherSockets = new ControlledSockets();
    other = await newClient({ kv: new MemoryKv(), docs: new MemoryDocStore(), sockets: otherSockets });
    await pair(other, otherSockets);
    await waitFor(() => other!.machine('mbp')?.info !== null, '第二台设备收到 machine.info');
    return other;
  }

  test('⑪ rename → 本设备列表标题变更；agent ≥ 0.2.0 通过能力探测', async () => {
    await pair();
    await waitFor(() => client.machine('mbp')?.info !== null, 'machine.info');
    expect(supportsSessionMutations(client.machine('mbp')?.info)).toBe(true);
    const sid = await createSession();
    await chat(sid, 'hello');
    await client.listSessions('mbp');

    await client.renameSession('mbp', sid, '  新的标题\u0007  ');
    // 应答之前 agent 已在同一条机器级流上广播 session.updated：resolve 时已落地
    expect(client.sessions('mbp')[sid]?.title).toBe('新的标题');
    expect(transcripts.info(sid)?.customTitle).toBe('新的标题');
    const rows = filterSessions({ mbp: client.sessions('mbp') }, LIST_QUERY).rows;
    expect(rows.map((r) => r.meta.title)).toEqual(['新的标题']);

    // 规范化后为空 → agent 的 invalid 原话
    const err = await client.renameSession('mbp', sid, '   ').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionMutateError);
    expect((err as SessionMutateError).code).toBe('invalid');
  }, 20_000);

  test('⑫ 归档后另一台设备收到 session.updated：默认列表隐藏、归档视图可见；取消归档回来', async () => {
    await pair();
    const b = await pairOther();
    const sid = await createSession();
    await chat(sid, 'hello');
    await client.listSessions('mbp');
    await b.listSessions('mbp');
    expect(filterSessions({ mbp: b.sessions('mbp') }, LIST_QUERY).rows).toHaveLength(1);

    await client.archiveSession('mbp', sid, true);
    await waitFor(() => b.sessions('mbp')[sid]?.archived === true, '另一台设备收到归档');
    const view = (archived: boolean) =>
      filterSessions({ mbp: b.sessions('mbp') }, { ...LIST_QUERY, archived }).rows.map((r) => r.meta.sessionId);
    expect(view(false)).toEqual([]);
    expect(filterSessions({ mbp: b.sessions('mbp') }, LIST_QUERY).empty).toBe('all-archived');
    expect(view(true)).toEqual([sid]);

    await client.archiveSession('mbp', sid, false);
    await waitFor(() => b.sessions('mbp')[sid]?.archived !== true, '另一台设备收到取消归档');
    expect(view(false)).toEqual([sid]);
  }, 25_000);

  test('⑬ 永久删除：两台设备都清掉 sessions / 时间线 / 游标；再对它发请求得到 deleted 而不是复活', async () => {
    await pair();
    const b = await pairOther();
    const sid = await createSession();
    await chat(sid, 'hello');
    await client.listSessions('mbp');
    await b.listSessions('mbp');
    b.openSession('mbp', sid);
    await waitFor(() => b.timeline('mbp', sid).entries.length > 0, '另一台设备同步到时间线');

    // 未归档不许删（协议层兜底）
    const early = await client.deleteSession('mbp', sid).catch((e: unknown) => e);
    expect((early as SessionMutateError).code).toBe('not_archived');

    await client.archiveSession('mbp', sid, true);
    transcripts.backdate(sid, 120_000); // 删除有「60s 内写过则拒绝」的前置检查
    const removedOnB: string[] = [];
    b.on('sessionRemoved', (_m, s) => void removedOnB.push(s));

    await client.deleteSession('mbp', sid);
    expect(transcripts.has(sid)).toBe(false);
    expect(client.sessions('mbp')[sid]).toBeUndefined();
    expect(client.timeline('mbp', sid).entries).toHaveLength(0);
    expect(client.peer?.machines['mbp']?.inCursors[sid]).toBeUndefined();

    await waitFor(() => removedOnB.includes(sid), '另一台设备收到 session.removed');
    expect(b.sessions('mbp')[sid]).toBeUndefined();
    expect(b.timeline('mbp', sid).entries).toHaveLength(0);
    expect(b.peer?.machines['mbp']?.sessions[sid]).toBeUndefined();

    // 列表刷新也不再出现
    expect((await client.listSessions('mbp')).map((s) => s.sessionId)).not.toContain(sid);
    // 墓碑：任何带 reqId 的请求都回 deleted（视同 removed，不复活）
    const status = await client.request('mbp', { type: 'session.status.request', sessionId: sid }).catch((e: unknown) => e);
    expect((status as SessionMutateError).code).toBe('deleted');
    expect(client.sessions('mbp')[sid]).toBeUndefined();
  }, 30_000);

  test('⑭ 离线设备重连：先回放到机器流的 removed，随后的会话 scope 回放帧不重建时间线 / peer.sessions；深链也打不开（CM1）', async () => {
    await pair();
    const bStore = { kv: new MemoryKv(), docs: new MemoryDocStore(), sockets: new ControlledSockets() };
    const b = await newClient(bStore);
    other = b;
    await pair(b, bStore.sockets);
    const sid = await createSession();
    await chat(sid, 'hello');
    await b.listSessions('mbp');
    b.openSession('mbp', sid);
    await waitFor(() => b.timeline('mbp', sid).entries.length > 0, 'B 同步到时间线');
    b.closeSession('mbp', sid);

    // B 离线期间：A 继续聊几轮，然后归档 + 永久删除
    b.stop();
    await chat(sid, 'while b offline');
    await client.archiveSession('mbp', sid, true);
    transcripts.backdate(sid, 120_000);
    await client.deleteSession('mbp', sid);

    const timelineEvents: string[] = [];
    b.on('timeline', (_m, s) => void timelineEvents.push(s));
    const removedOnB: string[] = [];
    b.on('sessionRemoved', (_m, s) => void removedOnB.push(s));
    b.start();
    await waitFor(() => removedOnB.includes(sid), 'B 重连收到 session.removed');
    // 等会话 scope 的回放也处理完（B 重连时还不知道它已删，照样对它发了 sync）
    await waitFor(() => Object.keys(b.syncing).length === 0, 'B 全部 sync 完成');
    await settle(100);

    expect(b.timeline('mbp', sid).entries).toHaveLength(0);
    expect(timelineEvents.filter((s) => s === sid)).toEqual([]);
    expect(await bStore.docs.get(`timeline:mbp/${sid}`)).toBeUndefined();
    expect(b.peer?.machines['mbp']?.sessions[sid]).toBeUndefined();
    expect(b.sessions('mbp')[sid]).toBeUndefined();
    // 书签深链 / 浏览器后退回到它：拒绝打开，不 backfill
    expect(b.openSession('mbp', sid)).toBe(false);
    expect(b.peer?.machines['mbp']?.sessions[sid]).toBeUndefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 本机转录历史（session-history）
// ---------------------------------------------------------------------------

/** 造一段「本机终端里聊过」的转录：n 轮 user → assistant(text+tool_use) → tool_result */
function terminalTranscript(sid: string, n: number): SessionMessage[] {
  const out: SessionMessage[] = [];
  const at = (i: number) => new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString();
  const base = { session_id: sid, parent_tool_use_id: null, parent_agent_id: null };
  for (let i = 0; i < n; i++) {
    out.push({ ...base, type: 'user', uuid: `u${i}`, message: { role: 'user', content: `q${i}` }, timestamp: at(i * 4) } as unknown as SessionMessage);
    out.push({
      ...base,
      type: 'assistant',
      uuid: `a${i}`,
      message: { id: `msg_${i}`, role: 'assistant', content: [{ type: 'text', text: `a${i}` }] },
      timestamp: at(i * 4 + 1),
    } as unknown as SessionMessage);
    out.push({
      ...base,
      type: 'assistant',
      uuid: `t${i}`,
      message: { id: `msg_${i}`, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: `echo ${i}` } }] },
      timestamp: at(i * 4 + 2),
    } as unknown as SessionMessage);
    out.push({
      ...base,
      type: 'user',
      uuid: `r${i}`,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: `${i}`, is_error: false }] },
      timestamp: at(i * 4 + 3),
    } as unknown as SessionMessage);
  }
  return out;
}

describe('web lib · 斜杠命令补拉', () => {
  test('打开从未跑过的会话 → 不拉起会话进程即拿到带描述的命令清单；探测进程已关', async () => {
    await pair();
    await waitFor(() => client.machine('mbp')?.info != null && client.machine('mbp')?.online === true, 'machine.info');
    const sid = 'term-cmds';
    client.openSession('mbp', sid);
    await client.loadCommands('mbp', sid);
    expect(client.capabilities('mbp', sid)?.slashCommands).toEqual([
      { name: 'babysit-pr', description: 'Monitor a GitHub PR', source: 'project' },
      { name: 'compact', source: 'project' },
    ]);
    expect(agent.app.manager.has(sid)).toBe(false);
    expect(probes).toHaveLength(1);
    expect(probes[0]!.closed).toBe(true);
    // 已有命令：不再发请求
    await client.loadCommands('mbp', sid);
    expect(probes).toHaveLength(1);
  }, 20_000);
});

describe('web lib · 本机转录历史', () => {
  test('⑮ 打开本机终端建的会话（服务端无帧）→ sync 结束 → 拉到历史；翻页到底；刷新后仍在且不重拉', async () => {
    await pair();
    await waitFor(() => client.machine('mbp')?.info !== null, 'machine.info');
    const sid = 'term-1';
    // 3 轮 × 3 条（user / assistant / tool）= 9 条；另造一个 250 轮的翻页用
    transcripts[sid] = terminalTranscript(sid, 3);

    client.openSession('mbp', sid);
    await waitFor(() => client.syncing[`mbp/${sid}`] === undefined, 'sync.done');
    expect(entries(sid)).toEqual([]);
    expect(
      shouldAutoLoadHistory({ timeline: client.timeline('mbp', sid), syncing: client.syncing[`mbp/${sid}`], machine: client.machine('mbp') }),
    ).toBe(true);

    await client.loadHistory('mbp', sid);
    expect(entries(sid).map((e) => `${e.kind}:${e.id}`)).toEqual([
      'user:u0', 'assistant:msg_0', 'tool:toolu_0',
      'user:u1', 'assistant:msg_1', 'tool:toolu_1',
      'user:u2', 'assistant:msg_2', 'tool:toolu_2',
    ]);
    expect(entries(sid).every((e) => e.seq === 0)).toBe(true);
    expect(entries(sid)[2]).toMatchObject({ kind: 'tool', status: 'ok', argSummary: 'echo 0' });
    expect(client.timeline('mbp', sid).history).toEqual({ hasMore: false });
    expect(
      shouldAutoLoadHistory({ timeline: client.timeline('mbp', sid), syncing: undefined, machine: client.machine('mbp') }),
    ).toBe(false);

    // 刷新：历史条目与翻页状态都落了盘
    await waitFor(async () => {
      const doc = (await docs.get(`timeline:mbp/${sid}`)) as { history?: unknown; entries?: unknown[] } | undefined;
      return doc?.history !== undefined && doc.entries?.length === 9;
    }, '时间线落盘');
    client.stop();
    client = await newClient();
    client.start();
    await waitFor(() => client.connection.status === 'open', 'client 重连');
    expect(entries(sid)[0]).toMatchObject({ kind: 'user', id: 'u0' });
    expect(client.timeline('mbp', sid).history).toEqual({ hasMore: false });
  }, 20_000);

  test('⑰ 经 trine 跑过的会话：只收早于首个中转帧的历史项，重叠部分不重复', async () => {
    await pair();
    const sid = await createSession();
    await chat(sid, 'hello');
    const firstRelayTs = Math.min(...entries(sid).filter((e) => e.seq > 0).map((e) => e.ts));
    const base = { session_id: sid, parent_tool_use_id: null, parent_agent_id: null };
    transcripts[sid] = [
      // 配对前在终端里聊的
      { ...base, type: 'user', uuid: 'old-u', message: { role: 'user', content: '更早的问题' }, timestamp: new Date(firstRelayTs - 60_000).toISOString() },
      {
        ...base,
        type: 'assistant',
        uuid: 'old-a',
        message: { id: 'msg_old', role: 'assistant', content: [{ type: 'text', text: '更早的回答' }] },
        timestamp: new Date(firstRelayTs - 59_000).toISOString(),
      },
      // 经 trine 跑的那一轮，转录里也有（时间晚于首个中转帧）→ 必须被 cutoff 滤掉
      { ...base, type: 'user', uuid: 'dup-u', message: { role: 'user', content: 'hello' }, timestamp: new Date(firstRelayTs + 5).toISOString() },
      {
        ...base,
        type: 'assistant',
        uuid: 'dup-a',
        message: { id: 'a-dup', role: 'assistant', content: [{ type: 'text', text: 'echo: hello' }] },
        timestamp: new Date(firstRelayTs + 10).toISOString(),
      },
    ] as unknown as SessionMessage[];
    const before = entries(sid).map((e) => `${e.kind}:${e.id}`);
    await client.loadHistory('mbp', sid);
    expect(entries(sid).map((e) => `${e.kind}:${e.id}`)).toEqual(['user:old-u', 'assistant:msg_old', ...before]);
    expect(entries(sid).filter((e) => e.kind === 'user' && e.text === 'hello')).toHaveLength(1);
    // 再拉一次：幂等
    await client.loadHistory('mbp', sid);
    expect(entries(sid)).toHaveLength(before.length + 2);
  }, 20_000);

  test('⑯ 翻页：「加载更早」按游标往前取直到 hasMore=false', async () => {
    await pair();
    const sid = 'term-big';
    transcripts[sid] = terminalTranscript(sid, 150); // 450 条 → 200 + 200 + 50
    client.openSession('mbp', sid);
    await waitFor(() => client.syncing[`mbp/${sid}`] === undefined, 'sync.done');

    await client.loadHistory('mbp', sid);
    expect(entries(sid)).toHaveLength(200);
    expect(client.timeline('mbp', sid).history?.hasMore).toBe(true);
    const firstPageHead = entries(sid)[0]!.id;

    await client.loadHistory('mbp', sid, { older: true });
    expect(entries(sid)).toHaveLength(400);
    // 更早的一页前插在开头，原先的头部跟在后面
    expect(entries(sid)[200]!.id).toBe(firstPageHead);
    await client.loadHistory('mbp', sid, { older: true });
    expect(entries(sid)).toHaveLength(450);
    expect(entries(sid)[0]).toMatchObject({ kind: 'user', id: 'u0' });
    expect(client.timeline('mbp', sid).history).toEqual({ hasMore: false });
    // 没有更多时 older 直接返回，不发帧
    await client.loadHistory('mbp', sid, { older: true });
    expect(entries(sid)).toHaveLength(450);
    // ts 严格按时间正序
    const ts = entries(sid).map((e) => e.ts);
    expect(ts.every((t, i) => i === 0 || t >= ts[i - 1]!)).toBe(true);
  }, 20_000);
});

describe('web lib · 附件 e2e', () => {
  /** 读 objectURL 的内容（bun 的 fetch 支持 blob: URL） */
  async function bytesOf(url: string): Promise<Uint8Array> {
    return new Uint8Array(await (await fetch(url)).arrayBuffer());
  }

  test('A 上传并发送 → agent 落盘拿到路径 → B 设备点开加载；blob 过期后由 agent 重新上传', async () => {
    await pair();
    const sid = await createSession();
    // 另外两台设备先配对（relay 只给发送时已配对的设备各存一份回显）
    const b = { kv: new MemoryKv(), docs: new MemoryDocStore(), sockets: new ControlledSockets() };
    const c = { kv: new MemoryKv(), docs: new MemoryDocStore(), sockets: new ControlledSockets() };
    const clientB = await newClient(b);
    const clientC = await newClient(c);
    try {
      await pair(clientB, b.sockets);
      await pair(clientC, c.sockets);

      const bytes = new TextEncoder().encode('synthetic notes for e2e');
      const ref = await client.uploadAttachment(new File([bytes], 'notes.txt', { type: 'text/plain' }));
      // 别用 toMatchObject + 非对称匹配器：bun 1.4.3 会把匹配器写回被比较的对象
      expect([ref.name, ref.size, ref.kind]).toEqual(['notes.txt', bytes.length, 'file']);
      expect(ref.mime.startsWith('text/plain')).toBe(true);

      const id = client.sendInput('mbp', sid, '看看这个', [ref]);
      await waitFor(() => userEntry(sid, id)?.status === 'confirmed', '附件消息确认');
      expect(userEntry(sid, id)?.attachments).toEqual([ref]);

      // agent：文件落在 home/uploads 下，内容就是明文；交给会话的文字带路径清单
      const session = agent.app.manager.get(sid) as unknown as { prepared: Map<string, { content: unknown }> };
      const content = session.prepared.get(id)?.content as string;
      const path = /<attached-files>\n(.+)\n<\/attached-files>/.exec(content)?.[1];
      expect(path?.startsWith(join(home, 'uploads'))).toBe(true);
      expect(new Uint8Array(await Bun.file(path!).arrayBuffer())).toEqual(bytes);

      // 本机：刚上传的直接有预览，不用下载
      expect(client.attachmentUrl(ref.blobId)).toBeString();

      // B：收到回显，点开 → 从 relay 下载解密
      const synced = (cl: TrineClient) => {
        cl.openSession('mbp', sid);
        return () => cl.timeline('mbp', sid).entries.some((e) => e.kind === 'user' && e.attachments !== undefined);
      };
      await waitFor(synced(clientB), 'B 收到带附件的消息');
      const entryB = clientB.timeline('mbp', sid).entries.find((e): e is UserEntry => e.kind === 'user')!;
      expect(clientB.attachmentUrl(ref.blobId)).toBeUndefined();
      expect(await bytesOf(await clientB.openAttachment('mbp', sid, entryB.id, 0))).toEqual(bytes);

      // relay 上的 blob 没了（过期清理）：C 点开时 404 → attachment.fetch → agent 从本机副本重新上传
      rmSync(join(home, 'relay-blobs', ref.blobId));
      await waitFor(synced(clientC), 'C 收到带附件的消息');
      const entryC = clientC.timeline('mbp', sid).entries.find((e): e is UserEntry => e.kind === 'user')!;
      expect(await bytesOf(await clientC.openAttachment('mbp', sid, entryC.id, 0))).toEqual(bytes);
      // 新引用写回了条目
      const fresh = clientC.timeline('mbp', sid).entries.find((e): e is UserEntry => e.kind === 'user')!.attachments![0]!;
      expect(fresh.blobId).not.toBe(ref.blobId);
    } finally {
      clientB.stop();
      clientC.stop();
    }
  }, 20_000);

  test('附件下载失败 → input.rejected → 本地条目失败，可原样重试', async () => {
    await pair();
    const sid = await createSession();
    const ref = await client.uploadAttachment(new File([new Uint8Array([1, 2, 3])], 'a.bin'));
    rmSync(join(home, 'relay-blobs', ref.blobId));
    const id = client.sendInput('mbp', sid, '', [ref]);
    await waitFor(() => userEntry(sid, id)?.status === 'failed', '条目失败');
    expect(userEntry(sid, id)?.failReason).toContain('附件');
    expect(userEntry(sid, id)?.attachments).toEqual([ref]);
  });
});

describe('web lib · 扩展（ext.*）', () => {
  /** 合成扩展：view 给两条动作（新会话接续 / 接续到本会话），pick 给一个可关联项 */
  async function installExtension(): Promise<void> {
    const dir = join(home, 'ext-tasks');
    await Bun.write(
      join(dir, 'trine-extension.json'),
      JSON.stringify({
        apiVersion: 1,
        id: 'tasks',
        name: 'Tasks',
        version: '1.0.0',
        entry: ['bin/run'],
        contributes: { sessionPanel: { title: '任务' }, linkPicker: { title: '关联任务' } },
        capabilities: ['prompt.send', 'session.create', 'links.write'],
      }),
    );
    const view = {
      view: {
        sections: [
          {
            id: 'active',
            items: [
              {
                id: 'task-a',
                title: 'Task A',
                link: { ref: 'task-a', label: 'Task A' },
                actions: [
                  { id: 'new', label: '新会话接续', effects: [{ type: 'session.create', prompt: 'resume task-a', links: [{ ref: 'task-a', label: 'Task A' }] }] },
                  { id: 'here', label: '接续到本会话', effects: [{ type: 'prompt.send', text: 'continue task-a' }] },
                ],
              },
            ],
          },
        ],
      },
    };
    await Bun.write(
      join(dir, 'bin', 'run'),
      `#!/bin/sh\ncat >/dev/null\ncase "$1" in\n  view) echo '${JSON.stringify(view)}' ;;\n  pick) echo '{"items":[{"id":"task-a","title":"Task A","link":{"ref":"task-a","label":"Task A"}}]}' ;;\n  *) echo '{"error":{"code":"unsupported","message":"no"}}' ;;\nesac\n`,
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(join(dir, 'bin', 'run'), 0o755);
    await agent.app.extensionRegistry.add(dir);
  }

  const read = (sid: string) =>
    client.extRequest('mbp', { type: 'ext.read', ext: 'tasks', op: 'view', point: 'sessionPanel', targetSessionId: sid } as never, ['ext.read.response']);

  test('⑮ 目录 → 读取 → 全托管下「新会话接续」：agent 建会话、发首条消息、自动关联', async () => {
    await installExtension();
    await pair();
    await waitFor(() => (client.machine('mbp')?.info?.extensions?.count ?? 0) === 1, 'machine.info 带扩展摘要');
    const sid = await createSession();

    const catalog = await client.extRequest('mbp', { type: 'ext.catalog.request' } as never, ['ext.catalog.response']);
    expect(catalog.items).toHaveLength(1);
    const cfg = await client.extRequest(
      'mbp',
      { type: 'ext.config.set', ext: 'tasks', policy: { trust: 'full', capabilities: {} } } as never,
      ['ext.config.response'],
    );
    expect(cfg.ok).toBe(true);

    const res = await read(sid);
    expect(res.ok).toBe(true);
    const action = res.view!.sections[0]!.items[0]!.actions!.find((a) => a.id === 'new')!;
    expect(action.token).toBeString();
    // 视图里看不到效果内容
    expect(JSON.stringify(res.view)).not.toContain('resume task-a');

    const result = await client.extRequest(
      'mbp',
      { type: 'ext.action.prepare', token: action.token, invocationId: 'inv-1', newSession: { model: 'test-model', permissionMode: 'default' } } as never,
      ['ext.action.result', 'ext.action.plan'],
    );
    expect(result.type).toBe('ext.action.result');
    const created = (result as { createdSessionId?: string }).createdSessionId!;
    expect(created).toBeString();
    await waitFor(() => client.sessions('mbp')[created]?.links?.[0]?.ref === 'task-a', '新会话带关联');
    await waitFor(
      () => client.timeline('mbp', created).entries.some((e) => e.kind === 'assistant' && e.done && e.text === 'echo: resume task-a'),
      '新会话收到首条消息并回复',
    );
  });

  test('⑯ 自定义权限：发送要确认，commit 后才执行；token 一次性', async () => {
    await installExtension();
    await pair();
    await waitFor(() => (client.machine('mbp')?.info?.extensions?.count ?? 0) === 1, 'machine.info 带扩展摘要');
    const sid = await createSession();
    const res = await read(sid);
    const token = res.view!.sections[0]!.items[0]!.actions!.find((a) => a.id === 'here')!.token!;
    const plan = await client.extRequest('mbp', { type: 'ext.action.prepare', token, invocationId: 'inv-2' } as never, ['ext.action.plan', 'ext.action.result']);
    expect(plan.type).toBe('ext.action.plan');
    if (plan.type !== 'ext.action.plan') return;
    expect(plan.plan.steps[0]).toMatchObject({ type: 'prompt.send', targetSessionId: sid, text: 'continue task-a' });
    await settle();
    expect(entries(sid).some((e) => e.kind === 'assistant' && e.text === 'echo: continue task-a')).toBe(false);
    const done = await client.extRequest('mbp', { type: 'ext.action.commit', planId: plan.planId, invocationId: 'inv-2' } as never, ['ext.action.result']);
    expect(done.ok).toBe(true);
    await waitFor(() => entries(sid).some((e) => e.kind === 'assistant' && e.done && e.text === 'echo: continue task-a'), '确认后执行');
    const again = await client.extRequest('mbp', { type: 'ext.action.prepare', token, invocationId: 'inv-3' } as never, ['ext.action.result', 'ext.action.plan']);
    expect(again).toMatchObject({ type: 'ext.action.result', ok: false, error: { code: 'stale' } });
  });

  test('⑰ 手动关联：session.links.update 跨设备同步到 SessionMeta.links', async () => {
    await installExtension();
    await pair();
    const sid = await createSession();
    const res = await client.extRequest(
      'mbp',
      { type: 'session.links.update', targetSessionId: sid, ext: 'tasks', add: [{ ref: 'task-a', label: 'Task A' }] } as never,
      ['session.links.update.response'],
    );
    expect(res.ok).toBe(true);
    await waitFor(() => client.sessions('mbp')[sid]?.links?.length === 1, '关联写入');
    await client.extRequest('mbp', { type: 'session.links.update', targetSessionId: sid, ext: 'tasks', remove: ['task-a'] } as never, [
      'session.links.update.response',
    ]);
    await waitFor(() => client.sessions('mbp')[sid]?.links === undefined, '关联移除');
  });
});

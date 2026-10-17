import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  encodeTransportFrame,
  type TransportFrame,
} from '@trine/core/protocol';
import { generateSignKeyPair, sodiumReady } from '@trine/core/crypto';
import { AuthService } from '../auth/index.ts';
import { loadConfig, type ServerConfig } from '../config.ts';
import { PushDispatcher, type PushEvent } from '../push/index.ts';
import { Store } from '../store/index.ts';
import {
  PAIR_BEGIN_MAX_ENTRIES,
  PAIR_BEGIN_TTL_MS,
  PAIR_RATE_LIMIT,
  RelayHub,
} from './hub.ts';
import {
  ConnectionRegistry,
  type Conn,
  type PairingConn,
  type Sendable,
} from './registry.ts';

/** 测试替身：记录收到的帧，可模拟发送失败 */
class FakeSocket implements Sendable {
  readonly sent: TransportFrame[] = [];
  closed: { code?: number; reason?: string } | null = null;
  broken = false;

  send(data: string): void {
    if (this.broken) throw new Error('socket broken');
    this.sent.push(JSON.parse(data) as TransportFrame);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  /** 按类型筛已收帧 */
  ofType<K extends TransportFrame['type']>(
    type: K,
  ): Extract<TransportFrame, { type: K }>[] {
    return this.sent.filter((f) => f.type === type) as never;
  }
  clear(): void {
    this.sent.length = 0;
  }
}

let store: Store;
let registry: ConnectionRegistry<FakeSocket>;
let hub: RelayHub<FakeSocket>;
let config: ServerConfig;
let auth: AuthService;
let pushed: PushEvent[];
let clock: number;

beforeAll(async () => {
  // 背书登记会调 isValidSignPublicKey → 需要 libsodium 就绪
  await sodiumReady();
});

beforeEach(() => {
  clock = 1_000_000;
  store = new Store(':memory:');
  config = loadConfig({
    dbPath: ':memory:',
    parkedTtlMs: 10_000,
    parkedMaxPerMachine: 5,
    relayRetentionMs: 100_000,
    relayMaxPerStream: 100,
  });
  registry = new ConnectionRegistry<FakeSocket>();
  pushed = [];
  // 去抖与在线抑制在 push 层单测，这里关掉以观察每一次触发。
  // 直接截 dispatch()：hub 的职责边界就是「把什么样的事件交出去」，
  // 事件之后如何渲染成文案是 push 层的事
  const push = makeSpyDispatcher();
  auth = new AuthService(store, config, () => {});
  hub = new RelayHub<FakeSocket>({
    store,
    registry,
    config,
    push,
    auth,
    now: () => clock,
  });
  store.registerDevice('mbp', 'agent', 'PK-agent', clock);
  store.registerDevice('phone', 'client', 'PK-phone', clock);
});

/**
 * 记录 hub 交出的每个 PushEvent 的 dispatcher。
 * 关掉抑制与去抖——那两条策略在 push/push.test.ts 里单测。
 */
function makeSpyDispatcher(): PushDispatcher {
  const push = new PushDispatcher({
    suppressWhenOnline: false,
    dedupeWindowMs: 0,
    now: () => clock,
  });
  push.register({ name: 'test', async send() {} });
  const original = push.dispatch.bind(push);
  push.dispatch = (event) => {
    pushed.push(event);
    return original(event);
  };
  return push;
}

/** 配对中的新设备：免认证受限连接，不进 registry */
function connectPairing(
  deviceId = 'brand-new',
  source = 'src-default',
): PairingConn<FakeSocket> {
  const conn: PairingConn<FakeSocket> = {
    ws: new FakeSocket(),
    role: 'pairing',
    deviceId,
    source,
    connectedAt: clock,
    lastSeenAt: clock,
    beganAt: null,
  };
  hub.addPairingConn(conn);
  return conn;
}

function connectAgent(machineId = 'mbp'): Conn<FakeSocket> {
  const ws = new FakeSocket();
  const conn: Conn<FakeSocket> = {
    ws,
    deviceId: machineId,
    role: 'agent',
    machineId,
    connectedAt: clock,
    lastSeenAt: clock,
    pendingPings: 0,
  };
  registry.addAgent(conn);
  hub.onAgentOnline(conn);
  return conn;
}

function connectClient(deviceId = 'phone'): Conn<FakeSocket> {
  const ws = new FakeSocket();
  const conn: Conn<FakeSocket> = {
    ws,
    deviceId,
    role: 'client',
    connectedAt: clock,
    lastSeenAt: clock,
    pendingPings: 0,
  };
  registry.addClient(conn);
  hub.onClientOnline(conn);
  return conn;
}

/**
 * c2a 帧（client → agent）：**不带** recipientDeviceId——收件人天然是该
 * machineId 的 agent，带了会被 hub 按方向约定拒掉（transport.ts）。
 */
function relay(over: Partial<Extract<TransportFrame, { type: 'relay' }>> = {}) {
  return encodeTransportFrame({
    type: 'relay',
    machineId: 'mbp',
    sessionId: 's1',
    seq: 1,
    nonce: 'NONCE',
    ciphertext: 'CIPHERTEXT',
    ...over,
  } as TransportFrame);
}

/**
 * a2c 帧（agent → client）：**必带** recipientDeviceId。
 * 矩阵式配对下 agent 对每个收件人各 seal 一份，收件人是帧坐标的一部分。
 */
function a2cRelay(
  over: Partial<Extract<TransportFrame, { type: 'relay' }>> = {},
) {
  return encodeTransportFrame({
    type: 'relay',
    machineId: 'mbp',
    sessionId: 's1',
    recipientDeviceId: 'phone',
    seq: 1,
    nonce: 'NONCE',
    ciphertext: 'CIPHERTEXT',
    ...over,
  } as TransportFrame);
}

describe('入站校验', () => {
  test('非法 JSON / 不合 schema 的帧被拒，不抛异常', () => {
    const client = connectClient();
    expect(hub.handleRaw(client, 'not json')).toEqual({
      kind: 'rejected',
      reason: 'malformed_frame',
    });
    expect(hub.handleRaw(client, '{"type":"nope"}')).toEqual({
      kind: 'rejected',
      reason: 'malformed_frame',
    });
    // 缺 ciphertext 的 relay 帧
    expect(
      hub.handleRaw(client, '{"type":"relay","machineId":"mbp","seq":1,"nonce":"n"}'),
    ).toEqual({ kind: 'rejected', reason: 'malformed_frame' });
  });

  test('server→client 单向帧从对端发来即拒', () => {
    const client = connectClient();
    const forged = encodeTransportFrame({
      type: 'parked.count',
      machineId: 'mbp',
      parkedCount: 999,
    });
    expect(hub.handleRaw(client, forged).kind).toBe('rejected');
  });

  test('收到任何帧都会推进 lastSeenAt 并清零 pendingPings', () => {
    const client = connectClient();
    client.lastSeenAt = 0;
    client.pendingPings = 2;
    hub.handleRaw(client, relay({ seq: 1 }));
    expect(client.lastSeenAt).toBe(clock);
    expect(client.pendingPings).toBe(0);
  });
});

describe('身份与方向', () => {
  test('agent 不能以别的 machineId 发帧', () => {
    const agent = connectAgent('mbp');
    expect(hub.handleRaw(agent, a2cRelay({ machineId: 'other-machine' }))).toEqual({
      kind: 'rejected',
      reason: 'machine_id_mismatch',
    });
  });

  test('client 不能带 pushHint（推送触发权不交给 client）', () => {
    const client = connectClient();
    expect(hub.handleRaw(client, relay({ pushHint: 'run_done' }))).toEqual({
      kind: 'rejected',
      reason: 'push_hint_from_client',
    });
    expect(pushed).toHaveLength(0);
  });

  test('方向由已认证角色决定，落库的 dir 与角色一致', () => {
    const agent = connectAgent();
    hub.handleRaw(agent, a2cRelay({ seq: 1 }));
    expect(store.getFrame('mbp', 's1', 'a2c', 1, 'phone')).not.toBeNull();
    expect(store.getFrame('mbp', 's1', 'c2a', 1)).toBeNull();

    const client = connectClient();
    hub.handleRaw(client, relay({ seq: 1 }));
    expect(store.getFrame('mbp', 's1', 'c2a', 1)).not.toBeNull();
  });

  test('park.recall 只接受 client 发出', () => {
    const agent = connectAgent();
    const recall = encodeTransportFrame({
      type: 'park.recall',
      machineId: 'mbp',
      sessionId: 's1',
      seq: 1,
    });
    expect(hub.handleRaw(agent, recall)).toEqual({
      kind: 'rejected',
      reason: 'recall_from_non_client',
    });
  });
});

describe('中转路由', () => {
  test('agent → 只投给 recipientDeviceId 指定的设备（不再广播）', () => {
    // 矩阵式配对下每份密文只有对应设备解得开，广播给别人纯属浪费；
    // 多设备同步靠 agent 对每个收件人各发一帧来实现
    const phone = connectClient('phone');
    const laptop = connectClient('laptop');
    phone.ws.clear();
    laptop.ws.clear();
    const agent = connectAgent();

    expect(
      hub.handleRaw(agent, a2cRelay({ seq: 1, recipientDeviceId: 'phone' })),
    ).toEqual({ kind: 'relayed', dir: 'a2c', targets: 1 });

    const got = phone.ws.ofType('relay');
    expect(got).toHaveLength(1);
    expect(got[0]!.ciphertext).toBe('CIPHERTEXT');
    expect(got[0]!.recipientDeviceId).toBe('phone');
    // laptop 一帧都不该收到——那份密文不是给它的
    expect(laptop.ws.ofType('relay')).toHaveLength(0);
  });

  test('同一逻辑事件发两份：两台设备各收各的那一份', () => {
    const phone = connectClient('phone');
    const laptop = connectClient('laptop');
    phone.ws.clear();
    laptop.ws.clear();
    const agent = connectAgent();

    // 同一逻辑事件 → 同一 seq，两份密文只有收件人不同
    hub.handleRaw(
      agent,
      a2cRelay({ seq: 1, recipientDeviceId: 'phone', ciphertext: 'FOR-PHONE' }),
    );
    hub.handleRaw(
      agent,
      a2cRelay({
        seq: 1,
        recipientDeviceId: 'laptop',
        ciphertext: 'FOR-LAPTOP',
      }),
    );

    expect(phone.ws.ofType('relay').map((f) => f.ciphertext)).toEqual([
      'FOR-PHONE',
    ]);
    expect(laptop.ws.ofType('relay').map((f) => f.ciphertext)).toEqual([
      'FOR-LAPTOP',
    ]);
  });

  test('收件人不在线：只落库，等它重连后补发', () => {
    const agent = connectAgent();
    expect(
      hub.handleRaw(agent, a2cRelay({ seq: 1, recipientDeviceId: 'tablet' })),
    ).toEqual({ kind: 'relayed', dir: 'a2c', targets: 0 });
    // 帧确实存下来了——targets:0 不等于丢弃
    expect(store.getFrame('mbp', 's1', 'a2c', 1, 'tablet')).not.toBeNull();
  });

  test('方向约定：a2c 必带收件人、c2a 不许带', () => {
    const agent = connectAgent();
    const client = connectClient();
    // 两个方向都放行的话，帧坐标就有两种形状，去重与补发处处要分支
    expect(hub.handleRaw(agent, relay({ seq: 1 }))).toEqual({
      kind: 'rejected',
      reason: 'recipient_required',
    });
    expect(
      hub.handleRaw(client, a2cRelay({ seq: 1, recipientDeviceId: 'phone' })),
    ).toEqual({ kind: 'rejected', reason: 'recipient_not_allowed' });
  });

  test('client → 在线 agent 单播（不广播给其他 client）', () => {
    const agent = connectAgent();
    const other = connectClient('laptop');
    const client = connectClient('phone');
    other.ws.clear();
    agent.ws.clear();

    expect(hub.handleRaw(client, relay({ seq: 1 }))).toEqual({
      kind: 'relayed',
      dir: 'c2a',
      targets: 1,
    });
    expect(agent.ws.ofType('relay')).toHaveLength(1);
    expect(other.ws.ofType('relay')).toHaveLength(0);
  });

  test('密文与 nonce 原样透传，不被改写', () => {
    const client = connectClient();
    const agent = connectAgent();
    agent.ws.clear();
    hub.handleRaw(
      client,
      relay({ seq: 1, nonce: 'N-xyz', ciphertext: 'C-abc' }),
    );
    const got = agent.ws.ofType('relay')[0]!;
    expect(got.nonce).toBe('N-xyz');
    expect(got.ciphertext).toBe('C-abc');
  });

  test('同一设备的多条连接：死的那条不影响活的那条', () => {
    // 同一台设备可能有多条连接（多标签页、重连时新旧并存），
    // 定向投递要遍历全部匹配连接，不能只发第一条
    const dead = connectClient('phone');
    const alive = connectClient('phone');
    dead.ws.broken = true;
    alive.ws.clear();
    const agent = connectAgent();

    const out = hub.handleRaw(
      agent,
      a2cRelay({ seq: 1, recipientDeviceId: 'phone' }),
    );
    expect(out).toEqual({ kind: 'relayed', dir: 'a2c', targets: 1 });
    expect(alive.ws.ofType('relay')).toHaveLength(1);
  });
});

describe('seq 去重与单调', () => {
  test('重复 seq 判 duplicate，不再转发第二次', () => {
    const client = connectClient();
    client.ws.clear();
    const agent = connectAgent();

    expect(hub.handleRaw(agent, a2cRelay({ seq: 3 })).kind).toBe('relayed');
    expect(hub.handleRaw(agent, a2cRelay({ seq: 3 })).kind).toBe('duplicate');
    expect(client.ws.ofType('relay')).toHaveLength(1);
  });

  test('seq 回退被拒且不转发', () => {
    const client = connectClient();
    const agent = connectAgent();
    hub.handleRaw(agent, a2cRelay({ seq: 5 }));
    client.ws.clear();
    expect(hub.handleRaw(agent, a2cRelay({ seq: 2 }))).toEqual({
      kind: 'rejected',
      reason: 'seq_not_monotonic',
    });
    expect(client.ws.ofType('relay')).toHaveLength(0);
  });

  test('seq 0 被拒（0 保留给 sinceSeq 的「一帧未收」语义）', () => {
    const client = connectClient();
    const agent = connectAgent();
    agent.ws.clear();
    expect(hub.handleRaw(client, relay({ seq: 0 }))).toEqual({
      kind: 'rejected',
      reason: 'seq_below_first',
    });
    expect(agent.ws.ofType('relay')).toHaveLength(0);
  });

  test('机器级帧与会话级帧的 seq 各走各的，互不判回退', () => {
    connectClient();
    const agent = connectAgent();
    expect(hub.handleRaw(agent, a2cRelay({ sessionId: undefined, seq: 20 })).kind).toBe(
      'relayed',
    );
    // 会话级从 0 起，不该被机器级的 20 判成回退
    expect(hub.handleRaw(agent, a2cRelay({ sessionId: 's1', seq: 1 })).kind).toBe(
      'relayed',
    );
  });
});

describe('断线补发', () => {
  test('client 按 sinceSeq 收回 agent 发过的帧', () => {
    const agent = connectAgent();
    const client = connectClient();
    for (let i = 1; i <= 5; i++) hub.handleRaw(agent, a2cRelay({ seq: i }));
    client.ws.clear();

    const out = hub.handleRaw(
      client,
      encodeTransportFrame({
        type: 'sync.request',
        machineId: 'mbp',
        sessionId: 's1',
        sinceSeq: 3,
      }),
    );
    expect(out).toEqual({ kind: 'resent', count: 2 });
    expect(client.ws.ofType('relay').map((f) => f.seq)).toEqual([4, 5]);
  });

  test('sync.done 在最后一条补发帧之后到达，upTo = 本次补发的最大 seq', () => {
    const agent = connectAgent();
    const client = connectClient();
    for (let i = 1; i <= 5; i++) hub.handleRaw(agent, a2cRelay({ seq: i }));
    client.ws.clear();

    hub.handleRaw(
      client,
      encodeTransportFrame({
        type: 'sync.request',
        machineId: 'mbp',
        sessionId: 's1',
        sinceSeq: 3,
      }),
    );

    // 顺序是硬要求：client 要靠这一帧结束「补发期间暂存 live 帧」的状态，
    // 它若早于补发帧到达，暂存就会提前解除、补发帧反被当重放丢弃
    const types = client.ws.sent.map((f) => f.type);
    const doneAt = types.indexOf('sync.done');
    expect(doneAt).toBeGreaterThan(-1);
    expect(types.lastIndexOf('relay')).toBeLessThan(doneAt);

    const done = client.ws.ofType('sync.done');
    expect(done).toHaveLength(1);
    expect(done[0]).toEqual({
      type: 'sync.done',
      machineId: 'mbp',
      sessionId: 's1',
      upTo: 5,
    });
  });

  test('一帧都没补发时也发 sync.done，upTo 等于请求的 sinceSeq', () => {
    const agent = connectAgent();
    const client = connectClient();
    hub.handleRaw(agent, a2cRelay({ seq: 1 }));
    client.ws.clear();

    // 已经是最新的了：没有帧可补，但 client 仍在等一个「补完了」的信号，
    // 不发的话它会一直暂存 live 帧直到超时
    const out = hub.handleRaw(
      client,
      encodeTransportFrame({
        type: 'sync.request',
        machineId: 'mbp',
        sessionId: 's1',
        sinceSeq: 1,
      }),
    );
    expect(out).toEqual({ kind: 'resent', count: 0 });
    expect(client.ws.ofType('relay')).toHaveLength(0);
    expect(client.ws.ofType('sync.done')[0]).toEqual({
      type: 'sync.done',
      machineId: 'mbp',
      sessionId: 's1',
      upTo: 1,
    });
  });

  test('多条流各发各的 sync.done（机器级的那条省略 sessionId）', () => {
    const agent = connectAgent();
    const client = connectClient();
    hub.handleRaw(agent, a2cRelay({ sessionId: undefined, seq: 7 }));
    hub.handleRaw(agent, a2cRelay({ sessionId: 's1', seq: 2 }));
    hub.handleRaw(agent, a2cRelay({ sessionId: 's2', seq: 4 }));
    client.ws.clear();

    for (const sessionId of [undefined, 's1', 's2']) {
      hub.handleRaw(
        client,
        encodeTransportFrame({
          type: 'sync.request',
          machineId: 'mbp',
          ...(sessionId !== undefined ? { sessionId } : {}),
          sinceSeq: 0,
        }),
      );
    }

    // 每条流一帧，各自标定自己那条流的进度；机器级的不带 sessionId，
    // 与 sync.request 的同名字段语义一一对应
    expect(client.ws.ofType('sync.done')).toEqual([
      { type: 'sync.done', machineId: 'mbp', upTo: 7 },
      { type: 'sync.done', machineId: 'mbp', sessionId: 's1', upTo: 2 },
      { type: 'sync.done', machineId: 'mbp', sessionId: 's2', upTo: 4 },
    ]);
  });

  test('agent 侧补发（c2a）同样收得到 sync.done', () => {
    const agent = connectAgent();
    const client = connectClient();
    // c2a 方向：收件人天然是该机器的 agent，帧上不带 recipientDeviceId
    hub.handleRaw(
      client,
      encodeTransportFrame({
        type: 'relay',
        machineId: 'mbp',
        sessionId: 's1',
        seq: 1,
        nonce: 'NONCE',
        ciphertext: 'CIPHERTEXT',
      }),
    );
    agent.ws.clear();

    hub.handleRaw(
      agent,
      encodeTransportFrame({
        type: 'sync.request',
        machineId: 'mbp',
        sessionId: 's1',
        sinceSeq: 0,
      }),
    );
    expect(agent.ws.ofType('sync.done')[0]).toEqual({
      type: 'sync.done',
      machineId: 'mbp',
      sessionId: 's1',
      upTo: 1,
    });
  });

  test('client 把 sync.done 发回来被拒（server → client 单向帧）', () => {
    const client = connectClient();
    const out = hub.handleRaw(
      client,
      encodeTransportFrame({ type: 'sync.done', machineId: 'mbp', upTo: 1 }),
    );
    expect(out).toEqual({ kind: 'rejected', reason: 'server_only_frame:sync.done' });
  });

  test('a2c 补发只回请求设备自己那条子流', () => {
    const agent = connectAgent();
    const phone = connectClient('phone');
    const laptop = connectClient('laptop');
    // 同一逻辑事件的两份密文，seq 都是 1
    hub.handleRaw(
      agent,
      a2cRelay({ seq: 1, recipientDeviceId: 'phone', ciphertext: 'FOR-PHONE' }),
    );
    hub.handleRaw(
      agent,
      a2cRelay({
        seq: 1,
        recipientDeviceId: 'laptop',
        ciphertext: 'FOR-LAPTOP',
      }),
    );
    // 清掉在线投递时各自收到的那一帧，只观察补发
    phone.ws.clear();
    laptop.ws.clear();

    const sync = encodeTransportFrame({
      type: 'sync.request',
      machineId: 'mbp',
      sessionId: 's1',
      sinceSeq: 0,
    });
    expect(hub.handleRaw(phone, sync)).toEqual({ kind: 'resent', count: 1 });
    // 别人的密文虽然解不开，也没理由发过去；更重要的是它会打乱
    // client 侧按信封 seq 推进的单调游标
    expect(phone.ws.ofType('relay').map((f) => f.ciphertext)).toEqual([
      'FOR-PHONE',
    ]);
    expect(laptop.ws.ofType('relay')).toHaveLength(0);
  });

  test('a2c 补发的过滤依据是已认证 deviceId，不是任何自报字段', () => {
    const agent = connectAgent();
    const laptop = connectClient('laptop');
    hub.handleRaw(
      agent,
      a2cRelay({ seq: 1, recipientDeviceId: 'phone', ciphertext: 'FOR-PHONE' }),
    );
    laptop.ws.clear();

    // laptop 请求补发：库里只有 phone 的帧，它一条都不该拿到
    expect(
      hub.handleRaw(
        laptop,
        encodeTransportFrame({
          type: 'sync.request',
          machineId: 'mbp',
          sessionId: 's1',
          sinceSeq: 0,
        }),
      ),
    ).toEqual({ kind: 'resent', count: 0 });
    expect(laptop.ws.ofType('relay')).toHaveLength(0);
  });

  test('补发的是密文原文', () => {
    const agent = connectAgent();
    const client = connectClient();
    hub.handleRaw(agent, a2cRelay({ seq: 1, ciphertext: 'SECRET-1' }));
    client.ws.clear();
    hub.handleRaw(
      client,
      encodeTransportFrame({
        type: 'sync.request',
        machineId: 'mbp',
        sessionId: 's1',
        sinceSeq: 0,
      }),
    );
    expect(client.ws.ofType('relay')[0]!.ciphertext).toBe('SECRET-1');
  });

  test('机器级补发（省略 sessionId）只回机器级帧', () => {
    const agent = connectAgent();
    const client = connectClient();
    hub.handleRaw(agent, a2cRelay({ sessionId: undefined, seq: 1 }));
    hub.handleRaw(agent, a2cRelay({ sessionId: 's1', seq: 1 }));
    client.ws.clear();

    hub.handleRaw(
      client,
      encodeTransportFrame({
        type: 'sync.request',
        machineId: 'mbp',
        sinceSeq: 0,
      }),
    );
    const got = client.ws.ofType('relay');
    expect(got).toHaveLength(1);
    expect(got[0]!.sessionId).toBeUndefined();
  });

  test('agent 补发拿的是 client 发来的 c2a 帧', () => {
    const client = connectClient();
    const agent = connectAgent();
    hub.handleRaw(client, relay({ seq: 1 }));
    hub.handleRaw(client, relay({ seq: 1 }));
    agent.ws.clear();

    const out = hub.handleRaw(
      agent,
      encodeTransportFrame({
        type: 'sync.request',
        machineId: 'mbp',
        sessionId: 's1',
        sinceSeq: 0,
      }),
    );
    expect(out).toEqual({ kind: 'resent', count: 1 });
    expect(agent.ws.ofType('relay').map((f) => f.seq)).toEqual([1]);
  });

  test('client 补发后附带 machine.status 与 parked.count', () => {
    connectAgent();
    const client = connectClient();
    client.ws.clear();
    hub.handleRaw(
      client,
      encodeTransportFrame({
        type: 'sync.request',
        machineId: 'mbp',
        sessionId: 's1',
        sinceSeq: 0,
      }),
    );
    expect(client.ws.ofType('machine.status')[0]!.online).toBe(true);
    expect(client.ws.ofType('parked.count')[0]!.parkedCount).toBe(0);
  });

  test('agent 不能替别的机器请求补发', () => {
    const agent = connectAgent('mbp');
    expect(
      hub.handleRaw(
        agent,
        encodeTransportFrame({
          type: 'sync.request',
          machineId: 'other',
          sinceSeq: 0,
        }),
      ),
    ).toEqual({ kind: 'rejected', reason: 'machine_id_mismatch' });
  });

  test('游标只进不退', () => {
    const client = connectClient();
    const sync = (sinceSeq: number) =>
      hub.handleRaw(
        client,
        encodeTransportFrame({
          type: 'sync.request',
          machineId: 'mbp',
          sessionId: 's1',
          sinceSeq,
        }),
      );
    sync(10);
    sync(3);
    expect(store.getCursor('phone', 'mbp', 's1')).toBe(10);
  });
});

describe('agent 离线排队', () => {
  test('agent 离线时 client 帧被排队并收到 input.parked 回执', () => {
    const client = connectClient();
    client.ws.clear();
    const out = hub.handleRaw(client, relay({ seq: 7 }));
    expect(out).toEqual({ kind: 'parked', seq: 7 });

    const receipt = client.ws.ofType('input.parked');
    expect(receipt).toHaveLength(1);
    expect(receipt[0]).toMatchObject({
      machineId: 'mbp',
      sessionId: 's1',
      seq: 7,
      expiresAt: clock + config.parkedTtlMs,
    });
  });

  test('排队后向全体 client 广播 parked.count', () => {
    const other = connectClient('laptop');
    const client = connectClient('phone');
    other.ws.clear();
    hub.handleRaw(client, relay({ seq: 1 }));
    expect(other.ws.ofType('parked.count').at(-1)!.parkedCount).toBe(1);
  });

  test('机器级帧不排队（隔天再送达毫无意义）', () => {
    const client = connectClient();
    expect(hub.handleRaw(client, relay({ sessionId: undefined, seq: 1 }))).toEqual({
      kind: 'ignored',
      reason: 'agent_offline_machine_frame',
    });
    expect(hub.parked.pendingCount('mbp', clock)).toBe(0);
  });

  test('超出机器配额后拒绝', () => {
    const client = connectClient();
    for (let i = 1; i <= config.parkedMaxPerMachine; i++) {
      expect(hub.handleRaw(client, relay({ seq: i })).kind).toBe('parked');
    }
    expect(hub.handleRaw(client, relay({ seq: 99 }))).toEqual({
      kind: 'rejected',
      reason: 'parked_quota_exceeded',
    });
  });

  test('agent 上线后按序投递排队帧并转 delivered', () => {
    const client = connectClient();
    hub.handleRaw(client, relay({ seq: 1 }));
    hub.handleRaw(client, relay({ seq: 2 }));
    expect(hub.parked.pendingCount('mbp', clock)).toBe(2);

    const agent = connectAgent();
    expect(agent.ws.ofType('relay').map((f) => f.seq)).toEqual([1, 2]);
    expect(hub.parked.pendingCount('mbp', clock)).toBe(0);
    expect(hub.parked.get('mbp', 's1', 1)!.state).toBe('delivered');
  });

  test('agent 上线投递后 client 收到 parked.count 归零', () => {
    const client = connectClient();
    hub.handleRaw(client, relay({ seq: 1 }));
    client.ws.clear();
    connectAgent();
    expect(client.ws.ofType('parked.count').at(-1)!.parkedCount).toBe(0);
  });

  test('密文已被清理时判 expired，不谎报已送达', () => {
    const client = connectClient();
    hub.handleRaw(client, relay({ seq: 1 }));
    // 模拟密文被清掉（parked 元数据还在）
    store.db.query('DELETE FROM relay_frames').run();

    connectAgent();
    expect(hub.parked.get('mbp', 's1', 1)!.state).toBe('expired');
  });
});

describe('park.recall 撤回', () => {
  test('撤回 pending 帧后不再投递', () => {
    const client = connectClient();
    hub.handleRaw(client, relay({ seq: 4 }));
    const out = hub.handleRaw(
      client,
      encodeTransportFrame({
        type: 'park.recall',
        machineId: 'mbp',
        sessionId: 's1',
        seq: 4,
      }),
    );
    expect(out).toEqual({ kind: 'recalled', effective: true });

    const agent = connectAgent();
    expect(agent.ws.ofType('relay')).toHaveLength(0);
    expect(hub.parked.get('mbp', 's1', 4)!.state).toBe('recalled');
  });

  test('重复撤回幂等：第二次 effective=false 且不报错', () => {
    const client = connectClient();
    hub.handleRaw(client, relay({ seq: 4 }));
    const recall = encodeTransportFrame({
      type: 'park.recall',
      machineId: 'mbp',
      sessionId: 's1',
      seq: 4,
    });
    expect(hub.handleRaw(client, recall)).toEqual({
      kind: 'recalled',
      effective: true,
    });
    expect(hub.handleRaw(client, recall)).toEqual({
      kind: 'recalled',
      effective: false,
    });
  });

  test('撤回不存在的 seq 静默无操作', () => {
    const client = connectClient();
    expect(
      hub.handleRaw(
        client,
        encodeTransportFrame({
          type: 'park.recall',
          machineId: 'mbp',
          sessionId: 's1',
          seq: 404,
        }),
      ),
    ).toEqual({ kind: 'recalled', effective: false });
  });

  test('已投递的帧撤回无效（终态防覆盖）', () => {
    const client = connectClient();
    hub.handleRaw(client, relay({ seq: 4 }));
    connectAgent();
    expect(hub.parked.get('mbp', 's1', 4)!.state).toBe('delivered');

    expect(
      hub.handleRaw(
        client,
        encodeTransportFrame({
          type: 'park.recall',
          machineId: 'mbp',
          sessionId: 's1',
          seq: 4,
        }),
      ),
    ).toEqual({ kind: 'recalled', effective: false });
    expect(hub.parked.get('mbp', 's1', 4)!.state).toBe('delivered');
  });

  test('撤回后广播新的 parked.count', () => {
    const client = connectClient();
    hub.handleRaw(client, relay({ seq: 1 }));
    hub.handleRaw(client, relay({ seq: 2 }));
    client.ws.clear();
    hub.handleRaw(
      client,
      encodeTransportFrame({
        type: 'park.recall',
        machineId: 'mbp',
        sessionId: 's1',
        seq: 1,
      }),
    );
    expect(client.ws.ofType('parked.count').at(-1)!.parkedCount).toBe(1);
  });
});

describe('机器在线状态', () => {
  test('agent 上线广播 online=true，下线广播 false', () => {
    const client = connectClient();
    client.ws.clear();
    connectAgent();
    expect(client.ws.ofType('machine.status').at(-1)).toMatchObject({
      machineId: 'mbp',
      online: true,
    });

    client.ws.clear();
    hub.onAgentOffline('mbp');
    expect(client.ws.ofType('machine.status').at(-1)!.online).toBe(false);
  });

  test('client 上线收到所有已知 agent 的状态', () => {
    store.registerDevice('nuc', 'agent', 'PK2', clock);
    const client = connectClient();
    const ids = client.ws.ofType('machine.status').map((f) => f.machineId);
    expect(ids.sort()).toEqual(['mbp', 'nuc']);
  });

  test('离线状态的 lastSeenAt 用服务端记录的观测值', () => {
    store.touchDevice('mbp', 555);
    const client = connectClient();
    const status = client.ws.ofType('machine.status')[0]!;
    expect(status.online).toBe(false);
    expect(status.lastSeenAt).toBe(555);
  });
});

describe('推送触发', () => {
  test('agent 带 pushHint 的帧触发推送，只含路由字段 + 事件类型', () => {
    connectClient();
    const agent = connectAgent();
    hub.handleRaw(agent, a2cRelay({ seq: 1, pushHint: 'permission_pending' }));
    expect(pushed).toEqual([
      {
        machineId: 'mbp',
        sessionId: 's1',
        hint: 'permission_pending',
        at: clock,
      },
    ]);
    // 事件里没有任何正文字段的容身之处；sessionId 是明文路由字段，
    // 只喂给 dispatcher 做去抖分桶，不会进推送内容（push/text.ts 保证）
    expect(Object.keys(pushed[0]!).sort()).toEqual([
      'at',
      'hint',
      'machineId',
      'sessionId',
    ]);
  });

  test('提问 / 计划两类 pushHint 被新 server 接受并照常触发推送', () => {
    connectClient();
    const agent = connectAgent();
    expect(hub.handleRaw(agent, a2cRelay({ seq: 1, pushHint: 'question_pending' })).kind).not.toBe('rejected');
    expect(hub.handleRaw(agent, a2cRelay({ seq: 2, pushHint: 'plan_pending' })).kind).not.toBe('rejected');
    expect(pushed.map((p) => p.hint)).toEqual(['question_pending', 'plan_pending']);
  });

  test('机器级帧（无 sessionId）触发的推送不带 sessionId', () => {
    connectClient();
    const agent = connectAgent();
    hub.handleRaw(
      agent,
      encodeTransportFrame({
        type: 'relay',
        machineId: 'mbp',
        recipientDeviceId: 'phone',
        seq: 1,
        nonce: 'N',
        ciphertext: 'C',
        pushHint: 'run_error',
      }),
    );
    expect(pushed).toEqual([
      { machineId: 'mbp', hint: 'run_error', at: clock },
    ]);
  });

  test('无 pushHint 不触发推送', () => {
    connectClient();
    const agent = connectAgent();
    hub.handleRaw(agent, a2cRelay({ seq: 1 }));
    expect(pushed).toHaveLength(0);
  });

  test('重复帧不重复触发推送', () => {
    connectClient();
    const agent = connectAgent();
    hub.handleRaw(agent, a2cRelay({ seq: 1, pushHint: 'run_done' }));
    hub.handleRaw(agent, a2cRelay({ seq: 1, pushHint: 'run_done' }));
    expect(pushed).toHaveLength(1);
  });

  test('补发不重复触发推送', () => {
    const client = connectClient();
    const agent = connectAgent();
    hub.handleRaw(agent, a2cRelay({ seq: 1, pushHint: 'run_done' }));
    expect(pushed).toHaveLength(1);
    hub.handleRaw(
      client,
      encodeTransportFrame({
        type: 'sync.request',
        machineId: 'mbp',
        sessionId: 's1',
        sinceSeq: 0,
      }),
    );
    expect(pushed).toHaveLength(1);
  });

  test('推送渠道抛错不影响中转（推送是旁路，不是主链路）', () => {
    const boom = new PushDispatcher({
      suppressWhenOnline: false,
      dedupeWindowMs: 0,
      now: () => clock,
    });
    boom.register({
      name: 'boom',
      send: () => Promise.reject(new Error('渠道炸了')),
    });
    const brokenHub = new RelayHub<FakeSocket>({
      store,
      registry,
      config,
      push: boom,
      now: () => clock,
    });
    const client = connectClient('phone2');
    const agent = connectAgent();
    expect(
      brokenHub.handleRaw(
        agent,
        a2cRelay({ seq: 1, recipientDeviceId: 'phone2', pushHint: 'run_done' }),
      ),
    ).toEqual({ kind: 'relayed', dir: 'a2c', targets: 1 });
    // 帧照样送到了 client
    expect(client.ws.ofType('relay')).toHaveLength(1);
  });
});

describe('配对帧中转与背书式登记（D8）', () => {
  /** 一次配对用的一套材料 */
  function pairingMaterial(deviceId = 'brand-new') {
    const keys = generateSignKeyPair();
    return {
      keys,
      begin: {
        type: 'pair.begin' as const,
        pairingToken: 'TOK',
        clientPubKey: 'CPK',
        clientSignPubKey: keys.publicKey,
        clientDeviceId: deviceId,
      },
      confirm: {
        type: 'pair.confirm' as const,
        pairingToken: 'TOK',
        clientDeviceId: deviceId,
        clientSignPubKey: keys.publicKey,
      },
    };
  }

  test('pairing 连接的 pair.begin 转给全部在线 agent', () => {
    const agent = connectAgent();
    const pairing = connectPairing();
    agent.ws.clear();
    const out = hub.handlePair(pairing, pairingMaterial().begin);
    expect(out).toEqual({ kind: 'pair_forwarded', targets: 1 });
    expect(agent.ws.ofType('pair.begin')[0]).toMatchObject({
      pairingToken: 'TOK',
      clientPubKey: 'CPK',
    });
    // begin 被缓存下来，等 agent 复述时比对
    expect(hub.pendingPairBeginCount).toBe(1);
  });

  test('agent 复述一致 → 登记设备并把 confirm 转给 pairing 连接', () => {
    const agent = connectAgent();
    const pairing = connectPairing();
    const m = pairingMaterial();

    hub.handlePair(pairing, m.begin);
    pairing.ws.clear();
    const out = hub.handlePair(agent, m.confirm);

    expect(out).toEqual({
      kind: 'pair_registered',
      deviceId: 'brand-new',
      targets: 1,
    });
    // 设备真的进库了，且存的是 agent 背书的那把公钥
    const device = store.getDevice('brand-new');
    expect(device).toMatchObject({ role: 'client', signPubKey: m.keys.publicKey });
    // confirm 送到了正在等它的 pairing 连接
    expect(pairing.ws.ofType('pair.confirm')).toHaveLength(1);
    // 核销落码：begin 记录已删
    expect(hub.pendingPairBeginCount).toBe(0);
  });

  test('token 重放：同一 confirm 再来一次被拒（核销必须落码）', () => {
    const agent = connectAgent();
    const pairing = connectPairing();
    const m = pairingMaterial();
    hub.handlePair(pairing, m.begin);
    expect(hub.handlePair(agent, m.confirm).kind).toBe('pair_registered');

    pairing.ws.clear();
    expect(hub.handlePair(agent, m.confirm)).toEqual({
      kind: 'rejected',
      reason: 'pair_unknown_token',
    });
    // 被拒的 confirm 一个字节都不转发——否则 client 会误以为又配对成功了
    expect(pairing.ws.ofType('pair.confirm')).toHaveLength(0);
  });

  test('begin 记录过期后 confirm 被拒（超时核销）', () => {
    const agent = connectAgent();
    const pairing = connectPairing();
    const m = pairingMaterial();
    hub.handlePair(pairing, m.begin);

    clock += PAIR_BEGIN_TTL_MS + 1;
    expect(hub.handlePair(agent, m.confirm)).toEqual({
      kind: 'rejected',
      reason: 'pair_unknown_token',
    });
    expect(store.getDevice('brand-new')).toBeNull();
  });

  test('pair.abort 立刻作废本次配对（abort 核销）', () => {
    const agent = connectAgent();
    const pairing = connectPairing();
    const m = pairingMaterial();
    hub.handlePair(pairing, m.begin);
    expect(hub.pendingPairBeginCount).toBe(1);

    hub.handlePair(pairing, { type: 'pair.abort', pairingToken: 'TOK' });
    expect(hub.pendingPairBeginCount).toBe(0);
    // abort 之后 agent 再 confirm 也登记不了
    expect(hub.handlePair(agent, m.confirm).kind).toBe('rejected');
    expect(store.getDevice('brand-new')).toBeNull();
  });

  test('agent 复述的公钥与 begin 不符 → 拒绝登记并作废本次配对', () => {
    const agent = connectAgent();
    const pairing = connectPairing();
    const m = pairingMaterial();
    hub.handlePair(pairing, m.begin);

    const attacker = generateSignKeyPair();
    const out = hub.handlePair(agent, {
      ...m.confirm,
      clientSignPubKey: attacker.publicKey,
    });
    expect(out).toEqual({ kind: 'rejected', reason: 'pair_identity_mismatch' });
    expect(store.getDevice('brand-new')).toBeNull();
    // 本次配对整体作废，重来一次也不行——必须重新扫码
    expect(hub.pendingPairBeginCount).toBe(0);
    expect(hub.handlePair(agent, m.confirm).kind).toBe('rejected');
  });

  test('agent 复述的 deviceId 与 begin 不符 → 拒绝', () => {
    const agent = connectAgent();
    const pairing = connectPairing();
    const m = pairingMaterial();
    hub.handlePair(pairing, m.begin);

    expect(
      hub.handlePair(agent, { ...m.confirm, clientDeviceId: 'someone-else' }),
    ).toEqual({ kind: 'rejected', reason: 'pair_identity_mismatch' });
    expect(store.getDevice('someone-else')).toBeNull();
  });

  test('非 agent 角色发 confirm 一律被拒（自己给自己背书无效）', () => {
    connectAgent();
    const pairing = connectPairing();
    const client = connectClient();
    const m = pairingMaterial();
    hub.handlePair(pairing, m.begin);

    // pairing 连接自己发 confirm
    expect(hub.handlePair(pairing, m.confirm)).toEqual({
      kind: 'rejected',
      reason: 'pair_confirm_from_non_agent',
    });
    // 已认证的 client 发 confirm 同样无效
    expect(hub.handlePair(client, m.confirm)).toEqual({
      kind: 'rejected',
      reason: 'pair_confirm_from_non_agent',
    });
    expect(store.getDevice('brand-new')).toBeNull();
    // 两次失败都没碰缓存，正牌 agent 仍能完成配对
    expect(hub.pendingPairBeginCount).toBe(1);
  });

  test('没走过 begin 的 token，agent 直接 confirm 也登记不了', () => {
    const agent = connectAgent();
    const m = pairingMaterial();
    expect(hub.handlePair(agent, m.confirm)).toEqual({
      kind: 'rejected',
      reason: 'pair_unknown_token',
    });
    expect(store.getDevice('brand-new')).toBeNull();
  });

  test('没有 AuthService 时拒绝而不是假装成功', () => {
    const bare = new RelayHub<FakeSocket>({
      store,
      registry,
      config,
      now: () => clock,
    });
    const agent = connectAgent();
    const pairing = connectPairing();
    const m = pairingMaterial();
    bare.addPairingConn(pairing);
    bare.handlePair(pairing, m.begin);
    expect(bare.handlePair(agent, m.confirm)).toEqual({
      kind: 'rejected',
      reason: 'pair_registration_unavailable',
    });
  });

  test('登记失败（公钥非法）不转发 confirm', () => {
    const agent = connectAgent();
    const pairing = connectPairing();
    hub.handlePair(pairing, {
      type: 'pair.begin',
      pairingToken: 'TOK',
      clientPubKey: 'CPK',
      clientSignPubKey: 'not-a-valid-key',
      clientDeviceId: 'brand-new',
    });
    pairing.ws.clear();
    const out = hub.handlePair(agent, {
      type: 'pair.confirm',
      pairingToken: 'TOK',
      clientDeviceId: 'brand-new',
      clientSignPubKey: 'not-a-valid-key',
    });
    expect(out).toEqual({
      kind: 'rejected',
      reason: 'pair_register_invalid_public_key',
    });
    expect(pairing.ws.ofType('pair.confirm')).toHaveLength(0);
  });

  test('不回传给发送方自己', () => {
    const a = connectClient('phone');
    const b = connectClient('laptop');
    connectAgent();
    a.ws.clear();
    b.ws.clear();
    hub.handleRaw(
      a,
      encodeTransportFrame({ type: 'pair.abort', pairingToken: 'TOK' }),
    );
    // 对侧是 agent，同侧的另一个 client 也不该收到
    expect(a.ws.ofType('pair.abort')).toHaveLength(0);
    expect(b.ws.ofType('pair.abort')).toHaveLength(0);
  });

  test('pairing 连接注销后不再收到转发', () => {
    const agent = connectAgent();
    const pairing = connectPairing();
    hub.removePairingConn(pairing);
    expect(hub.pairingConnCount).toBe(0);
    hub.handlePair(agent, { type: 'pair.abort', pairingToken: 'TOK' });
    expect(pairing.ws.ofType('pair.abort')).toHaveLength(0);
  });

  test('begin 缓存满时 LRU 淘汰最旧的，合法新配对永远挤得进（DoS 修 ②）', () => {
    connectAgent();
    // 灌满缓存：每条 begin 换一条新 pairing 连接，绕开单连接的 pair 帧限流
    // （限流本身就是每连接 20 帧，正是攻击者用多连接绕过的那道）
    for (let i = 0; i < PAIR_BEGIN_MAX_ENTRIES; i++) {
      hub.handlePair(connectPairing(`atk-${i}`), {
        ...pairingMaterial(`victim-${i}`).begin,
        pairingToken: `TOK-${i}`,
      });
    }
    expect(hub.pendingPairBeginCount).toBe(PAIR_BEGIN_MAX_ENTRIES);

    // 合法用户的新配对进来：不被拒，而是挤掉最旧的一条
    const fresh = pairingMaterial('legit');
    const out = hub.handlePair(connectPairing('legit'), {
      ...fresh.begin,
      pairingToken: 'TOK-FRESH',
    });
    expect(out.kind).toBe('pair_forwarded');
    // 缓存没有溢出，最旧的 TOK-0 被淘汰、新的进来了
    expect(hub.pendingPairBeginCount).toBe(PAIR_BEGIN_MAX_ENTRIES);

    // agent 用最旧那次的材料 confirm——它已被淘汰，登记不了（可接受代价）
    expect(
      hub.handlePair(connectAgent(), {
        type: 'pair.confirm',
        pairingToken: 'TOK-0',
        clientDeviceId: 'victim-0',
        clientSignPubKey: pairingMaterial('victim-0').begin.clientSignPubKey,
      }).kind,
    ).toBe('rejected');
    // 而合法用户那次仍在缓存里，能完成登记
    const agent = connectAgent();
    expect(
      hub.handlePair(agent, {
        type: 'pair.confirm',
        pairingToken: 'TOK-FRESH',
        clientDeviceId: 'legit',
        clientSignPubKey: fresh.begin.clientSignPubKey,
      }).kind,
    ).toBe('pair_registered');
  });

  test('同 token 重复 begin 刷新年龄，不会被 LRU 误当最旧淘汰', () => {
    connectAgent();
    const keep = pairingMaterial('keep');
    // 先插入 target
    hub.handlePair(connectPairing('keep'), {
      ...keep.begin,
      pairingToken: 'KEEP',
    });
    // 再灌满其余 MAX-1 条，其间对 KEEP 反复 begin 刷新
    for (let i = 0; i < PAIR_BEGIN_MAX_ENTRIES - 1; i++) {
      hub.handlePair(connectPairing(`f-${i}`), {
        ...pairingMaterial(`f-${i}`).begin,
        pairingToken: `F-${i}`,
      });
      // 每隔几条就重新 begin 一次 KEEP（client 重试的正常形态）
      if (i % 20 === 0) {
        hub.handlePair(connectPairing('keep2'), {
          ...keep.begin,
          pairingToken: 'KEEP',
        });
      }
    }
    // 再插一条触发淘汰
    hub.handlePair(connectPairing('trigger'), {
      ...pairingMaterial('trigger').begin,
      pairingToken: 'TRIGGER',
    });
    // KEEP 被刷新过，不应是最旧的——仍在缓存里，能 confirm
    expect(
      hub.handlePair(connectAgent(), {
        type: 'pair.confirm',
        pairingToken: 'KEEP',
        clientDeviceId: 'keep',
        clientSignPubKey: keep.begin.clientSignPubKey,
      }).kind,
    ).toBe('pair_registered');
  });

  test('sweepPairBegins 可独立触发，清掉过期条目（DoS 修 ③）', () => {
    const pairing = connectPairing();
    hub.handlePair(pairing, pairingMaterial('brand-new').begin);
    expect(hub.pendingPairBeginCount).toBe(1);

    // 攻击者刷完就断：过期条目不能只等 TTL 被动失效
    clock += PAIR_BEGIN_TTL_MS + 1;
    hub.sweepPairBegins();
    expect(hub.pendingPairBeginCount).toBe(0);
  });
});

describe('定期清理', () => {
  test('TTL 到点把 pending 转 expired 并广播新计数', () => {
    const client = connectClient();
    hub.handleRaw(client, relay({ seq: 1 }));
    client.ws.clear();

    clock += config.parkedTtlMs + 1;
    const result = hub.sweep();
    expect(result.parkedExpired).toBe(1);
    expect(hub.parked.get('mbp', 's1', 1)!.state).toBe('expired');
    expect(client.ws.ofType('parked.count').at(-1)!.parkedCount).toBe(0);
  });

  test('已投递的帧不会被 sweep 改成 expired', () => {
    const client = connectClient();
    hub.handleRaw(client, relay({ seq: 1 }));
    connectAgent();
    const deliveredAt = clock;

    // 走到原本的过期点（但还没到结算记录的清理线）：
    // sweep 扫得到它，可它已是 delivered，绝不能被改成 expired
    clock = deliveredAt + config.parkedTtlMs;
    expect(hub.sweep().parkedExpired).toBe(0);
    expect(hub.parked.get('mbp', 's1', 1)!.state).toBe('delivered');
  });

  test('结算记录再过一个 TTL 周期后才被清走（够 client 回来问明白）', () => {
    const client = connectClient();
    hub.handleRaw(client, relay({ seq: 1 }));
    connectAgent();
    const deliveredAt = clock;

    // 结算后不足一个 TTL：记录还在
    clock = deliveredAt + config.parkedTtlMs;
    expect(hub.sweep().settledPurged).toBe(0);
    expect(hub.parked.get('mbp', 's1', 1)!.state).toBe('delivered');

    // 超过一个 TTL：purgeSettled 清走
    clock = deliveredAt + config.parkedTtlMs + 1;
    expect(hub.sweep().settledPurged).toBe(1);
    expect(hub.parked.get('mbp', 's1', 1)).toBeNull();
  });

  test('超留存期的 relay 帧被清理', () => {
    connectClient();
    const agent = connectAgent();
    hub.handleRaw(agent, a2cRelay({ seq: 1 }));
    clock += config.relayRetentionMs + 1;
    const result = hub.sweep();
    expect(result.relayPurged).toBe(1);
    // 留存清了，基线还在（hwm TTL 远长于留存）
    expect(result.hwmPurged).toBe(0);
    expect(store.getFrame('mbp', 's1', 'a2c', 1)).toBeNull();
    expect(store.maxSeq('mbp', 's1', 'a2c', 'phone')).toBe(1);
  });

  test('超过 hwm TTL 的子流基线被清理，流变回 fresh（对抗：随机 sessionId 灌行有上界）', () => {
    connectClient();
    const agent = connectAgent();
    for (let i = 0; i < 5; i++) {
      hub.handleRaw(agent, a2cRelay({ seq: 1, sessionId: `junk-${i}` }));
    }
    expect(
      (store.db.query('SELECT COUNT(*) AS n FROM stream_hwm').get() as { n: number }).n,
    ).toBe(5);
    clock += config.hwmTtlMs + 1;
    expect(hub.sweep().hwmPurged).toBe(5);
    expect(
      (store.db.query('SELECT COUNT(*) AS n FROM stream_hwm').get() as { n: number }).n,
    ).toBe(0);
    // 变回 fresh：老会话再发任意 seq 都被接受成新基线
    agent.ws.clear();
    expect(hub.handleRaw(agent, a2cRelay({ seq: 900, sessionId: 'junk-0' })).kind).toBe('relayed');
    expect(agent.ws.ofType('relay.reject')).toHaveLength(0);
  });
});

describe('relay.reject 回执（帧不再静默蒸发）', () => {
  test('seq 回退：发起方收到带原因的回执', () => {
    const client = connectClient();
    const agent = connectAgent();
    hub.handleRaw(agent, a2cRelay({ seq: 5 }));
    agent.ws.clear();

    hub.handleRaw(agent, a2cRelay({ seq: 2 }));
    const reject = agent.ws.ofType('relay.reject');
    expect(reject).toHaveLength(1);
    expect(reject[0]).toMatchObject({
      machineId: 'mbp',
      sessionId: 's1',
      seq: 2,
      reason: 'seq_not_monotonic',
      // 高水位透传：发送方据此把计数器跳到 6 重发，不必猜
      expectedAfter: 5,
      // 被拒的是 phone 那条子流：agent 只给它重发
      recipientDeviceId: 'phone',
    });
    // 被拒的帧不会转发给对侧
    expect(client.ws.ofType('relay').map((f) => f.seq)).toEqual([5]);
  });

  test('expectedAfter 是持久高水位：留存被 sweep 清空后回执的值不归零', () => {
    const agent = connectAgent();
    hub.handleRaw(agent, a2cRelay({ seq: 5 }));
    clock += config.relayRetentionMs + 1;
    expect(hub.sweep().relayPurged).toBe(1);
    agent.ws.clear();

    hub.handleRaw(agent, a2cRelay({ seq: 3 }));
    expect(agent.ws.ofType('relay.reject')[0]).toMatchObject({
      reason: 'seq_not_monotonic',
      expectedAfter: 5,
    });
  });

  test('c2a 方向同样带 expectedAfter（client 侧自愈同款机制）', () => {
    const client = connectClient();
    connectAgent();
    hub.handleRaw(client, relay({ seq: 8 }));
    client.ws.clear();
    hub.handleRaw(client, relay({ seq: 1 }));
    const reject = client.ws.ofType('relay.reject')[0]!;
    expect(reject).toMatchObject({
      seq: 1,
      reason: 'seq_not_monotonic',
      expectedAfter: 8,
    });
    // c2a 没有收件人维度，回执也不带
    expect(reject.recipientDeviceId).toBeUndefined();
  });

  test('矩阵式配对：只有高水位高的那条子流被拒，回执定位到该收件人', () => {
    connectClient('phone');
    connectClient('tablet');
    const agent = connectAgent();
    // phone 子流已到 5；tablet 刚配对，子流 fresh
    hub.handleRaw(agent, a2cRelay({ seq: 5, recipientDeviceId: 'phone' }));
    agent.ws.clear();
    // agent 重启丢了计数器，从 1 发给两台
    hub.handleRaw(agent, a2cRelay({ seq: 1, recipientDeviceId: 'phone' }));
    hub.handleRaw(agent, a2cRelay({ seq: 1, recipientDeviceId: 'tablet' }));
    const rejects = agent.ws.ofType('relay.reject');
    expect(rejects).toHaveLength(1);
    expect(rejects[0]).toMatchObject({
      recipientDeviceId: 'phone',
      seq: 1,
      expectedAfter: 5,
    });
  });

  test('seq 0：回执 seq_below_first', () => {
    const client = connectClient();
    client.ws.clear();
    hub.handleRaw(client, relay({ seq: 0 }));
    expect(client.ws.ofType('relay.reject')[0]).toMatchObject({
      seq: 0,
      reason: 'seq_below_first',
    });
  });

  test('seq 跳跃过大：回执 seq_too_far_ahead', () => {
    const client = connectClient();
    const agent = connectAgent();
    hub.handleRaw(agent, a2cRelay({ seq: 1 }));
    agent.ws.clear();
    hub.handleRaw(agent, a2cRelay({ seq: Number.MAX_SAFE_INTEGER }));
    expect(agent.ws.ofType('relay.reject')[0]).toMatchObject({
      reason: 'seq_too_far_ahead',
      expectedAfter: 1,
    });
  });

  test('seq 0 / 排队配额满：非 seq 失配，不带 expectedAfter', () => {
    const client = connectClient();
    client.ws.clear();
    hub.handleRaw(client, relay({ seq: 0 }));
    const below = client.ws.ofType('relay.reject')[0]!;
    expect(below.reason).toBe('seq_below_first');
    expect(below.expectedAfter).toBeUndefined();
  });

  test('fresh 子流首帧 seq 很高也被接受并转发（新配对设备撞老会话高 seq）', () => {
    const client = connectClient('tablet');
    const agent = connectAgent();
    agent.ws.clear();
    hub.handleRaw(agent, a2cRelay({ seq: 30_000, recipientDeviceId: 'tablet' }));
    expect(agent.ws.ofType('relay.reject')).toHaveLength(0);
    expect(client.ws.ofType('relay').map((f) => f.seq)).toEqual([30_000]);
  });

  test('排队配额满：回执 parked_quota_exceeded', () => {
    const client = connectClient();
    for (let i = 1; i <= config.parkedMaxPerMachine; i++) {
      hub.handleRaw(client, relay({ seq: i }));
    }
    client.ws.clear();
    hub.handleRaw(client, relay({ seq: 99 }));
    expect(client.ws.ofType('relay.reject')[0]).toMatchObject({
      seq: 99,
      reason: 'parked_quota_exceeded',
    });
  });

  test('机器级帧被拒时回执省略 sessionId', () => {
    const client = connectClient();
    client.ws.clear();
    hub.handleRaw(client, relay({ sessionId: undefined, seq: 0 }));
    const reject = client.ws.ofType('relay.reject')[0]!;
    expect(reject.sessionId).toBeUndefined();
  });

  test('正常帧不产生回执', () => {
    const client = connectClient();
    const agent = connectAgent();
    agent.ws.clear();
    hub.handleRaw(agent, a2cRelay({ seq: 1 }));
    expect(agent.ws.ofType('relay.reject')).toHaveLength(0);
  });
});

describe('park.expired 告知', () => {
  test('TTL 到点：向 client 逐条广播过期坐标', () => {
    const client = connectClient();
    hub.handleRaw(client, relay({ seq: 1 }));
    hub.handleRaw(client, relay({ seq: 2 }));
    client.ws.clear();

    clock += config.parkedTtlMs + 1;
    hub.sweep();

    const expired = client.ws.ofType('park.expired');
    expect(expired.map((f) => f.seq).sort()).toEqual([1, 2]);
    expect(expired[0]).toMatchObject({ machineId: 'mbp', sessionId: 's1' });
  });

  test('密文已被裁掉导致投不出去时也告知', () => {
    const client = connectClient();
    hub.handleRaw(client, relay({ seq: 1 }));
    // 模拟密文被清掉，parked 元数据还在
    store.db.query('DELETE FROM relay_frames').run();
    client.ws.clear();

    connectAgent();
    expect(client.ws.ofType('park.expired')[0]).toMatchObject({
      machineId: 'mbp',
      sessionId: 's1',
      seq: 1,
    });
  });

  test('已投递的帧不会产生过期告知', () => {
    const client = connectClient();
    hub.handleRaw(client, relay({ seq: 1 }));
    connectAgent();
    client.ws.clear();

    clock += config.parkedTtlMs + 1;
    hub.sweep();
    expect(client.ws.ofType('park.expired')).toHaveLength(0);
  });
});

describe('N5：补发发完全部积压', () => {
  test('积压超过单次 limit 时也一次补齐', () => {
    // 本用例专测补发循环，留存上限调到足够大，免得裁剪把积压提前削掉
    hub = new RelayHub<FakeSocket>({
      store,
      registry,
      config: { ...config, relayMaxPerStream: 10_000 },
      now: () => clock,
    });
    const agent = connectAgent();
    const client = connectClient();
    // framesSince 单批上限 1000，这里造 1200 条跨过它
    const total = 1200;
    for (let i = 1; i <= total; i++) {
      hub.handleRaw(agent, a2cRelay({ seq: i }));
    }
    client.ws.clear();

    const out = hub.handleRaw(
      client,
      encodeTransportFrame({
        type: 'sync.request',
        machineId: 'mbp',
        sessionId: 's1',
        sinceSeq: 0,
      }),
    );
    // 一次 sync.request 就该把 1200 条全部发完，不留缺口
    expect(out).toEqual({ kind: 'resent', count: total });
    const seqs = client.ws.ofType('relay').map((f) => f.seq);
    expect(seqs).toHaveLength(total);
    expect(seqs[0]).toBe(1);
    expect(seqs.at(-1)).toBe(total);
  });
});

describe('N1：pair.* 频率上限', () => {
  test('超过每连接上限后被拒', () => {
    connectAgent();
    const client = connectClient();
    const pair = encodeTransportFrame({
      type: 'pair.begin',
      pairingToken: 'TOK',
      clientPubKey: 'CPK',
      clientSignPubKey: generateSignKeyPair().publicKey,
      clientDeviceId: 'brand-new',
    });
    for (let i = 0; i < PAIR_RATE_LIMIT.maxFrames; i++) {
      expect(hub.handleRaw(client, pair).kind).toBe('pair_forwarded');
    }
    expect(hub.handleRaw(client, pair)).toEqual({
      kind: 'rejected',
      reason: 'pair_rate_limited',
    });
  });

  test('窗口滑过后恢复', () => {
    connectAgent();
    const client = connectClient();
    const pair = encodeTransportFrame({
      type: 'pair.abort',
      pairingToken: 'TOK',
    });
    for (let i = 0; i < PAIR_RATE_LIMIT.maxFrames; i++) {
      hub.handleRaw(client, pair);
    }
    expect(hub.handleRaw(client, pair).kind).toBe('rejected');

    clock += PAIR_RATE_LIMIT.windowMs + 1;
    expect(hub.handleRaw(client, pair).kind).toBe('pair_forwarded');
  });

  test('上限按连接隔离，一个 client 刷爆不影响另一个', () => {
    connectAgent();
    const noisy = connectClient('noisy');
    const quiet = connectClient('quiet');
    // 用 abort 而非 confirm：confirm 会先被「非 agent 不得背书」挡下，
    // 那样就测不到限流本身了
    const pair = encodeTransportFrame({
      type: 'pair.abort',
      pairingToken: 'TOK',
    });
    for (let i = 0; i < PAIR_RATE_LIMIT.maxFrames; i++) {
      hub.handleRaw(noisy, pair);
    }
    expect(hub.handleRaw(noisy, pair).kind).toBe('rejected');
    expect(hub.handleRaw(quiet, pair).kind).toBe('pair_forwarded');
  });
});

describe('连接注册表', () => {
  test('同机器新连接顶掉旧连接', () => {
    const first = connectAgent('mbp');
    const secondWs = new FakeSocket();
    const second: Conn<FakeSocket> = {
      ws: secondWs,
      deviceId: 'mbp',
      role: 'agent',
      machineId: 'mbp',
      connectedAt: clock,
      lastSeenAt: clock,
      pendingPings: 0,
    };
    const replaced = registry.addAgent(second);
    expect(replaced?.ws).toBe(first.ws);
    expect(registry.agent('mbp')?.ws).toBe(secondWs);
  });

  test('旧连接 close 回调不会误删已顶替的新连接', () => {
    const first = connectAgent('mbp');
    const secondWs = new FakeSocket();
    registry.addAgent({
      ws: secondWs,
      deviceId: 'mbp',
      role: 'agent',
      machineId: 'mbp',
      connectedAt: clock,
      lastSeenAt: clock,
      pendingPings: 0,
    });
    registry.remove(first.ws);
    expect(registry.isAgentOnline('mbp')).toBe(true);
    expect(registry.agent('mbp')?.ws).toBe(secondWs);
  });

  test('client 移除后不再收到广播', () => {
    const client = connectClient();
    registry.remove(client.ws);
    const agent = connectAgent();
    expect(hub.handleRaw(agent, a2cRelay({ seq: 1 }))).toEqual({
      kind: 'relayed',
      dir: 'a2c',
      targets: 0,
    });
  });
});

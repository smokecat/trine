import { beforeAll, describe, expect, test } from 'bun:test';
import { sodiumReady } from '@trine/core/crypto';
import { decodeTransportFrame, type TransportFrame } from '@trine/core/protocol';
import {
  backoffDelay,
  CLOSE_REPLACED,
  CLOSE_UNAUTHENTICATED,
  DEFAULT_BACKOFF,
  REPLACED_RECONNECT_MS,
  WsClient,
  type SocketLike,
} from './ws-client.ts';

beforeAll(async () => {
  await sodiumReady();
});

/** 手动驱动的 WS 替身 */
class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private handlers = new Map<string, ((arg: never) => void)[]>();

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }
  addEventListener(type: string, fn: (arg: never) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
  }
  emit(type: string, arg?: unknown): void {
    for (const fn of this.handlers.get(type) ?? []) fn(arg as never);
  }
  frames(): TransportFrame[] {
    return this.sent.map((s) => decodeTransportFrame(s));
  }
}

/** 受控时钟：把待执行的定时任务攒起来，由测试显式触发 */
class FakeTimers {
  private pending: { fn: () => void; ms: number }[] = [];

  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    this.pending.push({ fn, ms });
    return this.pending.length - 1;
  };
  readonly clearTimeout = (): void => {
    this.pending = [];
  };
  get delays(): number[] {
    return this.pending.map((p) => p.ms);
  }
  /** 触发全部待执行任务 */
  runAll(): void {
    const batch = this.pending;
    this.pending = [];
    for (const p of batch) p.fn();
  }
}

interface Harness {
  client: WsClient;
  sockets: FakeSocket[];
  timers: FakeTimers;
  tokens: string[];
  frames: TransportFrame[];
  logs: string[];
}

function harness(over: { token?: string } = {}): Harness {
  const sockets: FakeSocket[] = [];
  const timers = new FakeTimers();
  const tokens: string[] = [];
  const frames: TransportFrame[] = [];
  const logs: string[] = [];
  let issued = 0;

  const client = new WsClient({
    url: 'wss://example.com/ws',
    deviceId: 'mbp',
    ...(over.token !== undefined ? { token: over.token } : {}),
    refreshToken: async () => {
      const t = `token-${++issued}`;
      tokens.push(t);
      return t;
    },
    onFrame: (f) => frames.push(f),
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    log: (line) => logs.push(line),
  });
  return { client, sockets, timers, tokens, frames, logs };
}

describe('指数退避', () => {
  test('按倍数增长且不超过上限', () => {
    const noJitter = { ...DEFAULT_BACKOFF, jitter: 0 };
    expect(backoffDelay(0, noJitter)).toBe(1000);
    expect(backoffDelay(1, noJitter)).toBe(2000);
    expect(backoffDelay(2, noJitter)).toBe(4000);
    // 封顶
    expect(backoffDelay(20, noJitter)).toBe(noJitter.maxMs);
  });

  test('抖动只往下减，不突破上限', () => {
    // 多台 agent 同时掉线时没有抖动会在同一毫秒一起冲回来
    const delays = Array.from({ length: 50 }, () =>
      backoffDelay(3, DEFAULT_BACKOFF),
    );
    const base = 1000 * 2 ** 3;
    expect(Math.max(...delays)).toBeLessThanOrEqual(base);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(base * 0.7 - 1);
    expect(new Set(delays).size).toBeGreaterThan(1);
  });
});

describe('建连与握手', () => {
  test('open 后第一帧就是 hello（服务端的硬要求）', async () => {
    const h = harness({ token: 'T' });
    await h.client.start();
    h.sockets[0]!.emit('open');

    const first = h.sockets[0]!.frames()[0]!;
    expect(first).toEqual({
      type: 'hello',
      v: 1,
      role: 'agent',
      deviceId: 'mbp',
      authToken: 'T',
    });
    expect(h.client.state).toBe('open');
  });

  test('没有 token 时先换一个再连', async () => {
    const h = harness();
    await h.client.start();
    h.sockets[0]!.emit('open');
    expect(h.tokens).toEqual(['token-1']);
    expect(h.sockets[0]!.frames()[0]).toMatchObject({ authToken: 'token-1' });
  });

  test('未连上时 send 返回 false 而不是抛错或排队', async () => {
    const h = harness({ token: 'T' });
    expect(h.client.send({ type: 'pair.abort', pairingToken: 'X' })).toBe(false);
    await h.client.start();
    h.sockets[0]!.emit('open');
    expect(h.client.send({ type: 'pair.abort', pairingToken: 'X' })).toBe(true);
  });

  test('入站帧过 schema 校验后交给回调', async () => {
    const h = harness({ token: 'T' });
    await h.client.start();
    h.sockets[0]!.emit('open');
    h.sockets[0]!.emit('message', {
      data: JSON.stringify({
        type: 'machine.status',
        machineId: 'mbp',
        online: true,
        lastSeenAt: 1,
      }),
    });
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]!.type).toBe('machine.status');
  });

  test('读不懂的入站帧被丢弃但不断连', async () => {
    const h = harness({ token: 'T' });
    await h.client.start();
    h.sockets[0]!.emit('open');
    h.sockets[0]!.emit('message', { data: '{"type":"不存在的帧"}' });
    expect(h.frames).toHaveLength(0);
    expect(h.client.state).toBe('open');
  });
});

describe('重连', () => {
  test('断线后按退避重连，连上即把计数归零', async () => {
    const h = harness({ token: 'T' });
    await h.client.start();
    h.sockets[0]!.emit('open');

    h.sockets[0]!.emit('close', { code: 1006, reason: 'network' });
    expect(h.client.state).toBe('reconnecting');
    expect(h.client.attempt).toBe(1);

    h.timers.runAll();
    h.sockets[1]!.emit('open');
    expect(h.client.state).toBe('open');
    // 归零：否则一次长断网会让之后每次抖动都从 60s 起步
    expect(h.client.attempt).toBe(0);
  });

  test('连续失败时等待越来越久', async () => {
    const h = harness({ token: 'T' });
    await h.client.start();
    h.sockets[0]!.emit('open');

    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      h.sockets.at(-1)!.emit('close', { code: 1006, reason: 'x' });
      delays.push(h.timers.delays[0]!);
      h.timers.runAll();
    }
    expect(delays[1]).toBeGreaterThan(delays[0]!);
    expect(delays[2]).toBeGreaterThan(delays[1]!);
  });

  test('4001 → 丢掉废 token，重连前重新认证', async () => {
    const h = harness({ token: 'stale' });
    await h.client.start();
    h.sockets[0]!.emit('open');
    expect(h.sockets[0]!.frames()[0]).toMatchObject({ authToken: 'stale' });

    h.sockets[0]!.emit('close', {
      code: CLOSE_UNAUTHENTICATED,
      reason: 'auth required',
    });
    h.timers.runAll();
    // 拿着同一个废 token 无限重连是最容易写出来的死循环，这里必须换新的
    await Promise.resolve();
    h.sockets[1]!.emit('open');
    expect(h.sockets[1]!.frames()[0]).toMatchObject({ authToken: 'token-1' });
  });

  test('断开时记下 close code 与 reason', async () => {
    const h = harness({ token: 'T' });
    await h.client.start();
    h.sockets[0]!.emit('open');
    h.sockets[0]!.emit('close', { code: 1006, reason: '' });
    h.timers.runAll();
    h.sockets[1]!.emit('open');
    h.sockets[1]!.emit('close', { code: 4003, reason: 'idle' });
    expect(h.logs).toContain('[ws] 连接关闭 code=1006');
    expect(h.logs).toContain('[ws] 连接关闭 code=4003 reason=idle');
  });

  test('4005 被顶替 → 告警并按固定长间隔重连，不走 1s 退避', async () => {
    const h = harness({ token: 'T' });
    await h.client.start();
    h.sockets[0]!.emit('open');
    h.sockets[0]!.emit('close', { code: CLOSE_REPLACED, reason: 'replaced by new connection' });

    expect(h.timers.delays).toEqual([REPLACED_RECONNECT_MS]);
    expect(h.logs.some((l) => l.includes('被同一身份的另一条连接顶替'))).toBe(true);
    // 仍然重连：对方可能只是短暂出现，放弃会让常驻 agent 永久离线
    h.timers.runAll();
    await Promise.resolve();
    expect(h.sockets).toHaveLength(2);
  });

  test('主动 stop() 之后不再重连', async () => {
    const h = harness({ token: 'T' });
    await h.client.start();
    h.sockets[0]!.emit('open');

    h.client.stop();
    expect(h.client.state).toBe('stopped');
    h.sockets[0]!.emit('close', { code: 1000, reason: 'bye' });
    h.timers.runAll();
    // 一次优雅退出不该变成无限重连
    expect(h.sockets).toHaveLength(1);
    expect(h.client.state).toBe('stopped');
  });

  test('stop() 在 socket close 事件到达时 resolve；不到达则等到上限', async () => {
    const h = harness({ token: 'T' });
    await h.client.start();
    h.sockets[0]!.emit('open');
    let resolved = false;
    const stopping = h.client.stop().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    h.sockets[0]!.emit('close', { code: 1000, reason: 'bye' });
    await stopping;
    expect(resolved).toBe(true);

    // 对端不回 close：等待上限到点后也要 resolve，进程才能退出
    const h2 = harness({ token: 'T' });
    await h2.client.start();
    h2.sockets[0]!.emit('open');
    let resolved2 = false;
    const stopping2 = h2.client.stop().then(() => {
      resolved2 = true;
    });
    await Promise.resolve();
    expect(resolved2).toBe(false);
    h2.timers.runAll();
    await stopping2;
    expect(resolved2).toBe(true);
    // 没连接时立即 resolve
    await h2.client.stop();
  });

  test('start() 幂等：已连上时不会再开一条', async () => {
    const h = harness({ token: 'T' });
    await h.client.start();
    h.sockets[0]!.emit('open');
    await h.client.start();
    expect(h.sockets).toHaveLength(1);
  });

  test('建连抛错也走退避而不是把异常抛给调用方', async () => {
    const timers = new FakeTimers();
    const client = new WsClient({
      url: 'wss://example.com/ws',
      deviceId: 'mbp',
      token: 'T',
      refreshToken: async () => 'T',
      onFrame: () => {},
      createSocket: () => {
        throw new Error('DNS 解析失败');
      },
      setTimeoutImpl: timers.setTimeout,
      clearTimeoutImpl: timers.clearTimeout,
    });
    await client.start();
    expect(client.state).toBe('reconnecting');
    expect(timers.delays).toHaveLength(1);
  });
});

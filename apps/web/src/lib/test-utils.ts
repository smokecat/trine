/**
 * lib/ 测试共用的替身：拨表时钟、脚本化 socket、a2c 帧封装。
 * 不含断言逻辑，只提供可控的环境。
 */
import { sealJson } from '@trine/core/crypto';
import type { AgentToClientEvent, TransportFrame } from '@trine/core';
import type { Clock, SocketLike } from './adapters.ts';

// ---------------------------------------------------------------------------
// FakeClock
// ---------------------------------------------------------------------------

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** 手动推进的时钟：`advance(ms)` 按到期顺序触发定时器 */
export class FakeClock implements Clock {
  #now: number;
  #timers: Timer[] = [];
  #nextId = 1;

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer: Timer = { id: this.#nextId++, at: this.#now + Math.max(0, ms), fn };
    this.#timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle);
  }

  /** 挂起中的定时器数（断言「没有遗留定时器」用） */
  get pending(): number {
    return this.#timers.length;
  }

  /** 推进 ms 毫秒，依次触发期间到期的定时器（触发中新建的到期定时器也会跑） */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      const due = this.#timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.#timers = this.#timers.filter((t) => t.id !== due.id);
      this.#now = Math.max(this.#now, due.at);
      due.fn();
      // 让定时器里触发的 Promise 链有机会跑完
      await flushMicrotasks();
    }
    this.#now = target;
    await flushMicrotasks();
  }
}

export async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// FakeSocket
// ---------------------------------------------------------------------------

type Listener = (ev: never) => void;

/** 脚本化 socket：测试手动触发 open / message / close，记录 send 的帧 */
export class FakeSocket implements SocketLike {
  readonly url: string;
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  readonly #listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  addEventListener(type: string, fn: (ev: never) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(fn);
    this.#listeners.set(type, list);
  }

  /** 已发出的帧（解析成对象） */
  get sentFrames(): TransportFrame[] {
    return this.sent.map((s) => JSON.parse(s) as TransportFrame);
  }

  emitOpen(): void {
    this.#emit('open', undefined);
  }
  emitMessage(frame: TransportFrame | string): void {
    this.#emit('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }
  emitClose(code = 1006, reason = ''): void {
    this.#emit('close', { code, reason });
  }
  emitError(err: unknown = new Error('socket error')): void {
    this.#emit('error', err);
  }

  #emit(type: string, ev: unknown): void {
    for (const fn of this.#listeners.get(type) ?? []) fn(ev as never);
  }
}

/** 记录每次 createSocket 造出的 FakeSocket */
export class FakeSocketFactory {
  readonly sockets: FakeSocket[] = [];
  readonly create = (url: string): SocketLike => {
    const s = new FakeSocket(url);
    this.sockets.push(s);
    return s;
  };
  get last(): FakeSocket {
    const s = this.sockets[this.sockets.length - 1];
    if (!s) throw new Error('还没有创建过 socket');
    return s;
  }
}

// ---------------------------------------------------------------------------
// a2c 帧封装
// ---------------------------------------------------------------------------

/** 分配式 Omit：对判别联合逐成员 Omit，保留各自字段 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type A2cBody = DistributiveOmit<AgentToClientEvent, 'ts' | 'seq' | 'dir'>;

/** 以 agent 身份把一个 a2c 事件封成 relay 帧（信封字段与密文一致） */
export function sealA2c(
  body: A2cBody,
  seq: number,
  keys: { agentSecretKey: string; clientPublicKey: string },
  machineId = 'mbp',
  recipientDeviceId = 'web-test',
  ts = 1_700_000_000_000,
): Extract<TransportFrame, { type: 'relay' }> {
  const event = { ...body, ts, seq, dir: 'a2c' } as AgentToClientEvent;
  const box = sealJson(event, keys.clientPublicKey, keys.agentSecretKey);
  return {
    type: 'relay',
    machineId,
    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    recipientDeviceId,
    seq,
    nonce: box.nonce,
    ciphertext: box.ciphertext,
  };
}

/**
 * 平台适配器：lib/ 对浏览器能力的**唯一**入口。
 *
 * lib/ 是零 React、零浏览器全局直引的纯逻辑层（方案 §3）——不是为了架构洁癖，
 * 而是因为 bun 1.3.11 里没有 localStorage / indexedDB / navigator.locks
 * （评审 C5），直接引用这些全局就没法在 `bun test` 里跑。于是所有存储、
 * 锁、跨标签页广播、时钟、WebSocket 都通过这里定义的接口注入：浏览器实现在
 * `adapters.browser.ts`，测试用本文件的内存实现。
 *
 * 接口刻意取**各浏览器 API 的最小子集**，能一比一映射到 localStorage /
 * idb-keyval / navigator.locks / BroadcastChannel / WebSocket，适配层不含逻辑。
 */

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

/** 同步键值存储（localStorage 形状）：identity / peer / prefs 这类小 JSON */
export interface KvAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** 异步文档存储（idb-keyval 形状）：时间线这类可能上百 KB 的文档 */
export interface DocStore {
  /** 不存在返回 undefined */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * 跨标签页互斥锁（navigator.locks 的子集，只有 exclusive 模式）。
 *
 * 语义与 Web Locks 一致：`callback` 被调用即表示拿到锁（`granted=true`），
 * **锁一直持有到 callback 返回的 Promise 结束**；`ifAvailable` 且当前被占
 * 时立即以 `granted=false` 调回调、不排队；`signal` 中止排队中的请求
 * （返回的 Promise 以 AbortError reject）。
 */
export interface LockAdapter {
  /** 运行环境是否真有锁（没有时 leader.ts 退化为广播心跳选举） */
  readonly available: boolean;
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (granted: boolean) => Promise<void>,
  ): Promise<void>;
}

/** 跨标签页广播（BroadcastChannel 形状）：消息**不会**回送给发送者自己 */
export interface ChannelAdapter {
  post(message: unknown): void;
  subscribe(handler: (message: unknown) => void): () => void;
  close(): void;
}

/** 时钟：所有超时/退避/去抖都走它，测试用 FakeClock 拨表 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** WebSocket 的最小接口（与 agent 的 ws-client.ts 同形，便于注入替身） */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', fn: () => void): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'close', fn: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: 'error', fn: (ev: unknown) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

// ---------------------------------------------------------------------------
// 内存实现（测试；也是浏览器存储不可用时的兜底）
// ---------------------------------------------------------------------------

export class MemoryKv implements KvAdapter {
  readonly map = new Map<string, string>();
  /**
   * 写次数（set + remove）。真实 localStorage 的每一次写都是**同步**的
   * 全量序列化，批量操作里写多少次是有意义的性能判据（评审 N6 的 e2e ⑩
   * 用它断言 resetMachineCursors 的落盘是常数次而不是 O(会话数)）。
   */
  writes = 0;
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.writes++;
    this.map.set(key, value);
  }
  remove(key: string): void {
    this.writes++;
    this.map.delete(key);
  }
}

/** 存 JSON 副本而不是引用：模拟 IndexedDB 的结构化克隆，避免测试里误共享对象 */
export class MemoryDocStore implements DocStore {
  readonly map = new Map<string, string>();
  async get(key: string): Promise<unknown> {
    const raw = this.map.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }
  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

interface LockWaiter {
  callback: (granted: boolean) => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

interface LockState {
  held: boolean;
  queue: LockWaiter[];
}

/**
 * 进程内共享的锁注册表：`adapter()` 造出的每个 LockAdapter 都共用同一份
 * 锁状态——两个 `TrineClient`/`LeaderElector` 实例各拿一个 adapter，就等价于
 * 两个标签页。`available=false` 的变体用于测试无 Web Locks 的退化路径。
 */
export class MemoryLockRegistry {
  readonly #locks = new Map<string, LockState>();

  adapter(available = true): LockAdapter {
    return {
      available,
      request: (name, options, callback) => this.#request(name, options, callback),
    };
  }

  /** 某把锁当前是否被持有（测试断言用） */
  isHeld(name: string): boolean {
    return this.#locks.get(name)?.held ?? false;
  }

  #state(name: string): LockState {
    let state = this.#locks.get(name);
    if (state === undefined) {
      state = { held: false, queue: [] };
      this.#locks.set(name, state);
    }
    return state;
  }

  #request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (granted: boolean) => Promise<void>,
  ): Promise<void> {
    const state = this.#state(name);
    if (options.signal?.aborted) {
      return Promise.reject(abortError());
    }
    if (state.held && options.ifAvailable) {
      return callback(false);
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: LockWaiter = { callback, resolve, reject, signal: options.signal, onAbort: undefined };
      if (options.signal) {
        waiter.onAbort = () => {
          const idx = state.queue.indexOf(waiter);
          if (idx >= 0) {
            state.queue.splice(idx, 1);
            reject(abortError());
          }
        };
        options.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      state.queue.push(waiter);
      this.#pump(name, state);
    });
  }

  #pump(name: string, state: LockState): void {
    if (state.held) return;
    const next = state.queue.shift();
    if (next === undefined) return;
    if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
    state.held = true;
    // 与 Web Locks 一致：回调异步执行，拿锁不在 request() 的同步栈上完成
    queueMicrotask(() => {
      next
        .callback(true)
        .then(
          () => next.resolve(),
          (err: unknown) => next.reject(err),
        )
        .finally(() => {
          state.held = false;
          this.#pump(name, state);
        });
    });
  }
}

function abortError(): Error {
  const err = new Error('lock request aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * 进程内的广播总线：`channel()` 造出的每个 ChannelAdapter 互相可见，
 * 消息异步（microtask）投递给**其他**成员——与 BroadcastChannel 一致，
 * 不回送给发送者。
 */
export class MemoryChannelHub {
  readonly #members = new Set<MemoryChannel>();

  channel(): ChannelAdapter {
    const ch = new MemoryChannel(this);
    this.#members.add(ch);
    return ch;
  }

  /** @internal */
  broadcast(from: MemoryChannel, message: unknown): void {
    for (const member of this.#members) {
      if (member === from) continue;
      queueMicrotask(() => member.deliver(message));
    }
  }

  /** @internal */
  drop(member: MemoryChannel): void {
    this.#members.delete(member);
  }
}

class MemoryChannel implements ChannelAdapter {
  readonly #handlers = new Set<(message: unknown) => void>();
  #closed = false;
  constructor(private readonly hub: MemoryChannelHub) {}
  post(message: unknown): void {
    if (this.#closed) return;
    this.hub.broadcast(this, message);
  }
  subscribe(handler: (message: unknown) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }
  close(): void {
    this.#closed = true;
    this.#handlers.clear();
    this.hub.drop(this);
  }
  /** @internal */
  deliver(message: unknown): void {
    if (this.#closed) return;
    for (const h of this.#handlers) h(message);
  }
}

/** 真实时钟（浏览器与 e2e 测试共用；FakeClock 见 test-utils.ts） */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

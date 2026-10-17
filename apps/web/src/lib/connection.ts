/**
 * 连接状态机（方案 §4.2）：认证 → 建 WS → hello → open → 断线退避重连。
 *
 *   idle → authenticating → connecting → open → backoff → authenticating → …
 *
 * - 认证：注入的 `authenticate()`（core/net AuthClient）；token 缓存到
 *   `onToken`，`expiresAt` 提前 60s 视为过期。
 * - onOpen 回调在 hello 发出后**同步**触发，调用方在里面发 sync.request
 *   ——不得 await 任何 I/O（sinceSeq 从内存态取），否则 live 帧会抢在
 *   sync.request 前到达（评审 B1）。
 * - 关闭码：`4001` 丢 token 重认证；`4006` 版本不符，**停止重连**并暴露
 *   `needs_upgrade`；其余按退避重连（1s 起、30s 封顶、20% 抖动）。
 * - `wake()`：页面回前台 → 退避中立刻重连；`stopped`（调用方明确停过）
 *   与 `needs_upgrade` 不动，恢复要显式 `start()`。
 */
import { encodeTransportFrame, decodeTransportFrame, type TransportFrame } from '@trine/core';
import type { AuthToken } from '@trine/core/net';
import { wsEndpoint } from '@trine/core/net';
import type { Clock, SocketFactory, SocketLike } from './adapters.ts';

export const CLOSE_UNAUTHENTICATED = 4001;
export const CLOSE_VERSION_MISMATCH = 4006;
/** token 提前多少视为过期 */
export const TOKEN_EXPIRY_SKEW_MS = 60_000;
/** `wake()` 的去抖窗口：移动端 visibilitychange 可以密集触发（评审 N2） */
export const WAKE_DEBOUNCE_MS = 1_000;
/** 「刚刚还连着」的窗口：`wake()` 只在这个窗口内才把退避计数归零（评审 N2） */
export const RECENT_OPEN_MS = 60_000;
/**
 * `authenticating` / `connecting` 的看门狗超时（评审 N3）。
 *
 * 这两态原本**没有任何定时器**：`authenticate()` 的 fetch 与建 socket 都可能
 * 永不 settle（手机 WiFi→蜂窝 的瞬间 TCP 半开是最常见的场景），于是状态机
 * 卡在「正在认证…」再也不动，UI 横幅连按钮都没有，只能手动刷新页面
 * （探针：10 分钟后仍 authenticating，无重试定时器在册）。
 *
 * 25s 的取值：服务端正常响应是毫秒级，移动网络最坏也在 10s 内；给足余量
 * 又不至于让用户干等太久（TCP 自己的重传要到 1 分钟以上才放弃）。
 */
export const CONNECT_WATCHDOG_MS = 25_000;
/**
 * `wake()` 眼中「中间态已经陈旧」的阈值（评审 N3）。
 *
 * 看门狗到 `CONNECT_WATCHDOG_MS` 才收，但用户点了 UI 上的「重试」（或切回
 * 前台）时不该干等剩下的十几秒。比看门狗短一截即可——短于它才有意义，
 * 又要长到不会打断一次正常的认证往返。
 */
export const STALE_CONNECTING_MS = 8_000;

export type ConnectionStatus =
  | 'idle'
  | 'authenticating'
  | 'connecting'
  | 'open'
  | 'backoff'
  | 'needs_upgrade'
  | 'stopped';

export interface ConnectionSnapshot {
  status: ConnectionStatus;
  /** 连续失败次数（open 后归零） */
  attempt: number;
  nextRetryAt: number | null;
  lastCloseCode: number | null;
  lastError: string | null;
}

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
  /** 抖动比例（往下减，保证不突破 maxMs） */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: 0.2 };

export function backoffDelay(attempt: number, options: BackoffOptions, random: () => number): number {
  const base = Math.min(options.maxMs, options.initialMs * options.factor ** attempt);
  return Math.max(0, Math.round(base - base * options.jitter * random()));
}

export interface ConnectionOptions {
  serverUrl: string;
  deviceId: string;
  /**
   * 取 token。`signal` 由看门狗在 `CONNECT_WATCHDOG_MS` 到点时 abort
   * （评审 N3）——实现方应当把它透传给 fetch，否则半开连接下这个 promise
   * 永不 settle，状态机就永远停在 `authenticating`。
   */
  authenticate: (signal: AbortSignal) => Promise<AuthToken>;
  /** 启动时的缓存 token（可能已过期，会检查） */
  token?: AuthToken | null;
  onToken?: (token: AuthToken | null) => void;
  createSocket: SocketFactory;
  clock: Clock;
  random?: () => number;
  /** hello 已发出；在此同步发 sync.request */
  onOpen: () => void;
  onFrame: (frame: TransportFrame) => void;
  onClose?: (code: number, reason: string) => void;
  onStatus?: (snapshot: ConnectionSnapshot) => void;
  backoff?: BackoffOptions;
  log?: (line: string) => void;
}

export class Connection {
  #status: ConnectionStatus = 'idle';
  #attempt = 0;
  #nextRetryAt: number | null = null;
  #lastCloseCode: number | null = null;
  #lastError: string | null = null;
  #token: AuthToken | null;
  #socket: SocketLike | null = null;
  /** 代际号：旧 socket 迟到的事件按代际丢弃 */
  #generation = 0;
  #retryHandle: unknown = null;
  #stopped = true;
  /** 上一次真正 open 成功的时刻；null = 从未连上过（评审 N2） */
  #lastOpenedAt: number | null = null;
  /** 上一次 `wake()` 被受理的时刻，用于去抖（评审 N2） */
  #lastWakeAt = Number.NEGATIVE_INFINITY;
  /** `authenticating`/`connecting` 的看门狗定时器（评审 N3） */
  #watchdogHandle: unknown = null;
  /** 当前这一轮 `#cycle()` 的取消器：看门狗到点时用它掐断在途的 authenticate */
  #abort: AbortController | null = null;
  /** 当前这一轮 `#cycle()` 的起始时刻（判断中间态是否陈旧，评审 N3） */
  #cycleStartedAt = 0;
  readonly #backoff: BackoffOptions;
  readonly #random: () => number;
  readonly #log: (line: string) => void;

  constructor(private readonly options: ConnectionOptions) {
    this.#token = options.token ?? null;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#random = options.random ?? Math.random;
    this.#log = options.log ?? (() => {});
  }

  snapshot(): ConnectionSnapshot {
    return {
      status: this.#status,
      attempt: this.#attempt,
      nextRetryAt: this.#nextRetryAt,
      lastCloseCode: this.#lastCloseCode,
      lastError: this.#lastError,
    };
  }

  get isOpen(): boolean {
    return this.#status === 'open';
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#attempt = 0;
    void this.#cycle();
  }

  /** 主动停止：关 socket、不再重连 */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clearRetry();
    this.#clearWatchdog();
    const socket = this.#socket;
    this.#socket = null;
    this.#generation++;
    if (socket) {
      try {
        socket.close(1000, 'client stop');
      } catch {
        // 已关
      }
    }
    this.#setStatus('stopped');
  }

  /**
   * 页面回前台：**正在等待重连的话就别等了，立刻重连**。
   *
   * 语义刻意定得窄——`wake()` 只是「把已经安排好的那次重连提前」，不是
   * 「不管什么状态都给我连上」。按状态：
   *
   * - `backoff`：取消定时器立刻重来（手机后台回来时最常见，退避可能还剩 20s）；
   * - `stopped`：**不重连**。`#stopped` 只由 `stop()` 置位，是调用方的明确
   *   决定（主标签让位、重置本地状态），此时另一个 client 实例很可能正持有
   *   连接；回前台就自作主张连上去会让两个实例抢同一个 deviceId 的 outSeq。
   *   要恢复请显式 `start()`；
   * - `needs_upgrade`（4006）：服务端明确拒绝了本版本，重连只会再被拒；
   * - `open`：已经连上，无事可做；
   * - `authenticating` / `connecting`：正常情况下「已经在路上」，不打扰。
   *   但**陈旧**（本轮已开始超过 `STALE_CONNECTING_MS`）的这两态就不一样了
   *   ——那多半是半开连接卡住了（评审 N3），看门狗要到
   *   `CONNECT_WATCHDOG_MS` 才收，用户此刻点「重试」应当立刻重来一轮，
   *   而不是干等。重启一轮会递代际，旧的在途 I/O 被 abort 且其回调作废。
   *
   * ## 两条防重连风暴的约束（评审 N2）
   *
   * 1. **退避计数不无条件归零**。`#attempt = 0` 原本是 close 分支里
   *    `if (opened)` 的语义——只有**真连上过**才算「这次断线是新的一轮」。
   *    搬进 wake 之后，服务端宕机期间用户每切一次前后台（锁屏解锁、切 app、
   *    下拉通知栏）都把退避打回 1s，指数退避退化成「每次切前台立刻重连一次」，
   *    电量、服务端连接配额、pairing 免认证路径的配额全被打穿
   *    （探针：20 次 wake → 21 个 socket）。这里改成只有「距上次成功 open
   *    不足 `RECENT_OPEN_MS`」才归零：刚刚还连得好好的说明网络没问题，
   *    这次断多半是瞬时的，值得从头退；连都没连上过就老老实实爬退避。
   * 2. **去抖 `WAKE_DEBOUNCE_MS`**。`visibilitychange` 在移动端可以密集触发，
   *    1s 内的重复 wake 只算一次。
   */
  wake(): void {
    if (this.#stopped) return;
    const now = this.options.clock.now();
    const stale =
      (this.#status === 'authenticating' || this.#status === 'connecting') &&
      now - this.#cycleStartedAt >= STALE_CONNECTING_MS;
    if (this.#status !== 'backoff' && !stale) return;
    if (now - this.#lastWakeAt < WAKE_DEBOUNCE_MS) return;
    this.#lastWakeAt = now;
    this.#clearRetry();
    if (stale) {
      // 掐断卡住的那一轮，否则它的 socket/fetch 会和新一轮并存
      this.#abortCycle('wake：中间态已陈旧，重启一轮');
      this.#attempt++; // 这一轮算失败过，退避照常往上爬
    } else if (this.#lastOpenedAt !== null && now - this.#lastOpenedAt < RECENT_OPEN_MS) {
      // 刚才还连着（瞬时断线）才把退避打回头，否则继续爬——见上面第 1 条
      this.#attempt = 0;
    }
    void this.#cycle();
  }

  send(frame: TransportFrame): boolean {
    if (this.#status !== 'open' || this.#socket === null) return false;
    try {
      this.#socket.send(encodeTransportFrame(frame));
      return true;
    } catch (err) {
      this.#log(`[conn] send 失败：${String(err)}`);
      return false;
    }
  }

  // ---- 内部 ----

  async #cycle(): Promise<void> {
    if (this.#stopped) return;
    const generation = ++this.#generation;
    const now = this.options.clock.now();
    this.#cycleStartedAt = now;
    this.#armWatchdog(generation);
    const abort = new AbortController();
    this.#abort = abort;
    if (this.#token === null || this.#token.expiresAt - TOKEN_EXPIRY_SKEW_MS <= now) {
      this.#setStatus('authenticating');
      try {
        const token = await this.options.authenticate(abort.signal);
        if (this.#stopped || generation !== this.#generation) return;
        this.#token = token;
        this.options.onToken?.(token);
      } catch (err) {
        if (this.#stopped || generation !== this.#generation) return;
        this.#lastError = err instanceof Error ? err.message : String(err);
        this.#log(`[conn] 认证失败：${this.#lastError}`);
        this.#scheduleRetry();
        return;
      }
    }

    this.#setStatus('connecting');
    let socket: SocketLike;
    try {
      socket = this.options.createSocket(wsEndpoint(this.options.serverUrl));
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
      this.#scheduleRetry();
      return;
    }
    this.#socket = socket;
    let opened = false;
    let closed = false;

    socket.addEventListener('open', () => {
      if (generation !== this.#generation) return;
      opened = true;
      const token = this.#token;
      if (token === null) return;
      socket.send(
        encodeTransportFrame({
          type: 'hello',
          v: 1,
          role: 'client',
          deviceId: this.options.deviceId,
          authToken: token.token,
        }),
      );
      this.#attempt = 0;
      this.#lastOpenedAt = this.options.clock.now();
      this.#lastError = null;
      this.#clearWatchdog(); // 到 open 了，看门狗功成身退
      this.#setStatus('open');
      this.options.onOpen();
    });
    socket.addEventListener('message', (ev) => {
      if (generation !== this.#generation) return;
      let frame: TransportFrame;
      try {
        frame = decodeTransportFrame(String(ev.data));
      } catch (err) {
        this.#log(`[conn] 丢弃无法解析的帧：${String(err)}`);
        return;
      }
      this.options.onFrame(frame);
    });
    socket.addEventListener('close', (ev) => {
      if (generation !== this.#generation || closed) return;
      closed = true;
      this.#socket = null;
      this.#lastCloseCode = ev.code;
      this.options.onClose?.(ev.code, ev.reason);
      if (this.#stopped) return;
      if (ev.code === CLOSE_UNAUTHENTICATED) {
        // token 已废：丢掉，下一轮重新挑战-应答
        this.#token = null;
        this.options.onToken?.(null);
      }
      if (ev.code === CLOSE_VERSION_MISMATCH) {
        this.#log('[conn] 服务端协议版本不符，停止重连');
        this.#clearWatchdog();
        this.#setStatus('needs_upgrade');
        return;
      }
      if (opened) this.#attempt = 0;
      this.#scheduleRetry();
    });
    socket.addEventListener('error', (err) => {
      if (generation !== this.#generation) return;
      this.#lastError = err instanceof Error ? err.message : 'socket error';
      // 浏览器与 Bun 都会紧跟着触发 close；这里只记录
    });
  }

  /**
   * 给这一轮 `#cycle()` 挂看门狗：`CONNECT_WATCHDOG_MS` 内没进 `open` 就
   * 当这一轮失败，掐断在途的 authenticate / socket 并走退避重连。
   *
   * **代际号是必须的**：被掐断的那次 authenticate 的 promise 可能在很久之后
   * 才 settle（甚至成功），若不递代际，它会用陈旧的 token 覆盖新一轮的状态。
   * 这里先 `#generation++` 再安排重试，旧回调返回时 `generation !==
   * this.#generation` 必然成立，一律被丢弃。
   */
  #armWatchdog(generation: number): void {
    this.#clearWatchdog();
    this.#watchdogHandle = this.options.clock.setTimeout(() => {
      this.#watchdogHandle = null;
      if (this.#stopped || generation !== this.#generation) return;
      if (this.#status !== 'authenticating' && this.#status !== 'connecting') return;
      this.#lastError = `连接超时（${this.#status === 'authenticating' ? '认证' : '建立连接'}）`;
      this.#abortCycle(`${this.#status} 超过 ${CONNECT_WATCHDOG_MS}ms 无进展，判为失败并重试`);
      this.#scheduleRetry();
    }, CONNECT_WATCHDOG_MS);
  }

  /**
   * 掐断当前这一轮 `#cycle()`：作废代际、abort 在途的 authenticate、关掉
   * 可能半开的 socket。看门狗与 `wake()` 的「陈旧中间态」两条路共用。
   *
   * **先递代际再掐断**：顺序反了的话 abort 触发的 catch 分支会拿着仍然有效的
   * 代际去 `#scheduleRetry()`，排出两个重试定时器。
   */
  #abortCycle(why: string): void {
    this.#log(`[conn] ${why}`);
    this.#generation++;
    this.#clearWatchdog();
    this.#abort?.abort();
    this.#abort = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      try {
        socket.close(1000, 'connect timeout');
      } catch {
        // 已关或半开，无所谓——代际已作废，它的事件不会再被处理
      }
    }
  }

  #clearWatchdog(): void {
    if (this.#watchdogHandle !== null) {
      this.options.clock.clearTimeout(this.#watchdogHandle);
      this.#watchdogHandle = null;
    }
  }

  #scheduleRetry(): void {
    if (this.#stopped) return;
    this.#clearWatchdog();
    const delay = backoffDelay(this.#attempt, this.#backoff, this.#random);
    this.#attempt++;
    this.#nextRetryAt = this.options.clock.now() + delay;
    this.#setStatus('backoff');
    this.#retryHandle = this.options.clock.setTimeout(() => {
      this.#retryHandle = null;
      this.#nextRetryAt = null;
      void this.#cycle();
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryHandle !== null) {
      this.options.clock.clearTimeout(this.#retryHandle);
      this.#retryHandle = null;
    }
    this.#nextRetryAt = null;
  }

  #setStatus(status: ConnectionStatus): void {
    this.#status = status;
    this.options.onStatus?.(this.snapshot());
  }
}

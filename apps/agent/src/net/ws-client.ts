/**
 * agent 侧的 WS 客户端：建连 → hello → 收发帧 → 断线指数退避重连（D2）。
 *
 * agent **只出站**（D2 / 项目约束）：不开监听端口，一律主动连服务端，
 * 对 NAT 与家用宽带友好。因此重连的节奏完全由本端掌握——服务端那侧只管
 * 快速清理死连接。
 *
 * ## 关掉与断掉的区别
 *
 * `stop()` 是主动关闭，之后**不再重连**；其余所有断开（网络抖动、服务端
 * 重启、被顶替）都要重连。混作一谈的话，一次优雅退出会变成无限重连。
 *
 * ## token 过期
 *
 * 服务端以 4001（UNAUTHENTICATED）关连接。此时重连也没用——手里的 token
 * 已经废了。所以重连前会调 `refreshToken`（由调用方注入，走挑战-应答），
 * 拿到新 token 再连。
 *
 * ## 被顶替（4005）
 *
 * 服务端对同一 machineId 只留一条 agent 连接，新连接进来就以 4005 踢掉旧的。
 * 本进程自己的重连不会撞上它（旧 socket 早已断开），撞上几乎总是**另一个
 * 进程/机器在用同一身份**。这时照常 1s 退避重连只会和对方每秒互踢一次，
 * 所以改用固定的长间隔并明确告警；仍然重连而不是放弃——对方可能只是短暂
 * 出现（例如误起的前台进程），放弃会让常驻 agent 永久离线。
 */
import {
  decodeTransportFrame,
  encodeTransportFrame,
  type TransportFrame,
} from '@trine/core/protocol';

/** 服务端的 UNAUTHENTICATED 关闭码（与 apps/server 的 CLOSE 对齐） */
export const CLOSE_UNAUTHENTICATED = 4001;

/** 服务端的 REPLACED 关闭码：同一 machineId 的新连接顶替了本连接 */
export const CLOSE_REPLACED = 4005;

/** 被顶替后的重连间隔（见文件头） */
export const REPLACED_RECONNECT_MS = 30_000;

/**
 * `stop()` 等 socket 真正 close 的上限。退出路径在 stop 之后紧接 process.exit，
 * 不等的话刚 send 的帧（permission.invalidated 等收尾帧）可能还在内核缓冲里；
 * 但也不能无限等——对端不回 close 握手时进程得能退出。
 */
export const CLOSE_WAIT_MS = 500;

export interface BackoffOptions {
  /** 首次重连等待 */
  initialMs: number;
  /** 上限，避免长时间断网后越等越离谱 */
  maxMs: number;
  /** 每次失败的倍数 */
  factor: number;
  /**
   * 抖动比例（0~1）。多台 agent 同时掉线时（服务端重启）没有抖动就会
   * 在同一毫秒一起冲回来，把刚起来的服务端再打趴一次。
   */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 1_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.3,
};

/** 第 n 次重试（从 0 起）的等待时长 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const base = Math.min(
    options.maxMs,
    options.initialMs * options.factor ** attempt,
  );
  // 抖动只往下减不往上加：上加会突破 maxMs 这个明确承诺
  const jitter = base * options.jitter * random();
  return Math.max(0, Math.round(base - jitter));
}

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'stopped';

/** WebSocket 的最小接口，便于注入测试替身 */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', fn: () => void): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    fn: (ev: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: 'error', fn: (ev: unknown) => void): void;
}

export interface WsClientOptions {
  /** WS 地址，如 `wss://trine.example.com/ws` */
  url: string;
  deviceId: string;
  /** 当前 token；为空时先调 refreshToken */
  token?: string;
  /** 重新走挑战-应答换 token（token 过期或首次接入时调用） */
  refreshToken: () => Promise<string>;
  /** 收到一帧（已过 schema 校验） */
  onFrame: (frame: TransportFrame) => void;
  /** 连接就绪——补发请求（sync.request）应在这里发出 */
  onOpen?: (client: WsClient) => void | Promise<void>;
  onClose?: (info: { code: number; reason: string }) => void;
  onError?: (err: unknown) => void;
  /** 注入 WebSocket 构造，测试用 */
  createSocket?: (url: string) => SocketLike;
  backoff?: BackoffOptions;
  /** 被 4005 顶替后的重连间隔，默认 REPLACED_RECONNECT_MS */
  replacedReconnectMs?: number;
  /** 注入定时器，测试用 */
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  log?: (line: string) => void;
}

export class WsClient {
  #socket: SocketLike | null = null;
  #state: ConnectionState = 'idle';
  #attempt = 0;
  #token: string | undefined;
  #retryHandle: unknown = null;
  /** 主动 stop() 过：任何后续断开都不再重连 */
  #stopped = false;

  private readonly backoff: BackoffOptions;
  private readonly log: (line: string) => void;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;

  constructor(private readonly options: WsClientOptions) {
    this.#token = options.token;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.log = options.log ?? (() => {});
    this.setTimeoutImpl =
      options.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutImpl =
      options.clearTimeoutImpl ?? ((h) => clearTimeout(h as never));
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** 当前重连尝试次数（0 = 上次连接成功过） */
  get attempt(): number {
    return this.#attempt;
  }

  /** 建立连接（幂等：已连上或正在连时无操作） */
  async start(): Promise<void> {
    if (this.#state === 'open' || this.#state === 'connecting') return;
    this.#stopped = false;
    await this.#connect();
  }

  /**
   * 主动关闭，不再重连。返回的 Promise 在 socket 收到 close 事件、或
   * CLOSE_WAIT_MS 到点时 resolve——调用方据此决定何时可以 process.exit。
   */
  stop(code = 1000, reason = 'client shutdown'): Promise<void> {
    this.#stopped = true;
    this.#state = 'stopped';
    if (this.#retryHandle !== null) {
      this.clearTimeoutImpl(this.#retryHandle);
      this.#retryHandle = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    if (!socket) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      let handle: unknown = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (handle !== null) this.clearTimeoutImpl(handle);
        resolve();
      };
      handle = this.setTimeoutImpl(finish, CLOSE_WAIT_MS);
      socket.addEventListener('close', finish);
      try {
        socket.close(code, reason);
      } catch {
        // 已经关掉的连接再关一次不算错；也不会再来 close 事件，直接结束
        finish();
      }
    });
  }

  /**
   * 发一帧。连接不在时返回 false 而不是抛错或排队。
   *
   * **刻意不做本地重发队列**：出站事件的补发语义已经由服务端的 relay 留存
   * + `sync.request` 承担了，再在这里搭一层队列就是两套互相不知道对方存在
   * 的补发机制，重连后要么重复要么打架。发不出去的帧由上层决定怎么办。
   */
  send(frame: TransportFrame): boolean {
    if (this.#state !== 'open' || !this.#socket) return false;
    try {
      this.#socket.send(encodeTransportFrame(frame));
      return true;
    } catch {
      return false;
    }
  }

  async #connect(): Promise<void> {
    this.#state = 'connecting';
    let token = this.#token;
    if (!token) {
      try {
        token = await this.options.refreshToken();
        this.#token = token;
      } catch (err) {
        this.options.onError?.(err);
        this.#scheduleReconnect();
        return;
      }
    }

    let socket: SocketLike;
    try {
      socket = (this.options.createSocket ??
        ((url: string) => new WebSocket(url) as unknown as SocketLike))(
        this.options.url,
      );
    } catch (err) {
      this.options.onError?.(err);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.addEventListener('open', () => {
      // hello 必须是第一帧（服务端的握手要求）
      socket.send(
        encodeTransportFrame({
          type: 'hello',
          v: 1,
          role: 'agent',
          deviceId: this.options.deviceId,
          authToken: this.#token!,
        }),
      );
      this.#state = 'open';
      // 连上就把退避重置，否则一次长时间断网会让之后每次抖动都从 60s 起步
      this.#attempt = 0;
      void this.options.onOpen?.(this);
    });

    socket.addEventListener('message', (ev) => {
      let frame: TransportFrame;
      try {
        frame = decodeTransportFrame(String(ev.data));
      } catch (err) {
        // 服务端发来读不懂的帧：记下但不断连——多半是版本不齐，
        // 断了也不会变好，其余帧还能正常工作
        this.log(`[ws] 丢弃无法解析的入站帧：${(err as Error).message}`);
        return;
      }
      this.options.onFrame(frame);
    });

    socket.addEventListener('error', (err) => {
      this.options.onError?.(err);
    });

    socket.addEventListener('close', (ev) => {
      this.#socket = null;
      this.options.onClose?.(ev);
      if (this.#stopped) {
        this.#state = 'stopped';
        return;
      }
      this.log(`[ws] 连接关闭 code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ''}`);
      if (ev.code === CLOSE_REPLACED) {
        this.log(
          '[ws] 被同一身份的另一条连接顶替：是否有另一个 agent 进程（或另一台机器）' +
            '在用同一份身份？两边会在服务端互相顶替，请只保留一个',
        );
        this.#scheduleReconnect(this.options.replacedReconnectMs ?? REPLACED_RECONNECT_MS);
        return;
      }
      // 4001：手里的 token 已经不管用了，丢掉它，重连前重新换一个。
      // 不丢的话会拿着同一个废 token 无限重连、无限被 4001 踢掉。
      if (ev.code === CLOSE_UNAUTHENTICATED) {
        this.log('[ws] token 已失效，重连前重新认证');
        this.#token = undefined;
      }
      this.#scheduleReconnect();
    });
  }

  /** `fixedDelayMs`：不走指数退避，用指定间隔（被顶替时） */
  #scheduleReconnect(fixedDelayMs?: number): void {
    if (this.#stopped) return;
    this.#state = 'reconnecting';
    const delay = fixedDelayMs ?? backoffDelay(this.#attempt, this.backoff);
    this.#attempt++;
    this.log(`[ws] ${delay}ms 后重连（第 ${this.#attempt} 次）`);
    this.#retryHandle = this.setTimeoutImpl(() => {
      this.#retryHandle = null;
      void this.#connect();
    }, delay);
  }
}

/**
 * `codex app-server` 的 stdio 客户端（JSON-RPC，换行分隔，线上不带 jsonrpc 头）。
 *
 * 惰性启动：第一次 call 才拉起进程并握手；空闲一段时间自动退出，下次 call 再起。
 * 进程只归 trine-agent 所有，不接本机共享的 app-server daemon（生命周期不归我们）。
 *
 * 协议没有稳定性承诺，又随 Codex 自更新，所以这一层不解释业务字段，只负责收发。
 */
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_MS = 5 * 60_000;
/** 启动失败后这么久内不重试：列表每次都等一个起不来的进程不值 */
const DEFAULT_START_RETRY_MS = 60_000;

export interface AppServerTransport {
  send(line: string): void;
  kill(): void;
}

export interface AppServerHandlers {
  onLine(line: string): void;
  onExit(): void;
}

export type SpawnAppServer = (handlers: AppServerHandlers) => AppServerTransport;

export class AppServerError extends Error {
  constructor(
    message: string,
    /** JSON-RPC 错误码；进程退出 / 超时等本地错误没有 */
    readonly code?: number,
  ) {
    super(message);
    this.name = 'AppServerError';
  }
}

export interface AppServerClientOptions {
  spawn: SpawnAppServer;
  clientVersion: string;
  callTimeoutMs?: number;
  idleMs?: number;
  startRetryMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  /**
   * 服务端发来的请求（审批等）。返回 false = 不处理，这里回错误，免得对端干等。
   * 返回 true 但要异步才知道处理不了（如先查子 thread 归属）时，调 `fail` 回错误。
   */
  onServerRequest?: (
    id: unknown,
    method: string,
    params: Record<string, unknown>,
    reply: (result: unknown) => void,
    fail: (code: number, message: string) => void,
  ) => boolean;
  /** 进程退出（不含空闲退出和 dispose）：加载的 thread 都没了 */
  onExit?: () => void;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 真实进程。按字节流切行：chunk 边界可能落在一行（甚至一个多字节字符）中间 */
export function spawnCodexAppServer(bin: string): SpawnAppServer {
  return (handlers) => {
    const proc = Bun.spawn([bin, 'app-server'], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      const reader = proc.stdout.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          handlers.onLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf('\n');
        }
      }
    })()
      .catch(() => {})
      .finally(() => handlers.onExit());
    return {
      send: (line) => {
        void proc.stdin.write(line);
        void proc.stdin.flush();
      },
      kill: () => proc.kill(),
    };
  };
}

export class AppServerClient {
  readonly #options: AppServerClientOptions;
  readonly #callTimeoutMs: number;
  readonly #idleMs: number;
  readonly #startRetryMs: number;
  readonly #now: () => number;
  readonly #pending = new Map<number, PendingCall>();
  #transport: AppServerTransport | undefined;
  #ready: Promise<void> | undefined;
  #nextId = 1;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #inFlight = 0;
  #holds = 0;
  #startFailedAt: number | undefined;
  #startError: Error | undefined;
  #userAgent: string | undefined;
  #disposed = false;

  constructor(options: AppServerClientOptions) {
    this.#options = options;
    this.#callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.#startRetryMs = options.startRetryMs ?? DEFAULT_START_RETRY_MS;
    this.#now = options.now ?? Date.now;
  }

  /** 握手拿到的 userAgent，如 `trine/0.166.0 (...)`；还没握手过是 undefined */
  get userAgent(): string | undefined {
    return this.#userAgent;
  }

  get running(): boolean {
    return this.#transport !== undefined;
  }

  async call(method: string, params: unknown): Promise<unknown> {
    if (this.#disposed) throw new AppServerError('app-server 客户端已关闭');
    this.#inFlight += 1;
    this.#clearIdle();
    try {
      await this.#ensureReady();
      return await this.#request(method, params);
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0 && this.#holds === 0) this.#armIdle();
    }
  }

  /** 有加载中的 thread 时持有：空闲退出会把它们一起带走 */
  hold(): void {
    this.#holds += 1;
    this.#clearIdle();
  }

  release(): void {
    this.#holds = Math.max(0, this.#holds - 1);
    if (this.#holds === 0 && this.#inFlight === 0) this.#armIdle();
  }

  /** 换掉进程（Codex 更新后）：下次调用起新版。有 thread 或请求在用时不动，等它们用完自然退出 */
  recycle(): void {
    if (this.#holds === 0 && this.#inFlight === 0) this.#stop(new AppServerError('app-server 更新后重启'));
  }

  /**
   * 立即换掉进程（机器页「重启 Codex」：换账号后旧进程不重新读登录）。加载着的 thread 会随之失效，
   * 按进程退出处理（onExit），下一条消息 resume；有没有轮次在跑由调用方先查。没在运行 = 什么都不做
   */
  restart(): void {
    if (this.#transport === undefined) return;
    this.#clearIdle();
    this.#startFailedAt = undefined;
    this.#startError = undefined;
    this.#stop(new AppServerError('app-server 已重启'));
    this.#options.onExit?.();
  }

  dispose(): void {
    this.#disposed = true;
    this.#stop(new AppServerError('app-server 客户端已关闭'));
  }

  #ensureReady(): Promise<void> {
    if (this.#ready !== undefined) return this.#ready;
    if (
      this.#startFailedAt !== undefined &&
      this.#startError !== undefined &&
      this.#now() - this.#startFailedAt < this.#startRetryMs
    ) {
      return Promise.reject(this.#startError);
    }
    const ready = this.#start().catch((err: unknown) => {
      const error = err instanceof Error ? err : new AppServerError(String(err));
      this.#startFailedAt = this.#now();
      this.#startError = error;
      this.#stop(error);
      throw error;
    });
    this.#ready = ready;
    return ready;
  }

  async #start(): Promise<void> {
    const transport = this.#options.spawn({
      onLine: (line) => {
        if (this.#transport === transport) this.#onLine(line);
      },
      onExit: () => {
        if (this.#transport !== transport) return;
        this.#options.log?.('[codex] app-server 已退出');
        this.#stop(new AppServerError('app-server 进程已退出'));
        this.#options.onExit?.();
      },
    });
    this.#transport = transport;
    const result = await this.#request('initialize', {
      clientInfo: { name: 'trine', title: 'trine', version: this.#options.clientVersion },
    });
    if (isRecord(result) && typeof result['userAgent'] === 'string') this.#userAgent = result['userAgent'];
    transport.send(`${JSON.stringify({ method: 'initialized' })}\n`);
    this.#startFailedAt = undefined;
    this.#startError = undefined;
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const transport = this.#transport;
    if (transport === undefined) return Promise.reject(new AppServerError('app-server 没有运行'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AppServerError(`${method} 超时`));
      }, this.#callTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        transport.send(`${JSON.stringify({ id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new AppServerError(`写入 app-server 失败：${String(err)}`));
      }
    });
  }

  #onLine(line: string): void {
    if (line.trim() === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#options.log?.('[codex] app-server 输出了无法解析的行，已忽略');
      return;
    }
    if (!isRecord(message)) return;
    const id = message['id'];
    if (typeof message['method'] === 'string') {
      const params = isRecord(message['params']) ? message['params'] : {};
      if (id === undefined) {
        this.#options.onNotification?.(message['method'], params);
        return;
      }
      const transport = this.#transport;
      // 请求所在的进程已经没了，回复不了也不需要回复
      const live = (): boolean => this.#transport === transport;
      const fail = (code: number, msg: string): void => {
        if (live()) transport?.send(`${JSON.stringify({ id, error: { code, message: msg } })}\n`);
      };
      const handled = this.#options.onServerRequest?.(
        id,
        message['method'],
        params,
        (result) => {
          if (live()) transport?.send(`${JSON.stringify({ id, result })}\n`);
        },
        fail,
      );
      if (handled !== true) fail(-32601, 'not supported by this client');
      return;
    }
    if (typeof id !== 'number') return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const error = message['error'];
    if (isRecord(error)) {
      pending.reject(
        new AppServerError(
          typeof error['message'] === 'string' ? error['message'] : 'app-server 返回错误',
          typeof error['code'] === 'number' ? error['code'] : undefined,
        ),
      );
    } else {
      pending.resolve(message['result']);
    }
  }

  #stop(reason: Error): void {
    this.#clearIdle();
    const transport = this.#transport;
    this.#transport = undefined;
    this.#ready = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
    try {
      transport?.kill();
    } catch {
      // 进程可能已经退出
    }
  }

  #armIdle(): void {
    this.#clearIdle();
    if (this.#transport === undefined || this.#disposed) return;
    this.#idleTimer = setTimeout(() => {
      if (this.#inFlight === 0 && this.#holds === 0) this.#stop(new AppServerError('app-server 空闲退出'));
    }, this.#idleMs);
    this.#idleTimer.unref?.();
  }

  #clearIdle(): void {
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }
}

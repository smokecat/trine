/** 子命令侧的控制通道客户端：连 daemon 的 control.sock，收发换行分隔 JSON */
import { connect, type Socket } from 'node:net';
import {
  ControlEventSchema,
  encodeLine,
  LineDecoder,
  type ControlEvent,
  type ControlRequest,
} from './protocol.ts';

export class ControlClient {
  readonly #queue: ControlEvent[] = [];
  readonly #waiters: ((event: ControlEvent | null) => void)[] = [];
  #closed = false;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    const decoder = new LineDecoder();
    socket.on('data', (chunk: string) => {
      const { lines, overflow } = decoder.push(chunk);
      for (const line of lines) {
        let event: ControlEvent;
        try {
          event = ControlEventSchema.parse(JSON.parse(line));
        } catch {
          event = { ev: 'error', message: 'agent 回了无法识别的消息（agent 与命令版本不一致？）', fatal: true };
        }
        this.#deliver(event);
      }
      if (overflow) socket.destroy();
    });
    socket.on('error', () => {
      // close 里统一收尾
    });
    socket.on('close', () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(null);
    });
  }

  /**
   * 连接 daemon。socket 不存在或没人在听（daemon 没跑 / 崩溃留下的残骸）
   * 返回 null；其余错误照抛。
   */
  static async connect(path: string): Promise<ControlClient | null> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      const onError = (err: NodeJS.ErrnoException): void => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') resolve(null);
        else reject(err);
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.off('error', onError);
        resolve(new ControlClient(socket));
      });
    });
  }

  send(request: ControlRequest): void {
    if (!this.#closed) this.socket.write(encodeLine(request));
  }

  /** 下一条事件；连接已断返回 null */
  next(): Promise<ControlEvent | null> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** 发一个请求并等第一条回应（一问一答的操作用） */
  async request(request: ControlRequest): Promise<ControlEvent | null> {
    this.send(request);
    return this.next();
  }

  close(): void {
    this.socket.end();
  }

  #deliver(event: ControlEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(event);
    else this.#queue.push(event);
  }
}

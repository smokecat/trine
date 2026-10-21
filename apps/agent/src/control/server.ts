/**
 * daemon 侧的控制通道：在 `<home>/control.sock` 上接受本机子命令的请求。
 *
 * 协议与信任边界见 protocol.ts。这里只做两件事：
 * - 一问一答的查询/操作（status、devices.list、devices.revoke）；
 * - 有状态的配对：pair.start 在 daemon 里开一次配对，pair.begin 到达时把 SAS
 *   推给发起它的那条连接，等子命令里的人比对后回 pair.answer。
 *
 * 配对会话归属于发起它的连接：连接断开（用户 Ctrl-C、终端关掉）即中止，
 * 不留一个没人看着的有效配对码。
 */
import { chmodSync, lstatSync, statSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { PairingSession, PeerIdentity } from '../net/pairing.ts';
import {
  ControlRequestSchema,
  encodeLine,
  LineDecoder,
  type ControlEvent,
  type ControlRequest,
  type DeviceInfo,
  type ExtListItem,
} from './protocol.ts';
import type { RestartNotice, RestartOutcome } from '../app/restart.ts';

/** daemon 暴露给控制通道的能力（生产由 AgentApp 适配，测试可替换） */
export interface ControlHost {
  status(): { machineId: string; name: string; online: boolean; devices: number };
  listDevices(): DeviceInfo[];
  revokeDevice(deviceId: string): Promise<boolean>;
  startPairing(): PairingSession;
  confirmPairing(pairingToken: string, expected: PeerIdentity): Promise<boolean>;
  abortPairing(pairingToken: string, reason: string): void;
  /** 扩展注册表；不给 = 不支持（测试） */
  extensions?: {
    list(): ExtListItem[];
    add(path: string): Promise<ExtListItem>;
    remove(id: string): Promise<boolean>;
    reload(id?: string): Promise<ExtListItem[]>;
  };
  /** 重启 agent；不给 = 不支持（测试） */
  restart?: {
    request(req: { now: boolean; notice?: RestartNotice }): Promise<RestartOutcome>;
    cancel(): RestartOutcome;
    /** 排空进度（restart.result 附带给命令行看） */
    pending(): { busySessions: number; deadline?: number } | undefined;
  };
}

export interface ControlServerOptions {
  pid?: number;
  now?: () => number;
  log?: (line: string) => void;
}

interface PendingRequest {
  requestId: number;
  peer: PeerIdentity;
}

interface Connection {
  socket: Socket;
  /** 本连接发起的、仍有效的配对 */
  pairingToken: string | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  /** 最近一次推给用户的配对请求；更早的 requestId 一律作废 */
  request: PendingRequest | null;
  /** 正在确认中（confirm 是异步的），防同一请求被确认两次 */
  answering: boolean;
}

export class ControlServer {
  readonly #connections = new Set<Connection>();
  #server: Server | null = null;
  #path: string | null = null;
  #nextRequestId = 1;
  readonly #pid: number;
  readonly #now: () => number;
  readonly #log: (line: string) => void;

  constructor(
    private readonly host: ControlHost,
    options: ControlServerOptions = {},
  ) {
    this.#pid = options.pid ?? process.pid;
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.log ?? (() => {});
  }

  /**
   * 开始监听。调用方必须已持有单实例锁——所以路径上已有的 socket 一定是
   * 上一个进程崩溃留下的残骸，直接删掉。不是 socket 的同名文件不碰，报错。
   */
  async listen(path: string): Promise<void> {
    const dirMode = statSync(dirname(path)).mode & 0o777;
    if ((dirMode & 0o077) !== 0) {
      this.#log(
        `[control] 警告：${dirname(path)} 权限为 ${dirMode.toString(8)}，建议 chmod 700——` +
          '控制通道可以发起配对和撤销设备，只应对本用户开放',
      );
    }
    try {
      if (!lstatSync(path).isSocket()) {
        throw new Error(`${path} 已存在且不是 socket，拒绝覆盖`);
      }
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const server = createServer((socket) => this.#accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(path, 0o600);
    server.on('error', (err) => this.#log(`[control] 监听出错：${err.message}`));
    this.#server = server;
    this.#path = path;
  }

  /** 关闭监听、断开全部连接（其上进行中的配对随之中止）、删 socket 文件 */
  async close(): Promise<void> {
    for (const conn of this.#connections) conn.socket.destroy();
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.#path !== null) {
      try {
        unlinkSync(this.#path);
      } catch {
        // 已经不在了
      }
      this.#path = null;
    }
  }

  /**
   * AgentApp.onPairingRequest 的分发入口：配对是本通道发起的就接手并返回 true，
   * 否则返回 false（交给前台 `--pair` 的终端处理）。
   */
  onPairingRequest(session: PairingSession): boolean {
    const conn = this.#owner(session.pairingToken);
    const peer = session.pending;
    if (!conn || !peer) return false;
    const requestId = this.#nextRequestId++;
    conn.request = {
      requestId,
      peer: {
        clientDeviceId: peer.clientDeviceId,
        clientPubKey: peer.clientPubKey,
        clientSignPubKey: peer.clientSignPubKey,
      },
    };
    this.#send(conn, {
      ev: 'pair.request',
      requestId,
      peer: { clientDeviceId: peer.clientDeviceId, digits: peer.sas.digits, emoji: peer.sas.emoji },
    });
    return true;
  }

  /** client 放弃了配对：通知发起它的子命令 */
  onPairingAborted(pairingToken: string): boolean {
    const conn = this.#owner(pairingToken);
    if (!conn) return false;
    this.#clearPairing(conn);
    this.#send(conn, { ev: 'pair.aborted', reason: '对端取消了配对' });
    return true;
  }

  #owner(pairingToken: string): Connection | undefined {
    for (const conn of this.#connections) {
      if (conn.pairingToken === pairingToken) return conn;
    }
    return undefined;
  }

  #accept(socket: Socket): void {
    const conn: Connection = { socket, pairingToken: null, expiryTimer: null, request: null, answering: false };
    this.#connections.add(conn);
    socket.setEncoding('utf8');
    const decoder = new LineDecoder();
    socket.on('data', (chunk: string) => {
      const { lines, overflow } = decoder.push(chunk);
      if (overflow) {
        this.#fatal(conn, '请求过长');
        return;
      }
      for (const line of lines) void this.#handleLine(conn, line);
    });
    socket.on('error', () => {
      // 对端异常断开：close 事件里统一收尾
    });
    socket.on('close', () => {
      this.#connections.delete(conn);
      if (conn.pairingToken !== null) {
        this.host.abortPairing(conn.pairingToken, 'pairing cancelled on agent');
        this.#log('[control] 配对发起方已断开，配对已中止');
      }
      this.#clearPairing(conn);
    });
  }

  async #handleLine(conn: Connection, line: string): Promise<void> {
    let request: ControlRequest;
    try {
      request = ControlRequestSchema.parse(JSON.parse(line));
    } catch {
      this.#fatal(conn, '无法识别的请求（agent 与命令版本不一致？）');
      return;
    }
    try {
      await this.#handle(conn, request);
    } catch (err) {
      this.#send(conn, { ev: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async #handle(conn: Connection, request: ControlRequest): Promise<void> {
    switch (request.op) {
      case 'status':
        this.#send(conn, { ev: 'status', pid: this.#pid, ...this.host.status() });
        return;
      case 'devices.list':
        this.#send(conn, { ev: 'devices', devices: this.host.listDevices() });
        return;
      case 'devices.revoke': {
        const removed = await this.host.revokeDevice(request.deviceId);
        this.#send(conn, { ev: 'revoked', deviceId: request.deviceId, removed });
        return;
      }
      case 'pair.start':
        this.#startPairing(conn);
        return;
      case 'pair.answer':
        await this.#answer(conn, request.requestId, request.confirm);
        return;
      case 'ext.list':
      case 'ext.add':
      case 'ext.remove':
      case 'ext.reload': {
        const ext = this.host.extensions;
        if (ext === undefined) throw new Error('这个 agent 不支持扩展');
        if (request.op === 'ext.list') this.#send(conn, { ev: 'ext.list', items: ext.list() });
        else if (request.op === 'ext.add') this.#send(conn, { ev: 'ext.added', item: await ext.add(request.path) });
        else if (request.op === 'ext.remove') this.#send(conn, { ev: 'ext.removed', id: request.id, removed: await ext.remove(request.id) });
        else this.#send(conn, { ev: 'ext.reloaded', items: await ext.reload(request.id) });
        return;
      }
      case 'restart':
      case 'restart.cancel': {
        const restart = this.host.restart;
        if (restart === undefined) throw new Error('这个 agent 不支持重启');
        const outcome =
          request.op === 'restart.cancel'
            ? restart.cancel()
            : await restart.request({
                now: request.now,
                ...(request.sessionId === undefined
                  ? {}
                  : {
                      notice: {
                        sessionId: request.sessionId,
                        ...(request.note === undefined ? {} : { note: request.note }),
                        ...(request.continuePrompt === undefined ? {} : { continuePrompt: request.continuePrompt }),
                      },
                    }),
              });
        const pending = restart.pending();
        this.#send(
          conn,
          outcome.ok
            ? {
                ev: 'restart.result',
                ok: true,
                phase: outcome.phase,
                ...(outcome.toVersion === undefined ? {} : { toVersion: outcome.toVersion }),
                ...(pending === undefined ? {} : { busySessions: pending.busySessions }),
                ...(pending?.deadline === undefined ? {} : { deadline: pending.deadline }),
              }
            : {
                ev: 'restart.result',
                ok: false,
                code: outcome.code,
                message: outcome.message,
                ...(outcome.output === undefined ? {} : { output: outcome.output }),
              },
        );
        return;
      }
    }
  }

  #startPairing(conn: Connection): void {
    if (conn.pairingToken !== null) {
      this.host.abortPairing(conn.pairingToken, 'superseded');
      this.#clearPairing(conn);
    }
    const session = this.host.startPairing();
    conn.pairingToken = session.pairingToken;
    // PairingManager 只做被动过期（sweep），这里补一个定时器，让终端那头
    // 及时知道「配对码已过期」，而不是对着一个死码干等
    conn.expiryTimer = setTimeout(
      () => {
        if (conn.pairingToken !== session.pairingToken) return;
        this.host.abortPairing(session.pairingToken, 'expired');
        this.#clearPairing(conn);
        this.#send(conn, { ev: 'pair.expired' });
      },
      Math.max(0, session.expiresAt - this.#now()),
    );
    this.#log('[control] 已通过控制通道发起配对');
    this.#send(conn, { ev: 'pair.started', payload: session.payload, expiresAt: session.expiresAt });
  }

  async #answer(conn: Connection, requestId: number, confirm: boolean): Promise<void> {
    const token = conn.pairingToken;
    const request = conn.request;
    if (token === null || request === null) {
      throw new Error('没有等待确认的配对请求（可能已过期或已被取消）');
    }
    if (request.requestId !== requestId) {
      throw new Error('这条回答对应的配对请求已被新请求取代；请以最新显示的校验码为准');
    }
    if (conn.answering) throw new Error('正在处理上一个回答');

    if (!confirm) {
      this.host.abortPairing(token, 'SAS mismatch');
      this.#clearPairing(conn);
      this.#log('[control] 用户判定校验码不一致，配对已中止');
      this.#send(conn, { ev: 'pair.aborted', reason: '校验码不一致——可能有人在替换密钥，请重新扫码' });
      return;
    }

    conn.answering = true;
    try {
      const sent = await this.host.confirmPairing(token, request.peer);
      this.#clearPairing(conn);
      this.#send(conn, { ev: 'pair.done', clientDeviceId: request.peer.clientDeviceId, sent });
    } finally {
      conn.answering = false;
    }
  }

  #clearPairing(conn: Connection): void {
    if (conn.expiryTimer !== null) clearTimeout(conn.expiryTimer);
    conn.expiryTimer = null;
    conn.pairingToken = null;
    conn.request = null;
  }

  #fatal(conn: Connection, message: string): void {
    this.#send(conn, { ev: 'error', message, fatal: true });
    conn.socket.end();
  }

  #send(conn: Connection, event: ControlEvent): void {
    if (conn.socket.writable) conn.socket.write(encodeLine(event));
  }
}

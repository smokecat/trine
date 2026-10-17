/**
 * 配对状态机（方案 §4.5）。
 *
 *   idle → ready（已解码，显示 SAS）→ waiting（pairing 连接上等 confirm）
 *        → verifying（探测 authenticate）→ done | aborted | failed
 *
 * ## 完成的权威判据 = `AuthClient.authenticate()` 成功（评审 B2）
 *
 * 服务端在转发 pair.confirm **之前**就已完成背书登记；而 pairing 连接 2 分钟
 * 空闲即被服务端 4004 关掉（且服务端不向它 ping）。用户在 agent 终端犹豫超过
 * 2 分钟再按 y，confirm 就无处可送——但登记其实成功了。所以：
 * - 收到 confirm → 立刻探测 authenticate（快路径）；
 * - pairing 连接**任何原因**关闭 → 同样立刻探测；
 * - `unknown_device`（还没登记）→ 每 5s 重试，总时限 5 分钟（agent token TTL）；
 * - 成功即 done，结果交给 `TrineClient.completePairing()`。
 *
 * MVP 单服务端：已有 PeerState 且 serverUrl 不同的 QR 直接拒绝。
 */
import { decodePairingPayload, deriveSas, type PairingPayload, type Sas } from '@trine/core/crypto';
import { AuthClient, AuthClientError, httpBase, wsEndpoint, type AuthToken } from '@trine/core/net';
import { decodeTransportFrame, encodeTransportFrame, type TransportFrame } from '@trine/core';
import { ZodError } from 'zod';
import type { Clock, SocketFactory, SocketLike } from './adapters.ts';
import type { PairingResult } from './client.ts';
import type { Identity } from './storage.ts';

export type PairingPhase = 'idle' | 'ready' | 'waiting' | 'verifying' | 'done' | 'aborted' | 'failed' | 'disposed';

export interface PairingSnapshot {
  phase: PairingPhase;
  sas: Sas | null;
  serverUrl: string | null;
  machineId: string | null;
  /** verifying 阶段已尝试认证的次数 */
  attempts: number;
  error: string | null;
  result: PairingResult | null;
}

export interface PairingDeps {
  identity: Identity;
  /** 已配对的服务端（单服务端约束）；未配对为 null */
  currentServerUrl: string | null;
  createSocket: SocketFactory;
  clock: Clock;
  fetchImpl?: typeof fetch;
  /** 注入认证客户端（测试） */
  makeAuth?: (baseUrl: string) => { authenticate(): Promise<AuthToken> };
  onChange?: (snapshot: PairingSnapshot) => void;
  retryMs?: number;
  deadlineMs?: number;
  log?: (line: string) => void;
}

export const PAIRING_VERIFY_RETRY_MS = 5_000;
export const PAIRING_DEADLINE_MS = 5 * 60_000;

const CODE_TRUNCATED = '配对码内容损坏或不完整，请重新复制';

/**
 * zod 校验失败里，哪些字段**根本没出现**（漏了半截），哪些是出现了但不合法。
 *
 * 两者要给完全不同的话：漏字段是「你粘少了」，值不合法是「这个配对码本身有
 * 问题」。早先这里只对 message 做 `includes('serverUrl')` 之类的子串匹配，
 * 而 zod 的报文**恰好也包含字段名**——于是「缺 agentPubKey」被说成「agent
 * 公钥损坏」、「缺 serverUrl」被说成「服务端地址不合法（必须是 https/wss）」，
 * 用户照着这句话去查根本不存在的问题。
 *
 * 判据用 issue 的结构而不是报文：`invalid_type` + received undefined = 缺字段。
 */
function describeZodIssues(err: unknown): string | null {
  if (!(err instanceof ZodError)) return null;
  const issues = err.issues;
  if (issues.length === 0) return null;
  const missing = issues.filter(
    (i) => i.code === 'invalid_type' && String(i.message).includes('received undefined'),
  );
  if (missing.length > 0) return CODE_TRUNCATED;
  // 字段在、值不合法：按字段给具体原因
  const paths = new Set(issues.map((i) => String(i.path[0] ?? '')));
  if (paths.has('serverUrl')) return '配对码里的服务端地址不合法（必须是 https/wss，或本机回环地址）';
  if (paths.has('agentPubKey')) return '配对码里的 agent 公钥损坏';
  return CODE_TRUNCATED;
}

/** 把解码失败翻译成用户能读的原因 */
export function describePairingCodeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('not a trine pairing payload')) return '这不是 trine 配对码（应以 trine1: 开头）';
  const zod = describeZodIssues(err);
  if (zod !== null) return zod;
  // agentPubKey 长度校验是 decodePairingPayload 自己抛的普通 Error（不是 zod）
  if (message.includes('agentPubKey')) return '配对码里的 agent 公钥损坏';
  // libsodium 的 from_base64 对非法字符与残缺输入一律抛 `incomplete input`
  // ——纯英文，早先落到兜底分支原样透给用户
  if (message.includes('incomplete input')) return CODE_TRUNCATED;
  if (message.includes('JSON') || message.includes('base64') || message.includes('Unexpected')) {
    return CODE_TRUNCATED;
  }
  return `配对码无法解析：${message}`;
}

export class PairingFlow {
  #phase: PairingPhase = 'idle';
  #payload: PairingPayload | null = null;
  #sas: Sas | null = null;
  #error: string | null = null;
  #attempts = 0;
  #result: PairingResult | null = null;
  #socket: SocketLike | null = null;
  #retryTimer: unknown = null;
  #deadline = 0;
  #verifying = false;
  readonly #retryMs: number;
  readonly #deadlineMs: number;
  readonly #log: (line: string) => void;

  constructor(private readonly deps: PairingDeps) {
    this.#retryMs = deps.retryMs ?? PAIRING_VERIFY_RETRY_MS;
    this.#deadlineMs = deps.deadlineMs ?? PAIRING_DEADLINE_MS;
    this.#log = deps.log ?? (() => {});
  }

  get phase(): PairingPhase {
    return this.#phase;
  }

  snapshot(): PairingSnapshot {
    return {
      phase: this.#phase,
      sas: this.#sas,
      serverUrl: this.#payload?.serverUrl ?? null,
      machineId: this.#payload?.machineId ?? null,
      attempts: this.#attempts,
      error: this.#error,
      result: this.#result,
    };
  }

  /** 第 1-3 步：解码配对码、单服务端校验、算 SAS。失败抛可读错误并进入 failed */
  prepare(codeText: string): PairingSnapshot {
    let payload: PairingPayload;
    try {
      payload = decodePairingPayload(codeText.trim());
    } catch (err) {
      return this.#fail(describePairingCodeError(err));
    }
    // 归一化后再比：`http://x:5173` 与 `http://x:5173/`、大小写不同的 host 是同一个服务端
    if (this.deps.currentServerUrl !== null && httpBase(this.deps.currentServerUrl) !== httpBase(payload.serverUrl)) {
      return this.#fail(
        `MVP 只支持一个服务端：本设备已配对 ${this.deps.currentServerUrl}，这个配对码指向 ${payload.serverUrl}。` +
          '如需换服务端，请先在设置里「重置本地状态」。',
      );
    }
    this.#payload = payload;
    this.#sas = deriveSas(
      payload.agentPubKey,
      {
        boxPubKey: this.deps.identity.box.publicKey,
        signPubKey: this.deps.identity.sign.publicKey,
        deviceId: this.deps.identity.deviceId,
      },
      payload.qrSecret,
    );
    this.#error = null;
    return this.#setPhase('ready');
  }

  /** 第 4 步：以 pairing 角色建连并发 pair.begin */
  start(): void {
    const payload = this.#payload;
    if (payload === null || this.#phase !== 'ready') return;
    this.#deadline = this.deps.clock.now() + this.#deadlineMs;
    let socket: SocketLike;
    try {
      socket = this.deps.createSocket(wsEndpoint(payload.serverUrl));
    } catch (err) {
      this.#fail(`无法连接服务端：${String(err)}`);
      return;
    }
    this.#socket = socket;
    this.#setPhase('waiting');
    socket.addEventListener('open', () => {
      if (this.#socket !== socket) return;
      socket.send(encodeTransportFrame({ type: 'hello', v: 1, role: 'pairing', deviceId: this.deps.identity.deviceId }));
      socket.send(
        encodeTransportFrame({
          type: 'pair.begin',
          pairingToken: payload.pairingToken,
          clientPubKey: this.deps.identity.box.publicKey,
          clientSignPubKey: this.deps.identity.sign.publicKey,
          clientDeviceId: this.deps.identity.deviceId,
        }),
      );
    });
    socket.addEventListener('message', (ev) => {
      if (this.#socket !== socket) return;
      let frame: TransportFrame;
      try {
        frame = decodeTransportFrame(String(ev.data));
      } catch {
        return;
      }
      if (frame.type === 'pair.confirm' && frame.pairingToken === payload.pairingToken) {
        this.#log('[pairing] 收到 pair.confirm，探测认证');
        this.#closeSocket();
        this.#beginVerify();
      } else if (frame.type === 'pair.abort' && frame.pairingToken === payload.pairingToken) {
        this.#closeSocket();
        this.#setPhase('aborted');
        this.#error = frame.reason === undefined ? 'agent 中止了配对（校验码不一致或用户拒绝）' : `agent 中止了配对：${frame.reason}`;
        this.deps.onChange?.(this.snapshot());
      }
    });
    socket.addEventListener('close', (ev) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      if (this.#phase !== 'waiting') return;
      // 任何原因关闭（含 4004 空闲）→ 登记可能已经成功，去探测
      this.#log(`[pairing] pairing 连接关闭（${ev.code}），转为探测认证`);
      this.#beginVerify();
    });
    socket.addEventListener('error', () => {
      // close 会紧跟着来
    });
  }

  /** 用户点「不一致，中止」 */
  abort(reason = 'SAS mismatch'): void {
    const payload = this.#payload;
    if (this.#socket && payload) {
      try {
        this.#socket.send(encodeTransportFrame({ type: 'pair.abort', pairingToken: payload.pairingToken, reason }));
      } catch {
        // 连接已断
      }
    }
    this.#closeSocket();
    this.#clearRetry();
    this.#error = '已中止配对';
    this.#setPhase('aborted');
  }

  /**
   * 离开页面：停掉一切并置 disposed——在途的 authenticate 结果随之作废
   * （phase 不再是 verifying，#verifyOnce 会丢弃它），不会出现「服务端已登记、
   * agent 名册已写、client 却永远不 completePairing」的悬空状态被误当成成功。
   */
  dispose(): void {
    if (this.#phase === 'done') return;
    this.#closeSocket();
    this.#clearRetry();
    this.#phase = 'disposed';
  }

  // ---- 内部 ----

  #beginVerify(): void {
    if (this.#phase === 'done' || this.#phase === 'aborted' || this.#phase === 'failed') return;
    if (this.#verifying) return;
    this.#verifying = true;
    this.#setPhase('verifying');
    void this.#verifyOnce();
  }

  async #verifyOnce(): Promise<void> {
    const payload = this.#payload;
    if (payload === null || this.#phase !== 'verifying') return;
    this.#attempts++;
    const base = httpBase(payload.serverUrl);
    const auth =
      this.deps.makeAuth?.(base) ??
      new AuthClient({
        baseUrl: base,
        deviceId: this.deps.identity.deviceId,
        signKeys: this.deps.identity.sign,
        ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
      });
    try {
      const token = await auth.authenticate();
      if (this.#phase !== 'verifying') return;
      this.#result = {
        serverUrl: payload.serverUrl,
        agentBoxPubKey: payload.agentPubKey,
        machineId: payload.machineId,
        token,
      };
      this.#error = null;
      this.#setPhase('done');
    } catch (err) {
      if (this.#phase !== 'verifying') return;
      const reason = err instanceof AuthClientError ? err.reason : (err instanceof Error ? err.message : String(err));
      if (this.deps.clock.now() >= this.#deadline) {
        this.#fail(`等待 agent 确认超时（5 分钟）；最后一次认证失败：${reason}`);
        return;
      }
      this.#log(`[pairing] 认证未通过（${reason}），${this.#retryMs}ms 后重试`);
      this.deps.onChange?.(this.snapshot());
      this.#retryTimer = this.deps.clock.setTimeout(() => {
        this.#retryTimer = null;
        void this.#verifyOnce();
      }, this.#retryMs);
    }
  }

  #closeSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      try {
        socket.close(1000, 'pairing done');
      } catch {
        // 已关
      }
    }
  }

  #clearRetry(): void {
    if (this.#retryTimer !== null) {
      this.deps.clock.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
  }

  #fail(message: string): PairingSnapshot {
    this.#closeSocket();
    this.#clearRetry();
    this.#error = message;
    return this.#setPhase('failed');
  }

  #setPhase(phase: PairingPhase): PairingSnapshot {
    this.#phase = phase;
    const snapshot = this.snapshot();
    this.deps.onChange?.(snapshot);
    return snapshot;
  }
}

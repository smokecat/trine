/**
 * agent 侧的配对发起与主导。
 *
 * agent 是配对里的**可信方**：它生成一次性材料、算 SAS、拿到用户确认后向
 * 服务端背书（D8）。服务端只是个明文中转，client 在配对完成前连身份都没有。
 *
 * ## pairingToken 的三路径核销（D8 代价意识里点名要求落码）
 *
 * token 的权威 TTL 在这里——它是 agent 生成的，服务端从没见过它的签发时刻。
 * 三条路径都必须真的把记录删掉，不能只写在注释里
 * （Happy issue #674 的反面教材：TTL 写了注释没落码，token 永久可用）：
 * 1. `confirm()` 成功 → 立即删；
 * 2. `abort()` → 立即删；
 * 3. 超时 → `sweep()` 被动清理（每次进出都顺手扫一遍，规模是「同时进行的
 *    配对数」，个位数，不值得挂定时器）。
 *
 * ## 为什么 SAS 必须人工比对
 *
 * `pair.begin` 经不可信服务端**明文广播**给全部在线 agent，中间人完全有
 * 能力替换掉 client 的公钥。SAS 由 双方 X25519 公钥 + qrSecret 派生，而
 * qrSecret 只进 QR、服务端拿不到——公钥被换过的话两端算出的 SAS 必然不同。
 * 这是整套流程里唯一挡得住中间人的环节，所以 `confirm()` 刻意做成必须由
 * 上层显式调用（等价于「用户点了确认」），本模块绝不自动确认。
 */
import {
  deriveSas,
  encodePairingPayload,
  generateQrSecret,
  isValidSignPublicKey,
  randomToken,
  type Sas,
} from '@trine/core/crypto';
import type { TransportFrame } from '@trine/core/protocol';
import type { Recipient, RecipientBookStore } from './recipients.ts';

/** pairingToken 有效期（D8 拍板：5 分钟） */
export const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * 一次配对会话在 agent 内存里的记录。
 *
 * qrSecret 在这里而不在任何持久化文件里：它的生命周期就是这一次配对，
 * 落盘只会多一个泄露点。
 */
export interface PairingSession {
  pairingToken: string;
  /** SAS 的 keyed-hash 密钥，只进 QR，**永不发给服务端** */
  qrSecret: string;
  /** 展示给用户的 QR 文本 */
  payload: string;
  createdAt: number;
  expiresAt: number;
  /** 收到 pair.begin 后填上——等待用户比对 SAS 的状态 */
  pending: PendingPeer | null;
}

/** 已收到 pair.begin、正等用户比对 SAS 的对端 */
export interface PendingPeer {
  clientDeviceId: string;
  clientPubKey: string;
  clientSignPubKey: string;
  sas: Sas;
  receivedAt: number;
}

/** 收到 pair.begin 的处理结果 */
export type BeginOutcome =
  | { kind: 'awaiting_confirm'; session: PairingSession; peer: PendingPeer }
  /**
   * token 不认识 / 已过期 / 已核销——静默丢弃。
   * 服务端把 pair.begin 广播给全体在线 agent（它不知道 token 属于谁），
   * 所以这是绝大多数 agent 的正常结局，不是异常。
   */
  | { kind: 'ignored'; reason: 'unknown_token' }
  | { kind: 'rejected'; reason: 'invalid_sign_key' | 'invalid_pub_key' };

export interface ConfirmResult {
  frame: Extract<TransportFrame, { type: 'pair.confirm' }>;
  recipient: Recipient;
}

export interface PairingManagerOptions {
  /** agent 自己的 X25519 公钥，进 QR 给 client */
  agentBoxPubKey: string;
  /** 已配对设备名册，确认后写入 */
  recipients: RecipientBookStore;
  /** 客户端接入用的服务端地址，必须是 wss:// 或 https://（core 会校验） */
  serverUrl: string;
  /**
   * 本机 machineId，写进 QR 让 client 直接知道配的是哪台机器。
   *
   * 可选是为了不强迫纯配对逻辑的测试去编一个 machineId；生产装配
   * （AgentNode.create）一定会传。不传则 QR 不带该字段，client 退回
   * 「首条在线 machine.status」的猜法——多机场景会猜错。
   */
  machineId?: string;
  now?: () => number;
  tokenTtlMs?: number;
}

export class PairingManager {
  readonly #sessions = new Map<string, PairingSession>();
  readonly #now: () => number;
  readonly #ttl: number;

  constructor(private readonly options: PairingManagerOptions) {
    this.#now = options.now ?? (() => Date.now());
    this.#ttl = options.tokenTtlMs ?? PAIRING_TOKEN_TTL_MS;
  }

  /**
   * 发起一次配对：生成一次性材料并产出 QR 文本。
   *
   * pairingToken 取 256-bit 随机（`randomToken(32)`）：它经明文广播传播，
   * 猜中一个未核销的 token 就能抢在真设备之前发 pair.begin。配合服务端的
   * PAIR_RATE_LIMIT，枚举在算力上完全不成立。
   */
  begin(): PairingSession {
    this.sweep();
    const now = this.#now();
    const session: PairingSession = {
      pairingToken: randomToken(32),
      qrSecret: generateQrSecret(),
      payload: '',
      createdAt: now,
      expiresAt: now + this.#ttl,
      pending: null,
    };
    session.payload = encodePairingPayload({
      v: 1,
      serverUrl: this.options.serverUrl,
      agentPubKey: this.options.agentBoxPubKey,
      pairingToken: session.pairingToken,
      qrSecret: session.qrSecret,
      ...(this.options.machineId !== undefined
        ? { machineId: this.options.machineId }
        : {}),
    });
    this.#sessions.set(session.pairingToken, session);
    return session;
  }

  /**
   * 处理一条 `pair.begin`。
   *
   * 服务端把 pair.begin 广播给**全部**在线 agent（它不知道 token 属于谁，
   * 见 hub 的注释），所以「token 不认识」是完全正常的情况——静默忽略，
   * 不记日志噪音、更不回任何东西（回复等于告诉发送方「这台机器在线」）。
   */
  onBegin(
    frame: Extract<TransportFrame, { type: 'pair.begin' }>,
  ): BeginOutcome {
    // 先扫再查：过期会话在这一步就被删掉，于是过期与「根本不认识」
    // 归到同一条 unknown_token 路径。刻意不区分——对外区分等于告诉
    // 发送方「这个 token 曾经在本机存在过」，那是不必要的信息泄露。
    this.sweep();
    const session = this.#sessions.get(frame.pairingToken);
    if (!session) return { kind: 'ignored', reason: 'unknown_token' };

    // 早校验：格式不对的公钥进不了 crypto_box，也进不了服务端的登记，
    // 在这里挡下来，用户就不用去比对一个注定用不了的 SAS
    if (!isValidSignPublicKey(frame.clientSignPubKey)) {
      return { kind: 'rejected', reason: 'invalid_sign_key' };
    }
    let sas: Sas;
    try {
      // SAS 覆盖的是 agent **实际收到**的这份身份——box 公钥、签名公钥、
      // deviceId 全部纳入。server 若在中转途中篡改了其中任一字段（哪怕
      // 只换签名公钥、保留 box 公钥），两端算出的 SAS 就必然不一致，
      // 用户比对时会发现（评审打回的信任根缺陷正是漏了后两样）。
      sas = deriveSas(
        this.options.agentBoxPubKey,
        {
          boxPubKey: frame.clientPubKey,
          signPubKey: frame.clientSignPubKey,
          deviceId: frame.clientDeviceId,
        },
        session.qrSecret,
      );
    } catch {
      // clientPubKey 不是合法 base64/长度不对：同理，早失败
      return { kind: 'rejected', reason: 'invalid_pub_key' };
    }

    const peer: PendingPeer = {
      clientDeviceId: frame.clientDeviceId,
      clientPubKey: frame.clientPubKey,
      clientSignPubKey: frame.clientSignPubKey,
      sas,
      receivedAt: this.#now(),
    };
    // 后到的 begin 覆盖先到的：同一 token 正常只会有一个对端，出现第二个
    // 说明要么 client 重试，要么有人在抢——两种情况用户都会在 SAS 上察觉
    session.pending = peer;
    return { kind: 'awaiting_confirm', session, peer };
  }

  /**
   * 用户比对 SAS 一致后确认。**只应由用户的显式动作触发**。
   *
   * 产出的 `pair.confirm` 复述的是 agent **实际收到**的那份身份——服务端
   * 拿它与自己缓存的 begin 记录逐字比对，这就是「谁背书谁登记」。
   *
   * 写名册与发帧的顺序：先写名册再返回帧，让调用方在「已经能给这台设备
   * 加密」的状态下才把 confirm 发出去。反过来的话，client 收到 confirm 后
   * 立刻接入并发帧，agent 却还不认识它，头几帧会被当成未知发送方丢掉。
   */
  async confirm(pairingToken: string): Promise<ConfirmResult> {
    const session = this.#sessions.get(pairingToken);
    if (!session) {
      throw new Error('配对会话不存在或已失效，请重新扫码');
    }
    if (session.expiresAt <= this.#now()) {
      this.#sessions.delete(pairingToken);
      throw new Error('配对码已过期（5 分钟），请重新生成');
    }
    const peer = session.pending;
    if (!peer) {
      throw new Error('还没有收到对端的配对请求，无从确认');
    }

    const recipient: Recipient = {
      deviceId: peer.clientDeviceId,
      boxPubKey: peer.clientPubKey,
      signPubKey: peer.clientSignPubKey,
      pairedAt: this.#now(),
    };
    await this.options.recipients.add(recipient);

    // 核销路径 1：确认成功即作废，重放到此为止
    this.#sessions.delete(pairingToken);

    return {
      frame: {
        type: 'pair.confirm',
        pairingToken,
        clientDeviceId: peer.clientDeviceId,
        clientSignPubKey: peer.clientSignPubKey,
      },
      recipient,
    };
  }

  /**
   * 中止一次配对（用户拒绝、SAS 不一致、或就是不想配了）。
   *
   * SAS 不一致时**不做自动重试**：默认假设是中间人而不是网络抖动，
   * 让用户重新扫码走一遍全新流程（新 token、新 qrSecret）。
   */
  abort(pairingToken: string, reason?: string): Extract<TransportFrame, { type: 'pair.abort' }> | null {
    // 核销路径 2
    const existed = this.#sessions.delete(pairingToken);
    if (!existed) return null;
    return {
      type: 'pair.abort',
      pairingToken,
      ...(reason ? { reason } : {}),
    };
  }

  /** 核销路径 3：丢弃已过期的会话 */
  sweep(now = this.#now()): number {
    let dropped = 0;
    for (const [token, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(token);
        dropped++;
      }
    }
    return dropped;
  }

  get(pairingToken: string): PairingSession | null {
    return this.#sessions.get(pairingToken) ?? null;
  }

  /** 进行中的配对数（测试断言核销确实落码用） */
  get activeCount(): number {
    return this.#sessions.size;
  }
}

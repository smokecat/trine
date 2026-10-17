/**
 * 设备注册与挑战-应答认证。
 *
 * ## 机制定稿（调研报告议题 3.1 落地）
 *
 * 每台设备（client 浏览器 / agent 机器）持有一对长期 **Ed25519** 身份密钥
 * （`@trine/core` 的 sign.ts；与 E2E 的 X25519 密钥刻意分离，理由见该文件）。
 *
 * ```
 * 1. 注册   POST /auth/register  { deviceId, role, signPubKey }
 *           → 服务端登记公钥。同 deviceId 已存在时**不覆盖公钥**
 *             （覆盖 = 无需持有旧私钥即可接管设备）。
 *
 * 2. 取挑战 POST /auth/challenge { deviceId }
 *           → { challenge, expiresAt }   challenge = 32 字节随机 base64url，
 *             一次性、TTL 2 分钟。
 *
 * 3. 应答   POST /auth/verify    { deviceId, challenge, signature }
 *           signature = Ed25519(私钥, "trine-auth-v1|deviceId|challenge")
 *           → { token, expiresAt }       token = 32 字节随机不透明串，
 *             库里只存 sha256 摘要，默认 24h。
 *
 * 4. 接入   WS /ws 的第一帧 hello 带 authToken；服务端查摘要换回 deviceId。
 * ```
 *
 * ## 为什么这么设计
 *
 * - **不透明随机 token 而非 JWT**：单进程服务端，撤销一个 token 只要删一行；
 *   JWT 的无状态优势在这里换不到任何东西，却要自己扛签名密钥轮换和
 *   「已签发无法吊销」的老问题。
 * - **只存 sha256 摘要**：SQLite 文件泄露（备份、快照）不等于 token 泄露。
 * - **挑战串取出即删**：无论验签成败都删，攻击者无法对同一挑战反复试。
 * - **限流按 deviceId + 来源 IP 复合计数，且两个端点各有独立计数器**：
 *   单用 deviceId 会让任何人都能锁死真设备（deviceId 不是秘密）；
 *   两端点共用计数器则会让取挑战吃光验签配额。详见各方法注释。
 * - **每设备只留一个未过期挑战**：挑战表恒定为设备数量级，不随请求增长。
 * - **常量时间比较**：token 摘要与签名比对都走 sodium 的定长比较路径，
 *   避免早退型时序侧信道。
 */
import {
  authChallengeMessage,
  isValidSignPublicKey,
  randomToken,
  verifyDetached,
} from '@trine/core/crypto';
import type { ServerConfig } from '../config.ts';
import type { DeviceRole, Store } from '../store/index.ts';

/** token 只存摘要：库泄露不等于凭据泄露 */
export function hashToken(token: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(token);
  return hasher.digest('base64');
}

export type AuthError =
  | 'unknown_device'
  | 'device_revoked'
  | 'invalid_challenge'
  | 'bad_signature'
  | 'rate_limited'
  | 'invalid_public_key'
  | 'registration_closed'
  | 'device_exists_with_other_key'
  | 'role_mismatch';

export type AuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AuthError };

/**
 * 设备登记来源（D8：审计留痕）。
 * - `bootstrap` 空库首设备；`open` 手工开的注册窗口；
 * - `pairing` 已认证 agent 在 pair.confirm 里背书——常规路径。
 */
export type RegistrationSource = 'bootstrap' | 'open' | 'pairing';

export class AuthService {
  private readonly log: (line: string) => void;

  constructor(
    private readonly store: Store,
    private readonly config: ServerConfig,
    log: (line: string) => void = (line) => console.info(line),
  ) {
    this.log = log;
  }

  /**
   * 设备注册。
   *
   * 开放注册（`allowOpenRegistration`）默认关闭：生产部署下新设备应经配对
   * 流程引入，而不是任何人 POST 一个公钥就能进。
   * 但**库里一台设备都没有时永远允许**——否则全新部署无从 bootstrap，
   * 且此时也无人可冒充（没有既有设备可顶替）。
   *
   * `via` 是登记来源（D8 拍板：审计留痕）。三条路径的信任来源完全不同，
   * 混在一起看日志时分不清「这台设备当初是怎么进来的」：
   * - `bootstrap` — 空库首设备，无人可冒充；
   * - `open` — 手工开了 `allowOpenRegistration` 窗口（第二台 agent 暂用）；
   * - `pairing` — 已认证 agent 在 `pair.confirm` 里背书（唯一的常规路径）。
   *
   * **`pairing` 来源不受 `allowOpenRegistration` 限制**——它的放行依据是
   * agent 背书，与开放注册窗口是两回事；反过来说，调用方必须自己确保只在
   * 校验通过后才用这个来源（见 hub 的 handlePairConfirm）。
   */
  register(
    deviceId: string,
    role: DeviceRole,
    signPubKey: string,
    via: RegistrationSource,
    now = Date.now(),
  ): AuthResult<{ created: boolean }> {
    if (!isValidSignPublicKey(signPubKey)) {
      return { ok: false, error: 'invalid_public_key' };
    }

    const existing = this.store.getDevice(deviceId);
    if (existing) {
      // 幂等：同 deviceId + 同公钥当作重复注册放行；换了公钥一律拒绝
      if (existing.signPubKey !== signPubKey) {
        return { ok: false, error: 'device_exists_with_other_key' };
      }
      if (existing.role !== role) {
        return { ok: false, error: 'role_mismatch' };
      }
      if (existing.revokedAt !== null) {
        return { ok: false, error: 'device_revoked' };
      }
      return { ok: true, value: { created: false } };
    }

    // pairing 来源的放行依据是 agent 背书（调用方已校验），与开放注册窗口无关
    if (via !== 'pairing') {
      const bootstrap = this.store.countDevices() === 0;
      if (!bootstrap && !this.config.allowOpenRegistration) {
        return { ok: false, error: 'registration_closed' };
      }
    }

    this.store.registerDevice(deviceId, role, signPubKey, now);
    // 审计留痕：登记来源不入库（devices 表是零知识边界的一部分，不加列），
    // 只落日志——运维排查「这台设备当初怎么进来的」够用，成本为零
    this.log(`[auth] 登记设备 device=${deviceId} role=${role} via=${via}`);
    return { ok: true, value: { created: true } };
  }

  /**
   * 下发一次性挑战串。
   *
   * 限流用**宽松**阈值（`authFailMaxAttempts` 的若干倍）且成功也计数——
   * 这个端点本身是无害的（拿到挑战串没有私钥照样换不到 token），
   * 但它会写库，不限就是一个无成本的写放大入口（S2）。
   *
   * 每设备只保留最新的一个未过期挑战：发新挑战前先删掉该设备的旧挑战，
   * 挑战表因此恒定为「在线设备数」量级，不再随请求次数无界增长。
   * 代价是同一设备并发发起两次认证时，后者会作废前者——单用户场景下
   * 这本就不该发生，且客户端重试一次即可。
   */
  issueChallenge(
    deviceId: string,
    source = ANONYMOUS_SOURCE,
    now = Date.now(),
  ): AuthResult<{ challenge: string; expiresAt: number }> {
    // 独立计数器：取挑战的频率配额与验签的失败配额互不消耗，
    // 否则正常的多次取挑战会把验签配额吃光，真设备反而认证不了
    const key = challengeRateKey(deviceId, source);
    if (
      this.store.authFailureCount(key, this.config.authFailWindowMs, now) >=
      this.challengeMaxAttempts
    ) {
      return { ok: false, error: 'rate_limited' };
    }
    // 成功也计数：这是「请求频率」限流，不是「失败次数」限流
    this.store.recordAuthFailure(key, this.config.authFailWindowMs, now);

    const device = this.store.getDevice(deviceId);
    if (!device) return { ok: false, error: 'unknown_device' };
    if (device.revokedAt !== null) {
      return { ok: false, error: 'device_revoked' };
    }

    // 每设备只留最新一个挑战，挑战表不随请求次数增长
    this.store.clearChallengesFor(deviceId);

    const challenge = randomToken(32);
    const expiresAt = now + this.config.challengeTtlMs;
    this.store.putChallenge(challenge, deviceId, expiresAt);
    return { ok: true, value: { challenge, expiresAt } };
  }

  /**
   * 校验应答签名，换取短期 token。
   *
   * ## 限流为什么必须先验签、且按 deviceId + 来源复合计数
   *
   * 早先的写法以 deviceId 单独作限流 key 并在**所有**失败路径计数，
   * 于是任何知道 deviceId 的人（deviceId 本就不是秘密）只要狂发垃圾
   * verify，就能把真设备锁在门外——拒绝服务，而攻击者一无所需。
   *
   * 现在两条一起改：
   * - **只有签名校验失败才计数**。签名失败意味着对方确实没有私钥，
   *   这才是值得限流的「暴力尝试」；挑战串过期/对不上属于正常竞态，
   *   不该消耗配额。
   * - **key 是 deviceId + 来源 IP 的复合值**。攻击者只能锁死自己那个
   *   来源，真设备从自己的 IP 过来时配额是干净的。
   *
   * 顺带：没有私钥的人无论试多少次都换不到 token（Ed25519 摆在那里），
   * 所以这里的限流只是给日志和资源消耗设个上限，不是安全性的主要依靠。
   */
  verify(
    deviceId: string,
    challenge: string,
    signature: string,
    source = ANONYMOUS_SOURCE,
    now = Date.now(),
  ): AuthResult<{ token: string; expiresAt: number }> {
    const key = rateLimitKey(deviceId, source);
    if (
      this.store.authFailureCount(key, this.config.authFailWindowMs, now) >=
      this.config.authFailMaxAttempts
    ) {
      return { ok: false, error: 'rate_limited' };
    }

    // 取出即删——无论后面成不成，这个挑战串都作废
    const consumed = this.store.consumeChallenge(challenge, now);
    if (!consumed || consumed.deviceId !== deviceId) {
      // 不计数：挑战过期/串号是正常竞态，计数会让它变成 DoS 杠杆
      return { ok: false, error: 'invalid_challenge' };
    }

    const device = this.store.getDevice(deviceId);
    if (!device) return { ok: false, error: 'unknown_device' };
    if (device.revokedAt !== null) return { ok: false, error: 'device_revoked' };

    const message = authChallengeMessage(deviceId, challenge);
    if (!verifyDetached(message, signature, device.signPubKey)) {
      // 只有这里计数：签名错 = 对方没有私钥
      this.store.recordAuthFailure(key, this.config.authFailWindowMs, now);
      return { ok: false, error: 'bad_signature' };
    }

    // 认证成功，两个计数器一并清零
    this.store.clearAuthFailures(key);
    this.store.clearAuthFailures(challengeRateKey(deviceId, source));
    const token = randomToken(32);
    const expiresAt = now + this.config.tokenTtlMs;
    this.store.putToken(hashToken(token), deviceId, now, expiresAt);
    return { ok: true, value: { token, expiresAt } };
  }

  /** WS hello 用：token → 已认证设备 */
  authenticateToken(
    token: string,
    now = Date.now(),
  ): AuthResult<{ deviceId: string; role: DeviceRole }> {
    const found = this.store.lookupToken(hashToken(token), now);
    if (!found) return { ok: false, error: 'bad_signature' };
    const device = this.store.getDevice(found.deviceId);
    if (!device) return { ok: false, error: 'unknown_device' };
    if (device.revokedAt !== null) return { ok: false, error: 'device_revoked' };
    return { ok: true, value: { deviceId: device.deviceId, role: device.role } };
  }

  logout(token: string): void {
    this.store.revokeToken(hashToken(token));
  }

  /** 取挑战的限流阈值：比验签阈值宽松，因为这个端点本身无害 */
  private get challengeMaxAttempts(): number {
    return this.config.authFailMaxAttempts * CHALLENGE_LIMIT_MULTIPLIER;
  }
}

/** 取挑战端点的限流阈值相对验签阈值的倍数 */
const CHALLENGE_LIMIT_MULTIPLIER = 5;

/** 拿不到来源标识时的占位（如测试、或反代没透传 IP） */
export const ANONYMOUS_SOURCE = 'unknown';

/**
 * 限流 key：deviceId + 来源复合。
 *
 * 单独用 deviceId 会让任何人都能锁死真设备（deviceId 不是秘密）；
 * 单独用 IP 则让同一 NAT 后的多台设备互相牵连。复合值两头都躲开。
 * 用 ` ` 分隔，保证 deviceId 里即便有奇怪字符也拼不出歧义 key。
 */
export function rateLimitKey(deviceId: string, source: string): string {
  return `${deviceId} ${source}`;
}

/**
 * 取挑战端点的限流 key。刻意与 `rateLimitKey` 分开：两个端点的配额必须是
 * 独立计数器。共用一个的话，正常的多次取挑战会把验签配额吃光，真设备
 * 反而认证不了——那等于把刚修好的 S1 从另一个门放了回来。
 */
export function challengeRateKey(deviceId: string, source: string): string {
  return `challenge ${deviceId} ${source}`;
}

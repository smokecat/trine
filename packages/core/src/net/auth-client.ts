/**
 * 服务端认证端点的客户端：注册 → 取挑战 → 签名应答 → 换 token。
 *
 * 对应 apps/server/src/auth 的三个 HTTP 端点。token 有效期由服务端决定
 * （默认 24h），过期就重走一遍挑战-应答——所以这里刻意**不缓存 token**，
 * 缓存的职责归调用方（ws-client 持有当前 token，收到 4001 就重取）。
 *
 * 放在 core 而不是某一端：agent 与 web client 走的是**同一套**挑战-应答，
 * 复制一份必然随服务端改动而漂移。唯一的平台依赖是 `fetch`，三端都有。
 */
import { authChallengeMessage, signDetached } from '../crypto/index.ts';

/** 认证失败：带上服务端给的机器可读原因，调用方据此决定重试还是罢手 */
export class AuthClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 服务端 `{ error }` 字段，如 `unknown_device` / `rate_limited` */
    readonly reason: string,
  ) {
    super(message);
    this.name = 'AuthClientError';
  }
}

export interface AuthClientOptions {
  /** 服务端根地址，如 `https://trine.example.com`（不带尾斜杠也行） */
  baseUrl: string;
  deviceId: string;
  /** Ed25519 密钥对 */
  signKeys: { publicKey: string; secretKey: string };
  /** 注入 fetch，测试用 */
  fetchImpl?: typeof fetch;
}

/**
 * 每个请求的可选项。
 *
 * `signal` 是给调用方做**超时兜底**的（评审 N3）：移动网络的半开连接里
 * `fetch` 可以永不 settle，等它的状态机就成了永久黑洞。core 不自己定超时
 * 策略——超时多久、超时之后怎么办（退避重连？报错？）是调用方的事，
 * core 只负责把 signal 老实透传给 fetch。
 */
export interface AuthRequestOptions {
  signal?: AbortSignal;
  /** Agent-only enrollment credential; never persisted. */
  invitation?: string;
}

export interface AuthToken {
  token: string;
  expiresAt: number;
}

export class AuthClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AuthClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
    // 全局 fetch 必须绑到 globalThis：浏览器里以任意对象为 this 调用 window.fetch
    // 会抛「Illegal invocation」（Bun 不校验 this 所以此前没暴露）。注入的
    // fetchImpl 原样保留——调用方自负其绑定。
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  /** Idempotent registration; new agents require an invitation, clients use pairing. */
  async register(
    role: 'agent' | 'client' = 'agent',
    opts: AuthRequestOptions = {},
  ): Promise<{ created: boolean }> {
    if (opts.invitation !== undefined) assertEnrollmentUrl(this.base);
    const res = await this.post(
      '/auth/register',
      {
        deviceId: this.options.deviceId,
        role,
        signPubKey: this.options.signKeys.publicKey,
        ...(opts.invitation === undefined ? {} : { invitation: opts.invitation }),
      },
      opts,
    );
    return { created: Boolean((res as { created?: boolean }).created) };
  }

  /** 取一次性挑战串 */
  async challenge(opts: AuthRequestOptions = {}): Promise<{ challenge: string; expiresAt: number }> {
    return (await this.post(
      '/auth/challenge',
      { deviceId: this.options.deviceId },
      opts,
    )) as { challenge: string; expiresAt: number };
  }

  /**
   * 签名应答换 token。
   *
   * 待签名串必须与服务端逐字节一致——所以用 core 的
   * `authChallengeMessage()` 而不是本地拼字符串（三端共用同一个函数正是
   * 它定义在 core 的理由）。
   */
  async verify(challenge: string, opts: AuthRequestOptions = {}): Promise<AuthToken> {
    const signature = signDetached(
      authChallengeMessage(this.options.deviceId, challenge),
      this.options.signKeys.secretKey,
    );
    return (await this.post(
      '/auth/verify',
      { deviceId: this.options.deviceId, challenge, signature },
      opts,
    )) as AuthToken;
  }

  /** 便捷：挑战 + 应答一步到位 */
  async authenticate(opts: AuthRequestOptions = {}): Promise<AuthToken> {
    const { challenge } = await this.challenge(opts);
    return this.verify(challenge, opts);
  }

  /** Existing identities authenticate first; registration only on unknown_device. */
  async bootstrap(opts: AuthRequestOptions = {}): Promise<AuthToken> {
    try {
      return await this.authenticate(opts);
    } catch (err) {
      if (!(err instanceof AuthClientError) || err.reason !== 'unknown_device') throw err;
    }
    await this.register('agent', opts);
    return this.authenticate(opts);
  }

  private async post(path: string, body: unknown, opts: AuthRequestOptions = {}): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // 透传调用方的超时/取消信号（评审 N3）；未给就不设，行为与从前一致
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    const payload = (await res.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!res.ok) {
      const reason = String(payload?.error ?? 'unknown');
      throw new AuthClientError(
        `${path} 失败：HTTP ${res.status} ${reason}`,
        res.status,
        reason,
      );
    }
    return payload ?? {};
  }
}

/** Credentials must never follow redirects or travel over remote plaintext HTTP. */
export function assertEnrollmentUrl(base: string): void {
  const url = new URL(base);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('Enrollment requires HTTPS (or loopback HTTP), without URL credentials/query/fragment');
  }
}

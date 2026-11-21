/**
 * Web Push 渠道（PWA 原生通知，RFC 8030/8291/8292）。
 *
 * ## 为什么不走 PushDispatcher
 *
 * dispatcher 是**广播**模型：一条逻辑事件（run_done 等）去抖后只投一次，
 * 渠道拿到的 PushMessage 里刻意没有路由信息（types.ts 的脱敏签名约束）。
 * 而 Web Push 天然是**按设备定向**的：每台手机各自 subscribe 一个 endpoint，
 * 机器↔设备的映射关系服务端并不持有（配对名册在 agent 手里），中转链路里
 * 唯一能见到「这份数据属于哪台设备」的地方是 a2c relay 帧上的
 * `recipientDeviceId`——每收件人一帧。所以本渠道由 hub 在 routeToRecipient
 * 处按帧直调 `deliverTo()`，自带**按设备**的在线抑制与去抖；dispatcher 与
 * Bark 的行为一个字节都不动。
 *
 * ## 抑制与去抖（按设备，不是按机器）
 *
 * - **在线抑制**：目标设备当前有 WS 连接就不推——它正开着 trine，消息走
 *   WS 实时到达，再响一声只是噪音。这比 dispatcher 的全局抑制更准：PC 开着
 *   不该挡手机的推送。
 * - **去抖**：同一 (设备, 机器, 会话, hint) 30s 内只推一次，权限请求风暴
 *   不刷屏（与 dispatcher 同款窗口，独立计数）。
 *
 * ## 脱敏
 *
 * 文案复用 `renderPushMessage`（机器标识 + 事件类型的固定中文），payload 里
 * 额外带 machineId/sessionId 供 SW 点击深链——RFC 8291 加密后推送服务
 * （FCM/Apple）只见得到密文，这与 Bark 把机器标识明文交给第三方服务器相比
 * 反而更收敛。
 *
 * ## 投递
 *
 * 加密与 VAPID 头用久经沙场的 web-push 库生成（`generateRequestDetails`），
 * HTTP 用自己的 fetch（可注入、好测试）：5s 超时、4xx 不重试；404/410 =
 * 订阅已失效，顺手清掉本行。
 */
import {
  generateRequestDetails,
  generateVAPIDKeys,
  setVapidDetails,
} from 'web-push';
import type { Store } from '../store/index.ts';
import type { PushHint } from '@trine/core';
import { renderPushMessage, parseAliases } from './text.ts';

/**
 * VAPID 联系人（RFC 8292 subject）的兜底值：推送服务出问题时找谁。
 * 会被 env TRINE_VAPID_SUBJECT 覆盖。
 *
 * **iOS 注意（实测 2026-11）**：Apple 的推送服务拒绝 `mailto:` 带
 * localhost 域的 subject（HTTP 403 BadJwtToken），且订阅与 VAPID 公钥
 * 绑定（换公钥发报 400 VapidPkHashMismatch）。iOS 场景务必把
 * TRINE_VAPID_SUBJECT 配成自己的 https 地址，如 https://trine.example.com。
 */
const DEFAULT_VAPID_SUBJECT = 'mailto:trine@example.com';

/** 通知存活时长：跑完/待确认的提醒过两小时还没送达就别响了 */
const TTL_BY_HINT: Record<PushHint, number> = {
  permission_pending: 30 * 60,
  question_pending: 30 * 60,
  plan_pending: 30 * 60,
  run_done: 2 * 60 * 60,
  run_error: 2 * 60 * 60,
};

/** 权限类提醒值得立刻叫人，跑完类默认优先级 */
const URGENCY_BY_HINT: Record<PushHint, 'high' | 'normal'> = {
  permission_pending: 'high',
  question_pending: 'high',
  plan_pending: 'high',
  run_done: 'normal',
  run_error: 'normal',
};

/** 传给 SW 的 payload（RFC 8291 加密，推送服务读不到） */
interface PushPayload {
  title: string;
  body: string;
  tag: string;
  machineId: string;
  sessionId?: string;
}

/** 最小 fetch 签名（typeof fetch 在 bun 的类型里带 preconnect 等扩展，测试替身难对齐） */
export type PushFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface WebPushDeps {
  store: Store;
  /** 目标设备当前是否有 WS 连接（在线抑制判据，注入便于测试） */
  isDeviceOnline: (deviceId: string) => boolean;
  /** 机器标识别名，与 Bark 渠道同一份 TRINE_PUSH_ALIAS 原串 */
  rawAlias?: string;
  /** VAPID subject（env TRINE_VAPID_SUBJECT）；iOS 需配 https 域名，见 DEFAULT_VAPID_SUBJECT 注释 */
  vapidSubject?: string;
  fetchImpl?: PushFetch;
  log?: (line: string) => void;
  now?: () => number;
  dedupeWindowMs?: number;
  /** 单次投递超时 */
  timeoutMs?: number;
}

export type DeliverOutcome =
  | { kind: 'sent' }
  | { kind: 'skipped'; reason: 'no_subscription' | 'device_online' | 'muted' | 'deduped' | 'disabled' }
  | { kind: 'failed'; status?: number };

export class WebPushService {
  readonly #store: Store;
  readonly #isDeviceOnline: (deviceId: string) => boolean;
  readonly #aliases: Record<string, string>;
  readonly #fetchImpl: PushFetch;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #dedupeWindowMs: number;
  readonly #timeoutMs: number;
  readonly #subject: string;
  /** 去抖记录：key = device|machine|session|hint → 上次推送时刻 */
  readonly #lastSentAt = new Map<string, number>();
  #vapid: { publicKey: string; privateKey: string } | null = null;

  constructor(deps: WebPushDeps) {
    this.#store = deps.store;
    this.#isDeviceOnline = deps.isDeviceOnline;
    this.#aliases = parseAliases(deps.rawAlias);
    this.#fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.#log = deps.log ?? (() => {});
    this.#now = deps.now ?? (() => Date.now());
    this.#dedupeWindowMs = deps.dedupeWindowMs ?? 30_000;
    this.#timeoutMs = deps.timeoutMs ?? 5_000;
    this.#subject = deps.vapidSubject ?? DEFAULT_VAPID_SUBJECT;
  }

  /**
   * VAPID 公钥：首启自动生成并落库（跨重启稳定），之后每次 client 连上
   * 由 hub 用它发 push.config。库内部状态（setVapidDetails）同步在这里初始化。
   */
  get vapidPublicKey(): string | null {
    if (this.#vapid === null) {
      try {
        this.#vapid = this.#store.getOrInitVapid(() => {
          const keys = generateVAPIDKeys();
          return { publicKey: keys.publicKey, privateKey: keys.privateKey };
        }, this.#now());
        setVapidDetails(
          this.#subject, this.#vapid.publicKey, this.#vapid.privateKey,
        );
      } catch (err) {
        // 推送是旁路，初始化失败只记日志：订阅/投递会各自返回 disabled/failed
        this.#log(`[webpush] VAPID 初始化失败：${String((err as Error).message ?? err)}`);
        return null;
      }
    }
    return this.#vapid.publicKey;
  }

  /** client 上报订阅（hub 在 push.subscribe 帧处调用，deviceId 来自连接身份） */
  subscribe(
    deviceId: string,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  ): void {
    this.#store.upsertPushSubscription(
      { deviceId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      this.#now(),
    );
    this.#log(`[webpush] 设备已订阅 ${deviceId}`);
  }

  /** client 退订；endpoint 对不上也无妨（幂等，删的是该设备的行） */
  unsubscribe(deviceId: string): void {
    this.#store.removePushSubscription(deviceId);
    this.#log(`[webpush] 设备已退订 ${deviceId}`);
  }

  /** 全量覆盖该设备的会话静音名单（push.mute；轮询会话防骚扰） */
  setMutes(deviceId: string, sessionIds: readonly string[]): void {
    this.#store.setPushMutes(deviceId, sessionIds, this.#now());
    this.#log(`[webpush] 设备静音名单更新 ${deviceId}（${sessionIds.length} 个会话）`);
  }

  /**
   * 一条 a2c relay 帧带 pushHint 时，向**那一帧的收件设备**投一次通知。
   * 同步返回判定结果，真正的 HTTP fire-and-forget——绝不阻塞中转主链路。
   */
  deliverTo(event: {
    machineId: string;
    recipientDeviceId: string;
    sessionId?: string;
    hint: PushHint;
  }): DeliverOutcome {
    if (this.vapidPublicKey === null) return { kind: 'skipped', reason: 'disabled' };

    const sub = this.#store.getPushSubscription(event.recipientDeviceId);
    if (sub === null) return { kind: 'skipped', reason: 'no_subscription' };

    if (this.#isDeviceOnline(event.recipientDeviceId)) {
      // 在线设备不推也**不记去抖**（与 dispatcher 同款细节：否则人一下线，
      // 本该推的第一条会被抑制期的记录压掉）
      return { kind: 'skipped', reason: 'device_online' };
    }

    // 会话级静音（push.mute）：机器级事件没有 sessionId，不受静音影响
    if (event.sessionId !== undefined
      && this.#store.isPushMuted(event.recipientDeviceId, event.sessionId)) {
      return { kind: 'skipped', reason: 'muted' };
    }

    const key = [
      event.recipientDeviceId, event.machineId, event.sessionId ?? '', event.hint,
    ].join('\u0000');
    const now = this.#now();
    const last = this.#lastSentAt.get(key);
    if (last !== undefined && now - last < this.#dedupeWindowMs) {
      return { kind: 'skipped', reason: 'deduped' };
    }
    this.#lastSentAt.set(key, now);
    if (this.#lastSentAt.size > 256) this.#sweepDedupe(now);

    const message = renderPushMessage(
      { machineId: event.machineId, hint: event.hint, at: now },
      this.#aliases,
    );
    const payload: PushPayload = {
      title: message.title,
      body: message.body,
      tag: message.group,
      machineId: event.machineId,
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    };

    try {
      const req = generateRequestDetails(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: TTL_BY_HINT[event.hint], urgency: URGENCY_BY_HINT[event.hint] },
      );
      this.#post(event.recipientDeviceId, req.endpoint as string, req.headers as Record<string, string>, req.body as Buffer)
        .catch(() => { /* 错误在 #post 内已处理 */ });
    } catch (err) {
      this.#log(`[webpush] 构造请求失败：${String((err as Error).message ?? err)}`);
      return { kind: 'failed' };
    }
    return { kind: 'sent' };
  }

  /** 单次投递：5s 超时；4xx 不重试；404/410 = 订阅失效，清掉 */
  async #post(
    deviceId: string,
    url: string,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<void> {
    try {
      const res = await this.#fetchImpl(url, {
        method: 'POST',
        headers,
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (res.status === 404 || res.status === 410) {
        // 推送服务明确说订阅没了（卸载/权限收回/key 轮换）：清行，别再白发
        this.#store.removePushSubscription(deviceId);
        this.#log(`[webpush] 订阅已失效（${res.status}），清理 ${deviceId}`);
        return;
      }
      if (!res.ok) {
        this.#log(`[webpush] 投递失败 HTTP ${res.status}`);
      }
    } catch (err) {
      this.#log(`[webpush] 投递异常：${String((err as Error).message ?? err)}`);
    }
  }

  #sweepDedupe(now: number): void {
    for (const [key, at] of this.#lastSentAt) {
      if (now - at >= this.#dedupeWindowMs) this.#lastSentAt.delete(key);
    }
  }
}

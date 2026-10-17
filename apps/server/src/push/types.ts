/**
 * 推送的渠道无关类型（D6：事件 → 渠道适配器）。
 *
 * ## 零知识边界（硬约束）
 *
 * `PushEvent` 与 `PushMessage` 的字段集本身就是脱敏策略的执行者——
 * **结构里没有正文字段可填，也就没有误填的空间**。
 *
 * - `PushEvent`：机器标识 + 事件类型 + 时刻。`sessionId` 是服务端路由字段
 *   （信封外明文，不是会话名），只用于去抖分桶，**永远不进渠道 payload**；
 * - `PushMessage`：渠道真正发出去的东西，只有标题与正文两段固定文案，
 *   由 `renderPushMessage()` 从「机器标识 + 事件类型」拼出。
 *
 * 会话名、cwd、消息正文、密文、nonce 一律在 E2E 信封内，服务端根本读不到，
 * 更不可能推出去。
 */
import type { PushHint } from '@trine/core/types';

export interface PushEvent {
  /** 目标机器（服务端可见的路由字段） */
  machineId: string;
  /**
   * 会话路由标识（服务端可见的明文路由字段，非会话名）。
   * 只用于去抖分桶——同一会话的权限请求风暴不该刷屏。**不进推送内容。**
   */
  sessionId?: string;
  /** 事件类型——推送里唯一的语义内容 */
  hint: PushHint;
  at: number;
}

/** 渠道要发送的最终内容：只有这两段文案，没有别的 */
export interface PushMessage {
  title: string;
  body: string;
  /** 渠道分组用的稳定标识（Bark 的 group），= 机器标识，不含会话信息 */
  group: string;
}

/**
 * 渠道适配器。
 *
 * **只收 `PushMessage`，收不到 `PushEvent`**——这是刻意的：渠道实现拿不到
 * machineId 原值、sessionId 这些路由字段，也就不可能「顺手」把它们塞进
 * payload。想加个渠道就得接受这个约束，脱敏不靠自觉靠签名。
 *
 * ## 实现约定
 *
 * `send()` **不得同步抛出**——所有错误都要走返回的 Promise（`async` 函数
 * 天然满足；手写返回 Promise 的实现要自己保证入口不抛）。原因是调用方
 * `dispatch()` 是同步返回的，它上溯到 WS 消息处理器一路没有 try/catch，
 * 同步异常会打穿中转主链路。dispatcher 侧另有一层兜底，但那是安全网，
 * 不是许可。
 */
export interface PushChannel {
  readonly name: string;
  send(message: PushMessage): Promise<void>;
}

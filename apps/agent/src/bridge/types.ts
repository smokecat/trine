/**
 * 桥接层本地类型：只补 `@trine/core` 没有的「过程中」概念，
 * 不重定义任何已在 core 定稿的协议/领域类型。
 *
 * ## 核心概念：事件体（EventBody）
 *
 * core 的 `AgentToClientEvent` 每一帧都强制带信封字段 `{ ts, seq, dir, sessionId? }`
 * （见 core/protocol/events.ts 文件头「信封绑定」）。但 seq 必须由**发送方单点**
 * 按序列分配才能保证单调，ts 也应取实际发送时刻——这两件事都不属于「把 SDK 消息
 * 翻译成事件」的职责。
 *
 * 所以分层如下（主会话拍板的决策 1）：
 * - **translate 层**（translate.ts）是纯函数，只产出 `EventBody`——即事件去掉
 *   信封四字段后的剩余部分。纯函数意味着可以脱离 SDK、脱离会话状态直接单测。
 * - **发送层**（emitter.ts）统一补 `dir: 'a2c'` + `ts` + 自增 `seq`（+ 会话级帧的
 *   sessionId），产出完整的 `AgentToClientEvent`。seq 单调性由它单点管辖，
 *   与 server 的校验语义天然对齐。
 */
import type { AgentToClientEvent } from '@trine/core';

/** 信封字段名集合——EventBody 就是从事件类型里剔掉这些 */
export type EnvelopeField = 'ts' | 'seq' | 'dir' | 'sessionId';

/**
 * 事件体：`AgentToClientEvent` 去掉信封字段后的形状（保留 discriminated union，
 * 按 `type` 仍可判别）。translate 层的产出、emitter 层的输入。
 */
export type EventBody = {
  [E in AgentToClientEvent as E['type']]: Omit<E, EnvelopeField>;
}[AgentToClientEvent['type']];

/** 取某个具体事件类型的事件体，如 `EventBodyOf<'tool.start'>` */
export type EventBodyOf<T extends AgentToClientEvent['type']> = Omit<
  Extract<AgentToClientEvent, { type: T }>,
  EnvelopeField
>;

/** error.fatal 的 kind，复用协议定义避免漂移 */
export type ErrorKind = EventBodyOf<'error.fatal'>['kind'];

/**
 * 会话级 seq 序列的标识：会话级帧按 sessionId 各自一条序列，
 * 机器级帧（machine.info / cwd.* 等 sessionId 省略的）共用一条独立序列。
 * 用 `null` 表示机器级，与协议里「sessionId 省略」一一对应。
 */
export type SeqScope = string | null;

/** 一条待发送的完整事件（已补信封），加上路由所需的 scope */
export interface OutboundEvent {
  event: AgentToClientEvent;
  /** 与 event.sessionId 对应：会话级为 sessionId，机器级为 null */
  scope: SeqScope;
  /**
   * 定向收件人 deviceId：给了就**只发给这一台**（如 session.history.response——
   * 大帧、只有请求方用得上）；省略 = 发给名册里全部设备。
   *
   * seq 仍从该 scope 的共享序列里取，其余设备那条子流因此跳一号：client 只要求
   * 单调（seq > 游标）、服务端按收件人子流校验单调，缺号都不影响（见 outbox.ts
   * 文件头「按收件人记 seq」）。
   */
  to?: string;
}

/** 事件消费者：网络层接入前，演示脚本/测试直接消费 */
export type EventSink = (out: OutboundEvent) => void;

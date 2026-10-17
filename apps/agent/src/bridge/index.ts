/**
 * 代理端 Claude 桥接层：用 Agent SDK 驱动本机 claude。
 *
 * 分层（自下而上）：
 * - `translate.ts` — SDK 消息 → 协议事件体的**纯函数**（不含信封字段）
 * - `emitter.ts` — 补信封（ts/seq/dir/sessionId），seq 单点管辖
 * - `permission.ts` — canUseTool ↔ 远端异步应答
 * - `queue.ts` / `heartbeat.ts` / `errors.ts` — 排队去重 / 心跳 / 错误分类
 * - `session.ts` — 一个会话 = 一个 SDK query = 一个子进程
 * - `manager.ts` — sessionId 互斥、并发上限、空闲回收、会话列表
 *
 * 本层不含 WS 网络与 E2E 加密（另有任务），产出的是明文事件。
 */
export { EventEmitter, scopedEmitter, type ScopedEmitter, type EmitterOptions } from './emitter.ts';
export {
  classifyError,
  classifyResultSubtype,
  errorText,
  isAbortError,
  type ErrorClassification,
  type FatalClassification,
} from './errors.ts';
export { Heartbeat, type HeartbeatOptions, type HeartbeatTool } from './heartbeat.ts';
export {
  ConcurrencyLimitError,
  SessionManager,
  type AcquireResult,
  type CreateSessionArgs,
  type SessionManagerOptions,
} from './manager.ts';
export {
  PermissionBridge,
  type PendingPermissionSnapshot,
  type PermissionBridgeOptions,
  type PermissionVerdict,
} from './permission.ts';
export { InputQueue, type EnqueueResult, type InputQueueOptions, type QueuedInput } from './queue.ts';
export {
  ClaudeSession,
  createPushStream,
  type ClaudeSessionOptions,
  type SessionRuntimeMeta,
} from './session.ts';
export {
  formatDuration,
  outputPreview,
  summarizeToolArgs,
  summarizeToolResult,
  toSingleLine,
  type ToolOutcome,
} from './summarize.ts';
export {
  createTranslateState,
  translateMessage,
  type TranslateContext,
  type TranslateState,
} from './translate.ts';
export type {
  EnvelopeField,
  ErrorKind,
  EventBody,
  EventBodyOf,
  EventSink,
  OutboundEvent,
  SeqScope,
} from './types.ts';

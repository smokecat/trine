/**
 * 领域类型：会话 / 机器 / 权限请求等三端共享的数据形状。
 * 用 zod 定义并导出推断类型，protocol 层直接复用这些 schema。
 */
import { z } from 'zod';

/** epoch 毫秒时间戳 */
export const TimestampSchema = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof TimestampSchema>;

/** 会话运行状态（列表页状态 pill 与 run.state 同源） */
export const SessionStateSchema = z.enum([
  'idle',
  'running',
  'waiting_permission',
  'error',
  'stopped',
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

/** 权限模式，对应 SDK setPermissionMode / CLI --permission-mode */
export const PermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/**
 * 会话等待的是哪一类人工决定（`SessionMeta.waitingFor`）：
 * - `question` — AskUserQuestion（Claude 在提问）
 * - `plan` — ExitPlanMode（等待批准计划）
 * - `permission` — 其余工具的普通权限请求
 *
 * 由「最早一条挂起的权限请求」的 toolName 推出，映射见 permission/waiting.ts。
 */
export const WaitingForSchema = z.enum(['permission', 'question', 'plan']);
export type WaitingFor = z.infer<typeof WaitingForSchema>;

/** 心跳所处阶段 */
export const RunPhaseSchema = z.enum(['run', 'tool', 'wait']);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

/** 工具调用结果状态（工具卡右侧 ✓/⚠/✗） */
export const ToolResultStatusSchema = z.enum(['ok', 'warn', 'error']);
export type ToolResultStatus = z.infer<typeof ToolResultStatusSchema>;

/** 会话列表条目 / 会话元数据快照 */
export const SessionMetaSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string(),
  state: SessionStateSchema,
  /** 最近一条事件的单行摘要 */
  lastEvent: z.string().optional(),
  lastActivityAt: TimestampSchema,
  cwd: z.string(),
  model: z.string(),
  permissionMode: PermissionModeSchema,
  /** 会话级累计成本（USD） */
  costUsd: z.number().nonnegative(),
  /**
   * 以下均可选（session-list-v2 新增）：旧 agent 不发、旧 client 收到会被 strip，
   * 两个方向都兼容（SessionMetaSchema 非 strict）。
   *
   * 是否已归档。标记存在 agent 的 flags store（DECISIONS D12），省略 = 未归档。
   */
  archived: z.boolean().optional(),
  /** 归档时间（archived 为 true 时带） */
  archivedAt: TimestampSchema.optional(),
  /** 会话创建时间（SDK：转录首条记录的时间戳） */
  createdAt: TimestampSchema.optional(),
  /** git 分支（SDK：会话结束时的分支） */
  gitBranch: z.string().optional(),
  /** 首条有意义的用户输入（SDK firstPrompt，搜索用） */
  firstPrompt: z.string().optional(),
  /**
   * state 为 `waiting_permission` 时，最早一条挂起请求的类型（exit-plan-mode
   * 新增，可选）。非等待态不带；旧 agent 不发——client 缺省按 `permission` 处理。
   */
  waitingFor: WaitingForSchema.optional(),
  /**
   * 正在运行的后台任务数（background-tasks 新增，可选；agent ≥ 0.7.0）。
   * 会话 idle 但子进程里还有后台 Bash / 子 agent 在跑时 > 0——列表行 / 头部据此
   * 给「后台 N」的弱提示，不显示成运行中。省略 = 0 / 旧 agent。
   */
  bgRunning: z.number().int().nonnegative().optional(),
  /**
   * 非交互会话（session-ux 新增，可选）：转录出身是 `claude -p` / Python SDK
   * 之类的脚本调用，不是终端交互或 trine 开的。client 默认把它归为临时会话、
   * 不在列表里显示。省略 = 不是 / 不知道 / 旧 agent。
   */
  headless: z.boolean().optional(),
  /**
   * 会话当前在 agent 上有子进程（占一个活跃名额；live-sessions 新增，可选，
   * agent ≥ 0.10.0）。空闲回收 / 满额腾位后变回省略。省略 = 没有 / 旧 agent。
   */
  live: z.boolean().optional(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

/** 后台任务摘要（完成时的一行）长度上限 */
export const BG_TASK_SUMMARY_MAX = 200;

/**
 * 会话里的一个后台任务（Bash `run_in_background` / 后台子 agent；background-tasks
 * 新增）。来源是 SDK 的 task_started / task_progress / task_updated /
 * task_notification / background_tasks_changed 五种 system 消息，agent 侧汇总成
 * 快照（`bgtask.snapshot`）整体下发，client 直接替换、不做增量合并。
 *
 * - `kind`：local_bash → bash、local_agent → agent、其余 other
 * - `status`：running → completed / failed / stopped（stopped = 被 TaskStop /
 *   `bgtask.stop` 杀掉，或随子进程一起结束）
 * - `summary`：结束时的一行摘要（限长 BG_TASK_SUMMARY_MAX）
 * - `lastToolName` / `toolUses` / `durationMs`：子 agent 的进度（task_progress）
 */
export const BgTaskSchema = z.object({
  taskId: z.string().min(1),
  kind: z.enum(['bash', 'agent', 'other']),
  description: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'stopped']),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
  /** 发起它的那次工具调用（与时间线上的工具卡关联） */
  toolUseId: z.string().optional(),
  summary: z.string().max(BG_TASK_SUMMARY_MAX).optional(),
  lastToolName: z.string().optional(),
  toolUses: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type BgTask = z.infer<typeof BgTaskSchema>;

/**
 * 历史回看条目（`session.history.response`，决策 D8：agent 读本机会话存储按需拉取）。
 *
 * 形状刻意贴着 web 时间线的三种内容条目，id 与实时流同源，client 才能去重：
 * - `user` — 转录里的用户消息（id = 转录行 uuid）
 * - `assistant` — 同一 SDK `message.id`（`msg_…`）的全部文本块合并；
 *   id 与实时流 `assistant.*` 的 messageId 同源
 * - `tool` — 一次工具调用（id = toolUseId，与实时流 `tool.*` 同源），
 *   结果字段来自后续配对的 tool_result；没配到结果时省略
 *
 * `ts` 取转录行的 `timestamp`（ISO → epoch 毫秒）。
 */
export const HistoryItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    id: z.string().min(1),
    text: z.string(),
    ts: TimestampSchema,
  }),
  z.object({
    kind: z.literal('assistant'),
    id: z.string().min(1),
    text: z.string(),
    ts: TimestampSchema,
  }),
  z.object({
    kind: z.literal('tool'),
    id: z.string().min(1),
    toolName: z.string().min(1),
    argSummary: z.string(),
    status: ToolResultStatusSchema.optional(),
    /** tool_use 到 tool_result 两行 timestamp 之差（配到结果才有） */
    durationMs: z.number().int().nonnegative().optional(),
    resultSummary: z.string().optional(),
    outputPreview: z.string().optional(),
    ts: TimestampSchema,
  }),
]);
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

/** 机器信息（E2E 密文内） */
export const MachineInfoSchema = z.object({
  name: z.string(),
  platform: z.string(),
  osVersion: z.string(),
  agentVersion: z.string(),
  claudeVersion: z.string(),
  activeSessionCount: z.number().int().nonnegative(),
  /** 活跃会话上限（live-sessions 新增，可选；旧 agent 不发） */
  maxSessions: z.number().int().positive().optional(),
});
export type MachineInfo = z.infer<typeof MachineInfoSchema>;

/** 机器在线状态（服务端可见——在线状态本身就是服务端知道的） */
export const MachineStatusSchema = z.object({
  machineId: z.string().min(1),
  online: z.boolean(),
  lastSeenAt: TimestampSchema,
});
export type MachineStatus = z.infer<typeof MachineStatusSchema>;

/** MCP server 状态（源：SDK system/init 的 mcp_servers） */
export const McpServerStatusSchema = z.object({
  name: z.string(),
  state: z.enum(['connected', 'failed', 'needs_auth']),
  toolCount: z.number().int().nonnegative(),
});
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

/** slash command 条目（源：SDK system/init 的 slash_commands） */
export const SlashCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  source: z.enum(['project', 'user', 'skill', 'plugin']),
});
export type SlashCommand = z.infer<typeof SlashCommandSchema>;

/**
 * 推送提示（信封外明文元数据，零知识边界）：
 * 只含事件类型，服务端据此触发脱敏推送（机器名 + 事件类型，不含正文/会话名）。
 */
export const PushHintSchema = z.enum([
  'permission_pending',
  'run_done',
  'run_error',
  /**
   * 以下两项 exit-plan-mode 新增：AskUserQuestion / ExitPlanMode 的挂起请求。
   *
   * **部署顺序**：pushHint 走 transport 层的 RelayFrame，旧 server 用旧枚举
   * `TransportFrameSchema.parse` 整帧校验，遇到不认识的值会把**整条 relay
   * 帧**当 malformed 丢掉（连密文一起，且不回 relay.reject）——即那条
   * permission.request 根本到不了 client。所以必须先部署 server，再升级 agent。
   */
  'question_pending',
  'plan_pending',
]);
export type PushHint = z.infer<typeof PushHintSchema>;

/**
 * 领域类型：会话 / 机器 / 权限请求等三端共享的数据形状。
 * 用 zod 定义并导出推断类型，protocol 层直接复用这些 schema。
 */
import { z } from 'zod';
import { MachineExtensionsSummarySchema, SessionLinkSchema } from './ext.ts';

export * from './ext.ts';

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

/**
 * 会话 context 用量（usage-display 新增；源：SDK `Query.getContextUsage()`，主 agent
 * 每轮结束后取一次）。子进程回收后保留最后一次的值，`at` 是取值时间。
 */
export const ContextUsageSchema = z.object({
  usedTokens: z.number().int().nonnegative(),
  /** 用量的分母：自动压缩窗口（可能小于模型的硬上限） */
  maxTokens: z.number().int().positive(),
  /** usedTokens / maxTokens 的百分比，超窗时可 > 100 */
  percent: z.number().nonnegative(),
  at: TimestampSchema,
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

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
  /** 最近一次已知的 context 用量（usage-display 新增，可选；agent ≥ 0.12.0）。省略 = 还没取到 / 旧 agent */
  context: ContextUsageSchema.optional(),
  /**
   * 置顶时间（sidebar-pin 新增，可选；agent ≥ 0.14.0）。标记存在 agent 的 flags store，
   * 与 archived 同源；省略 = 未置顶。列表里置顶会话排在所属组 / 平铺列表的最前，越晚置顶越靠上。
   */
  pinnedAt: TimestampSchema.optional(),
  /**
   * 扩展写下的会话关联（extensions 新增，可选；agent ≥ 0.16.0）。存在 agent 的
   * session-links.json；省略 = 没有关联 / 旧 agent。
   */
  links: z.array(SessionLinkSchema).max(64).optional(),
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
 * 用户消息附件（图片 / 文件）。
 *
 * 字节不走 E2E 帧：发送端用一次性 key 加密成 blob 传到 relay，帧里只带引用
 * （`blobId` + `key`，都在 E2E 密文里）。blob 有 TTL，过期或根本没有 blob 的
 * 附件（本机 CLI 里直接粘贴的图片）由 agent 按需重新上传，见 `attachment.fetch`。
 *
 * - `image`：agent 尽量作为 image 内容块直接交给模型，超出 API 限制时退化为文件路径
 * - `file`：agent 落盘后在消息末尾附上路径，由 Claude 用 Read 读取
 */
export const AttachmentKindSchema = z.enum(['image', 'file']);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

/** 单条消息附件个数的协议硬上限（用户可调的默认值见 ATTACHMENTS_DEFAULT_*） */
export const ATTACHMENTS_MAX_COUNT = 32;
/** 默认每条消息最多附件个数（web 设置可调，不超过 ATTACHMENTS_MAX_COUNT） */
export const ATTACHMENTS_DEFAULT_MAX_COUNT = 10;
/** 默认每条消息附件合计字节上限（web 设置可调，不超过 relay 的 blob 上限） */
export const ATTACHMENTS_DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
/** 文件名长度上限（字符） */
export const ATTACHMENT_NAME_MAX = 255;

/** blobId：relay 生成的不透明 id（只含 URL 安全字符，可直接拼进路径） */
export const BlobIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

export const AttachmentMetaSchema = z.object({
  name: z.string().min(1).max(ATTACHMENT_NAME_MAX),
  mime: z.string().max(255),
  /** 原始字节数（明文） */
  size: z.number().int().nonnegative(),
  kind: AttachmentKindSchema,
});
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

/** 带 blob 引用的附件：拿着它就能从 relay 下载并解密 */
export const AttachmentRefSchema = AttachmentMetaSchema.extend({
  blobId: BlobIdSchema,
  /** secretstream key（base64url，32 字节） */
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

/** 历史条目里的附件：引用可能缺（从没上传过 / agent 不知道），点击时再按需拉 */
export const HistoryAttachmentSchema = AttachmentMetaSchema.extend({
  blobId: BlobIdSchema.optional(),
  key: AttachmentRefSchema.shape.key.optional(),
});
export type HistoryAttachment = z.infer<typeof HistoryAttachmentSchema>;

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
    /** 附件（agent ≥ 0.11.0）；下标即 `attachment.fetch.request` 的 index */
    attachments: z.array(HistoryAttachmentSchema).max(ATTACHMENTS_MAX_COUNT).optional(),
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
    /** 文件类工具（Read/Write/Edit…）的完整路径，见 ToolStartSchema.filePath（agent ≥ 0.20.0） */
    filePath: z.string().min(1).max(4096).optional(),
    status: ToolResultStatusSchema.optional(),
    /** tool_use 到 tool_result 两行 timestamp 之差（配到结果才有） */
    durationMs: z.number().int().nonnegative().optional(),
    resultSummary: z.string().optional(),
    outputPreview: z.string().optional(),
    ts: TimestampSchema,
  }),
]);
export type HistoryItem = z.infer<typeof HistoryItemSchema>;

/** 一个订阅限额窗口的用量（5 小时 / 7 天） */
export const RateLimitWindowSchema = z.object({
  /** 已用百分比，0–100 */
  percent: z.number().nonnegative(),
  /** 窗口重置时间；未知时省略 */
  resetsAt: TimestampSchema.optional(),
});
export type RateLimitWindow = z.infer<typeof RateLimitWindowSchema>;

/**
 * 机器上登录的 Claude 账号的订阅限额用量（usage-display 新增）。账号级数据：同一
 * 台机器的所有会话共用。会话活动时随 SDK 的限额事件刷新，或由 client 手动请求
 * （`machine.usage.request`）。API key / Bedrock / Vertex 等没有订阅限额的账号不带。
 */
export const RateLimitsSchema = z.object({
  fiveHour: RateLimitWindowSchema.optional(),
  sevenDay: RateLimitWindowSchema.optional(),
  /** agent 最近一次拿到这份数据的时间 */
  updatedAt: TimestampSchema,
});
export type RateLimits = z.infer<typeof RateLimitsSchema>;

/** 字节数 / 速率等非负整数（资源数据用） */
const BytesSchema = z.number().int().nonnegative();

/** 资源快照里的一个文件系统（home、`/` 所在的，去重后最多几个） */
export const MachineDiskSchema = z.object({
  /** 展示用标签：`/`、`~`，不是完整挂载路径 */
  label: z.string().min(1).max(64),
  totalBytes: BytesSchema,
  usedBytes: BytesSchema,
  /** 普通用户可用（statfs bavail），可能小于 total - used */
  availBytes: BytesSchema,
});
export type MachineDisk = z.infer<typeof MachineDiskSchema>;

/**
 * agent 机器的资源快照（machine-stats 新增，agent ≥ 0.14.0；`machine.stats` 事件）。
 * 各块都可选：某项采不到（平台不支持、命令失败）就省略那一块，不影响其余。
 */
export const MachineStatsSchema = z.object({
  /** 采样时间 */
  at: TimestampSchema,
  cpu: z
    .object({
      /** 自上次采样以来的总体占用，0–100 */
      percent: z.number().min(0).max(100),
      cores: z.number().int().positive(),
      /** 1 / 5 / 15 分钟平均负载 */
      load: z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative()]).optional(),
    })
    .optional(),
  memory: z
    .object({
      totalBytes: BytesSchema,
      /** total - 可用（Linux MemAvailable；macOS free + inactive + speculative） */
      usedBytes: BytesSchema,
      swapTotalBytes: BytesSchema.optional(),
      swapUsedBytes: BytesSchema.optional(),
    })
    .optional(),
  disks: z.array(MachineDiskSchema).max(8).optional(),
  /** 物理网卡合计速率（排除回环与容器 / VPN 等虚拟网卡），自上次采样以来 */
  network: z.object({ rxBytesPerSec: BytesSchema, txBytesPerSec: BytesSchema }).optional(),
  uptimeSec: z.number().int().nonnegative().optional(),
  /** agent 的全部子孙进程（claude CLI 及其拉起的 MCP server 等）：个数与 RSS 合计 */
  claude: z.object({ processes: z.number().int().nonnegative(), rssBytes: BytesSchema }).optional(),
});
export type MachineStats = z.infer<typeof MachineStatsSchema>;

/**
 * agent 自重启（agent-restart，agent ≥ 0.18.0）：运行版本与进行中的重启。
 *
 * 重启 = 预检 → 等全部会话空闲（排空）→ agent 自行退出、由 supervisor 拉起。会话的 claude
 * 子进程随 agent 一起结束，之后发消息按 resume 接上；所以要排空，不打断进行中的轮次。
 */
export const MachineRestartInfoSchema = z.object({
  /** 能否远程重启：agent 由 supervisor（systemd 等）拉起时才行 */
  available: z.boolean(),
  /** available 为 false 的原因（给人看） */
  unavailableReason: z.string().max(300).optional(),
  /** 运行中的代码版本（启动时工作区的 git HEAD，短 sha）；读不到不给 */
  revision: z.string().max(64).optional(),
  /** 工作区当前的 git HEAD（短 sha）；与 revision 不同 = 有更新还没生效 */
  workspaceRevision: z.string().max(64).optional(),
  /** 进行中的重启；没有就省略 */
  pending: z
    .object({
      /** checking：在跑预检；draining：预检通过，等会话空闲 */
      phase: z.enum(['checking', 'draining']),
      requestedAt: TimestampSchema,
      /** 排空的截止时刻：到点仍有会话在忙就取消这次重启 */
      deadline: TimestampSchema.optional(),
      /** 还在忙的会话数（排空时） */
      busySessions: z.number().int().nonnegative(),
    })
    .optional(),
});
export type MachineRestartInfo = z.infer<typeof MachineRestartInfoSchema>;

/**
 * claude 最新版本（claude-latest，agent ≥ 0.19.0）：agent 向 claude 自更新所用的发布源
 * （`downloads.claude.ai/claude-code-releases/<channel>`）查到的版本，与 claudeVersion 比较
 * 即知有没有新版本。启动后与每 6 小时自动查一次，也可手动 `machine.claude.check.request`。
 */
export const MachineClaudeLatestSchema = z.object({
  /** 查询的渠道：claude settings 的 `autoUpdatesChannel`，默认 latest */
  channel: z.enum(['latest', 'stable']),
  /** 最近一次查到的版本（如 `2.1.308`）；还没查成功过就省略 */
  version: z.string().max(64).optional(),
  /** version 的查询时刻 */
  checkedAt: TimestampSchema.optional(),
  /** 最近一次查询失败的原因（给人看）；之后查成功就清掉 */
  error: z.string().max(300).optional(),
});
export type MachineClaudeLatest = z.infer<typeof MachineClaudeLatestSchema>;

/** 文件查看能力（fs.list / fs.read，见 protocol §1.10） */
export const MachineFilesInfoSchema = z.object({
  /** 单个文件可预览的字节上限 */
  maxBytes: z.number().int().positive(),
});
export type MachineFilesInfo = z.infer<typeof MachineFilesInfoSchema>;

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
  /** 订阅限额用量（usage-display 新增，可选；agent ≥ 0.12.0）。省略 = 还没拿到 / 账号没有订阅限额 / 旧 agent */
  rateLimits: RateLimitsSchema.optional(),
  /**
   * 扩展摘要（extensions 新增，可选；agent ≥ 0.16.0）。缺失 = agent 不支持扩展，client 隐藏全部
   * 扩展入口；完整目录按 rev 另拉 `ext.catalog.request`。
   */
  extensions: MachineExtensionsSummarySchema.optional(),
  /** agent 自重启（agent-restart 新增，可选；agent ≥ 0.18.0）。缺失 = 不支持，client 隐藏重启入口 */
  restart: MachineRestartInfoSchema.optional(),
  /** claude 最新版本（claude-latest 新增，可选；agent ≥ 0.19.0）。缺失 = 不支持，client 隐藏检查入口 */
  claudeLatest: MachineClaudeLatestSchema.optional(),
  /** 文件查看（file-viewer 新增，可选；agent ≥ 0.20.0）。缺失 = 不支持或已关闭，client 隐藏文件入口 */
  files: MachineFilesInfoSchema.optional(),
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

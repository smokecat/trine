/**
 * E2E 事件帧：client ↔ agent 之间加密信封内的明文 payload。
 * 服务端永远看不到这些帧——但路由字段必须**同时**出现在密文里，
 * 见下方「信封绑定」。
 *
 * 命名约定：`域.动作`；req/resp 成对的帧用 `.request` / `.response` 后缀，
 * 以 `reqId` 关联。
 *
 * ## 信封绑定（防恶意服务端反射 / 重放 / 跨会话拼接）
 *
 * crypto_box 的双向共享密钥相同（X25519 ECDH，A→B 与 B→A 同一 key），
 * 因此只把路由元数据放在明文信封（RelayFrame）上是不够的：
 *
 * - **反射**：server 把 client 发的密文原样回发给 client，client 用同一
 *   共享密钥能解开，会把自己的指令当成 agent 的回复；
 * - **重放**：seq 只在信封上，等于让攻击者自己校验自己——server 改掉信封
 *   seq 就能重放旧密文；
 * - **跨会话拼接**：A 会话的密文挂上 B 会话的 sessionId 转发。
 *
 * 因此每帧密文内都带 `{ ts, seq, dir, sessionId? }`：
 *
 * - `dir` — 方向标记，各帧 schema 上用 `z.literal` 钉死
 *   （agent→client 恒为 `'a2c'`，client→agent 恒为 `'c2a'`）。
 *   解密后与本端角色比对：client 只接受 `a2c`，agent 只接受 `c2a`。
 * - `seq` — **密文内的 seq 才是可信值**；信封（RelayFrame）上的 seq 仅供
 *   服务端排序与断线补发路由，解密后必须比对两者一致，且相对同一
 *   (machineId, sessionId) 序列单调递增。
 * - `sessionId` — 会话级帧必带，机器级帧（machine.*、cwd.*、配对后的
 *   machine.info 等）省略；必须与信封的 sessionId 一致（含「都省略」）。
 *
 * 接收方解密后的校验顺序：dir 符合期望方向 → sessionId 与信封一致 →
 * seq 与信封一致 → seq 单调递增；任一不符即**丢弃整帧**（不要试图修复）。
 * 前三步由 `assertEnvelopeBinding()` 封装，三端复用；seq 单调性需要接收方
 * 自己持有的游标，由调用方在 assert 通过后自行推进。
 */
import { z } from 'zod';
import { SeqSchema } from './transport.ts';
import {
  ATTACHMENTS_MAX_COUNT,
  AttachmentRefSchema,
  BgTaskSchema,
  HistoryItemSchema,
  MachineInfoSchema,
  McpServerStatusSchema,
  PermissionModeSchema,
  RunPhaseSchema,
  SessionMetaSchema,
  SessionStateSchema,
  SlashCommandSchema,
  TimestampSchema,
  ToolResultStatusSchema,
} from '../types/index.ts';

/**
 * 帧方向：`c2a` = client → agent，`a2c` = agent → client。
 * 解密后与本端角色比对，防止恶意服务端把密文反射回发送方。
 */
export const FrameDirSchema = z.enum(['c2a', 'a2c']);
export type FrameDir = z.infer<typeof FrameDirSchema>;

/**
 * 每帧通用字段（不含 dir——dir 由各方向的 base 用 z.literal 钉死）：
 * - `ts` 事件时间戳（心跳/耗时计算基准）
 * - `seq` 与信封 seq 比对的可信副本（见文件头「信封绑定」）
 * - `sessionId` 会话级帧必带，机器级帧省略
 */
const commonBase = {
  ts: TimestampSchema,
  seq: SeqSchema,
  sessionId: z.string().min(1).optional(),
} as const;

/**
 * agent → client 帧的通用字段。dir 用 `z.literal('a2c')` 而非 enum：
 * 方向本就由帧类型唯一确定，写成字面量后 schema 层面就拒绝了方向错误的帧，
 * 无需每处再写运行时判断，类型推断也能直接得到具体方向。
 */
const a2cBase = { ...commonBase, dir: z.literal('a2c') } as const;

/** client → agent 帧的通用字段（同上，方向钉死为 `c2a`） */
const c2aBase = { ...commonBase, dir: z.literal('c2a') } as const;

const ReqIdSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// §1.1 聊天视图 · 流式回复（agent → client）
// ---------------------------------------------------------------------------

/** 文本增量（token 级，SDK includePartialMessages）；messageId 定位原地追加目标 */
export const AssistantDeltaSchema = z.object({
  type: z.literal('assistant.delta'),
  ...a2cBase,
  messageId: z.string().min(1),
  text: z.string(),
});

/** 一条 assistant 消息完成：终态全文覆盖，防增量乱序 */
export const AssistantDoneSchema = z.object({
  type: z.literal('assistant.done'),
  ...a2cBase,
  messageId: z.string().min(1),
  text: z.string(),
});

/** 思考开始信号（MVP 只显示「思考中…」占位，不传 thinking 正文） */
export const ThinkingStartSchema = z.object({
  type: z.literal('thinking.start'),
  ...a2cBase,
  messageId: z.string().min(1),
});

/** 用户消息回显：多客户端设备时，别的设备发的消息本设备也要看到 */
export const UserMessageSchema = z.object({
  type: z.literal('user.message'),
  ...a2cBase,
  messageId: z.string().min(1),
  /** 发起端的 clientMsgId，发起设备据此把本地暂存条目升级为已确认 */
  clientMsgId: z.string().optional(),
  text: z.string(),
  /** 附件引用（agent ≥ 0.11.0）：其他设备据此从 relay 下载并解密 */
  attachments: z.array(AttachmentRefSchema).max(ATTACHMENTS_MAX_COUNT).optional(),
  /**
   * 这条消息在本机转录里的 uuid（= 历史回看里 user 条目的 id）。回退
   * （`session.rewind`）以它定位目标消息；agent ≥ 0.9.0 才带，省略时 client 用
   * messageId 兜底（agent 进程内还记得 clientMsgId → uuid 的映射）。
   */
  uuid: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// §1.2 工具调用卡（原地更新，toolUseId 关联 start/end）
// ---------------------------------------------------------------------------

/**
 * 子 agent 归属（subagent-view，agent ≥ 0.8.0，可选）：子 agent 里的工具调用照常发
 * tool.start / tool.end，带上**父 Agent/Task 工具调用的 toolUseId**。client 据此把
 * 它挂到父工具卡下面而不是进顶层时间线；嵌套子 agent 自然成树（孙工具的 parent 是
 * 子 agent 里那次 Agent 调用）。省略 = 主线程工具。
 *
 * 互操作：旧 client 不认识这个字段（zod strip），会把子工具卡当顶层卡平铺——
 * 部署时须**先升级 web 再重启 agent**。
 */
const ParentToolUseIdSchema = z.string().min(1);

export const ToolStartSchema = z.object({
  type: z.literal('tool.start'),
  ...a2cBase,
  toolUseId: z.string().min(1),
  toolName: z.string().min(1),
  /** 单行参数摘要（Bash→命令、Edit→文件路径），由 agent 端生成 */
  argSummary: z.string(),
  /** 子 agent 的工具调用：父 Agent/Task 工具的 toolUseId（见 ParentToolUseIdSchema） */
  parentToolUseId: ParentToolUseIdSchema.optional(),
});

export const ToolEndSchema = z.object({
  type: z.literal('tool.end'),
  ...a2cBase,
  toolUseId: z.string().min(1),
  status: ToolResultStatusSchema,
  durationMs: z.number().int().nonnegative(),
  /** 单行结果摘要（`✓ +9 −2` / `⚠ 1 failed · 3.5s`） */
  resultSummary: z.string(),
  /** 尾部截断的输出文本（~2KB），展开查看用 */
  outputPreview: z.string().optional(),
  /** 同 tool.start：子 agent 的工具调用带父 toolUseId */
  parentToolUseId: ParentToolUseIdSchema.optional(),
});

// ---------------------------------------------------------------------------
// §1.3 心跳与运行状态（agent → client）
// ---------------------------------------------------------------------------

/** 周期心跳（决策 4：agent 发，2-5s，仅运行中） */
export const RunHeartbeatSchema = z.object({
  type: z.literal('run.heartbeat'),
  ...a2cBase,
  runElapsedMs: z.number().int().nonnegative(),
  currentTool: z
    .object({
      toolUseId: z.string(),
      name: z.string(),
      elapsedMs: z.number().int().nonnegative(),
    })
    .optional(),
  /** 无输出静默毫秒数 */
  silentMs: z.number().int().nonnegative(),
  phase: RunPhaseSchema,
});

/**
 * 会话运行状态迁移（列表页状态 pill 同源）。
 *
 * `detail`：附加说明。`state: 'running'` 且带 `detail` 是**自发轮**的开始标记
 * （background-tasks 新增语义）：后台任务完成后 CLI 自己开的一轮，没有用户消息
 * 触发；`detail` 是触发说明（如「后台任务“xxx”已完成」），client 据此在时间线上
 * 该轮第一条内容前插一行「⟳ …，Claude 继续」。这一帧即使状态没变（自发轮在
 * 用户轮进行中开始）也会发；旧 client 对 running 的 run.state 不画东西，无害。
 */
export const RunStateSchema = z.object({
  type: z.literal('run.state'),
  ...a2cBase,
  state: SessionStateSchema,
  detail: z.string().optional(),
});

/** 完成卡（costUsd 源：SDK result message 的 total_cost_usd） */
export const RunDoneSchema = z.object({
  type: z.literal('run.done'),
  ...a2cBase,
  durationMs: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  toolCount: z.number().int().nonnegative(),
  permissionCount: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// §1.4 权限卡
// ---------------------------------------------------------------------------

/** agent → client：canUseTool 转发 */
export const PermissionRequestSchema = z.object({
  type: z.literal('permission.request'),
  ...a2cBase,
  requestId: z.string().min(1),
  toolName: z.string().min(1),
  /** 完整工具参数（Bash 即完整命令），结构随工具而异 */
  input: z.unknown(),
  /** SDK canUseTool 提供的建议（权限规则建议等），原样透传 */
  suggestions: z.array(z.unknown()).optional(),
  requestedAt: TimestampSchema,
  /**
   * 子 agent 发起的权限请求：父 Agent/Task 工具的 toolUseId（subagent-view，
   * agent ≥ 0.8.0，可选）。agent 由 canUseTool 的 agentID（= task_id）经
   * task_started 建的映射查得；查不到就不带。client 据此在卡片上标注来源。
   */
  parentToolUseId: ParentToolUseIdSchema.optional(),
});

/** 拒绝附言上限：够写几段反馈，又不让单帧无界膨胀 */
export const PERMISSION_MESSAGE_MAX = 4000;

/**
 * 拒绝附言：只限长（按原始长度——限的是帧大小，不是有效字数）。
 * 「trim 后空串视同未给」由 agent 应用时判断（permission.ts），schema 不做
 * transform：帧经过多次 parse（发送前、接收后）时保持值原样更好推理。
 */
const PermissionMessageSchema = z.string().max(PERMISSION_MESSAGE_MAX);

/** client → agent：批准/拒绝（决策 3：remember 仅本会话 + 模式串） */
export const PermissionRespondSchema = z.object({
  type: z.literal('permission.respond'),
  ...c2aBase,
  requestId: z.string().min(1),
  verdict: z.enum(['allow', 'deny']),
  /** 改参数后批准 */
  updatedInput: z.unknown().optional(),
  remember: z
    .object({
      scope: z.literal('session'),
      pattern: z.string().min(1),
    })
    .optional(),
  /**
   * 拒绝时给 Claude 的附言（exit-plan-mode 新增，可选）：agent 用它代替默认的
   * 拒绝文案，作为 tool_result 送给 Claude（如「继续规划」的反馈）。
   * trim 后为空视同未给（agent 判断）；只在 deny 时生效。
   */
  message: PermissionMessageSchema.optional(),
  /**
   * 批准的同时切换会话权限模式（exit-plan-mode 新增，可选，只在 allow 时生效）。
   * agent 把它作为 `updatedPermissions:[{type:'setMode', destination:'session'}]`
   * 交给 CLI——由 CLI 在批准这一刻原子地切模式。不要改成「批准后再发
   * session.setPermissionMode」：ExitPlanMode 批准后 CLI 自己会切回 default，
   * 两者竞态。
   */
  setMode: PermissionModeSchema.optional(),
});

/** agent → client：多设备同步——谁批的、结果（其余设备把卡片置为已响应） */
export const PermissionResolvedSchema = z.object({
  type: z.literal('permission.resolved'),
  ...a2cBase,
  requestId: z.string().min(1),
  verdict: z.enum(['allow', 'deny']),
  /** 响应设备标识（展示用） */
  resolvedBy: z.string().optional(),
  /**
   * 用户「改参数后批准」时**实际交给 SDK 执行**的那份 input。
   *
   * 没有它的话，各端拿到的只有最初的 `permission.request.input`——改后的值
   * 仅存在于批准那台设备的组件 state 里，刷新即丢，其余设备根本不知道实际
   * 批准了什么（对一个「rm -rf x 被改成 ls」的记录来说这是要命的失真）。
   *
   * 可选，向后兼容：旧 agent 不发这个字段，新 client 照常按 `input` 显示。
   * 零知识不受影响——它在 E2E 密文内，服务端看不见。
   */
  updatedInput: z.unknown().optional(),
  /**
   * 拒绝时实际送给 Claude 的附言（仅当 client 给了非空 message；默认拒绝文案
   * 不回报）。其余设备 / 刷新后据此显示「继续规划」的反馈原文。可选，向后兼容。
   */
  message: PermissionMessageSchema.optional(),
  /** 批准时实际随之切换到的权限模式（仅 allow 且 respond 带了 setMode）。可选 */
  setMode: PermissionModeSchema.optional(),
});

/** agent 重启 / run 中止导致 pending 请求失效 */
export const PermissionInvalidatedSchema = z.object({
  type: z.literal('permission.invalidated'),
  ...a2cBase,
  requestId: z.string().min(1),
  reason: z.string(),
});

// ---------------------------------------------------------------------------
// §1.5 输入与排队
// ---------------------------------------------------------------------------

/**
 * client → agent：clientMsgId 幂等去重。
 *
 * 带附件时 text 可以为空（只发图片），但两者不能都空。附件先由发送端加密上传
 * 到 relay，这里只带引用；agent 下载、解密、落盘后再交给模型（agent ≥ 0.11.0，
 * 旧 agent 会因为不认识 attachments 之外的空 text 拒收，client 按版本探测）。
 */
export const InputSendSchema = z
  .object({
    type: z.literal('input.send'),
    ...c2aBase,
    clientMsgId: z.string().min(1),
    /** 以 `/` 开头即项目 slash command，原样进 SDK query，agent 不解析 */
    text: z.string(),
    attachments: z.array(AttachmentRefSchema).min(1).max(ATTACHMENTS_MAX_COUNT).optional(),
  })
  .refine((e) => e.text.length > 0 || (e.attachments?.length ?? 0) > 0, {
    message: 'text and attachments cannot both be empty',
  });

/** agent → client：会话运行中，agent 端已排队的回执 */
export const InputQueuedSchema = z.object({
  type: z.literal('input.queued'),
  ...a2cBase,
  clientMsgId: z.string().min(1),
});

/**
 * agent → client：这条消息没被接受（agent ≥ 0.11.0；目前只有附件准备失败——
 * blob 下载 / 解密 / 落盘出错）。没进队列、也没进去重表，client 把本地条目标为
 * 失败，用户可原样重试。所有设备都收到，只有发起端有对应的本地条目。
 */
export const InputRejectedSchema = z.object({
  type: z.literal('input.rejected'),
  ...a2cBase,
  clientMsgId: z.string().min(1),
  reason: z.string(),
});

/**
 * client → agent：撤回 **agent 端**排队中的消息（收到过 input.queued 回执的）。
 *
 * 两级排队 → 两级撤回，各管各的：
 * - **agent 在线、会话运行中排队**（回执 `input.queued`）→ 用本帧，走 E2E 密文，
 *   服务端读不到内容，由 agent 按 clientMsgId 从自己的队列里删。
 * - **agent 离线、帧 parked 在 server**（回执 transport 层 `input.parked`）→
 *   用 transport.ts 的 `park.recall`：此时密文根本到不了 agent，撤回指令必须是
 *   服务端可读的明文，按 `input.parked` 回执给出的 seq 定位待删帧。
 */
export const InputRecallSchema = z.object({
  type: z.literal('input.recall'),
  ...c2aBase,
  clientMsgId: z.string().min(1),
});

/** client → agent：停止当前任务（agent 回 run.state: stopped，已产出内容保留） */
export const RunStopSchema = z.object({
  type: z.literal('run.stop'),
  ...c2aBase,
});

/** client → agent：额度重置后自动续跑（配合 error.fatal 的 retryAt） */
export const RunResumeAtSchema = z.object({
  type: z.literal('run.resumeAt'),
  ...c2aBase,
  at: TimestampSchema,
});

// ---------------------------------------------------------------------------
// §1.6 后台任务（background-tasks，agent ≥ 0.7.0）
// ---------------------------------------------------------------------------

/**
 * agent → client：会话当前所有后台任务的**全量快照**（会话级帧）。变化即发，
 * client 直接替换本地列表，不做增量合并——重连 / 补发也就不需要对账。
 * 已结束的任务只保留最近若干条（agent 侧封顶），更早的不再出现。
 *
 * 互操作：旧 client 不认识本 type，schema 层丢弃该帧（游标不推进，下一帧照常），
 * 不影响其余事件。
 */
export const BgTaskSnapshotSchema = z.object({
  type: z.literal('bgtask.snapshot'),
  ...a2cBase,
  tasks: z.array(BgTaskSchema),
});

/**
 * client → agent：停止一个后台任务（会话级帧，只作用于**已活跃**的实例，不会为它
 * 拉起会话）。agent 调 SDK `Query.stopTask(taskId)`，结果经随后的
 * `bgtask.snapshot` 体现（status 变 stopped）。
 *
 * 应答复用机器级 `session.mutate.response`（reqId 关联，targetSessionId = 本会话）：
 * 成功 `ok:true`；没有活跃实例 / 子进程 → `not_found`；SDK 调用抛错 → `io`。
 * 不另造应答帧。旧 agent 不认识本 type，schema 层丢弃 → client 只能等超时；
 * client 应按 machine.info.agentVersion 探测（≥ 0.7.0），否则不显示停止按钮。
 */
export const BgTaskStopSchema = z.object({
  type: z.literal('bgtask.stop'),
  ...c2aBase,
  reqId: ReqIdSchema,
  taskId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// §1.7 子 agent 过程回看（subagent-view，agent ≥ 0.8.0）
// ---------------------------------------------------------------------------

/**
 * client → agent：拉取某次子 agent 调用（父 Agent/Task 工具的 `toolUseId`）的过程
 * ——历史回看里的 Task 卡没有实时收到的子工具卡，展开时按需拉。会话级帧，但与
 * session.history.request 一样**不拉起会话进程**：agent 只读本机子转录
 * （`<会话转录目录>/subagents/agent-<agentId>.jsonl`，按旁边 meta.json 的
 * toolUseId 找）。
 *
 * 互操作：旧 agent 不认识本 type，schema 层丢弃 → client 只能等超时；client 应按
 * machine.info.agentVersion 探测（≥ 0.8.0）。
 */
export const SubagentHistoryRequestSchema = z.object({
  type: z.literal('subagent.history.request'),
  ...c2aBase,
  reqId: ReqIdSchema,
  toolUseId: z.string().min(1),
});

/**
 * agent → client：子 agent 的过程条目（旧 → 新），**只发给请求方设备**。
 * `items` 以工具项为主（子工具卡；其中的 Agent/Task 项可再按它的 id 展开，嵌套同理），
 * 可含子 agent 的最终回复文字（assistant 项）。体积封顶同 session.history.response
 * （超了从最旧那头少给，并置 `truncated`）。找不到子转录 → 空 items，不报错。
 */
export const SubagentHistoryResponseSchema = z.object({
  type: z.literal('subagent.history.response'),
  ...a2cBase,
  reqId: ReqIdSchema,
  toolUseId: z.string().min(1),
  items: z.array(HistoryItemSchema),
  /** 体积封顶截掉了更早的条目 */
  truncated: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// §1.9 附件按需拉取（agent ≥ 0.11.0）
// ---------------------------------------------------------------------------

/**
 * client → agent：取某条用户消息第 `index` 个附件的（新）blob 引用。
 *
 * 用于 blob 已过期（relay 按 TTL 清理）或从没上传过（本机 CLI 里直接粘贴的
 * 图片，只存在于转录里）的附件：agent 从本机副本或转录取出字节，重新加密上传，
 * 回一个新引用。与 session.history.request 一样**不拉起会话进程**。
 *
 * `messageId` 是历史 user 条目的 id（转录 uuid），`index` 是它 attachments 的下标。
 */
export const AttachmentFetchRequestSchema = z.object({
  type: z.literal('attachment.fetch.request'),
  ...c2aBase,
  reqId: ReqIdSchema,
  messageId: z.string().min(1),
  index: z.number().int().nonnegative().max(ATTACHMENTS_MAX_COUNT - 1),
});

export const AttachmentFetchErrorCodeSchema = z.enum(['not_found', 'io', 'unavailable']);
export type AttachmentFetchErrorCode = z.infer<typeof AttachmentFetchErrorCodeSchema>;

/** agent → client：只发给请求方设备 */
export const AttachmentFetchResponseSchema = z.object({
  type: z.literal('attachment.fetch.response'),
  ...a2cBase,
  reqId: ReqIdSchema,
  ok: z.boolean(),
  attachment: AttachmentRefSchema.optional(),
  error: z.object({ code: AttachmentFetchErrorCodeSchema, message: z.string() }).optional(),
});

// ---------------------------------------------------------------------------
// §1.8 回退（rewind，agent ≥ 0.9.0）
// ---------------------------------------------------------------------------

/**
 * 回退模式，对应 Claude Code `/rewind` 的三个选项：
 * - `both`         代码 + 对话
 * - `conversation` 只回退对话（模型上下文截断到目标消息之前，文件不动）
 * - `code`         只还原文件（对话不动）
 */
export const RewindModeSchema = z.enum(['both', 'conversation', 'code']);
export type RewindMode = z.infer<typeof RewindModeSchema>;

/**
 * 回退失败原因：
 * - `busy`        会话运行中 / 等待批准 / 有排队消息 / 有后台任务在跑
 * - `not_found`   目标消息不在当前对话主链上（或会话不存在）
 * - `invalid`     请求的模式不适用（如回退对话到第一条消息之前）
 * - `unavailable` 没有可用的文件快照（开启 checkpoint 之前的轮次等）
 * - `io`          读转录 / 调 SDK 失败，或 agent 内部异常
 */
export const RewindErrorCodeSchema = z.enum(['busy', 'not_found', 'invalid', 'unavailable', 'io']);
export type RewindErrorCode = z.infer<typeof RewindErrorCodeSchema>;

const RewindErrorSchema = z.object({ code: RewindErrorCodeSchema, message: z.string() });

/**
 * 回退的目标消息 id：user 条目的转录 uuid（`user.message.uuid` / 历史条目 id），
 * 或者实时回显的 messageId（= clientMsgId，agent 进程内能映射回 uuid）。
 * 语义是「回到这条消息发出之前」：这条消息本身也被撤掉。
 */
const RewindTargetSchema = z.string().min(1);

/** 文件改动统计（SDK rewindFiles 的结果）；路径相对会话 cwd，cwd 之外的保持绝对路径 */
export const RewindFilesStatSchema = z.object({
  filesChanged: z.array(z.string()),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type RewindFilesStat = z.infer<typeof RewindFilesStatSchema>;

/**
 * client → agent：预览一次回退（不改任何东西）。会话级帧；会话没有子进程时
 * agent 会临时起一个（不发消息）来读文件快照，所以可能要一两秒。
 */
export const SessionRewindPreviewSchema = z.object({
  type: z.literal('session.rewind.preview'),
  ...c2aBase,
  reqId: ReqIdSchema,
  targetMessageId: RewindTargetSchema,
});

/**
 * agent → client：预览结果，**只发给请求方设备**。会话根本打不开（不存在 / 并发已满）
 * 时以机器级帧（不带 sessionId）回 `not_found`——client 只按 reqId 关联，两种都收得到。
 * `ok:false` 表示整个请求不成立（busy / not_found / io），此时其余字段省略。
 * `ok:true` 时分别给出对话与代码两部分能不能回退：
 * - `conversation.available` false 时 `reason` 说明原因（如目标是第一条消息）；
 * - `files.available` false 时 `reason` 说明原因（如没有快照）；true 时带改动统计。
 * `text` 是目标消息原文，供确认界面展示、回退后预填输入框。
 */
export const SessionRewindPreviewResponseSchema = z.object({
  type: z.literal('session.rewind.preview.response'),
  ...a2cBase,
  reqId: ReqIdSchema,
  ok: z.boolean(),
  error: RewindErrorSchema.optional(),
  text: z.string().optional(),
  conversation: z.object({ available: z.boolean(), reason: z.string().optional() }).optional(),
  files: z
    .object({ available: z.boolean(), reason: z.string().optional() })
    .extend(RewindFilesStatSchema.partial().shape)
    .optional(),
});

/**
 * client → agent：执行回退。`both` 先还原文件、再截断对话；文件还原失败则整体失败、
 * 对话不动。成功后 agent 先广播 `session.rewound`，再回 `session.rewind.response`。
 */
export const SessionRewindSchema = z.object({
  type: z.literal('session.rewind'),
  ...c2aBase,
  reqId: ReqIdSchema,
  targetMessageId: RewindTargetSchema,
  mode: RewindModeSchema,
});

/**
 * agent → client：回退结果，**只发给请求方设备**。`files` 只在还原了文件时带；
 * `skippedLinks` 是因符号链接等原因没敢还原的文件数。`text` 同 preview。
 */
export const SessionRewindResponseSchema = z.object({
  type: z.literal('session.rewind.response'),
  ...a2cBase,
  reqId: ReqIdSchema,
  ok: z.boolean(),
  error: RewindErrorSchema.optional(),
  text: z.string().optional(),
  files: RewindFilesStatSchema.extend({ skippedLinks: z.number().int().nonnegative().optional() }).optional(),
});

/**
 * agent → client：会话已回退（会话级广播，所有设备）。`conversation` 为 true 时
 * client 把时间线从目标消息起（含）截掉：`targetMessageIds` 列出这条消息可能的
 * 各种 id（转录 uuid、clientMsgId），哪个能对上本地条目就用哪个；都对不上就清空
 * 时间线重新拉历史。只回退了代码时时间线不动。
 *
 * 互操作：旧 client 不认识本 type，schema 层丢弃——它的时间线会保留已回退的消息，
 * 刷新历史后恢复正确。
 */
export const SessionRewoundSchema = z.object({
  type: z.literal('session.rewound'),
  ...a2cBase,
  targetMessageIds: z.array(z.string().min(1)).min(1),
  mode: RewindModeSchema,
  /** 还原的文件数（只回退对话时省略） */
  filesChanged: z.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// §2 会话列表与会话管理
// ---------------------------------------------------------------------------

export const SessionListRequestSchema = z.object({
  type: z.literal('session.list.request'),
  ...c2aBase,
  reqId: ReqIdSchema,
});

export const SessionListResponseSchema = z.object({
  type: z.literal('session.list.response'),
  ...a2cBase,
  reqId: ReqIdSchema,
  sessions: z.array(SessionMetaSchema),
});

/**
 * agent → client：列表增量（新会话）——广播给该机器的所有客户端设备。
 * 与 `session.create.response` 分工：发起端靠 response 的 reqId 关联自己那次
 * 请求（拿到 sessionId 才能跳转进会话），其余设备靠本广播刷新列表。
 * 发起端两帧都会收到，按 sessionId 幂等去重即可。
 */
export const SessionCreatedSchema = z.object({
  type: z.literal('session.created'),
  ...a2cBase,
  session: SessionMetaSchema,
});

/** agent → client：列表增量（标题生成、状态迁移、成本累计），全量快照覆盖 */
export const SessionUpdatedSchema = z.object({
  type: z.literal('session.updated'),
  ...a2cBase,
  session: SessionMetaSchema,
});

/** client → agent：新建会话（cwd 默认值 = 该机器 defaultCwd） */
export const SessionCreateSchema = z.object({
  type: z.literal('session.create'),
  ...c2aBase,
  reqId: ReqIdSchema,
  cwd: z.string().min(1),
  model: z.string().min(1),
  permissionMode: PermissionModeSchema,
});

/**
 * agent → client：session.create 的应答，以 reqId 关联发起端那次请求。
 * 会话本身的存在性通知走 `session.created` 广播（见其注释）。
 */
export const SessionCreateResponseSchema = z.object({
  type: z.literal('session.create.response'),
  ...a2cBase,
  reqId: ReqIdSchema,
  session: SessionMetaSchema,
});

// --- §2 会话元数据命令：重命名 / 归档 / 永久删除（session-list-v2） ---
//
// 三条 c2a 都是**会话级**帧（带 sessionId，与同会话的 input.send 在 agent 的
// 命令链上串行），但 agent **不会**因此把会话 resume 起来（不占并发名额）。
// 应答统一走**机器级** `session.mutate.response`（reqId 关联），业务拒绝也在
// 这里表达，不用 error.fatal——后者会进聊天时间线且无法关联请求。
// 成功时另有广播：rename/archive → `session.updated`；delete → `session.removed`。
//
// 互操作：旧 agent 不认识这些 type，schema 层静默丢弃 → client 的 request()
// 只能等超时；client 应按 machine.info.agentVersion 做能力探测（>= 0.2.0）。

/**
 * client → agent：重命名（与 CLI `/rename` 写同一条 custom-title 记录）。
 * agent 侧按 SDK 读取时的同款规则规范化 title，规范化后为空 → `invalid`。
 */
export const SessionRenameSchema = z.object({
  type: z.literal('session.rename'),
  ...c2aBase,
  sessionId: z.string().min(1),
  reqId: ReqIdSchema,
  title: z.string(),
});

/** client → agent：归档 / 取消归档。运行中、等待批准、有排队消息 → `busy` */
export const SessionArchiveSchema = z.object({
  type: z.literal('session.archive'),
  ...c2aBase,
  sessionId: z.string().min(1),
  reqId: ReqIdSchema,
  archived: z.boolean(),
});

/**
 * client → agent：永久删除（删本机转录，不可逆）。只允许删**已归档**的会话
 * （否则 `not_archived`），忙或本机 60s 内有写入 → `busy`。
 */
export const SessionDeleteSchema = z.object({
  type: z.literal('session.delete'),
  ...c2aBase,
  sessionId: z.string().min(1),
  reqId: ReqIdSchema,
});

/**
 * 会话元数据命令的失败原因：
 * - `busy`         会话运行中 / 等待批准 / 有排队消息；删除时还含「本机 60s 内写过转录」
 * - `not_found`    agent 找不到这个会话（无活跃实例、无本地记录、SDK 也查不到）
 * - `not_archived` 删除未归档的会话（协议层兜底：只能删已归档的）
 * - `invalid`      参数不合法（如规范化后标题为空）
 * - `io`           读写转录 / 本地状态文件失败，或 agent 内部异常
 * - `deleted`      该会话已被永久删除（agent 墓碑命中）
 */
export const SessionMutateErrorCodeSchema = z.enum([
  'busy',
  'not_found',
  'not_archived',
  'invalid',
  'io',
  'deleted',
]);
export type SessionMutateErrorCode = z.infer<typeof SessionMutateErrorCodeSchema>;

/**
 * agent → client：rename / archive / delete 共用的应答（**机器级**帧，reqId 关联）。
 *
 * 目标会话放在 `targetSessionId` 而**不是** `sessionId`：密文里的 `sessionId`
 * 是信封绑定字段（见文件头），带上它这帧就成了会话级帧——既违背「应答走机器级」
 * （client 会把它当成该会话时间线里的事件），也会为一个可能从没打开过的会话
 * 开一条 a2c seq 流。
 *
 * 墓碑命中时，agent 对**任何**带 reqId 的会话级请求（含 session.status.request
 * 等）都回本帧 `ok:false, code:'deleted'`——client 的 request() 只按 reqId 关联。
 */
export const SessionMutateResponseSchema = z.object({
  type: z.literal('session.mutate.response'),
  ...a2cBase,
  reqId: ReqIdSchema,
  targetSessionId: z.string().min(1),
  ok: z.boolean(),
  /** ok 为 false 时必带 */
  error: z
    .object({
      code: SessionMutateErrorCodeSchema,
      message: z.string(),
    })
    .optional(),
});

/**
 * agent → client：会话已被永久删除（机器级广播，所有设备据此清掉本地缓存）。
 * 字段名用 `targetSessionId` 的原因同 `session.mutate.response`。
 * 旧 client 不认识本 type 会静默丢弃，该行保留到下次刷新列表。
 */
export const SessionRemovedSchema = z.object({
  type: z.literal('session.removed'),
  ...a2cBase,
  targetSessionId: z.string().min(1),
});

// --- §6.1 会话控制命令（协议级，不走文本，本地即时响应零成本） ---

export const SessionSetModelSchema = z.object({
  type: z.literal('session.setModel'),
  ...c2aBase,
  model: z.string().min(1),
});

export const SessionSetPermissionModeSchema = z.object({
  type: z.literal('session.setPermissionMode'),
  ...c2aBase,
  mode: PermissionModeSchema,
});

export const SessionSetCwdSchema = z.object({
  type: z.literal('session.setCwd'),
  ...c2aBase,
  cwd: z.string().min(1),
});

export const SessionStatusRequestSchema = z.object({
  type: z.literal('session.status.request'),
  ...c2aBase,
  reqId: ReqIdSchema,
});

export const SessionStatusResponseSchema = z.object({
  type: z.literal('session.status.response'),
  ...a2cBase,
  reqId: ReqIdSchema,
  model: z.string(),
  cwd: z.string(),
  permissionMode: PermissionModeSchema,
  costUsd: z.number().nonnegative(),
  contextUsedTokens: z.number().int().nonnegative(),
  contextLimitTokens: z.number().int().nonnegative(),
  agentVersion: z.string(),
  claudeVersion: z.string(),
});

export const McpStatusRequestSchema = z.object({
  type: z.literal('mcp.status.request'),
  ...c2aBase,
  reqId: ReqIdSchema,
});

export const McpStatusResponseSchema = z.object({
  type: z.literal('mcp.status.response'),
  ...a2cBase,
  reqId: ReqIdSchema,
  servers: z.array(McpServerStatusSchema),
});

/**
 * client → agent：拉取本机转录历史（决策 D8：历史回看由 agent 读本机会话存储
 * 按需拉取）。会话级帧（sessionId 在信封），但 agent **不会**为它拉起会话进程。
 *
 * - `before` — 不透明游标：上一页响应的 `nextBefore`（实为某条目 id）；省略 = 最新一页
 * - `limit` — 每页条数上限，省略由 agent 定（默认 200）
 */
export const SessionHistoryRequestSchema = z.object({
  type: z.literal('session.history.request'),
  ...c2aBase,
  reqId: ReqIdSchema,
  before: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

/**
 * agent → client：历史一页，`items` 按时间正序（旧 → 新），是 `before` 之前
 * 最近的若干条。**只发给请求方设备**（其余设备那条子流跳一号，协议允许）。
 *
 * 整帧体积由 agent 封顶（会进服务端离线补发存储），超了就少给几条并置
 * `hasMore`；`hasMore` 时 `nextBefore` 即翻下一页用的游标。
 * 会话不存在 / 无转录 → 空 items、hasMore false，不报错。
 */
export const SessionHistoryResponseSchema = z.object({
  type: z.literal('session.history.response'),
  ...a2cBase,
  reqId: ReqIdSchema,
  items: z.array(HistoryItemSchema),
  hasMore: z.boolean(),
  nextBefore: z.string().min(1).optional(),
});

/**
 * client → agent：拉取会话 cwd 下可用的斜杠命令（项目/用户 skill 与命令）。
 * 会话级帧（sessionId 在信封），但 agent **不会**为它拉起会话进程——
 * 用一个不发消息的探测 query 取 `supportedCommands()`，按 cwd 缓存。
 *
 * 用途：`session.capabilities` 只在会话进程起来（首条消息）后才有，刷新 /
 * agent 重启后打开会话、发消息前斜杠菜单就能拿到命令清单。
 */
export const SessionCommandsRequestSchema = z.object({
  type: z.literal('session.commands.request'),
  ...c2aBase,
  reqId: ReqIdSchema,
});

/**
 * agent → client：斜杠命令清单（带 description，SDK init 那份没有）。
 * **只发给请求方设备**。探测失败 / 无 cwd → 空数组，不报错。
 */
export const SessionCommandsResponseSchema = z.object({
  type: z.literal('session.commands.response'),
  ...a2cBase,
  reqId: ReqIdSchema,
  slashCommands: z.array(SlashCommandSchema),
});

/** agent → client：会话就绪时推能力清单（源：SDK system/init） */
export const SessionCapabilitiesSchema = z.object({
  type: z.literal('session.capabilities'),
  ...a2cBase,
  slashCommands: z.array(SlashCommandSchema),
  /** 可用模型列表，以 agent 上报为准 */
  models: z.array(z.string()),
  mcpServers: z.array(McpServerStatusSchema),
});

// ---------------------------------------------------------------------------
// §3 机器管理（E2E 部分；在线状态在 transport 层）
// ---------------------------------------------------------------------------

export const MachineInfoEventSchema = z.object({
  type: z.literal('machine.info'),
  ...a2cBase,
  info: MachineInfoSchema,
});

export const MachineRenameSchema = z.object({
  type: z.literal('machine.rename'),
  ...c2aBase,
  name: z.string().min(1),
});

export const MachineUnpairSchema = z.object({
  type: z.literal('machine.unpair'),
  ...c2aBase,
});

// --- §3.1 远程更新代理机上的 claude（claude-update，agent 0.4.0 起） ---
//
// 语义：agent 用它解析出的 claude 可执行文件（与会话实际拉起的是同一个）跑
// `claude update`，完成后重新探测版本、广播 `machine.info`，再回应答。
// **运行中的会话不重启**——它们的子进程还是旧版，只有此后新起（含空闲回收后
// 重新 resume）的会话才用新版。
//
// 互操作：旧 agent 不认识本 type，schema 层静默丢弃 → client 只能等超时；
// client 应按 machine.info.agentVersion 做能力探测（>= 0.4.0）。

/** `machine.claude.update.response.output` 的长度上限（字符数，尾部截断） */
export const CLAUDE_UPDATE_OUTPUT_MAX = 4096;

/** client → agent：在代理机上执行 `claude update`（机器级帧） */
export const MachineClaudeUpdateRequestSchema = z.object({
  type: z.literal('machine.claude.update.request'),
  ...c2aBase,
  reqId: ReqIdSchema,
});

/**
 * `claude update` 的失败原因：
 * - `busy`      已有一次更新在进行中（单飞，不排队）
 * - `not_found` 代理机上没解析到全局 claude（会话在用 SDK 内置版本，无从更新）
 * - `timeout`   超时被 kill（agent 侧上限 5 分钟）
 * - `failed`    起不来 / 非零退出
 */
export const ClaudeUpdateErrorCodeSchema = z.enum(['busy', 'not_found', 'timeout', 'failed']);
export type ClaudeUpdateErrorCode = z.infer<typeof ClaudeUpdateErrorCodeSchema>;

/**
 * agent → client：`machine.claude.update.request` 的应答（机器级，reqId 关联）。
 *
 * - `fromVersion` / `toVersion` 是 `claude --version` 的首行（与 machine.info
 *   的 claudeVersion 同口径）；两者相等 = 已是最新。`busy` / `not_found` 时
 *   两者都是 agent 当前记着的版本。
 * - `output` 是 stdout+stderr 按到达顺序合并、去 ANSI 后的**尾部**，至多
 *   `CLAUDE_UPDATE_OUTPUT_MAX` 字符；`outputTruncated` 表示前面有被截掉的部分。
 */
export const MachineClaudeUpdateResponseSchema = z.object({
  type: z.literal('machine.claude.update.response'),
  ...a2cBase,
  reqId: ReqIdSchema,
  ok: z.boolean(),
  fromVersion: z.string(),
  toVersion: z.string(),
  output: z.string().max(CLAUDE_UPDATE_OUTPUT_MAX),
  outputTruncated: z.boolean().optional(),
  /** ok 为 false 时必带 */
  error: z
    .object({
      code: ClaudeUpdateErrorCodeSchema,
      message: z.string(),
    })
    .optional(),
});

// --- §3.2 手动刷新订阅限额用量（usage-display，agent 0.12.0 起） ---
//
// 语义：agent 向 Claude 查一次当前账号的 5 小时 / 7 天用量。有活跃会话进程时借用它，
// 没有就临时起一个不发消息的 claude 进程，用完即关——所以只给手动刷新用，client
// 不要定时发。拿到后先广播 `machine.info`（带新的 rateLimits），再回应答。
//
// 互操作：旧 agent 不认识本 type → client 只能等超时；client 按 agentVersion 探测。

/** client → agent：刷新订阅限额用量（机器级帧） */
export const MachineUsageRequestSchema = z.object({
  type: z.literal('machine.usage.request'),
  ...c2aBase,
  reqId: ReqIdSchema,
});

/**
 * 刷新失败原因：
 * - `unavailable` 账号没有订阅限额（API key / Bedrock / Vertex 等）
 * - `failed`      查询出错 / 超时 / 返回形状不认识
 */
export const UsageErrorCodeSchema = z.enum(['unavailable', 'failed']);
export type UsageErrorCode = z.infer<typeof UsageErrorCodeSchema>;

/** agent → client：`machine.usage.request` 的应答（机器级，reqId 关联） */
export const MachineUsageResponseSchema = z.object({
  type: z.literal('machine.usage.response'),
  ...a2cBase,
  reqId: ReqIdSchema,
  ok: z.boolean(),
  /** ok 为 false 时必带 */
  error: z
    .object({
      code: UsageErrorCodeSchema,
      message: z.string(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// §6.2 工作目录管理（决策 7：agent 端持久化，每机器一份）
// ---------------------------------------------------------------------------

export const CwdListRequestSchema = z.object({
  type: z.literal('cwd.list.request'),
  ...c2aBase,
  reqId: ReqIdSchema,
});

export const CwdListResponseSchema = z.object({
  type: z.literal('cwd.list.response'),
  ...a2cBase,
  reqId: ReqIdSchema,
  favorites: z.array(z.string()),
  defaultCwd: z.string(),
});

export const CwdAddSchema = z.object({
  type: z.literal('cwd.add'),
  ...c2aBase,
  path: z.string().min(1),
});

export const CwdRemoveSchema = z.object({
  type: z.literal('cwd.remove'),
  ...c2aBase,
  path: z.string().min(1),
});

export const CwdSetDefaultSchema = z.object({
  type: z.literal('cwd.setDefault'),
  ...c2aBase,
  path: z.string().min(1),
});

/** agent → client：目录变更广播，多客户端设备保持一致 */
export const CwdUpdatedSchema = z.object({
  type: z.literal('cwd.updated'),
  ...a2cBase,
  favorites: z.array(z.string()),
  defaultCwd: z.string(),
});

// ---------------------------------------------------------------------------
// §5 异常（agent → client）
// ---------------------------------------------------------------------------

/** 瞬时错误 + 自动 resume 中（聊天流里的一行痕迹） */
export const ErrorTransientSchema = z.object({
  type: z.literal('error.transient'),
  ...a2cBase,
  attempt: z.number().int().positive(),
  reason: z.string(),
});

export const ErrorFatalSchema = z.object({
  type: z.literal('error.fatal'),
  ...a2cBase,
  kind: z.enum(['quota', 'auth', 'config', 'other']),
  message: z.string(),
  /** 额度重置时间，支撑「xx:xx 后自动续跑」按钮（→ run.resumeAt） */
  retryAt: TimestampSchema.optional(),
});

// ---------------------------------------------------------------------------
// 联合
// ---------------------------------------------------------------------------

/** agent → client 事件帧 */
export const AgentToClientEventSchema = z.discriminatedUnion('type', [
  AssistantDeltaSchema,
  AssistantDoneSchema,
  ThinkingStartSchema,
  UserMessageSchema,
  ToolStartSchema,
  ToolEndSchema,
  RunHeartbeatSchema,
  RunStateSchema,
  RunDoneSchema,
  PermissionRequestSchema,
  PermissionResolvedSchema,
  PermissionInvalidatedSchema,
  InputQueuedSchema,
  InputRejectedSchema,
  BgTaskSnapshotSchema,
  SessionListResponseSchema,
  SessionCreatedSchema,
  SessionCreateResponseSchema,
  SessionUpdatedSchema,
  SessionMutateResponseSchema,
  SessionRemovedSchema,
  SessionStatusResponseSchema,
  McpStatusResponseSchema,
  SessionHistoryResponseSchema,
  SubagentHistoryResponseSchema,
  SessionCommandsResponseSchema,
  SessionRewindPreviewResponseSchema,
  SessionRewindResponseSchema,
  SessionRewoundSchema,
  AttachmentFetchResponseSchema,
  SessionCapabilitiesSchema,
  MachineInfoEventSchema,
  MachineClaudeUpdateResponseSchema,
  MachineUsageResponseSchema,
  CwdListResponseSchema,
  CwdUpdatedSchema,
  ErrorTransientSchema,
  ErrorFatalSchema,
]);
export type AgentToClientEvent = z.infer<typeof AgentToClientEventSchema>;

/** client → agent 事件帧 */
export const ClientToAgentEventSchema = z.discriminatedUnion('type', [
  InputSendSchema,
  InputRecallSchema,
  RunStopSchema,
  RunResumeAtSchema,
  BgTaskStopSchema,
  PermissionRespondSchema,
  SessionListRequestSchema,
  SessionCreateSchema,
  SessionRenameSchema,
  SessionArchiveSchema,
  SessionDeleteSchema,
  SessionSetModelSchema,
  SessionSetPermissionModeSchema,
  SessionSetCwdSchema,
  SessionStatusRequestSchema,
  McpStatusRequestSchema,
  SessionHistoryRequestSchema,
  SubagentHistoryRequestSchema,
  SessionCommandsRequestSchema,
  SessionRewindPreviewSchema,
  SessionRewindSchema,
  AttachmentFetchRequestSchema,
  MachineRenameSchema,
  MachineUnpairSchema,
  MachineClaudeUpdateRequestSchema,
  MachineUsageRequestSchema,
  CwdListRequestSchema,
  CwdAddSchema,
  CwdRemoveSchema,
  CwdSetDefaultSchema,
]);
export type ClientToAgentEvent = z.infer<typeof ClientToAgentEventSchema>;

/** 双向合集：解密后统一入口校验用 */
export const E2eEventSchema = z.discriminatedUnion('type', [
  ...AgentToClientEventSchema.options,
  ...ClientToAgentEventSchema.options,
]);
export type E2eEvent = z.infer<typeof E2eEventSchema>;

// ---------------------------------------------------------------------------
// 信封绑定校验（三端复用；原理见文件头「信封绑定」）
// ---------------------------------------------------------------------------

/** 绑定校验失败：调用方应当**丢弃整帧**，不要尝试修复或降级处理 */
export class EnvelopeBindingError extends Error {
  constructor(
    message: string,
    /** 机器可读的失败原因，便于上层分类计数/告警 */
    readonly reason: 'dir' | 'sessionId' | 'seq',
  ) {
    super(message);
    this.name = 'EnvelopeBindingError';
  }
}

/** 校验只用得到信封的这几个路由字段（RelayFrame 的子集） */
export interface EnvelopeBinding {
  sessionId?: string | undefined;
  seq: number;
}

/**
 * 解密并 schema 校验后，比对密文内的绑定字段与明文信封是否一致。
 *
 * 校验三项（顺序即失败归因顺序）：
 * 1. `dir` 是否等于本端期望方向——client 传 `'a2c'`，agent 传 `'c2a'`；
 *    不等说明密文被反射回了发送方；
 * 2. `sessionId` 是否与信封一致（两边都省略也算一致）——不等说明帧被挂到了
 *    别的会话上；
 * 3. `seq` 是否与信封一致——**密文内的才是可信值**，不等说明服务端动过信封 seq。
 *
 * 不校验 seq 单调性：那需要接收方自己维护的每序列游标，由调用方在本函数
 * 通过后自行比较并推进（信封与密文已确认一致，用哪个都行）。
 *
 * @throws {EnvelopeBindingError} 任一项不符
 */
export function assertEnvelopeBinding(
  event: E2eEvent,
  envelope: EnvelopeBinding,
  expectedDir: FrameDir,
): void {
  if (event.dir !== expectedDir) {
    throw new EnvelopeBindingError(
      `帧方向不符：期望 ${expectedDir}，实际 ${event.dir}（疑似密文反射）`,
      'dir',
    );
  }
  if (event.sessionId !== envelope.sessionId) {
    throw new EnvelopeBindingError(
      `sessionId 与信封不符：密文 ${event.sessionId ?? '(省略)'}，` +
        `信封 ${envelope.sessionId ?? '(省略)'}（疑似跨会话拼接）`,
      'sessionId',
    );
  }
  if (event.seq !== envelope.seq) {
    throw new EnvelopeBindingError(
      `seq 与信封不符：密文 ${event.seq}，信封 ${envelope.seq}（疑似重放）`,
      'seq',
    );
  }
}

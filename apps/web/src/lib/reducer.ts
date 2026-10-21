/**
 * 入站事件 → 本地状态的纯函数（方案 §4.3）。零 I/O、零副作用、不可变更新，
 * 每条要点都有单测。
 *
 * ## 三份状态
 *
 * - **Timeline**（每会话一份）：聊天时间线条目 + 心跳快照 + 会话状态；
 * - **sessions**（每机器一份 `sessionId → SessionMeta`）：列表页；
 * - **MachineState**（每机器一份）：机器卡 + 在线状态 + 机器级错误。
 *
 * ## 条目 id 与幂等
 *
 * 每种条目都有一个稳定 id：assistant 按 messageId、tool 按 toolUseId、
 * permission 按 requestId 原地更新；run.state / run.done / error 这类追加型
 * 条目用 `type:seq` 作 id，同一事件应用两次只会落一条。这样重连重发
 * （agent 对 pending 权限同 requestId 重发）与回填期间的重复帧都不会
 * 在时间线上留下重复。
 *
 * ## 本地条目状态机（不可倒退）
 *
 * 用户发出的消息先以 `sending` 进时间线，随后按回执迁移：
 *
 *   sending → queued → confirmed | cancelled | （撤回成功：条目删除）
 *   sending → parked → confirmed | expired
 *   sending → failed
 *
 * 还没进入对话的条目（见 `isPendingEntry`）不在时间线里画，在输入框上方的排队托盘里；
 * 确认（`user.message` 回显）时移到时间线末尾——agent ≥ 0.15.0 出队开始执行才回显，
 * 那一刻才是它在对话里的真实位置。
 *
 * 终态（confirmed / expired / failed / cancelled / recalled）**不被任何前态覆盖**——agent 的队列
 * 对重复 clientMsgId 仍回 `input.queued`，parked 投递与 agent 自己的补发
 * 也可能让同一条 input.send 两次进 agent，于是 `input.queued` 可能在
 * `confirmed` 之后才到（评审 C4）。
 */
import { z } from 'zod';
import type {
  AgentToClientEvent,
  AttachmentRef,
  BgTask,
  HistoryItem,
  MachineInfo,
  MachineStats,
  McpServerStatus,
  SessionMeta,
  SessionState,
  SlashCommand,
} from '@trine/core';
// **值**导入走 `@trine/core/types`，不走根 `@trine/core`：根 index 会
// re-export `./crypto`，那条线静态引入 libsodium（730KB asm.js/wasm 单文件）。
// reducer 在首屏依赖图里（store/types.ts → 这里），从根引就把 libsodium
// 钉进 entry 的必下集合。类型导入无所谓（编译期擦除），值导入必须挑子路径。
import {
  ATTACHMENTS_MAX_COUNT,
  BgTaskSchema,
  HistoryAttachmentSchema,
  McpServerStatusSchema,
  PermissionModeSchema,
  RunPhaseSchema,
  SessionStateSchema,
  SlashCommandSchema,
  ToolResultStatusSchema,
} from '@trine/core/types';
import {
  adoptPending,
  appendChildren,
  dropPending,
  historyToolEntry,
  pendingFor,
  stashChild,
  updateTool,
  type PendingChildren,
} from './tool-tree.ts';

// ---------------------------------------------------------------------------
// 类型（zod 定义：时间线要落盘，读回来必须能校验）
// ---------------------------------------------------------------------------

/**
 * 本地条目状态。`recalled` / `cancelled` 都是后补的终态——**加法改动**，
 * `store/types.ts` 冻结契约只允许加不允许改。
 *
 * - `recalled`：撤回成功。现在撤回成功的条目直接删掉，这个值只出现在旧版落盘的时间线里。
 * - `cancelled`：排队中被 agent 丢弃、没有执行（`input.cancelled` 的 stopped / closed）。
 *   不复用 `failed`：failed 的「重发」沿用同一个 clientMsgId，而 agent 的去重表还记着它，
 *   重发会被吃掉；cancelled 只能以新 clientMsgId 重发。
 */
export const LocalStatusSchema = z.enum([
  'sending',
  'queued',
  'parked',
  'confirmed',
  'expired',
  'failed',
  'recalled',
  'cancelled',
]);
export type LocalStatus = z.infer<typeof LocalStatusSchema>;

const entryBase = {
  /** 产生该条目的 a2c seq；本地条目在确认前为 0 */
  seq: z.number().int().nonnegative(),
  ts: z.number(),
} as const;

export const UserEntrySchema = z.object({
  kind: z.literal('user'),
  /** 本地条目 = clientMsgId；其他设备发的 = messageId */
  id: z.string().min(1),
  text: z.string(),
  /** 本设备发出的（有状态机）还是回显的别人的 */
  local: z.boolean(),
  status: LocalStatusSchema.optional(),
  messageId: z.string().optional(),
  /**
   * 转录 uuid（`user.message.uuid`，agent ≥ 0.9.0；历史条目即其 id）。回退以它指认
   * 目标消息，也用于和历史页去重。**加法字段**。
   */
  uuid: z.string().optional(),
  /**
   * 附件（agent ≥ 0.11.0）。本设备发的、回显的都带 blob 引用；历史里的可能没有
   * （CLI 粘贴的图片 / agent 不知道），点开时用 uuid + 下标找 agent 重新上传。
   * 只存元数据和引用，字节不进时间线（时间线会落盘到 IndexedDB）。**加法字段**。
   */
  attachments: z.array(HistoryAttachmentSchema).max(ATTACHMENTS_MAX_COUNT).optional(),
  /** input.parked 回执里的 seq，撤回（park.recall）与 park.expired 对账用 */
  parkedSeq: z.number().int().nonnegative().optional(),
  /**
   * `input.recall` 已发出的时刻（等回执期间按钮显示「撤回中…」并禁用）。
   *
   * 撤回成功 = `input.cancelled(recalled)`，条目删除；来不及 = 这条的 `user.message`
   * 回显（出队时发，早于撤回到达）把它升成 confirmed，这个字段随之清掉。
   * `RECALL_PENDING_MS` 内两样都没等到（帧丢了 / 旧 agent）就清掉它，按钮恢复可点。
   */
  recallingAt: z.number().optional(),
  /** 撤回是为了编辑：撤回成功时把文本放回输入框。超时不清（回执可能只是迟到），下次撤回重新设定 */
  recallForEdit: z.boolean().optional(),
  expiresAt: z.number().optional(),
  failReason: z.string().optional(),
  ...entryBase,
});

export const AssistantEntrySchema = z.object({
  kind: z.literal('assistant'),
  id: z.string().min(1),
  text: z.string(),
  done: z.boolean(),
  /** thinking.start 之后、首个 delta 之前为 true */
  thinking: z.boolean(),
  /** 本地斜杠命令的输出（assistant.done.command）：命令名，不知道时为空串；按命令卡渲染 */
  command: z.string().optional(),
  ...entryBase,
});

/**
 * ToolEntry 手写一份类型：children 是递归的，zod 的 getter 递归在这里推不出类型
 * （TS7022），给 getter 标注返回类型需要一个不依赖 schema 自身的目标类型。
 * 字段必须与下面的 schema 一致（typecheck 会在 z.array(ToolEntrySchema) 处核对）。
 */
export interface ToolEntry {
  kind: 'tool';
  id: string;
  toolName: string;
  argSummary: string;
  status?: z.infer<typeof ToolResultStatusSchema>;
  durationMs?: number;
  resultSummary?: string;
  outputPreview?: string;
  children?: ToolEntry[];
  childCount?: number;
  childrenLoaded?: boolean;
  seq: number;
  ts: number;
}

export const ToolEntrySchema = z.object({
  kind: z.literal('tool'),
  id: z.string().min(1),
  toolName: z.string(),
  argSummary: z.string(),
  status: ToolResultStatusSchema.optional(),
  durationMs: z.number().optional(),
  resultSummary: z.string().optional(),
  outputPreview: z.string().optional(),
  /**
   * 子 agent 的工具调用（subagent-view，加法字段）：带 `parentToolUseId` 的 tool 帧
   * 不进时间线，挂在父 Agent/Task 条目下（嵌套子 agent 成树）。顺序 = 到达顺序；
   * 条数封顶 `MAX_TOOL_CHILDREN`（超了丢最旧的已完成项），总数另记在 childCount。
   */
  get children(): z.ZodOptional<z.ZodArray<z.ZodType<ToolEntry>>> {
    return z.array(ToolEntrySchema).optional();
  },
  /** 见过的子工具调用总数（children 封顶后仍准；缺省按 children.length） */
  childCount: z.number().int().nonnegative().optional(),
  /** 已向 agent 拉过子转录（subagent.history.response 到了，哪怕是空的） */
  childrenLoaded: z.boolean().optional(),
  ...entryBase,
});

export const PermissionEntrySchema = z.object({
  kind: z.literal('permission'),
  id: z.string().min(1),
  toolName: z.string(),
  input: z.unknown(),
  suggestions: z.array(z.unknown()).optional(),
  requestedAt: z.number(),
  state: z.enum(['pending', 'resolved', 'invalidated']),
  verdict: z.enum(['allow', 'deny']).optional(),
  resolvedBy: z.string().optional(),
  /**
   * 「改参数后批准」时**实际被执行**的那份 input（来源 `permission.resolved`
   * 的 `updatedInput`，验收 5）。**加法改动**，`store/types.ts` 冻结契约允许。
   *
   * `input` 保留最初的请求原样——两者都要留着：卡片要能说清「请求的是这个、
   * 实际批的是那个」。早先没有这个字段，改后的值只活在批准那台设备的组件
   * state 里，刷新后按持久化条目回放的是最初请求，多设备也看不到实际批了什么。
   */
  approvedInput: z.unknown().optional(),
  /**
   * 拒绝时实际送给 Claude 的附言（来源 `permission.resolved.message`；如计划卡
   * 「继续规划」的反馈）。加法改动；旧 agent 不发。
   */
  denyMessage: z.string().optional(),
  /** 批准时随之切到的权限模式（来源 `permission.resolved.setMode`）。加法改动 */
  approvedMode: PermissionModeSchema.optional(),
  reason: z.string().optional(),
  /** 子 agent 发起的请求：父 Agent/Task 工具的 toolUseId（agent ≥ 0.8.0；加法字段） */
  parentToolUseId: z.string().optional(),
  ...entryBase,
});

export const RunStateEntrySchema = z.object({
  kind: z.literal('run_state'),
  id: z.string().min(1),
  state: SessionStateSchema,
  detail: z.string().optional(),
  ...entryBase,
});

export const RunDoneEntrySchema = z.object({
  kind: z.literal('run_done'),
  id: z.string().min(1),
  durationMs: z.number(),
  costUsd: z.number(),
  toolCount: z.number(),
  permissionCount: z.number(),
  turns: z.number().optional(),
  ...entryBase,
});

export const ErrorEntrySchema = z.object({
  kind: z.literal('error'),
  id: z.string().min(1),
  level: z.enum(['transient', 'fatal']),
  message: z.string(),
  attempt: z.number().optional(),
  errorKind: z.enum(['quota', 'auth', 'config', 'other']).optional(),
  retryAt: z.number().optional(),
  ...entryBase,
});

export const TimelineEntrySchema = z.discriminatedUnion('kind', [
  UserEntrySchema,
  AssistantEntrySchema,
  ToolEntrySchema,
  PermissionEntrySchema,
  RunStateEntrySchema,
  RunDoneEntrySchema,
  ErrorEntrySchema,
]);
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;
export type UserEntry = z.infer<typeof UserEntrySchema>;
export type AssistantEntry = z.infer<typeof AssistantEntrySchema>;
export type PermissionEntry = z.infer<typeof PermissionEntrySchema>;

export const HeartbeatSnapshotSchema = z.object({
  at: z.number(),
  runElapsedMs: z.number(),
  currentTool: z.object({ toolUseId: z.string(), name: z.string(), elapsedMs: z.number() }).optional(),
  silentMs: z.number(),
  phase: RunPhaseSchema,
});
export type HeartbeatSnapshot = z.infer<typeof HeartbeatSnapshotSchema>;

/**
 * 本机转录历史的翻页状态（`session.history.response`）。**加法改动**：
 * 省略 = 这条时间线还没向 agent 要过历史（打开会话 sync 结束后自动要一次）。
 */
export const HistoryStateSchema = z.object({
  /** agent 那边还有更早的（时间线顶部给「加载更早」） */
  hasMore: z.boolean(),
  /** 翻下一页的游标（上一页响应的 nextBefore）；省略 = 从最新一页取 */
  cursor: z.string().min(1).optional(),
});
export type HistoryState = z.infer<typeof HistoryStateSchema>;

/** 子 agent 工具条目暂存区（落盘用；加法字段，见 Timeline.pendingChildren） */
export const PendingChildrenSchema = z.record(z.string(), z.array(ToolEntrySchema));

/** `bgtask.snapshot` 的 tasks（落盘用同一份 schema；加法字段） */
export const BgTasksSchema = z.array(BgTaskSchema);

export interface Timeline {
  entries: TimelineEntry[];
  /** 已应用到本时间线的最大 a2c seq（加载时与 inCursors 取 max） */
  lastAppliedSeq: number;
  /** run.heartbeat 只更新这里，不进 entries */
  heartbeat: HeartbeatSnapshot | null;
  /** 最近一条 run.state */
  state: SessionState | null;
  /** 历史回看翻页状态（见 HistoryStateSchema）；省略 = 尚未拉过 */
  history?: HistoryState;
  /**
   * 后台任务（`bgtask.snapshot` 整份替换，不做增量合并；agent ≥ 0.7.0）。
   * 省略 = 从没收到过快照。随时间线落盘：agent 在拆子进程时会把在跑的标成
   * stopped 再发一帧，所以刷新后读回的「运行中」通常是真的还在跑。
   */
  bgTasks?: BgTask[];
  /**
   * 父条目还没出现的子 agent 工具条目，按父 toolUseId 分组暂存（subagent-view；
   * 见 tool-tree.ts）。省略 = 没有。随时间线落盘（父可能在更早的历史页里）。
   */
  pendingChildren?: PendingChildren;
  /**
   * 已被落盘裁剪（TIMELINE_MAX_ENTRIES）裁掉的 Agent/Task 条目 id（评审 m2）：父已经
   * 不在了，之后迟到的子帧直接丢，不进暂存区永远等。由 storage.trimTimelineForSave 维护。
   */
  trimmedToolIds?: string[];
}

export function emptyTimeline(): Timeline {
  return { entries: [], lastAppliedSeq: 0, heartbeat: null, state: null };
}

export const CapabilitiesSchema = z.object({
  slashCommands: z.array(SlashCommandSchema),
  models: z.array(z.string()),
  mcpServers: z.array(McpServerStatusSchema),
});
export interface Capabilities {
  slashCommands: SlashCommand[];
  models: string[];
  mcpServers: McpServerStatus[];
}

/** 机器的工作目录快照（`cwd.list.response / cwd.updated`） */
export interface MachineCwd {
  favorites: string[];
  defaultCwd: string;
  pinned?: Record<string, number>;
}

export interface MachineState {
  machineId: string;
  /** null = 还没收到过 machine.status（连接刚建立） */
  online: boolean | null;
  lastSeenAt: number | null;
  info: MachineInfo | null;
  /** info.name → peer.name → machineId，按可用性取 */
  name: string;
  parkedCount: number;
  /** pinned：置顶的工作区（cwd → 置顶时间），agent ≥ 0.14.0 才带 */
  cwd: MachineCwd | null;
  /** 机器级 error.fatal（无 sessionId；outbox 放弃自愈时 agent 发） */
  lastError: { kind: 'quota' | 'auth' | 'config' | 'other'; message: string; at: number } | null;
  /** 最近一次资源快照（`machine.stats`，agent ≥ 0.14.0）；只在内存，不落盘 */
  stats: MachineStats | null;
  /** 本次打开页面以来的资源快照（按时间升序，最多 STATS_HISTORY_MAX 条），画趋势用 */
  statsHistory: MachineStats[];
}

/** 资源快照保留条数（详情页 5 秒一次 ≈ 5 分钟） */
export const STATS_HISTORY_MAX = 60;

export function emptyMachine(machineId: string, name?: string): MachineState {
  return {
    machineId,
    online: null,
    lastSeenAt: null,
    info: null,
    name: name ?? machineId,
    parkedCount: 0,
    cwd: null,
    lastError: null,
    stats: null,
    statsHistory: [],
  };
}

// ---------------------------------------------------------------------------
// 本地条目状态机
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: ReadonlySet<LocalStatus> = new Set(['confirmed', 'expired', 'failed', 'recalled', 'cancelled']);

export function isTerminalStatus(status: LocalStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** 终态不被任何前态覆盖；非终态之间按事件到达顺序迁移 */
export function transitionLocalStatus(current: LocalStatus, next: LocalStatus): LocalStatus {
  if (isTerminalStatus(current)) return current;
  return next;
}

// ---------------------------------------------------------------------------
// Timeline reducer
// ---------------------------------------------------------------------------

function replaceEntry(entries: TimelineEntry[], index: number, entry: TimelineEntry): TimelineEntry[] {
  const out = entries.slice();
  out[index] = entry;
  return out;
}

function withEntries(tl: Timeline, entries: TimelineEntry[], seq: number): Timeline {
  return { ...tl, entries, lastAppliedSeq: Math.max(tl.lastAppliedSeq, seq) };
}

/** 追加型条目：同 id 已存在则视为重复应用，不动 */
function appendOnce(tl: Timeline, entry: TimelineEntry): Timeline {
  if (tl.entries.some((e) => e.kind === entry.kind && e.id === entry.id)) {
    return withEntries(tl, tl.entries, entry.seq);
  }
  return withEntries(tl, [...tl.entries, entry], entry.seq);
}

function findIndex(tl: Timeline, kind: TimelineEntry['kind'], id: string): number {
  return tl.entries.findIndex((e) => e.kind === kind && e.id === id);
}

/**
 * 把一条**会话级** a2c 事件应用到时间线。机器级事件（machine.info / cwd.* /
 * session.list.response 等）不该进来；进来了原样返回（只推进 lastAppliedSeq
 * 也不合适——它们不属于任何会话）。
 */
export function applyEvent(tl: Timeline, event: AgentToClientEvent): Timeline {
  const seq = event.seq;
  switch (event.type) {
    case 'assistant.delta': {
      const idx = findIndex(tl, 'assistant', event.messageId);
      if (idx >= 0) {
        const cur = tl.entries[idx] as AssistantEntry;
        // done 之后再来的 delta 是乱序残留：终态全文已覆盖，忽略
        if (cur.done) return withEntries(tl, tl.entries, seq);
        return withEntries(
          tl,
          replaceEntry(tl.entries, idx, { ...cur, text: cur.text + event.text, thinking: false }),
          seq,
        );
      }
      return withEntries(
        tl,
        [
          ...tl.entries,
          { kind: 'assistant', id: event.messageId, text: event.text, done: false, thinking: false, seq, ts: event.ts },
        ],
        seq,
      );
    }
    case 'assistant.done': {
      const idx = findIndex(tl, 'assistant', event.messageId);
      const entry: AssistantEntry = {
        kind: 'assistant',
        id: event.messageId,
        text: event.text,
        done: true,
        thinking: false,
        seq: idx >= 0 ? (tl.entries[idx] as AssistantEntry).seq : seq,
        ts: idx >= 0 ? (tl.entries[idx] as AssistantEntry).ts : event.ts,
        ...(event.command === undefined ? {} : { command: event.command }),
      };
      return withEntries(tl, idx >= 0 ? replaceEntry(tl.entries, idx, entry) : [...tl.entries, entry], seq);
    }
    case 'thinking.start': {
      const idx = findIndex(tl, 'assistant', event.messageId);
      if (idx >= 0) return withEntries(tl, tl.entries, seq);
      return withEntries(
        tl,
        [...tl.entries, { kind: 'assistant', id: event.messageId, text: '', done: false, thinking: true, seq, ts: event.ts }],
        seq,
      );
    }
    case 'user.message': {
      // 带 clientMsgId **且命中本地条目**才升级；否则追加（agent 对所有设备的
      // 回显都带 clientMsgId，不能用「带不带」判断是不是自己发的——评审 C4）
      if (event.clientMsgId !== undefined) {
        const idx = tl.entries.findIndex((e) => e.kind === 'user' && e.local && e.id === event.clientMsgId);
        if (idx >= 0) {
          const { recallingAt: _r, recallForEdit: _e, ...cur } = tl.entries[idx] as UserEntry;
          const status = transitionLocalStatus(cur.status ?? 'sending', 'confirmed');
          // 回显的位置就是它进入对话的位置：挪到末尾。排队 / 离线暂存的自不必说；sending
          // 也要挪——上一轮快结束时发出的，到 agent 时可能已空闲、直接执行，而上一轮最后
          // 的回复已经追加在这条本地条目后面了
          const moved = cur.status === undefined || !isTerminalStatus(cur.status);
          const entries = moved ? [...tl.entries.slice(0, idx), ...tl.entries.slice(idx + 1), tl.entries[idx]!] : tl.entries;
          return withEntries(
            tl,
            replaceEntry(entries, moved ? entries.length - 1 : idx, {
              ...cur,
              status,
              messageId: event.messageId,
              text: event.text,
              ...(event.attachments === undefined ? {} : { attachments: event.attachments }),
              ...(event.uuid === undefined ? {} : { uuid: event.uuid }),
              seq,
              // 换成 agent 时钟：发送时记的是浏览器时间，与后续 assistant / 工具条目
              // （agent 时钟）混排会因两端时钟差而错位
              ts: event.ts,
            }),
            seq,
          );
        }
      }
      const dupIdx = tl.entries.findIndex((e) => e.kind === 'user' && !e.local && e.id === event.messageId);
      if (dupIdx >= 0) return withEntries(tl, tl.entries, seq);
      return withEntries(
        tl,
        [
          ...tl.entries,
          {
            kind: 'user',
            id: event.messageId,
            text: event.text,
            local: false,
            messageId: event.messageId,
            ...(event.attachments === undefined ? {} : { attachments: event.attachments }),
            ...(event.uuid === undefined ? {} : { uuid: event.uuid }),
            seq,
            ts: event.ts,
          },
        ],
        seq,
      );
    }
    case 'session.rewound':
      return event.mode === 'code' ? withEntries(tl, tl.entries, seq) : applyRewound(tl, event.targetMessageIds, seq);
    case 'tool.start': {
      // 已有同 id 条目（重发 / 子条目先于 start 收到过 end）：原地更新名字与参数，
      // 结果与子树留着。顶层与任意深度的子条目都算
      const updated = updateTool(tl.entries, event.toolUseId, (cur) => ({
        ...cur,
        toolName: event.toolName,
        argSummary: event.argSummary,
      }));
      if (updated !== undefined) return withEntries(tl, updated, seq);
      const entry: ToolEntry = { kind: 'tool', id: event.toolUseId, toolName: event.toolName, argSummary: event.argSummary, seq, ts: event.ts };
      return placeTool(tl, entry, event.parentToolUseId, seq);
    }
    case 'tool.end': {
      const result = {
        status: event.status,
        durationMs: event.durationMs,
        resultSummary: event.resultSummary,
        ...(event.outputPreview === undefined ? {} : { outputPreview: event.outputPreview }),
      };
      const updated = updateTool(tl.entries, event.toolUseId, (cur) => ({ ...cur, ...result }));
      if (updated !== undefined) return withEntries(tl, updated, seq);
      // start 没收到（补发窗口外）：仍落一条，工具名未知
      const entry: ToolEntry = { kind: 'tool', id: event.toolUseId, toolName: '?', argSummary: '', ...result, seq, ts: event.ts };
      return placeTool(tl, entry, event.parentToolUseId, seq);
    }
    case 'permission.request': {
      const idx = findIndex(tl, 'permission', event.requestId);
      if (idx >= 0) {
        // 重连重发同 requestId：幂等——已 resolved/invalidated 的不回退到 pending
        return withEntries(tl, tl.entries, seq);
      }
      return withEntries(
        tl,
        [
          ...tl.entries,
          {
            kind: 'permission',
            id: event.requestId,
            toolName: event.toolName,
            input: event.input,
            ...(event.suggestions === undefined ? {} : { suggestions: event.suggestions }),
            requestedAt: event.requestedAt,
            state: 'pending',
            ...(event.parentToolUseId === undefined ? {} : { parentToolUseId: event.parentToolUseId }),
            seq,
            ts: event.ts,
          },
        ],
        seq,
      );
    }
    case 'permission.resolved': {
      const idx = findIndex(tl, 'permission', event.requestId);
      if (idx < 0) return withEntries(tl, tl.entries, seq);
      const cur = tl.entries[idx] as PermissionEntry;
      return withEntries(
        tl,
        replaceEntry(tl.entries, idx, {
          ...cur,
          state: 'resolved',
          verdict: event.verdict,
          ...(event.resolvedBy === undefined ? {} : { resolvedBy: event.resolvedBy }),
          // 实际批准的参数随条目落盘（验收 5）；旧 agent 不发这个字段，
          // 那时 approvedInput 保持 undefined，卡片回落到显示 input
          ...(event.updatedInput === undefined ? {} : { approvedInput: event.updatedInput }),
          ...(event.message === undefined ? {} : { denyMessage: event.message }),
          ...(event.setMode === undefined ? {} : { approvedMode: event.setMode }),
        }),
        seq,
      );
    }
    case 'permission.invalidated': {
      const idx = findIndex(tl, 'permission', event.requestId);
      if (idx < 0) return withEntries(tl, tl.entries, seq);
      const cur = tl.entries[idx] as PermissionEntry;
      if (cur.state === 'resolved') return withEntries(tl, tl.entries, seq);
      return withEntries(tl, replaceEntry(tl.entries, idx, { ...cur, state: 'invalidated', reason: event.reason }), seq);
    }
    case 'run.heartbeat':
      return {
        ...tl,
        lastAppliedSeq: Math.max(tl.lastAppliedSeq, seq),
        heartbeat: {
          at: event.ts,
          runElapsedMs: event.runElapsedMs,
          ...(event.currentTool === undefined ? {} : { currentTool: event.currentTool }),
          silentMs: event.silentMs,
          phase: event.phase,
        },
      };
    case 'run.state': {
      const next = appendOnce(tl, {
        kind: 'run_state',
        id: `run.state:${seq}`,
        state: event.state,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
        seq,
        ts: event.ts,
      });
      // 运行结束心跳就没意义了
      return { ...next, state: event.state, heartbeat: event.state === 'running' || event.state === 'waiting_permission' ? next.heartbeat : null };
    }
    case 'run.done':
      // 本地斜杠命令（/usage 等）不调模型：0 轮、0 工具的完成卡只是噪音，命令卡本身就是结果
      if (event.turns === 0 && event.toolCount === 0 && lastIsCommandOutput(tl.entries)) return withEntries(tl, tl.entries, seq);
      return appendOnce(tl, {
        kind: 'run_done',
        id: `run.done:${seq}`,
        durationMs: event.durationMs,
        costUsd: event.costUsd,
        toolCount: event.toolCount,
        permissionCount: event.permissionCount,
        ...(event.turns === undefined ? {} : { turns: event.turns }),
        seq,
        ts: event.ts,
      });
    case 'error.transient':
      return appendOnce(tl, {
        kind: 'error',
        id: `error.transient:${seq}`,
        level: 'transient',
        message: event.reason,
        attempt: event.attempt,
        seq,
        ts: event.ts,
      });
    case 'error.fatal':
      // 无 sessionId 的机器级 fatal 由 applyMachineEvent 承接，不该到这里
      if (event.sessionId === undefined) return tl;
      return appendOnce(tl, {
        kind: 'error',
        id: `error.fatal:${seq}`,
        level: 'fatal',
        message: event.message,
        errorKind: event.kind,
        ...(event.retryAt === undefined ? {} : { retryAt: event.retryAt }),
        seq,
        ts: event.ts,
      });
    case 'bgtask.snapshot':
      return { ...tl, lastAppliedSeq: Math.max(tl.lastAppliedSeq, seq), bgTasks: event.tasks };
    case 'input.rejected': {
      // agent 没接受（附件准备失败）：本地条目转 failed，可原样重试。别的设备没有这条本地条目
      const idx = tl.entries.findIndex((e) => e.kind === 'user' && e.local && e.id === event.clientMsgId);
      if (idx < 0) return withEntries(tl, tl.entries, seq);
      const cur = tl.entries[idx] as UserEntry;
      return withEntries(
        tl,
        replaceEntry(tl.entries, idx, {
          ...cur,
          status: transitionLocalStatus(cur.status ?? 'sending', 'failed'),
          failReason: event.reason,
        }),
        seq,
      );
    }
    case 'input.cancelled': {
      const idx = tl.entries.findIndex((e) => e.kind === 'user' && e.local && e.id === event.clientMsgId);
      if (idx < 0) return withEntries(tl, tl.entries, seq);
      const cur = tl.entries[idx] as UserEntry;
      if (cur.status !== undefined && isTerminalStatus(cur.status)) return withEntries(tl, tl.entries, seq);
      // 撤回成功：用户要的就是它消失（要编辑的，文本由 client 放回输入框）
      if (event.reason === 'recalled') {
        return withEntries(tl, [...tl.entries.slice(0, idx), ...tl.entries.slice(idx + 1)], seq);
      }
      const { recallingAt: _r, recallForEdit: _e, ...rest } = cur;
      return withEntries(
        tl,
        replaceEntry(tl.entries, idx, {
          ...rest,
          status: 'cancelled',
          failReason: event.reason === 'stopped' ? '已停止，未发送' : '会话关闭，未发送',
        }),
        seq,
      );
    }
    case 'input.queued': {
      const idx = tl.entries.findIndex((e) => e.kind === 'user' && e.local && e.id === event.clientMsgId);
      if (idx < 0) return withEntries(tl, tl.entries, seq);
      const cur = tl.entries[idx] as UserEntry;
      return withEntries(
        tl,
        replaceEntry(tl.entries, idx, { ...cur, status: transitionLocalStatus(cur.status ?? 'sending', 'queued') }),
        seq,
      );
    }
    // 会话级但不进时间线：交给 client 的 request() 关联 / capabilities 缓存
    case 'session.status.response':
    case 'mcp.status.response':
    // 历史页由 client.loadHistory 按 reqId 关联后经 mergeHistory 合并；这里只推进游标
    case 'session.history.response':
    // 子 agent 过程由 client 按 reqId 关联后并进父工具条目；这里只推进游标
    case 'subagent.history.response':
    // 附件新引用由 client.openAttachment 按 reqId 关联后写回条目；这里只推进游标
    case 'attachment.fetch.response':
    // 命令清单由 client.loadCommands 按 reqId 关联后写进 capabilities；这里只推进游标
    case 'session.commands.response':
    // 回退的预览 / 结果由 client 按 reqId 关联；时间线的变化走 session.rewound
    case 'session.rewind.preview.response':
    case 'session.rewind.response':
    case 'session.context.response':
    case 'session.capabilities':
      return { ...tl, lastAppliedSeq: Math.max(tl.lastAppliedSeq, seq) };
    // 机器级：不属于任何时间线
    case 'session.list.response':
    case 'session.created':
    case 'session.create.response':
    case 'session.updated':
    case 'session.mutate.response':
    case 'session.removed':
    case 'machine.info':
    case 'machine.claude.update.response':
    case 'machine.usage.response':
    case 'machine.stats':
    case 'cwd.list.response':
    case 'cwd.updated':
    case 'ext.catalog.response':
    case 'ext.read.response':
    case 'ext.action.plan':
    case 'ext.action.result':
    case 'ext.config.response':
    case 'session.links.update.response':
      return tl;
  }
}

/** 最近一条（跳过运行状态提示）是不是本地命令的输出 */
function lastIsCommandOutput(entries: readonly TimelineEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.kind === 'run_state') continue;
    return entry.kind === 'assistant' && entry.command !== undefined;
  }
  return false;
}

/**
 * 新工具条目落位（subagent-view）：
 * - 主线程（无 parent）→ 追加到时间线末尾；
 * - 子 agent 的 → 挂到父条目的 children；父条目还不在 → 暂存等它（见 tool-tree.ts）。
 * 落位前先把暂存区里等**它自己**的子条目并进来（子工具先于父 Agent 到达的乱序）。
 */
function placeTool(tl: Timeline, entry: ToolEntry, parentId: string | undefined, seq: number): Timeline {
  let pending = tl.pendingChildren;
  const waiting = pendingFor(pending, entry.id);
  let placed = entry;
  if (waiting !== undefined) {
    placed = appendChildren(entry, waiting);
    pending = dropPending(pending, entry.id);
  }
  if (parentId === undefined) {
    return withPending(withEntries(tl, [...tl.entries, placed], seq), pending);
  }
  const updated = updateTool(tl.entries, parentId, (p) => appendChildren(p, [placed]));
  if (updated !== undefined) return withPending(withEntries(tl, updated, seq), pending);
  // 父条目已被裁掉：它不会再回来，别让子条目在暂存区里永远等
  if (tl.trimmedToolIds?.includes(parentId) === true) return withPending(withEntries(tl, tl.entries, seq), pending);
  return withPending(withEntries(tl, tl.entries, seq), stashChild(pending, parentId, placed));
}

function withPending(tl: Timeline, pending: PendingChildren | undefined): Timeline {
  if (pending === tl.pendingChildren) return tl;
  if (pending === undefined) {
    const { pendingChildren: _drop, ...rest } = tl;
    return rest;
  }
  return { ...tl, pendingChildren: pending };
}

/**
 * 子 agent 回看（`subagent.history.response`）并进父工具条目（纯函数、幂等）。
 *
 * 只收工具项（agent 本就只给工具项；别的 kind 忽略）。与已有子条目按 id 合并——实时
 * 收到的为主、回看补缺；回看里没有的已有子条目保留。无论有没有内容都置
 * `childrenLoaded`（空结果也算拉过，卡片显示「没有记录」而不是再拉一次）。
 * 父条目不在时间线上（被裁了 / 会话换了）→ 原样返回。
 */
export function mergeSubagentHistory(
  tl: Timeline,
  parentId: string,
  items: readonly HistoryItem[],
): Timeline {
  const tools = items.filter((i): i is Extract<HistoryItem, { kind: 'tool' }> => i.kind === 'tool').map(historyToolEntry);
  const updated = updateTool(tl.entries, parentId, (p) => ({ ...appendChildren(p, tools, { fromHistory: true }), childrenLoaded: true }));
  if (updated === undefined) return tl;
  // 回看带进来的子条目可能正是暂存区里某组的父（嵌套）
  const adopted = adoptPending(updated, tl.pendingChildren);
  return withPending({ ...tl, entries: adopted.entries }, adopted.pending);
}

// ---------------------------------------------------------------------------
// 本地条目操作（用户动作与 transport 回执）
// ---------------------------------------------------------------------------

/** 用户点发送：立即以 sending 入时间线；同 clientMsgId 已存在（重发）则复位为 sending */
export function addLocalUserEntry(
  tl: Timeline,
  args: { clientMsgId: string; text: string; ts: number; attachments?: AttachmentRef[] },
): Timeline {
  const idx = tl.entries.findIndex((e) => e.kind === 'user' && e.local && e.id === args.clientMsgId);
  const entry: UserEntry = {
    kind: 'user',
    id: args.clientMsgId,
    text: args.text,
    ...(args.attachments === undefined || args.attachments.length === 0 ? {} : { attachments: args.attachments }),
    local: true,
    status: 'sending',
    seq: 0,
    ts: args.ts,
  };
  if (idx >= 0) {
    const cur = tl.entries[idx] as UserEntry;
    if (cur.status !== undefined && cur.status !== 'failed') return tl;
    return { ...tl, entries: replaceEntry(tl.entries, idx, entry) };
  }
  return { ...tl, entries: [...tl.entries, entry] };
}

/** 用新引用替换用户条目的第 index 个附件（agent 重新上传之后） */
export function setUserAttachment(tl: Timeline, entryId: string, index: number, ref: AttachmentRef): Timeline {
  const idx = tl.entries.findIndex((e) => e.kind === 'user' && e.id === entryId);
  if (idx < 0) return tl;
  const cur = tl.entries[idx] as UserEntry;
  if (cur.attachments === undefined || index >= cur.attachments.length) return tl;
  const attachments = cur.attachments.slice();
  attachments[index] = ref;
  return { ...tl, entries: replaceEntry(tl.entries, idx, { ...cur, attachments }) };
}

/** 按状态机迁移本地条目，可附带 parked 信息 / 失败原因 */
export function setLocalStatus(
  tl: Timeline,
  clientMsgId: string,
  next: LocalStatus,
  extra: { parkedSeq?: number; expiresAt?: number; failReason?: string } = {},
): Timeline {
  const idx = tl.entries.findIndex((e) => e.kind === 'user' && e.local && e.id === clientMsgId);
  if (idx < 0) return tl;
  const cur = tl.entries[idx] as UserEntry;
  const status = transitionLocalStatus(cur.status ?? 'sending', next);
  if (status === cur.status && Object.keys(extra).length === 0) return tl;
  // 进了终态就不再是「撤回中」：confirmed 说明撤回没赶上（消息已执行），
  // failed/expired 说明它彻底没送到——两种情况「撤回中…」都该消失
  const { recallingAt: _drop, recallForEdit: _edit, ...rest } = cur;
  const keepRecalling = !isTerminalStatus(status) && cur.recallingAt !== undefined;
  return {
    ...tl,
    entries: replaceEntry(tl.entries, idx, {
      ...rest,
      ...(keepRecalling ? { recallingAt: cur.recallingAt } : {}),
      ...(keepRecalling && cur.recallForEdit === true ? { recallForEdit: true } : {}),
      status,
      ...(extra.parkedSeq === undefined ? {} : { parkedSeq: extra.parkedSeq }),
      ...(extra.expiresAt === undefined ? {} : { expiresAt: extra.expiresAt }),
      ...(extra.failReason === undefined ? {} : { failReason: extra.failReason }),
    }),
  };
}

/** `input.recall` 已发出：置「撤回中」（见 UserEntry.recallingAt）；`forEdit` = 撤回成功后放回输入框 */
export function markRecalling(tl: Timeline, clientMsgId: string, at: number, forEdit = false): Timeline {
  const idx = tl.entries.findIndex((e) => e.kind === 'user' && e.local && e.id === clientMsgId);
  if (idx < 0) return tl;
  const cur = tl.entries[idx] as UserEntry;
  if (cur.status !== 'queued' || cur.recallingAt !== undefined) return tl;
  // 每次撤回重新表态：上次超时留下的「为编辑」不能带到这次单纯的撤回上
  const { recallForEdit: _prev, ...rest } = cur;
  return {
    ...tl,
    entries: replaceEntry(tl.entries, idx, { ...rest, recallingAt: at, ...(forEdit ? { recallForEdit: true } : {}) }),
  };
}

/**
 * 「撤回中…」最多等多久。agent ≥ 0.15.0 对撤回总有答复（成功 `input.cancelled`，
 * 来不及则回显早已到达），等不到说明帧丢了或 agent 太旧——不再猜「撤成了」，
 * 只把按钮恢复成可点。client 的定时器与托盘文案共用这个值。
 */
export const RECALL_PENDING_MS = 5_000;

/**
 * 清掉超时的「撤回中」（条目仍是 queued，按钮恢复可点）。
 *
 * 早先没有撤回回执时，这里到点就把条目判成「已撤回」——旧 agent 上撤回失败也会
 * 显示成撤回成功。现在成功有 `input.cancelled`，超时只意味着「不知道」。
 *
 * @param olderThan 早于这个时刻发出的撤回才算超时（调用方传 `now - 超时`）
 */
export function clearStaleRecalls(tl: Timeline, olderThan: number): Timeline {
  let changed = false;
  const entries = tl.entries.map((e) => {
    if (e.kind !== 'user' || !e.local) return e;
    if (e.recallingAt === undefined || e.recallingAt > olderThan) return e;
    changed = true;
    // recallForEdit 留着：回执只是迟到的话，撤回成功时仍要把文本放回输入框
    const { recallingAt: _drop, ...rest } = e;
    return rest;
  });
  return changed ? { ...tl, entries } : tl;
}

/** 删掉一条本地条目（托盘里的「丢弃」、离线暂存的撤回、重发前清掉旧条目） */
export function removeLocalEntry(tl: Timeline, clientMsgId: string): Timeline {
  const idx = tl.entries.findIndex((e) => e.kind === 'user' && e.local && e.id === clientMsgId);
  if (idx < 0) return tl;
  return { ...tl, entries: [...tl.entries.slice(0, idx), ...tl.entries.slice(idx + 1)] };
}

/**
 * 这条是不是**还没进入对话**的本设备消息：画在输入框上方的排队托盘里，不进时间线。
 *
 * - queued / parked：在 agent / 服务端排着；cancelled / expired / failed：没送进去，等用户
 *   重发或丢弃。
 * - sending 只在会话运行中算：运行中发出的马上会排队，先放托盘免得在时间线末尾闪一下；
 *   空闲时发出的马上就会执行，留在时间线里。
 * - 旧版落盘的 recalled 留在时间线里（显示「已撤回」）。
 */
export function isPendingEntry(entry: TimelineEntry, running: boolean): entry is UserEntry {
  if (entry.kind !== 'user' || !entry.local) return false;
  switch (entry.status) {
    case 'queued':
    case 'parked':
    case 'cancelled':
    case 'expired':
    case 'failed':
      return true;
    case 'sending':
      return running;
    default:
      return false;
  }
}

/** park.expired{seq}：按 parkedSeq 找条目 */
export function expireParkedBySeq(tl: Timeline, parkedSeq: number): Timeline {
  const idx = tl.entries.findIndex((e) => e.kind === 'user' && e.local && e.parkedSeq === parkedSeq);
  if (idx < 0) return tl;
  const cur = tl.entries[idx] as UserEntry;
  return { ...tl, entries: replaceEntry(tl.entries, idx, { ...cur, status: transitionLocalStatus(cur.status ?? 'parked', 'expired') }) };
}

/** 本地按 expiresAt 过期 parked 条目（离线期间收不到 park.expired 通知） */
export function expireParked(tl: Timeline, now: number): Timeline {
  let changed = false;
  const entries = tl.entries.map((e) => {
    if (e.kind !== 'user' || !e.local || e.status !== 'parked') return e;
    if (e.expiresAt === undefined || e.expiresAt > now) return e;
    changed = true;
    return { ...e, status: 'expired' as const };
  });
  return changed ? { ...tl, entries } : tl;
}

/**
 * outbox 放弃自愈 / scope fatal：受影响且**仍为 sending** 的本地条目转 failed（可重发）。
 * queued / parked 的不动——agent 或服务端已经收下了，标失败会误导用户重发出重复消息。
 */
export function failSendingEntries(tl: Timeline, clientMsgIds: readonly string[], reason: string): Timeline {
  if (clientMsgIds.length === 0) return tl;
  const ids = new Set(clientMsgIds);
  let changed = false;
  const entries = tl.entries.map((e) => {
    if (e.kind !== 'user' || !e.local || e.status !== 'sending' || !ids.has(e.id)) return e;
    changed = true;
    return { ...e, status: 'failed' as const, failReason: reason };
  });
  return changed ? { ...tl, entries } : tl;
}

/** 加载时：仍为 sending 的条目一律转 failed（待发队列在内存，刷新即丢） */
export function markSendingAsFailed(tl: Timeline): Timeline {
  let changed = false;
  const entries = tl.entries.map((e) => {
    if (e.kind !== 'user' || !e.local || e.status !== 'sending') return e;
    changed = true;
    return { ...e, status: 'failed' as const, failReason: '页面刷新时尚未发出' };
  });
  return changed ? { ...tl, entries } : tl;
}

/** 有本地 parked 条目且 expiresAt 最近的时刻（client 据此定下一次过期检查） */
export function nextParkedExpiry(tl: Timeline): number | null {
  let min: number | null = null;
  for (const e of tl.entries) {
    if (e.kind !== 'user' || !e.local || e.status !== 'parked' || e.expiresAt === undefined) continue;
    if (min === null || e.expiresAt < min) min = e.expiresAt;
  }
  return min;
}

// ---------------------------------------------------------------------------
// 回退（session.rewound）
// ---------------------------------------------------------------------------

/** 用户条目是否就是这些 id 之一（本地 id / messageId / 转录 uuid 任一对上） */
function userEntryMatches(entry: TimelineEntry, ids: ReadonlySet<string>): boolean {
  if (entry.kind !== 'user') return false;
  return (
    ids.has(entry.id) ||
    (entry.messageId !== undefined && ids.has(entry.messageId)) ||
    (entry.uuid !== undefined && ids.has(entry.uuid))
  );
}

/**
 * 对话已回退：从目标用户消息起（含）截掉时间线。对不上任何条目（时间线是旧的 /
 * 目标在没加载的更早历史里）就整条清空并忘掉翻页状态——视图随后自动重拉历史，
 * 以 agent 的转录为准。截掉的子 agent 暂存一并丢掉（父已经不在了）。
 */
function applyRewound(tl: Timeline, targetMessageIds: readonly string[], seq: number): Timeline {
  const ids = new Set(targetMessageIds);
  const at = tl.entries.findIndex((e) => userEntryMatches(e, ids));
  const { history, pendingChildren: _pending, ...rest } = tl;
  const lastAppliedSeq = Math.max(tl.lastAppliedSeq, seq);
  if (at < 0) return { ...rest, entries: [], lastAppliedSeq };
  return { ...rest, ...(history === undefined ? {} : { history }), entries: tl.entries.slice(0, at), lastAppliedSeq };
}

/**
 * 回退的目标 id：转录 uuid 优先，其次 messageId（agent 进程内能映射回 uuid）。
 * 还没被 agent 确认的本地条目（发送中 / 排队 / 失败……）不能回退，返回 undefined。
 */
export function rewindTargetId(entry: UserEntry): string | undefined {
  if (entry.local && entry.status !== undefined && entry.status !== 'confirmed') return undefined;
  return entry.uuid ?? entry.messageId ?? (entry.local ? undefined : entry.id);
}

// ---------------------------------------------------------------------------
// 历史回看（session.history.response → 时间线开头）
// ---------------------------------------------------------------------------

/**
 * 历史条目：由 mergeHistory 以 seq 0 前插的条目（本地发出的 user 条目确认前也是
 * seq 0，但它 `local: true`，不算）。
 */
export function isHistoryEntry(entry: TimelineEntry): boolean {
  return entry.seq === 0 && !(entry.kind === 'user' && entry.local);
}

function historyToEntry(item: HistoryItem): TimelineEntry {
  switch (item.kind) {
    case 'user':
      return {
        kind: 'user',
        id: item.id,
        text: item.text,
        local: false,
        messageId: item.id,
        uuid: item.id,
        ...(item.attachments === undefined ? {} : { attachments: item.attachments }),
        seq: 0,
        ts: item.ts,
      };
    case 'assistant':
      return { kind: 'assistant', id: item.id, text: item.text, done: true, thinking: false, seq: 0, ts: item.ts };
    case 'tool':
      return {
        kind: 'tool',
        id: item.id,
        toolName: item.toolName,
        argSummary: item.argSummary,
        ...(item.status === undefined ? {} : { status: item.status }),
        ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
        ...(item.resultSummary === undefined ? {} : { resultSummary: item.resultSummary }),
        ...(item.outputPreview === undefined ? {} : { outputPreview: item.outputPreview }),
        seq: 0,
        ts: item.ts,
      };
  }
}

/**
 * 把一页历史并进时间线（纯函数、幂等）。
 *
 * - **cutoff**：时间线里 agent 产生的条目（seq > 0）的最早 ts。只收早于它的历史项
 *   ——晚于它的那段服务端中转帧已经覆盖了（经 trine 跑的 run 同时写进了转录），
 *   再收就是重复。没有 agent 条目（本机终端建的 / 超 TTL 的会话）则全收。
 * - **去重**：按 kind + id（assistant 的 id 与实时 messageId 同源、tool 按 toolUseId；
 *   user 同时比 messageId），同一页应用两次只落一份。
 * - **前插**：新条目以 seq 0 与时间线开头已有的历史块按 ts 稳定归并，其余条目原样
 *   跟在后面——不打乱实时流的到达顺序。
 * - 翻页状态以本页为准覆盖（hasMore / nextBefore）。
 *
 * 没有新条目且翻页状态不变时原样返回（引用相等，client 据此不落盘不通知）。
 */
export function mergeHistory(
  tl: Timeline,
  page: { items: readonly HistoryItem[]; hasMore: boolean; nextBefore?: string | undefined },
): Timeline {
  let cutoff = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  for (const e of tl.entries) {
    if (e.seq > 0 && e.ts < cutoff) cutoff = e.ts;
    seen.add(`${e.kind}:${e.id}`);
    if (e.kind === 'user' && e.messageId !== undefined) seen.add(`user:${e.messageId}`);
    // 实时条目带了转录 uuid（agent ≥ 0.9.0）：与历史页的同一条消息直接对上
    if (e.kind === 'user' && e.uuid !== undefined) seen.add(`user:${e.uuid}`);
  }
  const fresh: TimelineEntry[] = [];
  for (const item of page.items) {
    if (item.ts >= cutoff) continue;
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(historyToEntry(item));
  }

  const history: HistoryState = {
    hasMore: page.hasMore,
    ...(page.hasMore && page.nextBefore !== undefined ? { cursor: page.nextBefore } : {}),
  };
  const sameHistory = tl.history?.hasMore === history.hasMore && tl.history.cursor === history.cursor;
  if (fresh.length === 0 && sameHistory) return tl;

  let entries = tl.entries;
  if (fresh.length > 0) {
    let head = 0;
    while (head < tl.entries.length && isHistoryEntry(tl.entries[head]!)) head++;
    const existing = tl.entries.slice(0, head);
    fresh.sort((a, b) => a.ts - b.ts);
    // 稳定归并：同 ts 时已有的在前（它来自更新的一页之前就已在场，顺序已定）
    const merged: TimelineEntry[] = [];
    let i = 0;
    let j = 0;
    while (i < existing.length || j < fresh.length) {
      if (j >= fresh.length || (i < existing.length && existing[i]!.ts <= fresh[j]!.ts)) merged.push(existing[i++]!);
      else merged.push(fresh[j++]!);
    }
    entries = [...merged, ...tl.entries.slice(head)];
  }
  // 历史页带进来的 Agent 条目可能正是暂存子条目在等的父
  const adopted = fresh.length > 0 ? adoptPending(entries, tl.pendingChildren) : { entries, pending: tl.pendingChildren };
  return withPending({ ...tl, entries: adopted.entries, history }, adopted.pending);
}

/** 支持 session.history.request 的最低 agent 版本 */
export const HISTORY_MIN_AGENT_VERSION = '0.3.0';

function parseVersion(v: string): number[] | null {
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 支持 session.commands.request 的最低 agent 版本 */
export const COMMANDS_MIN_AGENT_VERSION = '0.5.0';

/** agent 版本 ≥ min；解析不了（未知版本）按不支持处理 */
function agentAtLeast(agentVersion: string | undefined, min: string): boolean {
  if (agentVersion === undefined) return false;
  const have = parseVersion(agentVersion);
  const need = parseVersion(min)!;
  if (have === null) return false;
  for (let k = 0; k < 3; k++) {
    if (have[k]! !== need[k]!) return have[k]! > need[k]!;
  }
  return true;
}

/** agent 版本 ≥ HISTORY_MIN_AGENT_VERSION；解析不了（未知版本）按不支持处理 */
export function agentSupportsHistory(agentVersion: string | undefined): boolean {
  return agentAtLeast(agentVersion, HISTORY_MIN_AGENT_VERSION);
}

/** agent 版本 ≥ COMMANDS_MIN_AGENT_VERSION；解析不了（未知版本）按不支持处理 */
export function agentSupportsCommands(agentVersion: string | undefined): boolean {
  return agentAtLeast(agentVersion, COMMANDS_MIN_AGENT_VERSION);
}

/**
 * permission.respond 的 message（拒绝附言）/ setMode（批准时切模式）生效的最低
 * agent 版本。旧 agent 收到这两个字段不拒帧（zod strip），只是静默不生效——
 * 计划卡据此决定显不显示「自动接受编辑」与反馈框，不给出做不到的选项。
 */
export const PLAN_OPTIONS_MIN_AGENT_VERSION = '0.6.0';

/** agent 版本 ≥ PLAN_OPTIONS_MIN_AGENT_VERSION；解析不了（未知版本）按不支持处理 */
export function agentSupportsPlanOptions(agentVersion: string | undefined): boolean {
  return agentAtLeast(agentVersion, PLAN_OPTIONS_MIN_AGENT_VERSION);
}

/**
 * `bgtask.stop` 生效的最低 agent 版本。旧 agent 不认识这个 type（schema 层丢弃、
 * 永不应答）——后台任务条据此决定显不显示「停止」按钮，不给出做不到的操作。
 * 快照本身（`bgtask.snapshot`）不需要探测：旧 agent 根本不发，条就不出现。
 */
export const BG_TASK_STOP_MIN_AGENT_VERSION = '0.7.0';

/** agent 版本 ≥ BG_TASK_STOP_MIN_AGENT_VERSION；解析不了（未知版本）按不支持处理 */
export function agentSupportsBgTaskStop(agentVersion: string | undefined): boolean {
  return agentAtLeast(agentVersion, BG_TASK_STOP_MIN_AGENT_VERSION);
}

/**
 * `subagent.history.request`（子 agent 过程回看）的最低 agent 版本。旧 agent 不认识
 * 这个 type（schema 层丢弃、永不应答）——历史里的 Task 卡据此决定展开时拉不拉。
 * 实时子工具卡（tool 帧的 parentToolUseId）不需要探测：旧 agent 根本不发。
 */
export const SUBAGENT_HISTORY_MIN_AGENT_VERSION = '0.8.0';

/** agent 版本 ≥ SUBAGENT_HISTORY_MIN_AGENT_VERSION；解析不了（未知版本）按不支持处理 */
export function agentSupportsSubagentHistory(agentVersion: string | undefined): boolean {
  return agentAtLeast(agentVersion, SUBAGENT_HISTORY_MIN_AGENT_VERSION);
}

/**
 * 回退（`session.rewind.preview` / `session.rewind`）的最低 agent 版本。旧 agent 不认识
 * 这些 type（schema 层丢弃、永不应答）——用户消息据此决定显不显示「回退」。
 */
export const REWIND_MIN_AGENT_VERSION = '0.9.0';

/** agent 版本 ≥ REWIND_MIN_AGENT_VERSION；解析不了（未知版本）按不支持处理 */
export function agentSupportsRewind(agentVersion: string | undefined): boolean {
  return agentAtLeast(agentVersion, REWIND_MIN_AGENT_VERSION);
}

/**
 * 附件（input.send / user.message 带 attachments、attachment.fetch、input.rejected）的
 * 最低 agent 版本。旧 agent 会丢掉附件字段，只带附件的消息整帧被拒——输入框据此决定
 * 给不给附件入口。
 */
export const ATTACHMENTS_MIN_AGENT_VERSION = '0.11.0';

export function agentSupportsAttachments(agentVersion: string | undefined): boolean {
  return agentAtLeast(agentVersion, ATTACHMENTS_MIN_AGENT_VERSION);
}

/** 快照里正在运行的后台任务数（没有快照 = 0） */
export function bgRunningCount(tasks: readonly BgTask[] | undefined): number {
  if (tasks === undefined) return 0;
  let n = 0;
  for (const t of tasks) if (t.status === 'running') n += 1;
  return n;
}

/**
 * 落盘快照里的「运行中」是否已陈旧（评审 M2）。
 *
 * 快照只在变化时发：agent 被 kill -9 / 机器重启，`close()` 里那帧「全部 stopped」
 * 发不出去，web 落盘的 bgTasks 里就永远是 running、永远走秒。对账点是 agent 权威的
 * `meta.bgRunning`（`session.list.response` / `session.updated`，只在 >0 时带）：
 * agent ≥ 0.7.0（会发这个字段）、meta 在手、它说没有在跑、快照却说有 → 快照陈旧，
 * 那些 running 按「状态未知」处理、不计入在跑数。meta 还没拿到时不下结论。
 *
 * 顺序上不会误判：agent 发快照（running）后紧接着经 onMeta 发 session.updated
 * （bgRunning:1），两帧之间的窗口只有一条消息的距离。
 */
export function bgTasksStale(args: {
  bgTasks: readonly BgTask[] | undefined;
  meta: Pick<SessionMeta, 'bgRunning'> | undefined;
  agentVersion: string | undefined;
}): boolean {
  const { bgTasks, meta, agentVersion } = args;
  if (bgRunningCount(bgTasks) === 0) return false;
  if (meta === undefined) return false;
  if (!agentSupportsBgTaskStop(agentVersion)) return false;
  return (meta.bgRunning ?? 0) === 0;
}

/**
 * 按 name 把已知的 description 并回新清单：SDK init 来的 `session.capabilities`
 * 只有命令名，覆盖时别把 `session.commands.response` 带来的描述冲掉。
 * 新清单自带描述的以新的为准；名字集合以新清单为准。
 */
export function mergeCommandDescriptions(next: SlashCommand[], known: readonly SlashCommand[]): SlashCommand[] {
  if (known.length === 0) return next;
  const desc = new Map<string, string>();
  for (const c of known) if (c.description !== undefined && c.description !== '') desc.set(c.name, c.description);
  if (desc.size === 0) return next;
  return next.map((c) => {
    if (c.description !== undefined && c.description !== '') return c;
    const d = desc.get(c.name);
    return d === undefined ? c : { ...c, description: d };
  });
}

/**
 * 打开会话后是否该自动拉一次历史：机器在线、agent 支持、该会话同步已结束
 * （sync.done——否则 cutoff 算的是半截时间线）、且这条时间线还没拉过。
 */
export function shouldAutoLoadHistory(args: {
  timeline: Timeline;
  syncing: unknown;
  machine: Pick<MachineState, 'online' | 'info'> | undefined;
}): boolean {
  const { timeline, syncing, machine } = args;
  if (machine === undefined || machine.online !== true) return false;
  if (syncing !== undefined) return false;
  if (timeline.history !== undefined) return false;
  return agentSupportsHistory(machine.info?.agentVersion);
}

// ---------------------------------------------------------------------------
// sessions / machine
// ---------------------------------------------------------------------------

/** 会话列表合并（按 sessionId 幂等） */
export function applySessionsEvent(
  sessions: Record<string, SessionMeta>,
  event: AgentToClientEvent,
): Record<string, SessionMeta> {
  switch (event.type) {
    case 'session.list.response': {
      // agent 是权威：全量覆盖
      const out: Record<string, SessionMeta> = {};
      for (const s of event.sessions) out[s.sessionId] = s;
      return out;
    }
    case 'session.created':
    case 'session.updated':
    case 'session.create.response':
      return { ...sessions, [event.session.sessionId]: event.session };
    case 'run.state': {
      if (event.sessionId === undefined) return sessions;
      const cur = sessions[event.sessionId];
      if (cur === undefined) return sessions;
      const next: SessionMeta = { ...cur, state: event.state, lastActivityAt: Math.max(cur.lastActivityAt, event.ts) };
      // 跑起来的会话一定不再是「已归档」：agent 在 meta 出口自动取消归档并广播
      // session.updated（评审 M1），这里先本地置掉，免得那一帧到之前它还藏在归档视图里
      if (event.state === 'running' && next.archived === true) {
        delete next.archived;
        delete next.archivedAt;
      }
      return { ...sessions, [event.sessionId]: next };
    }
    // 永久删除：广播，或墓碑命中时的 `deleted` 应答（视同已删除，评审 B4）
    case 'session.removed':
      return omitSession(sessions, event.targetSessionId);
    case 'session.mutate.response':
      return isDeletedResponse(event) ? omitSession(sessions, event.targetSessionId) : sessions;
    default:
      return sessions;
  }
}

/** `session.mutate.response` 是否在说「这个会话已被永久删除」（agent 墓碑命中） */
export function isDeletedResponse(event: AgentToClientEvent): event is Extract<AgentToClientEvent, { type: 'session.mutate.response' }> {
  return event.type === 'session.mutate.response' && !event.ok && event.error?.code === 'deleted';
}

function omitSession(sessions: Record<string, SessionMeta>, sessionId: string): Record<string, SessionMeta> {
  if (!(sessionId in sessions)) return sessions;
  const { [sessionId]: _removed, ...rest } = sessions;
  return rest;
}

/** 机器级事件 → MachineState */
export function applyMachineEvent(machine: MachineState, event: AgentToClientEvent): MachineState {
  switch (event.type) {
    case 'machine.info':
      return { ...machine, info: event.info, name: event.info.name };
    case 'cwd.list.response':
    case 'cwd.updated':
      return {
        ...machine,
        cwd: {
          favorites: event.favorites,
          defaultCwd: event.defaultCwd,
          ...(event.pinned === undefined ? {} : { pinned: event.pinned }),
        },
      };
    case 'machine.stats': {
      // 断线补发可能把旧快照晚送到：只收比已有更新的
      if (machine.stats !== null && event.stats.at <= machine.stats.at) return machine;
      return {
        ...machine,
        stats: event.stats,
        statsHistory: [...machine.statsHistory, event.stats].slice(-STATS_HISTORY_MAX),
      };
    }
    case 'error.fatal':
      if (event.sessionId !== undefined) return machine;
      return { ...machine, lastError: { kind: event.kind, message: event.message, at: event.ts } };
    default:
      return machine;
  }
}

export function applyMachineStatus(machine: MachineState, status: { online: boolean; lastSeenAt: number }): MachineState {
  return { ...machine, online: status.online, lastSeenAt: status.lastSeenAt };
}

export function applyParkedCount(machine: MachineState, parkedCount: number): MachineState {
  return machine.parkedCount === parkedCount ? machine : { ...machine, parkedCount };
}


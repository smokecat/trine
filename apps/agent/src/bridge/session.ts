/**
 * 单个 Claude 会话：SDK `query()` 流式输入 + 长驻读取循环 + 按轮记账 + 排队 +
 * 权限 + 心跳 + 自动续跑。
 *
 * ## 进程模型
 *
 * 一个 ClaudeSession = 一个 SDK `query()` = 一个 Claude Code 子进程。
 * 采用**流式输入模式**（prompt 传 AsyncIterable）而非一问一答：
 * - 进程长驻，多轮对话零冷启动；
 * - `canUseTool` **只在流式输入模式下可用**（调研报告 §1），而权限转发是 MVP 核心；
 * - `interrupt()` 可远程停止当前任务。
 *
 * ## 配置对齐（CLAUDE.md 硬约束 / D3）
 *
 * 必须显式设 `systemPrompt: {type:'preset', preset:'claude_code'}` 与
 * `settingSources: ['user','project','local']`。SDK 的默认值**不是** Claude Code
 * 的默认值：不设 systemPrompt 会得到一个空系统提示的裸 agent，不设 settingSources
 * 则不加载 CLAUDE.md / 项目设置。远程会话必须与本机 `claude` 行为一致，
 * 否则「远程操控」名不副实。绝不用 `--bare`（会绕开订阅 OAuth 转而要 API key）。
 *
 * 同理，拉起的是**本机全局 claude**（`pathToClaudeCodeExecutable`，app 启动时经
 * claude-cli.ts 解析）而不是 SDK 包里钉死版本的内置二进制：版本与本机终端里的
 * claude 一致，远程 `claude update` 才对会话生效。找不到全局 claude 时不传，
 * 回退 SDK 内置。
 *
 * ## 读取模型：长驻读取循环 + 按「轮」记账
 *
 * 早先的读法是「推一条用户消息 → 读到 result 就停」，空闲期没人读流。这在
 * **后台任务**（Bash `run_in_background` / 后台子 agent）面前会错位：后台任务
 * 完成后 CLI 会**自发**开启新一轮（`system/init` → assistant → `result`，全程没有
 * 用户消息，真 claude 2.1.282 实测）。空闲期完成的自发轮积压在 SDK 里，用户下一条
 * 消息推进去后读到的第一个 result 是自发轮的，trine 以为本轮结束；用户那条的真正
 * 回复要到再下一条消息才被读出——每出现一次自发轮就永久错位一轮。
 *
 * 现在改为：`#startQuery` 后起一个长驻读取循环（`#readLoop`），query 存活期间
 * **持续消费**消息流，所有消息都经它翻译、发帧、驱动状态；用户消息的推送方只等
 * 「归属于自己那一轮的 result」（`#inflight` 的 promise），不再自己读流。
 *
 * ### 轮（Round）与归属
 *
 * 每一轮以 `system/init`（或第一条主 agent 帧）开始、以 `result` 结束。
 * 轮开始时若没有「已推送、待回应」的用户消息（`#inflight`）→ **自发轮**；有的话
 * 先记为「待定」，由第一条回复帧（includePartialMessages 下是第一个非 ping 的
 * `stream_event`；没有流事件时是第一条 `assistant`）上的 `user_message_uuid`
 * 定归属（SDK 文档：该字段是「触发本轮的用户消息 uuid，只打在本轮第一条回复帧上，
 * 自发/合成轮不带」）：
 * - 带了且等于 `#inflight.uuid` → **用户轮**；
 * - 带了但不等 → 自发轮（用户消息仍待回应，排在它后面）；
 * - 不带 → 若本 query 里见过这个标记（`#stampsSeen`）→ 自发轮；否则说明对端是不打
 *   标记的旧 CLI / 假 SDK → 按旧语义归给在途用户消息。这个兜底成立的前提是：query
 *   的第一轮永远由我们的推送触发（query 是惰性起的，后台任务不跨进程存活），所以
 *   新 CLI 上第一轮必然带标记，此后的无标记轮就是自发轮；旧 CLI 上则全程走旧语义。
 * - 一轮没有任何回复帧就到了 result（如零帧的错误型 result）→ 有在途用户消息就归它
 *   （不让用户消息挂死），否则按自发轮。
 *
 * ### run 状态的归属（关键不变量）
 *
 * 「run 状态」= `queue.running` / `run.state` / 心跳 / 统计复位 / `onIdle`。
 * 任一时刻它有且只有一个所有者：
 * - **drain 循环**（`#drainBusy`）：用户消息队列在跑时拥有；用户轮的开跑/收尾都由
 *   `#runOne` / `#drain` 做，读取循环只负责解开 `#inflight`；
 * - **自发轮**（`#round.ownsRun`）：自发轮开始时 drain 不在跑才接管——迁 running、
 *   起心跳、复位统计；它的 result 之后收尾（回 idle，或队列里有待发消息就起 drain）；
 *   drain 在跑时开始的自发轮只发一条带 `detail` 的 `run.state`（供 client 标记轮的
 *   边界），状态归 drain 管；drain 收尾时若自发轮仍在进行，把所有权交给它。
 * 「同一时刻只有一条用户消息在途」的简单模型不变：自发轮进行中来的用户消息照常
 * 排队，等它 result 后再推。
 *
 * ### 拆 query 时读取循环怎么退出（不变量：读取循环退出 ⇒ `#query === undefined`）
 *
 * 读取循环每次 `await q.next()` 之后都核对 `this.#query === q`：query 已被拆
 * （stop / close / 续跑）就静默退出，不碰任何状态、不误报崩溃。在途用户消息由
 * `#teardownQuery` 用 AbortError 解开，`#runOne` 的代际守卫 / closed / abort 判断
 * 接手。只有**存活** query 的流意外结束或抛错才算崩溃（`#onStreamBroken`）：
 * **无论哪种情况先拆 query**——读取循环一退出，这个 query 就再没人读了，留着它
 * 只会让下一条消息推进无人消费的输入流永久挂死（评审 B1：auth / 403 这类 fatal
 * 分类的错误正是本机踩过的场景）。拆完再分派：有在途用户消息 → 交给 `#runOne`
 * 分类续跑（与早先一致，重起新 query）；自发轮中断 → 报 fatal；空闲 → 静默，
 * 下次 send 以 resume 重起。
 *
 * ### 单条消息处理失败不拆流（评审 B2）
 *
 * `#handleMessage` 里翻译层 / 后台任务表遇到畸形或新形状的消息抛异常，早先会让
 * `#readLoop` 的 promise 带着未处理 rejection 退出——Bun 默认为此**退出整个
 * agent 进程**。现在读取循环把每条消息的处理包在 try/catch 里：记日志、丢掉这一
 * 帧、继续读；只有流本身坏了（`q.next()` 抛错 / done）才走 `#onStreamBroken`。
 * 各子步骤（任务表、翻译）也各自兜底，一处坏了不影响轮的记账。
 *
 * ## 自动续跑
 *
 * 瞬时错误（分类见 errors.ts）自动 `resume` 同 sessionId 续跑，
 * 且**不重发原消息**——原消息可能已执行一半，重发会 double-write。
 * 改为发一句「继续」提示，让 Claude 基于已有上下文自行接续。
 *
 * ## 回退（rewind）
 *
 * - **代码**：所有 query 都开 `enableFileCheckpointing`（SDK 默认关，本机交互式
 *   claude 默认开），CLI 在 Write / Edit 前给文件做快照，落盘在
 *   `~/.claude/file-history/<sessionId>/`，跨进程可用。`previewFiles()` / `restoreFiles()` 有活跃 query
 *   就用它；没有就临时起一个 resume 的 query（不发消息，不写转录），用完即关。
 *   Bash 改的文件不在快照范围内。
 * - **对话**：`resumeSessionAt` 只是启动参数，所以回退对话 = 拆掉当前 query，记下
 *   截断点（`#pendingRewind`），下次惰性起 query 时带上。CLI 只在新分支上真的写了
 *   消息之后才「记住」截断——只起进程不发消息就关掉，下次普通 resume 又回到长链
 *   （实测）。所以截断点要一直带着，直到这个 query 收到第一条回复帧或 result，
 *   才算生效并通知调用方清掉持久化的副本。
 * - 用户消息的转录 uuid 就是推送时打的 `SDKUserMessage.uuid`（实测一致）。它在
 *   `send()` 入队时生成并随 `user.message` 回显出去，client 回退时用它指认目标。
 */
import { randomUUID } from 'node:crypto';
import {
  query,
  type Options,
  type Query,
  type RewindFilesResult,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { BgTask, ContextUsage, PermissionMode, SessionState, WaitingFor } from '@trine/core';
import { BgTaskTracker, spontaneousDetailOf } from './bgtasks.ts';
import {
  classifyError,
  classifyResultSubtype,
  errorText,
  isAbortError,
  type FatalClassification,
} from './errors.ts';
import { Heartbeat } from './heartbeat.ts';
import { idleInput } from './idle-input.ts';
import { PermissionBridge, type PermissionVerdict } from './permission.ts';
import { InputQueue } from './queue.ts';
import type { PreparedInput, UserContent } from './attachments.ts';
import { backgroundSubagentEnd, toSingleLine } from './summarize.ts';
import {
  createTranslateState,
  permissionModeFromStatus,
  translateMessage,
  type TranslateState,
} from './translate.ts';
import type { EventBody } from './types.ts';
import { contextUsageFrom, rateLimitPatchFromEvent, type RateLimitPatch } from './usage.ts';

/** 自动续跑最大次数，超过就报 fatal（防无限重试烧额度） */
const MAX_TRANSIENT_RETRIES = 3;

/** close() 等待 drain 收尾的上限（见 close() 里的说明） */
const CLOSE_DRAIN_TIMEOUT_MS = 3_000;

/**
 * 自动续跑的退避基数：第 n 次重试等 `BASE * 2^(n-1)` 毫秒（1s / 2s / 4s）。
 *
 * 立刻重试对「上游正在抖动」这类场景毫无帮助，只会把三次机会在一秒内烧光。
 * 退避期间**心跳照发**——用户看到的是「正在恢复」而不是界面冻住。
 */
const RETRY_BACKOFF_BASE_MS = 1_000;

/** 续跑提示语。写操作场景更保守——先核实再继续，防 double-write */
const RESUME_HINT =
  '（连接中断后自动恢复）请先核实上一步操作是否已经完成，再继续未完成的工作，不要重复已完成的修改。';

/** clientMsgId ↔ 推送 uuid 映射的容量（与队列去重表同量级；rewind 要用） */
const MAX_REMEMBERED_UUIDS = 500;

/** 临时 query 读 / 还原文件快照的超时：冷启动一两秒，留足余量 */
const REWIND_FILES_TIMEOUT_MS = 30_000;

/** 每轮结束后取 context 用量的超时（控制请求，实测 ~2s） */
const CONTEXT_USAGE_TIMEOUT_MS = 15_000;

/** 子 agent task_id → 父 toolUseId 映射的容量（量小，超限淘汰最早的） */
const MAX_SUBAGENT_PARENTS = 500;

export interface ClaudeSessionOptions {
  /** 会话 id：新建时由调用方生成 UUID，resume 时用历史 id */
  sessionId: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  /** 事件出口（会话层已绑定 sessionId scope） */
  emit: (body: EventBody) => void;
  /** 是否 resume 已有会话 */
  resume?: boolean;
  /** 拉起的 claude 可执行文件（见文件头「配置对齐」）；不给 = SDK 内置 */
  pathToClaudeCodeExecutable?: string;
  now?: () => number;
  /** 心跳间隔 */
  heartbeatIntervalMs?: number;
  /** 注入 SDK query，测试用假实现替换 */
  queryFn?: typeof query;
  /** 注入延时（续跑退避用）；测试传假实现避免真睡 */
  sleep?: (ms: number) => Promise<void>;
  /** run 结束回调，供 SessionManager 做空闲回收计时 */
  onIdle?: () => void;
  /** 会话元数据变化回调（成本/状态/标题），供 SessionManager 广播 session.updated */
  onMeta?: (meta: SessionRuntimeMeta) => void;
  /** 日志出口（单条消息处理失败等非致命异常）；不给则 console.error */
  log?: (line: string) => void;
  /** 待生效的对话截断点（上次回退后还没发过消息，app 从 state.json 读出来） */
  rewindPoint?: RewindPoint;
  /** 额外可读目录（本会话的附件上传目录）：Read 这些路径不弹权限请求 */
  additionalDirectories?: string[];
  /** 截断点已生效（新分支上有了第一条回复），调用方据此清掉持久化的截断点 */
  onRewindApplied?: () => void;
  /** CLI 报来新的订阅限额用量（rate_limit_event，账号级），供 app 汇总广播 */
  onRateLimits?: (patch: RateLimitPatch) => void;
}

/**
 * 对话截断点（回退对话，见文件头「回退」）。
 * - `resumeAt`：保留链上的最后一条 uuid，起 query 时作为 `resumeSessionAt`；
 * - `dropFrom`：被撤掉的第一条用户消息 uuid，生效前读历史要从它截断。
 */
export interface RewindPoint {
  resumeAt: string;
  dropFrom: string;
}

/** 会话运行时元数据快照 */
export interface SessionRuntimeMeta {
  sessionId: string;
  state: SessionState;
  costUsd: number;
  lastActivityAt: number;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  /** state 为 waiting_permission 时最早一条挂起请求的类型；其余状态不带 */
  waitingFor?: WaitingFor;
  /** 正在运行的后台任务数（Bash run_in_background / 后台子 agent）；省略视同 0 */
  bgRunning?: number;
  /** 最近一次取到的 context 用量；本实例还没取到时不带（manager 保留缓存里的旧值） */
  context?: ContextUsage;
}

/** stopBgTask 的结果（router 转成 session.mutate.response） */
export type StopBgTaskResult =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'io'; message: string };

/** 自发轮触发说明只认这么新的结束通知（通知到 CLI 自发开轮实测 <1s） */
const SPONTANEOUS_TRIGGER_FRESH_MS = 15_000;

/** 已推送、待回应的用户消息（同一时刻至多一条） */
interface Inflight {
  /** 推送时打在 SDKUserMessage 上的 uuid，回复帧的 user_message_uuid 与之比对 */
  uuid: string;
  /** 续跑提示等内部推送没有 clientMsgId */
  clientMsgId: string | undefined;
  /** 归属于它的 result 到了（成功或已按 subtype 报 fatal） */
  resolve: () => void;
  /** 归属于它的错误型 result / 流意外结束 / query 被拆 */
  reject: (err: unknown) => void;
}

/** 当前进行中的一轮（见文件头「轮与归属」） */
interface Round {
  /** unknown = 有在途用户消息、等第一条回复帧定归属 */
  kind: 'unknown' | 'user' | 'spontaneous';
  /** 自发轮是否接管了 run 状态（见文件头「run 状态的归属」） */
  ownsRun: boolean;
}

/**
 * 一个活跃的 Claude 会话。
 *
 * 生命周期：`constructor` → 首次 `send()` 惰性起 query → 多轮 → `close()`。
 * 起进程是惰性的：新建会话但没发消息时不该占着一个子进程。
 */
export class ClaudeSession {
  readonly sessionId: string;
  #cwd: string;
  #model: string;
  #permissionMode: PermissionMode;

  readonly #emit: (body: EventBody) => void;
  readonly #now: () => number;
  readonly #queryFn: typeof query;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onIdle: (() => void) | undefined;
  readonly #onMeta: ((meta: SessionRuntimeMeta) => void) | undefined;
  readonly #log: (line: string) => void;
  readonly #claudeExecutable: string | undefined;
  readonly #additionalDirectories: string[];

  readonly #queue: InputQueue;
  readonly #heartbeat: Heartbeat;
  readonly permissions: PermissionBridge;
  /** 后台任务表（bgtask.snapshot 的来源） */
  readonly #bgTasks: BgTaskTracker;
  /** 上次经 onMeta 广播过的后台任务数，变了才重发 meta */
  #bgRunningAnnounced = 0;

  #state: SessionState = 'idle';
  /** 会话累计成本 = 基线 + 当前 query 累计（见 #closeRound 的说明） */
  #costUsd = 0;
  /** 已结束的历次 query 的成本之和 */
  #costBaselineUsd = 0;
  /** 当前 query 报上来的累计成本（该 query 内单调递增） */
  #currentQueryCostUsd = 0;
  #lastActivityAt: number;
  #closed = false;
  #resumeRequested: boolean;

  /** 当前 SDK query（未起进程时 undefined） */
  #query: Query | undefined = undefined;
  /** 流式输入的推送口 */
  #pushInput: ((message: SDKUserMessage) => void) | undefined = undefined;
  /** 关闭流式输入（让 query 迭代器收尾） */
  #endInput: (() => void) | undefined = undefined;
  /** 中止当前 run 用 */
  #abort: AbortController | undefined = undefined;
  /** 当前 query 的读取循环（close 等它退出） */
  #reading: Promise<void> | undefined = undefined;
  #translate: TranslateState;
  #transientRetries = 0;
  /** 当前 run 对应的 clientMsgId（用于失败续跑判断） */
  #currentMsgId: string | undefined = undefined;
  /** 正在跑的 drain 循环；非 undefined 即表示已有循环在消费队列 */
  #draining: Promise<void> | undefined = undefined;
  /** drain 循环正在跑（从起动到收尾块之间）——run 状态归它管 */
  #drainBusy = false;
  /** 用户已停止：drain 循环见到即收手，直到下一次 send 重置 */
  #stopped = false;
  /** drain 循环的代号，用于让被遗弃的旧循环不误清新循环的闸门 */
  #drainGeneration = 0;

  /** 已推送、待回应的用户消息 */
  #inflight: Inflight | undefined = undefined;
  /** 进行中的一轮 */
  #round: Round | undefined = undefined;
  /** 本 query 里是否见过 user_message_uuid 标记（见文件头「轮与归属」） */
  #stampsSeen = false;
  /**
   * 进入 waiting_permission 前的状态。主线程空闲时后台子 agent 也会要权限（真 claude
   * 实测），那时会话本是 idle——批准后要回到 idle，而不是没有轮、没有心跳的 running
   * （评审 M2）。
   */
  #stateBeforeWait: SessionState | undefined = undefined;
  /** clientMsgId → 推送 uuid（插入序即淘汰序） */
  readonly #userMessageUuids = new Map<string, ReturnType<typeof randomUUID>>();
  /** 待生效的对话截断点（见文件头「回退」） */
  #pendingRewind: RewindPoint | undefined;
  /** 带着截断点起的那个 query；它收到第一条回复即截断生效 */
  #rewindQuery: Query | undefined = undefined;
  readonly #onRewindApplied: (() => void) | undefined;
  readonly #onRateLimits: ((patch: RateLimitPatch) => void) | undefined;
  /** 最近一次取到的 context 用量（每轮 result 后在同一 query 上取） */
  #context: ContextUsage | undefined = undefined;
  /** 正在取 context 用量；期间又有 result 到达则记 #contextStale，取完再补一次 */
  #contextFetching = false;
  #contextStale = false;
  /**
   * 子 agent 的 task_id → 父 Agent/Task 工具的 toolUseId（task_started 时记）。
   * canUseTool 的 agentID 就是 task_id，权限卡的来源靠它查。会话生命周期内保留
   * （跨 query：resume 的子 agent 沿用同一 task_id），封顶 MAX_SUBAGENT_PARENTS。
   */
  readonly #subagentParents = new Map<string, string>();
  /**
   * 后台运行中的子 agent（task_id）：父卡的 tool.end 在「已启动」时就发了，完成时
   * 要按 task_notification 再发一帧收尾（评审 M1）。收尾后移除。
   */
  readonly #backgroundSubagents = new Set<string>();

  constructor(options: ClaudeSessionOptions) {
    this.sessionId = options.sessionId;
    this.#cwd = options.cwd;
    this.#model = options.model;
    this.#permissionMode = options.permissionMode;
    this.#emit = options.emit;
    this.#now = options.now ?? (() => Date.now());
    this.#queryFn = options.queryFn ?? query;
    this.#sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.#onIdle = options.onIdle;
    this.#onMeta = options.onMeta;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#claudeExecutable = options.pathToClaudeCodeExecutable;
    this.#additionalDirectories = options.additionalDirectories ?? [];
    this.#resumeRequested = options.resume ?? false;
    this.#pendingRewind = options.rewindPoint;
    this.#onRewindApplied = options.onRewindApplied;
    this.#onRateLimits = options.onRateLimits;
    this.#lastActivityAt = this.#now();
    this.#translate = createTranslateState(this.#now());

    this.#queue = new InputQueue({ now: this.#now });
    this.#bgTasks = new BgTaskTracker({ now: this.#now });
    this.#heartbeat = new Heartbeat({
      emit: this.#emit,
      now: this.#now,
      ...(options.heartbeatIntervalMs === undefined
        ? {}
        : { intervalMs: options.heartbeatIntervalMs }),
    });
    this.permissions = new PermissionBridge({
      emit: this.#emit,
      now: this.#now,
      onPending: () => {
        this.#translate.permissionCount += 1;
        this.#heartbeat.setPhase('wait');
        if (this.#state !== 'waiting_permission') this.#stateBeforeWait = this.#state;
        this.#setState('waiting_permission');
      },
      onDrained: () => {
        if (this.#state === 'waiting_permission') this.#leaveWaiting();
      },
      // 多条挂起中先答了最早那条：状态不变，但 waitingFor 可能换了（提问 →
      // 普通权限），要重发一次 meta。新请求追加在后面不改变「最早一条」，不必发
      onPendingChanged: () => {
        if (this.#state === 'waiting_permission') this.#onMeta?.(this.meta());
      },
      parentToolUseIdOf: (agentId) => this.#subagentParents.get(agentId),
      parentToolUseIdOfToolUse: (toolUseId) => this.#translate.pendingTools.get(toolUseId)?.parentToolUseId,
    });
  }

  get state(): SessionState {
    return this.#state;
  }

  get costUsd(): number {
    return this.#costUsd;
  }

  get lastActivityAt(): number {
    return this.#lastActivityAt;
  }

  get queueLength(): number {
    return this.#queue.length;
  }

  /** 是否有活跃子进程（空闲回收判断用） */
  get hasProcess(): boolean {
    return this.#query !== undefined;
  }

  get permissionMode(): PermissionMode {
    return this.#permissionMode;
  }

  /** 正在运行的后台任务数（空闲回收不得回收有后台任务在跑的会话——回收会杀掉子进程） */
  get bgRunningCount(): number {
    return this.#bgTasks.runningCount;
  }

  /** 当前后台任务快照（重连补发等场景可按需取） */
  bgTasks(): BgTask[] {
    return this.#bgTasks.snapshot();
  }

  /** 某条用户消息推送时用的 uuid（rewind 用）；没推过 / 已淘汰返回 undefined */
  userMessageUuid(clientMsgId: string): string | undefined {
    return this.#userMessageUuids.get(clientMsgId);
  }

  /** userMessageUuid 的反查（回退广播要带上 clientMsgId，让实时条目也能对上） */
  clientMsgIdOf(uuid: string): string | undefined {
    for (const [clientMsgId, known] of this.#userMessageUuids) if (known === uuid) return clientMsgId;
    return undefined;
  }

  /** 待生效的对话截断点（见文件头「回退」） */
  get pendingRewind(): RewindPoint | undefined {
    return this.#pendingRewind;
  }

  /**
   * 不能回退的原因；undefined = 可以。运行中 / 等批准 / 有排队消息都会被回退打断，
   * 后台任务会随拆进程死掉，所以都拒绝。
   */
  rewindBlocker(): string | undefined {
    if (this.#state === 'running' || this.#state === 'waiting_permission' || this.#drainBusy || this.#round !== undefined) {
      return '会话正在运行，请等它跑完或先停止';
    }
    if (this.#queue.length > 0) return '会话有排队中的消息，请先撤回或等它们跑完';
    if (this.#bgTasks.runningCount > 0) return '会话有后台任务在运行，回退会终止它们；请先停止后台任务';
    return undefined;
  }

  /**
   * 统计把文件还原到某条用户消息发出之前会改动什么（不改文件）。有活跃 query 就用它；
   * 没有就临时起一个 resume 的 query（不发消息），用完即关（见文件头「回退」）。
   * 调用方负责先确认会话空闲、目标消息在转录里。
   */
  previewFiles(userMessageUuid: string): Promise<RewindFilesResult> {
    return this.#withQuery((q) => q.rewindFiles(userMessageUuid, { dryRun: true }), '读取文件快照超时', REWIND_FILES_TIMEOUT_MS);
  }

  /**
   * 把文件还原到某条用户消息发出之前。SDK 真正还原时不回改动统计（只有 dryRun 才给，
   * 实测），所以在同一个 query 上先 dryRun 取统计、再还原，结果合并两者。
   */
  restoreFiles(userMessageUuid: string): Promise<RewindFilesResult> {
    return this.#withQuery(async (q) => {
      const preview = await q.rewindFiles(userMessageUuid, { dryRun: true });
      if (!preview.canRewind) return preview;
      const result = await q.rewindFiles(userMessageUuid);
      if (!result.canRewind) return result;
      return {
        ...result,
        filesChanged: result.filesChanged ?? preview.filesChanged ?? [],
        insertions: result.insertions ?? preview.insertions ?? 0,
        deletions: result.deletions ?? preview.deletions ?? 0,
      };
    }, '读取文件快照超时', REWIND_FILES_TIMEOUT_MS);
  }

  /**
   * 手动刷新 context 用量（协议 session.context.request）：有活跃 query 就直接查；没有
   * 就临时起一个 resume 本会话、不发消息的 query 查完即关（实测约 2 秒，不写转录）。
   * 有待生效的对话截断点时从截断点 resume，查的是回退后的上下文。取到即更新 meta。
   *
   * @throws 会话还没开始过（没有转录可 resume）、超时、应答形状不认识
   */
  async refreshContextNow(): Promise<ContextUsage> {
    if (this.#query === undefined && !this.#resumeRequested) {
      throw new Error('会话还没有开始，没有可统计的上下文');
    }
    const rewind = this.#pendingRewind;
    const response = await this.#withQuery(
      (q) => q.getContextUsage(),
      '读取 context 用量超时',
      CONTEXT_USAGE_TIMEOUT_MS,
      rewind === undefined ? {} : { resumeSessionAt: rewind.resumeAt },
    );
    const context = contextUsageFrom(response, this.#now());
    if (context === undefined) throw new Error('context 用量的格式不认识（Claude Code 版本变化？）');
    if (!this.#closed) {
      this.#context = context;
      this.#onMeta?.(this.meta());
    }
    return context;
  }

  /**
   * 在活跃 query 上跑控制请求；没有就起一个 resume 本会话的临时 query（不发消息、
   * 带超时、用完即关）。读文件快照与手动刷新 context 共用。
   */
  async #withQuery<T>(
    fn: (q: Query) => Promise<T>,
    timeoutMessage: string,
    timeoutMs: number,
    extraOptions: Partial<Options> = {},
  ): Promise<T> {
    this.#touch();
    const live = this.#query;
    if (live !== undefined) return fn(live);
    const abort = new AbortController();
    const q = this.#queryFn({
      prompt: idleInput(abort.signal),
      options: { ...this.#baseOptions(), resume: this.sessionId, abortController: abort, ...extraOptions },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(q),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      abort.abort();
      try {
        q.close();
      } catch {
        // 进程随 abort 收走
      }
    }
  }

  /**
   * 回退对话：拆掉当前 query，记下截断点，下次起 query 时从截断点接上（见文件头
   * 「回退」）。调用方负责先确认会话空闲（rewindBlocker）并持久化截断点。
   */
  rewindConversation(point: RewindPoint): void {
    this.#touch();
    if (this.#query !== undefined) this.#teardownQuery();
    this.#pendingRewind = point;
    this.#resumeRequested = true;
  }

  meta(): SessionRuntimeMeta {
    const waitingFor = this.#state === 'waiting_permission' ? this.permissions.waitingFor : undefined;
    return {
      sessionId: this.sessionId,
      state: this.#state,
      costUsd: this.#costUsd,
      lastActivityAt: this.#lastActivityAt,
      cwd: this.#cwd,
      model: this.#model,
      permissionMode: this.#permissionMode,
      ...(waitingFor === undefined ? {} : { waitingFor }),
      bgRunning: this.#bgTasks.runningCount,
      ...(this.#context === undefined ? {} : { context: this.#context }),
    };
  }

  /**
   * 在活跃 query 上查订阅限额用量（SDK 的实验性 /usage 接口，返回原始应答，由调用方
   * 解析）。没有活跃子进程 / SDK 没这个方法 → undefined，调用方另想办法。
   */
  planUsage(): Promise<unknown> | undefined {
    const q = this.#query;
    if (q === undefined || typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') return undefined;
    return q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
  }

  /**
   * 停止一个后台任务（协议 `bgtask.stop`）：交给 SDK `Query.stopTask`，结果由随后
   * CLI 发的 task_updated(killed) / task_notification(stopped) 经快照体现。
   * 没有活跃子进程、或表里记着它已结束 → not_found；SDK 抛错 → io。
   * 表里不认识的 taskId 照样交给 SDK（表可能漏收），由它决定。
   */
  async stopBgTask(taskId: string): Promise<StopBgTaskResult> {
    this.#touch();
    const q = this.#query;
    if (q === undefined) return { ok: false, code: 'not_found', message: '会话没有活跃的 claude 进程，后台任务已随之结束' };
    const known = this.#bgTasks.snapshot().find((t) => t.taskId === taskId);
    if (known !== undefined && known.status !== 'running') {
      return { ok: false, code: 'not_found', message: `后台任务已结束（${known.status}）` };
    }
    try {
      await q.stopTask(taskId);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: 'io', message: toSingleLine(`停止后台任务失败：${errorText(err)}`, 300) };
    }
  }

  /**
   * 收到 `input.send`：去重 → 入队 → 回执 → 空闲则立即开跑。
   *
   * @returns 是否是重复消息（调用方无需区分处理，回执逻辑已在内部完成）
   */
  send(clientMsgId: string, text: string, prepared?: PreparedInput): { duplicate: boolean; uuid?: string } {
    this.#touch();
    // 新消息即解除停止态：用户又开口了，说明要继续用这个会话。
    // error 态同理——下一条消息就是重试意图。
    this.#stopped = false;
    const result = this.#queue.enqueue(clientMsgId, text, prepared?.content);

    if (result.duplicate) {
      // 重复投递多半是发起端没收到回执，所以仍回一次（见 queue.ts 文件头）
      this.#emit({ type: 'input.queued', clientMsgId });
      return { duplicate: true };
    }

    // 转录 uuid 入队时就定下来（推送时沿用），随回显发出去供回退指认
    const uuid = randomUUID();
    this.#rememberUuid(clientMsgId, uuid);
    // 回显给所有客户端设备（协议 §1.1 user.message）
    this.#emit({
      type: 'user.message',
      messageId: clientMsgId,
      clientMsgId,
      text,
      ...(prepared === undefined || prepared.attachments.length === 0 ? {} : { attachments: prepared.attachments }),
      uuid,
    });

    if (result.shouldRunNow && this.#draining === undefined) {
      // #draining 是并发闸门：`shouldRunNow` 只反映「队列层认为空闲」，而
      // setRunning(true) 发生在 #runOne 里（异步），同步连发两条时两次 send
      // 都会看到 running=false。没有这道闸门就会起两个 drain 循环并发消费
      // 同一队列——同一轮往 SDK 推两条消息、run.done 计数错乱。
      // 自发轮进行中 queue.running 已为 true，shouldRunNow 为 false → 走排队分支。
      this.#startDrain();
    } else {
      // 运行中 → 排队回执
      this.#emit({ type: 'input.queued', clientMsgId });
    }
    return { duplicate: false, uuid };
  }

  /** 撤回排队中的消息（协议 `input.recall`） */
  recall(clientMsgId: string): boolean {
    this.#touch();
    return this.#queue.recall(clientMsgId);
  }

  /** 应答一次权限请求 */
  respondPermission(verdict: PermissionVerdict): boolean {
    this.#touch();
    return this.permissions.respond(verdict);
  }

  /**
   * 停止当前任务（协议 `run.stop`）：已产出内容保留。
   *
   * 用 SDK 的 `interrupt()`（等价交互式 Esc），而不是杀进程——
   * 杀进程会丢掉会话状态，interrupt 则让 Claude 干净地结束当前 turn。
   * 自发轮同样被它中断（它就是当前 turn）。
   */
  async stop(): Promise<void> {
    this.#touch();
    // 「停止」= 停住这次运行**以及**它后面排着的：只停当前 turn 而让队列继续跑，
    // 等于用户按了停止却看着任务一条条接着执行。被丢弃的排队消息发 invalidated
    // 语义的回执由上层决定，这里先保证不再执行。
    // NOTE(协议缺口)：被丢弃的排队消息目前没有对应的回执帧——协议里
    // `input.queued` 有、「排队消息被取消」没有。client 侧可由 run.state:stopped
    // 推断（停止后队列必然清空），但显式回执更好。待协议补 `input.dropped`
    // 之类的帧后在这里补发。
    this.#stopped = true;
    this.#queue.clear();
    // pending 权限请求先作废，否则 interrupt 后它们还挂着，query 迭代器不结束
    this.permissions.invalidateAll('用户停止了当前任务');
    try {
      await this.#query?.interrupt();
    } catch (err) {
      // interrupt 失败不致命（可能 run 已经自己结束了），记一条痕迹即可
      this.#emit({
        type: 'error.transient',
        attempt: 1,
        reason: toSingleLine(`中断请求失败：${errorText(err)}`),
      });
    }
    this.#heartbeat.stop();
    this.#queue.setRunning(false);
    this.#setState('stopped');

    // —— 关键不变量：一个 query 上永远只有一个读取循环 ——
    //
    // interrupt() 不保证让挂起的 next() 返回。若只放开闸门而留着 #query，
    // 被中断那轮的读取循环仍挂在迭代器上，与 stop 之前的旧语义一样存在
    // 「一个迭代器多个消费者争抢帧」的隐患（实测 5 轮 send+stop 后迭代器上累积
    // 6 个 waiter）。所以 stop 走与 #teardownQuery 一致的路径把 query 整个拆掉：
    // abort 让读取循环退出（它核对 #query 已换、静默走人），#query 置空。
    // 下一条消息由 #pumpOnce 惰性重起，并以 resume 续上同一 sessionId 的上下文。
    // 代价是 stop 后下一条消息要冷启动一次子进程，换来的是可推理的不变量。
    // 附带好处：SDK 侧 still_queued 的 turn 随进程一起消失，不会在背后继续跑。
    //
    // TODO(优化)：SDK 的 interrupt 支持 `cancel_queued: true`
    // （能力位 `interrupt_cancel_queued_v1`，在 system/init 的 capabilities 里
    // 特性检测），一次往返即可精确清掉排队中的 turn 并在响应的 `cancelled`
    // 字段列出——SDK 文档明确点名这就是「远程 UI 的 Stop 按钮」该走的路径。
    // 用它可以免掉这里整个拆 query 的冷启动代价。等做能力检测时切过去；
    // 在那之前用拆 query 这个不依赖能力位、老 CLI 上同样成立的保守做法。
    this.#drainGeneration += 1;
    this.#draining = undefined;
    this.#drainBusy = false;
    this.#teardownQuery();
    // 重起时按 resume 走，接上已有会话上下文
    this.#resumeRequested = true;
    // interrupt 的 await 期间若有新消息到达（用户点了停止紧接着输入），send()
    // 看到 queue.running=true 只给了排队回执；此刻 run 状态已清、query 已拆，
    // 没有任何循环会去取它——这里补起一个 drain。被丢弃的旧循环即便还在，
    // 也会因代际不符（且 #draining 已被新循环占住）而不碰状态。
    if (!this.#stopped && !this.#closed && this.#queue.length > 0 && this.#draining === undefined) {
      this.#startDrain();
    }
  }

  /** 运行中改权限模式（SDK 支持运行时改，无需重启会话） */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.#touch();
    // 先让 SDK 接受再落本地：被拒时本地状态不能跟着变，否则 meta 与实际不符
    await this.#query?.setPermissionMode(mode);
    this.#permissionMode = mode;
    this.#onMeta?.(this.meta());
  }

  /** 运行中改模型 */
  async setModel(model: string): Promise<void> {
    this.#model = model;
    this.#touch();
    await this.#query?.setModel(model);
    this.#onMeta?.(this.meta());
  }

  /**
   * 关闭会话：停心跳、作废权限、关子进程。
   * 幂等——重复调用安全。
   *
   * @param drainTimeoutMs 等 drain 循环收尾的上限；进程退出路径会传一个更短
   *   的值（整机退出有总预算，不能让一个会话独占）。
   */
  async close(
    reason = '会话已关闭',
    drainTimeoutMs = CLOSE_DRAIN_TIMEOUT_MS,
  ): Promise<void> {
    if (this.#closed) return;
    // 关子进程 = 杀掉在跑的后台任务：先把快照发出去，client 不会永远看到「运行中」
    this.#syncBgTasks(this.#bgTasks.markAllStopped());
    this.#closed = true;
    this.#heartbeat.stop();
    this.permissions.invalidateAll(reason);
    this.#queue.clear();
    this.#round = undefined;
    this.#endInput?.();
    this.#abort?.abort();
    // 在途用户消息：解开 #runOne 的等待（它见到 #closed 即退出）
    this.#abandonInflight(tornDownError());
    try {
      this.#query?.close();
    } catch {
      // 关闭失败无所谓，进程随后会被 abort 收走
    }
    try {
      // 等在跑的 drain 循环与读取循环收尾，避免它们在 close 之后还碰已拆掉的 query。
      //
      // 加超时兜底：SDK 文档只承诺 close() 之后「不再收到消息」，**没承诺**
      // 挂起中的 next() 会 resolve 或 reject。真实实现大概率靠 abortController
      // 解开，但这是未文档化的行为——赌它会返回就可能让 close() 永久挂住，
      // 进而卡住整个 agent 的退出流程。
      await Promise.race([Promise.all([this.#draining, this.#reading]), Bun.sleep(drainTimeoutMs)]);
    } catch {
      // drain 内部已处理错误
    }
    this.#query = undefined;
    this.#pushInput = undefined;
    this.#reading = undefined;
  }

  // -------------------------------------------------------------------------
  // 内部：drain 循环（用户消息队列）
  // -------------------------------------------------------------------------

  /** 起一个新代的 drain 循环（send 空闲时 / 自发轮收尾发现队列非空时） */
  #startDrain(): void {
    // generation 让每个循环只能清掉**自己那一代**的闸门：stop() 会丢弃当前代，
    // 被遗弃的旧循环事后收尾时不能把新循环的闸门一起抹掉。
    const generation = ++this.#drainGeneration;
    this.#draining = this.#drain(generation).finally(() => {
      if (this.#drainGeneration === generation) this.#draining = undefined;
    });
  }

  /** 把队列跑干：一条跑完接着下一条 */
  async #drain(generation: number): Promise<void> {
    this.#drainBusy = true;
    // #stopped / #closed 都是「别再跑下一条」的信号；
    // 前者由用户 stop() 置位，后者由 close() 置位
    while (!this.#closed && !this.#stopped) {
      const next = this.#queue.takeNext();
      if (next === undefined) break;
      // 每条重新置位：stop() 会把它清掉，而被 stop 遗弃的旧循环可能接着跑
      // 同宏任务内新来的消息（见下面的代际守卫），跑着时 run 状态仍归它
      this.#drainBusy = true;
      this.#currentMsgId = next.clientMsgId;
      await this.#runOne(next.content ?? next.text, next.clientMsgId, generation);
    }

    // —— 代际守卫：只有「当代」循环才有资格收尾 ——
    //
    // stop() 的 abort 会同步 reject 孤儿的等待，但孤儿这一段收尾代码要到后续
    // 微任务才跑。若 send() 在同一宏任务内到达（WS 场景很常见：用户点了停止
    // 紧接着输入，两帧同批送达），新 drain 已经起来了，孤儿的收尾段随后就会把
    // setRunning(false) / setState('idle') / onIdle() 踩到**新 run** 头上——
    // 新 query 于是无人消费，那条消息卡住（再发一条可恢复，非永久）。
    // 代号对不上且**确有**新循环在跑（#draining 非空）就直接走人，什么都不碰。
    //
    // 反过来，代号对不上但没有新循环（stop() 丢弃了本代、之后没人再起）时，
    // 孤儿可能刚替同宏任务里到达的消息跑完了一轮（那条消息在 stop 的 await
    // 期间入队，队列层看到 running=true 只给了排队回执，只有孤儿会去取它）。
    // 这时不收尾会把 running=true / 状态 running / 心跳一直留着，第三条消息
    // 永远只收到排队回执——所以没有新循环时孤儿照常收尾。
    if (this.#closed) return;
    if (this.#drainGeneration !== generation && this.#draining !== undefined) return;

    this.#drainBusy = false;
    this.#currentMsgId = undefined;
    // 自发轮正在进行（在 drain 跑着时开始的）：run 状态交给它，由它的 result 收尾。
    // 这里若照常回 idle，用户会看到「空闲」的同时 Claude 还在吐字。
    if (this.#round?.kind === 'spontaneous') {
      this.#round.ownsRun = true;
      return;
    }
    this.#queue.setRunning(false);
    this.#heartbeat.stop();
    // error/stopped 是终态，不该被 drain 收尾覆盖成 idle
    if (this.#state !== 'error' && this.#state !== 'stopped') {
      this.#setState('idle');
    }
    this.#onIdle?.();
  }

  /** 跑一条消息，含瞬时错误自动续跑 */
  async #runOne(content: UserContent, clientMsgId: string, generation: number): Promise<void> {
    this.#queue.setRunning(true);
    this.#setState('running');
    this.#heartbeat.start();
    this.#translate.toolCount = 0;
    this.#translate.permissionCount = 0;
    this.#translate.runStartedAt = this.#now();
    this.#translate.slashCommand = slashCommandOf(content);
    this.#transientRetries = 0;

    let prompt: UserContent = content;
    let msgId: string | undefined = clientMsgId;
    for (;;) {
      try {
        await this.#pumpOnce(prompt, msgId);
        this.#transientRetries = 0;
        return;
      } catch (err) {
        // 代际守卫放在最前：#stopped 与 #abort 都是**会被后来者改写的共享状态**
        // ——stop() 后同宏任务的 send() 已经把 #stopped 复位、并让 #abort 指向
        // 新 run 的 controller，此时孤儿再去读这两个值只会得到「没停过、也不是
        // 我 abort 的」，于是把这次 abort 当成瞬时错误走进续跑分支，抢走新 run
        // 的 turn。代号是唯一不会被改写的判据。
        if (this.#drainGeneration !== generation) return;
        // 传入本端 signal：只有我们自己确实 abort 过才算主动中止，
        // 不靠猜上游错误文案（否则会静默吞掉瞬时错误）
        if (this.#closed || this.#stopped || isAbortError(err, this.#abort?.signal)) {
          return;
        }

        const classified = classifyError(err);
        if (!classified.retryable) {
          this.#reportFatal(classified);
          return;
        }

        this.#transientRetries += 1;
        if (this.#transientRetries > MAX_TRANSIENT_RETRIES) {
          this.#reportFatal({
            retryable: false,
            kind: 'other',
            message: `连续 ${MAX_TRANSIENT_RETRIES} 次自动恢复均失败：${classified.reason}`,
          });
          return;
        }

        this.#emit({
          type: 'error.transient',
          attempt: this.#transientRetries,
          reason: toSingleLine(classified.reason, 200),
        });
        // 关键：不重发原消息，改发续跑提示（见文件头「自动续跑」）
        prompt = RESUME_HINT;
        msgId = undefined;
        this.#resumeRequested = true;
        this.#teardownQuery();
        // 指数退避：1s / 2s / 4s。心跳在退避期间继续跑，
        // 用户看到的是「正在恢复」而不是界面冻住
        await this.#sleep(
          RETRY_BACKOFF_BASE_MS * 2 ** (this.#transientRetries - 1),
        );
        if (this.#closed || this.#stopped) return;
      }
    }
  }

  /**
   * 起（或复用）query，推入一条用户消息，等**归属于它那一轮**的 result。
   *
   * 流式输入模式下 query 是长驻的：第一次调用起进程（并起读取循环），后续
   * 复用同一个 query，只是往输入流里 push 新消息。读流的事归读取循环，这里
   * 只等 `#inflight` 被解开：result 归它 → resolve；错误型 result / 流意外结束 /
   * query 被拆 → reject，交给 #runOne 分类。
   */
  async #pumpOnce(content: UserContent, clientMsgId: string | undefined): Promise<void> {
    if (this.#query === undefined) {
      this.#startQuery();
    }
    const push = this.#pushInput;
    if (push === undefined) throw new Error('输入流未就绪');

    // 用户消息沿用 send() 时定下的 uuid；续跑提示等内部推送现生成
    const known = clientMsgId === undefined ? undefined : this.#userMessageUuids.get(clientMsgId);
    const uuid = known ?? randomUUID();
    if (clientMsgId !== undefined && known === undefined) this.#rememberUuid(clientMsgId, uuid);
    // 先登记在途、再推送：读取循环处理本轮第一帧时必须已经能看到它
    const settled = new Promise<void>((resolve, reject) => {
      this.#inflight = { uuid, clientMsgId, resolve, reject };
    });
    push({
      type: 'user',
      uuid,
      message: { role: 'user', content },
      parent_tool_use_id: null,
      // SDK（SDKMessageOrigin 的说明）："A host wrapping keyboard input must stamp
      // {kind:'human'} explicitly — absent origin is treated as unattributed and
      // fails closed at strict isHuman() trust gates."——trine 转发的就是用户在
      // 客户端敲的键盘输入，与本机交互式 claude 的输入同属 human；续跑提示是宿主
      // 代用户发的「继续」，同样按 human 标注。
      origin: { kind: 'human' },
    });

    await settled;
  }

  #rememberUuid(clientMsgId: string, uuid: ReturnType<typeof randomUUID>): void {
    this.#userMessageUuids.set(clientMsgId, uuid);
    while (this.#userMessageUuids.size > MAX_REMEMBERED_UUIDS) {
      const oldest = this.#userMessageUuids.keys().next();
      if (oldest.done === true) break;
      this.#userMessageUuids.delete(oldest.value);
    }
  }

  // -------------------------------------------------------------------------
  // 内部：query 生命周期与读取循环
  // -------------------------------------------------------------------------

  /** 会话 query 与读文件快照的临时 query 共用的配置（对齐见文件头） */
  #baseOptions(): Options {
    return {
      // —— 硬约束：与本机交互式 claude 行为对齐（CLAUDE.md / D3）——
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      // 本机全局 claude；undefined 时不传 = SDK 内置
      ...(this.#claudeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.#claudeExecutable }),
      ...(this.#additionalDirectories.length === 0 ? {} : { additionalDirectories: this.#additionalDirectories }),
      // —— 会话参数 ——
      cwd: this.#cwd,
      model: this.#model,
      permissionMode: this.#permissionMode,
      // 只是「允许」运行中切到 bypassPermissions（对应 CLI
      // --allow-dangerously-skip-permissions），不会主动启用它；不设的话
      // setPermissionMode('bypassPermissions') 会被 CLI 拒绝
      allowDangerouslySkipPermissions: true,
      // 文件快照：回退代码的前提（见文件头「回退」）
      enableFileCheckpointing: true,
    };
  }

  /** 起 SDK query（配置对齐见文件头）并起它的读取循环 */
  #startQuery(): void {
    const abort = new AbortController();
    this.#abort = abort;

    // 流式输入：一个由外部 push 驱动的 AsyncIterable
    const stream = createPushStream<SDKUserMessage>();
    this.#pushInput = stream.push;
    this.#endInput = stream.end;

    const rewind = this.#resumeRequested ? this.#pendingRewind : undefined;
    const options: Options = {
      ...this.#baseOptions(),
      includePartialMessages: true,
      canUseTool: this.permissions.canUseTool,
      abortController: abort,
      ...(this.#resumeRequested
        ? { resume: this.sessionId }
        : { sessionId: this.sessionId }),
      // 回退对话后的第一次起进程：从截断点接上（见文件头「回退」）
      ...(rewind === undefined ? {} : { resumeSessionAt: rewind.resumeAt }),
    };

    const q = this.#queryFn({ prompt: stream.iterable, options });
    this.#query = q;
    this.#rewindQuery = rewind === undefined ? undefined : q;
    // resume 只在首次起进程时有意义，之后同一 query 长驻
    this.#resumeRequested = false;
    // 每个进程从头记：标记见没见过、有没有进行中的轮都是 per-query 的事实
    this.#stampsSeen = false;
    this.#round = undefined;
    this.#reading = this.#readLoop(q);
    // SDK 文档：「consumers must reset to the empty set whenever the session's CLI
    // process (re)starts」——这个 reset 也要传到 client：agent 崩溃 / 重启后 web
    // 落盘的快照里还是「运行中」，没有对账点就会永远走秒（评审 M2）。每次起进程
    // 都发一帧当前快照（拆进程时已把在跑的标成 stopped；新实例则为空）
    this.#emit({ type: 'bgtask.snapshot', tasks: this.#bgTasks.snapshot() });
  }

  /**
   * 长驻读取循环：query 存活期间持续消费消息流（见文件头「读取模型」）。
   *
   * 每次 `await q.next()` 之后先核对 `this.#query === q`——query 已被拆就静默退出，
   * 绝不碰状态：拆 query 的一方（stop / close / 续跑）已经把在途消息解开、
   * 状态迁好。只有存活 query 的流结束 / 抛错才算崩溃（`#onStreamBroken`）。
   */
  async #readLoop(q: Query): Promise<void> {
    for (;;) {
      let next: IteratorResult<SDKMessage, void>;
      try {
        next = await q.next();
      } catch (err) {
        if (this.#query !== q || this.#closed) return;
        this.#onStreamBroken(err);
        return;
      }
      if (this.#query !== q || this.#closed) return;
      if (next.done === true) {
        // 迭代器结束却没被我们拆：子进程崩了 / 被 OOM kill / 意外退出。
        // 早先这里直接 return，于是 #runOne 认为「成功」、#drain 把状态设成 idle——
        // 零 run.done、零 error.*，用户眼里任务凭空消失。交给分类/续跑路径，
        // 这恰恰是最该自动 resume 的场景。
        this.#onStreamBroken(new Error('claude 进程意外结束（未产出本轮 result）'));
        return;
      }
      try {
        this.#handleMessage(next.value);
      } catch (err) {
        // 单条消息处理失败：丢这一帧、继续读（见文件头「单条消息处理失败不拆流」）。
        // 抛到这里说明连轮的记账都没走完（各子步骤自己兜底的异常不会到这）
        this.#log(
          `[session ${this.sessionId}] 处理 SDK 消息失败，已跳过该帧（type=${next.value.type}）：${errorText(err)}`,
        );
      }
    }
  }

  /**
   * 存活 query 的流意外结束 / 抛错。**先拆 query**（不变量：读取循环退出 ⇒
   * `#query === undefined`），再分派：
   *
   * - 有在途用户消息：以原始错误 reject 它，#runOne 按错误分类续跑（重起新 query）；
   *   可重试与否都不会再有死 query 留在 #query 上让下一条消息挂死；
   * - 自发轮进行中：没有可重推的消息，报 fatal（下次 send 以 resume 恢复）；
   * - 空闲：静默，下次 send 以 resume 重起——用户什么都没在等，不必惊动。
   */
  #onStreamBroken(err: unknown): void {
    const inflight = this.#inflight;
    const round = this.#round;
    // 先摘下在途消息再拆：#teardownQuery 会用 AbortError 解开它，而这里要让
    // #runOne 看到的是真实错误（走分类），不是「主动中止」
    this.#inflight = undefined;
    this.#teardownQuery();
    this.#resumeRequested = true;
    if (inflight !== undefined) {
      inflight.reject(err);
      return;
    }
    if (round?.kind === 'spontaneous') {
      this.#reportFatal({
        retryable: false,
        kind: 'other',
        message: `后台任务触发的运行意外中断：${errorText(err)}`,
      });
      if (round.ownsRun) this.#settleSpontaneous();
    }
  }

  /**
   * 读取循环拿到一条 SDK 消息：后台任务表 → 轮的开合与归属 → 翻译发帧 → 副作用 →
   * result 收轮。任务表与翻译各自兜底（畸形消息只影响自己那一步），轮的记账照走。
   */
  #handleMessage(message: SDKMessage): void {
    // 后台任务表先更新：task_notification 先于自发轮的 init 到达，开轮时要能读到它
    try {
      this.#syncBgTasks(this.#bgTasks.observe(message));
    } catch (err) {
      this.#log(`[session ${this.sessionId}] 后台任务表处理失败，已忽略该帧：${errorText(err)}`);
    }
    this.#noteSubagent(message);
    if (this.#round === undefined && opensRound(message)) this.#openRound();
    if (this.#round?.kind === 'unknown' && isReplyFrame(message)) this.#attributeRound(message);
    if (userMessageUuidOf(message) !== undefined) this.#stampsSeen = true;
    if (this.#rewindQuery !== undefined && (isReplyFrame(message) || message.type === 'result')) this.#rewindApplied();

    let bodies: EventBody[] = [];
    try {
      bodies = translateMessage(message, {
        now: this.#now(),
        state: this.#translate,
      });
    } catch (err) {
      this.#log(`[session ${this.sessionId}] 翻译 SDK 消息失败，已跳过该帧（type=${message.type}）：${errorText(err)}`);
    }
    for (const body of bodies) {
      this.#applyHeartbeatSideEffects(body);
      this.#emit(body);
    }
    this.#syncCliPermissionMode(message);
    this.#noteRateLimits(message);
    this.#touch();

    if (message.type === 'result') {
      this.#closeRound(message);
      this.#refreshContext();
    }
  }

  /** rate_limit_event → 交给 app 汇总（账号级，不进会话 meta） */
  #noteRateLimits(message: SDKMessage): void {
    if (message.type !== 'rate_limit_event' || this.#onRateLimits === undefined) return;
    const patch = rateLimitPatchFromEvent(message.rate_limit_info);
    if (patch === undefined) return;
    try {
      this.#onRateLimits(patch);
    } catch (err) {
      this.#log(`[session ${this.sessionId}] 处理限额用量失败：${errorText(err)}`);
    }
  }

  /**
   * 一轮结束：在当前 query 上取 context 用量，变了就重发 meta。异步、不阻塞下一轮；
   * 取不到（假 SDK 没这个方法 / 超时 / 形状不认识）就保留旧值，不影响会话。
   */
  #refreshContext(): void {
    if (this.#contextFetching) {
      this.#contextStale = true;
      return;
    }
    const q = this.#query;
    // 测试里的假 query 可能没有这个方法
    if (q === undefined || typeof q.getContextUsage !== 'function') return;
    this.#contextFetching = true;
    this.#contextStale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('超时')), CONTEXT_USAGE_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    void Promise.race([q.getContextUsage(), timeout])
      .then((response) => {
        if (this.#closed) return;
        const context = contextUsageFrom(response, this.#now());
        if (context === undefined) return;
        const previous = this.#context;
        this.#context = context;
        if (previous === undefined || previous.usedTokens !== context.usedTokens || previous.maxTokens !== context.maxTokens) {
          this.#onMeta?.(this.meta());
        }
      })
      .catch((err: unknown) => {
        if (!this.#closed) this.#log(`[session ${this.sessionId}] 取 context 用量失败：${errorText(err)}`);
      })
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer);
        this.#contextFetching = false;
        if (this.#contextStale && !this.#closed) this.#refreshContext();
      });
  }

  /**
   * 挂起的权限全部了结：回到等待之前的状态。有轮在跑（drain 在跑 / 进行中的一轮）
   * 就是 running；否则恢复进入等待前的状态（idle / stopped / error），不凭空造一个
   * 无人收尾的 running（评审 M2）。
   */
  #leaveWaiting(): void {
    const before = this.#stateBeforeWait;
    this.#stateBeforeWait = undefined;
    const busy = this.#drainBusy || this.#round !== undefined;
    if (!busy && (before === 'idle' || before === 'stopped' || before === 'error')) {
      this.#setState(before);
      return;
    }
    this.#heartbeat.setPhase('run');
    this.#setState('running');
  }

  /**
   * task_started（子 agent 的，task_type local_agent）→ 记 task_id → 父 toolUseId。
   * 别的任务类型（后台 Bash 等）的 task_id 不会作为 canUseTool 的 agentID 出现，不记。
   */
  #noteSubagent(message: SDKMessage): void {
    if (message.type !== 'system') return;
    if (message.subtype === 'task_updated') {
      // 前台子 agent 被转到后台（Ctrl+B / backgroundTasks）
      const patch: unknown = message.patch;
      if (typeof message.task_id === 'string' && this.#subagentParents.has(message.task_id) && typeof patch === 'object' && patch !== null && (patch as { is_backgrounded?: unknown }).is_backgrounded === true) {
        this.#backgroundSubagents.add(message.task_id);
      }
      return;
    }
    if (message.subtype === 'task_notification') {
      this.#finishBackgroundSubagent(message);
      return;
    }
    if (message.subtype !== 'task_started') return;
    const taskId: unknown = message.task_id;
    const toolUseId: unknown = message.tool_use_id;
    const taskType: unknown = message.task_type;
    if (typeof taskId !== 'string' || taskId === '' || typeof toolUseId !== 'string' || toolUseId === '') return;
    if (taskType !== undefined && taskType !== 'local_agent') return;
    this.#subagentParents.delete(taskId);
    this.#subagentParents.set(taskId, toolUseId);
    if (message.is_backgrounded === true) this.#backgroundSubagents.add(taskId);
    while (this.#subagentParents.size > MAX_SUBAGENT_PARENTS) {
      const oldest = this.#subagentParents.keys().next();
      if (oldest.done === true) break;
      this.#subagentParents.delete(oldest.value);
      this.#backgroundSubagents.delete(oldest.value);
    }
  }

  /** 后台子 agent 结束：父卡原地收尾——再发一帧同 toolUseId 的 tool.end（评审 M1） */
  #finishBackgroundSubagent(message: Extract<SDKMessage, { type: 'system'; subtype: 'task_notification' }>): void {
    const taskId: unknown = message.task_id;
    if (typeof taskId !== 'string' || !this.#backgroundSubagents.has(taskId)) return;
    this.#backgroundSubagents.delete(taskId);
    const fromMessage: unknown = message.tool_use_id;
    const toolUseId = typeof fromMessage === 'string' && fromMessage !== '' ? fromMessage : this.#subagentParents.get(taskId);
    if (toolUseId === undefined) return;
    const end = backgroundSubagentEnd(message.status, (message as { usage?: unknown }).usage, message.summary);
    this.#emit({ type: 'tool.end', toolUseId, ...end });
  }

  /** 一轮开始：有在途用户消息 → 待定；没有 → 自发轮 */
  #openRound(): void {
    // 每轮的统计从零起：自发轮与用户轮各自出一张完成卡，数字不能串
    this.#translate.toolCount = 0;
    this.#translate.permissionCount = 0;
    this.#translate.runStartedAt = this.#now();
    if (this.#inflight === undefined) {
      this.#round = { kind: 'spontaneous', ownsRun: false };
      this.#beginSpontaneous();
    } else {
      this.#round = { kind: 'unknown', ownsRun: false };
    }
  }

  /** 待定轮见到第一条回复帧：按 user_message_uuid 定归属（规则见文件头） */
  #attributeRound(message: SDKMessage): void {
    const round = this.#round;
    const inflight = this.#inflight;
    if (round === undefined || inflight === undefined) return;
    const stamp = userMessageUuidOf(message);
    let kind: Round['kind'];
    if (stamp !== undefined) {
      kind = stamp === inflight.uuid ? 'user' : 'spontaneous';
    } else {
      kind = this.#stampsSeen ? 'spontaneous' : 'user';
    }
    round.kind = kind;
    if (kind === 'spontaneous') this.#beginSpontaneous();
  }

  /**
   * 自发轮开始。drain 没在跑 → 接管 run 状态（迁 running、起心跳）；
   * drain 在跑 → 只发一条带 detail 的 run.state 标记轮边界，状态归 drain 管。
   */
  #beginSpontaneous(round: Round | undefined = this.#round): void {
    if (round === undefined) return;
    const detail = this.#spontaneousDetail();
    if (!this.#drainBusy) {
      round.ownsRun = true;
      this.#queue.setRunning(true);
      this.#heartbeat.start();
    }
    // 状态已是 running 时也发一帧（带 detail）：client 靠它标出自发轮的边界
    this.#setState('running', detail);
  }

  /**
   * 自发轮的触发说明（`run.state.detail`，client 据此在时间线上标出「⟳ 后台任务
   * “xxx”已完成，Claude 继续」）：取最近一次任务结束通知（**只在这里**取走——早先
   * 每轮 result 都清一次，通知在用户轮期间到达、CLI 在该轮 result 之后才开自发轮
   * 的常见时序下任务名就丢了，评审 m5）；太旧的不算（被 CLI 折进某一轮而没有
   * 后续自发轮的通知会自然过期）。没有来源信息就给通用说明。
   */
  #spontaneousDetail(): string {
    const n = this.#bgTasks.lastNotification(true);
    const fresh = n !== undefined && this.#now() - n.at <= SPONTANEOUS_TRIGGER_FRESH_MS ? n : undefined;
    return spontaneousDetailOf(fresh);
  }

  /** 后台任务表变了：发全量快照；在跑的数量变了再经 onMeta 广播（列表行的「后台 N」） */
  #syncBgTasks(changed: boolean): void {
    if (!changed) return;
    this.#emit({ type: 'bgtask.snapshot', tasks: this.#bgTasks.snapshot() });
    const running = this.#bgTasks.runningCount;
    if (running !== this.#bgRunningAnnounced) {
      this.#bgRunningAnnounced = running;
      this.#onMeta?.(this.meta());
    }
  }

  /**
   * result 到了：成本记账 → 定归属 → 按轮收尾。
   *
   * result 上的 `user_message_uuid` 是**权威归属键**（SDK：成功 / 错误型 result 都
   * 回显触发本轮的用户消息 uuid，自发 / 合成轮不带）。它解决两件首帧标记解决不了
   * 的事（评审 M1）：零回复帧就到 result 的轮（首帧从未出现）——早先一律归在途
   * 消息，于是自发轮的错误型 result 会让 #runOne 拆掉排着用户原文的进程、改推
   * RESUME_HINT，用户原文静默丢失；以及首帧因故没打标记被判成自发轮——result
   * 一到就纠正回用户轮，在途消息不会永久挂死。
   */
  #closeRound(message: Extract<SDKMessage, { type: 'result' }>): void {
    const round = this.#round;
    this.#round = undefined;
    if (round !== undefined) this.#reconcileRoundByResult(round, message);

    // 成本是「跨 query 基线 + 当前 query 累计」两段式：SDK 的 total_cost_usd
    // 是 **per-query() 累计**，且文档明说 resumed session 从头算
    // （"resumed sessions start fresh"）。直接赋值会让 resume 后会话成本
    // 从 $1.20 缩水成本轮的 $0.05。
    const raw = message.total_cost_usd;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      this.#currentQueryCostUsd = raw;
    }
    this.#costUsd = this.#costBaselineUsd + this.#currentQueryCostUsd;
    this.#onMeta?.(this.meta());

    const detail = message.subtype === 'success' ? undefined : message.errors.join('; ');

    if (round?.kind === 'spontaneous') {
      if (message.subtype !== 'success') {
        const reason = `后台任务触发的运行出错：${detail === '' ? message.subtype : detail}`;
        if (round.ownsRun) {
          // 自发轮独占 run：没有可重推的消息，瞬时/致命一律报 fatal（下次 send 即恢复）
          const bySubtype = classifyResultSubtype(message.subtype, detail ?? '');
          this.#reportFatal(bySubtype ?? { retryable: false, kind: 'other', message: reason });
        } else {
          // drain 在跑（用户消息在途 / 排队）：会话级 run 状态归 drain，自发轮的错误
          // 不能把会话置成 error——否则用户轮随后正常完成也回不到 idle（评审 M3）。
          // 只留一行非致命痕迹；用户轮照常。
          this.#emit({ type: 'error.transient', attempt: 1, reason: toSingleLine(reason, 200) });
        }
      }
      if (round.ownsRun) this.#settleSpontaneous();
      return;
    }

    // 用户轮（含零回复帧就到 result 的待定轮——归在途消息，不让它挂死）
    const inflight = this.#inflight;
    this.#inflight = undefined;
    if (message.subtype !== 'success') {
      // 错误型 result：先按 subtype 定性（结构化信号比猜文本可靠，且
      // max_turns/超预算/结构化重试耗尽这三类重跑必然同样失败），
      // 拿不到结论再抛给 #runOne 按文本分类
      const bySubtype = classifyResultSubtype(message.subtype, detail ?? '');
      if (bySubtype !== undefined) {
        this.#reportFatal(bySubtype);
        inflight?.resolve();
        return;
      }
      inflight?.reject(new Error(detail === '' ? `运行失败：${message.subtype}` : detail));
      return;
    }
    inflight?.resolve();
  }

  /**
   * 用 result 上的 `user_message_uuid` 定 / 纠正本轮归属（规则见 #closeRound）：
   * - 待定轮（零回复帧）：带标记按标记；不带则本 query 见过标记 → 自发轮，否则旧语义归在途；
   * - 已判自发但 result 标记 = 在途 uuid → 改判用户轮（首帧漏标的第二道保险）；
   * - 已判用户轮：不动（首帧标记与 result 冲突属对端异常，宁可归用户，不让消息挂死）。
   */
  #reconcileRoundByResult(round: Round, message: Extract<SDKMessage, { type: 'result' }>): void {
    const inflight = this.#inflight;
    const stamp = userMessageUuidOf(message);
    if (round.kind === 'unknown') {
      if (inflight === undefined) {
        round.kind = 'spontaneous';
      } else if (stamp !== undefined) {
        round.kind = stamp === inflight.uuid ? 'user' : 'spontaneous';
      } else {
        round.kind = this.#stampsSeen ? 'spontaneous' : 'user';
      }
      // 待定轮此刻才定成自发轮：补发轮边界标记（状态不动——drain 在跑）
      if (round.kind === 'spontaneous' && inflight !== undefined) this.#beginSpontaneous(round);
      return;
    }
    if (round.kind === 'spontaneous' && inflight !== undefined && stamp === inflight.uuid) {
      round.kind = 'user';
    }
  }

  /**
   * 拥有 run 状态的自发轮结束：队列里有待发消息 → 起 drain 接着跑（状态保持
   * running）；否则回 idle。stop / close 之后不起 drain。
   */
  #settleSpontaneous(): void {
    this.#queue.setRunning(false);
    this.#heartbeat.stop();
    if (!this.#closed && !this.#stopped && this.#queue.length > 0 && !this.#drainBusy) {
      this.#startDrain();
      return;
    }
    if (this.#state !== 'error' && this.#state !== 'stopped') {
      this.#setState('idle');
    }
    this.#onIdle?.();
  }

  /**
   * CLI 自己切了权限模式（system/status 带 permissionMode，解析见
   * translate.ts permissionModeFromStatus）→ 同步本地记账并经 onMeta 广播。
   *
   * 修的 bug：ExitPlanMode 批准后 CLI 已切回 default / acceptEdits，trine 记的
   * 还是 plan——web 显示错，且 state.json 里的 plan 会让下次 resume 又以 plan
   * 启动。持久化由 manager 在 onMeta 里发现模式变化后回调 app 落盘（与
   * session.setPermissionMode 写的是同一条 state.json 路径）。
   *
   * 这里**不**调 query.setPermissionMode：模式已经是 CLI 那边的事实，只是回报。
   */
  #syncCliPermissionMode(message: SDKMessage): void {
    const mode = permissionModeFromStatus(message);
    if (mode === undefined || mode === this.#permissionMode) return;
    this.#permissionMode = mode;
    this.#onMeta?.(this.meta());
  }

  /** 事件体驱动心跳的阶段/活动计时 */
  #applyHeartbeatSideEffects(body: EventBody): void {
    // 子 agent 的工具：只算「有输出」，不改心跳的 currentTool（那是主线程的 Agent 调用）
    if ((body.type === 'tool.start' || body.type === 'tool.end') && body.parentToolUseId !== undefined) {
      this.#heartbeat.noteActivity();
      return;
    }
    switch (body.type) {
      case 'tool.start':
        this.#heartbeat.noteToolStart(body.toolUseId, body.toolName);
        break;
      case 'tool.end':
        this.#heartbeat.noteToolEnd(body.toolUseId);
        break;
      case 'assistant.delta':
      case 'assistant.done':
        this.#heartbeat.noteActivity();
        break;
      default:
        break;
    }
  }

  /** 统一发 error.fatal 并把会话置为 error 终态 */
  #reportFatal(classified: FatalClassification): void {
    this.#emit({
      type: 'error.fatal',
      kind: classified.kind,
      message: toSingleLine(classified.message, 300),
      ...(classified.retryAt === undefined ? {} : { retryAt: classified.retryAt }),
    });
    this.#heartbeat.stop();
    this.#setState('error');
  }

  /** 拆掉当前 query（stop / 续跑前 / 流意外结束）；同步完成，读取循环见 #query 已换即退出 */
  #teardownQuery(): void {
    // 当前 query 的成本折进基线：新 query 的 total_cost_usd 会从 0 重新累计，
    // 不折进去的话续跑轮的花费会被 translate 的 delta 计算 clamp 成 0
    this.#costBaselineUsd += this.#currentQueryCostUsd;
    this.#currentQueryCostUsd = 0;
    this.#translate.lastCostUsd = 0;
    this.#round = undefined;
    // 子进程一拆，在跑的后台任务随之死亡
    this.#syncBgTasks(this.#bgTasks.markAllStopped());
    this.#endInput?.();
    this.#abort?.abort();
    try {
      this.#query?.close();
    } catch {
      // 忽略
    }
    this.#query = undefined;
    // 截断还没生效就拆了：#pendingRewind 留着，下次起 query 再带上
    this.#rewindQuery = undefined;
    this.#pushInput = undefined;
    this.#endInput = undefined;
    this.#abort = undefined;
    this.#reading = undefined;
    // 在途用户消息随 query 一起作废：#runOne 收到 AbortError 后按代际 / closed /
    // abort 判断退出；续跑路径调到这里时在途消息已被读取循环 reject 过，这里为空
    this.#abandonInflight(tornDownError());
  }

  #abandonInflight(err: Error): void {
    const inflight = this.#inflight;
    if (inflight === undefined) return;
    this.#inflight = undefined;
    inflight.reject(err);
  }

  /**
   * 迁移会话状态并发 run.state。状态没变时默认不发；给了 `detail`（自发轮的
   * 触发说明）则即使状态没变也发一帧——client 靠它在时间线上标出轮的边界。
   */
  #setState(state: SessionState, detail?: string): void {
    if (this.#state === state) {
      if (detail !== undefined) this.#emit({ type: 'run.state', state, detail });
      return;
    }
    this.#state = state;
    this.#emit({ type: 'run.state', state, ...(detail === undefined ? {} : { detail }) });
    this.#onMeta?.(this.meta());
  }

  #touch(): void {
    this.#lastActivityAt = this.#now();
  }

  /** 带截断点起的 query 收到了第一条回复：新分支已落盘，截断生效 */
  #rewindApplied(): void {
    this.#rewindQuery = undefined;
    if (this.#pendingRewind === undefined) return;
    this.#pendingRewind = undefined;
    try {
      this.#onRewindApplied?.();
    } catch (err) {
      this.#log(`[session ${this.sessionId}] 清理截断点失败：${errorText(err)}`);
    }
  }
}

/** 用户消息是斜杠命令（`/usage`、`/cost 7d`）时取命令名（不带 `/`）；否则 undefined */
export function slashCommandOf(content: UserContent): string | undefined {
  const text =
    typeof content === 'string'
      ? content
      : content.find((block): block is { type: 'text'; text: string } => block.type === 'text')?.text ?? '';
  const match = /^\/([\w:.-]{1,64})(?:\s|$)/.exec(text.trimStart());
  return match?.[1];
}

/** query 被拆时解开在途等待用的错误：#runOne 按 AbortError 识别为主动中止 */
function tornDownError(): Error {
  const err = new Error('query 已被拆掉');
  err.name = 'AbortError';
  return err;
}

/**
 * 哪些消息算「一轮的开始」：主 agent 的会话帧。后台任务 / 子 agent / hook /
 * 限流之类的旁路 system 消息在空闲期也会出现，不能让它们开一轮。
 */
function opensRound(message: SDKMessage): boolean {
  switch (message.type) {
    case 'system':
      return message.subtype === 'init';
    case 'stream_event':
    case 'assistant':
    case 'user':
      return message.parent_tool_use_id === null;
    case 'result':
      return true;
    default:
      return false;
  }
}

/**
 * 「回复帧」= 能承载 user_message_uuid 的那类帧：主 agent 的非 ping stream_event
 * 或 assistant 消息（SDK 对该字段的说明见文件头「轮与归属」）。
 */
function isReplyFrame(message: SDKMessage): boolean {
  if (message.type === 'assistant') return message.parent_tool_use_id === null;
  if (message.type !== 'stream_event' || message.parent_tool_use_id !== null) return false;
  const event = message.event as unknown as { type?: unknown };
  return event.type !== 'ping';
}

/** 取消息上的 user_message_uuid 标记（wrapper 级字段，不在 message.content 里）；回复帧与 result 都可能带 */
function userMessageUuidOf(message: SDKMessage): string | undefined {
  if (message.type !== 'stream_event' && message.type !== 'assistant' && message.type !== 'result') return undefined;
  const stamp = (message as { user_message_uuid?: unknown }).user_message_uuid;
  return typeof stamp === 'string' && stamp !== '' ? stamp : undefined;
}

/**
 * 由外部 push 驱动的 AsyncIterable——SDK 流式输入需要的形态。
 *
 * 语义：push 的消息若无人等待就先缓冲；消费者领先时挂起等下一条；
 * end() 让迭代器正常结束。
 */
export function createPushStream<T>(): {
  iterable: AsyncIterable<T>;
  push: (value: T) => void;
  end: () => void;
} {
  const buffer: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let ended = false;

  const push = (value: T): void => {
    if (ended) return;
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter({ value, done: false });
      return;
    }
    buffer.push(value);
  };

  const end = (): void => {
    if (ended) return;
    ended = true;
    while (waiters.length > 0) {
      waiters.shift()?.({ value: undefined as never, done: true });
    }
  };

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          const buffered = buffer.shift();
          if (buffered !== undefined) {
            return Promise.resolve({ value: buffered, done: false });
          }
          if (ended) {
            return Promise.resolve({ value: undefined as never, done: true });
          }
          return new Promise<IteratorResult<T>>((resolve) => {
            waiters.push(resolve);
          });
        },
        return(): Promise<IteratorResult<T>> {
          end();
          return Promise.resolve({ value: undefined as never, done: true });
        },
      };
    },
  };

  return { iterable, push, end };
}

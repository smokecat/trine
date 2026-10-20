/**
 * 会话管理：sessionId 单活跃进程互斥、并发上限、空闲回收、会话列表。
 *
 * ## 为什么必须互斥（调研报告 §6 的硬约束）
 *
 * 同一 sessionId 不能被两个进程同时 resume——会话转录是**追加写**的 jsonl，
 * 两个进程同时写会互相覆盖链尾，历史直接损坏。SDK 不替我们保证这件事，
 * 必须由代理端做「会话 → 活跃进程」的互斥。
 *
 * 这里的互斥不只是「拒绝第二个」：并发请求同一 sessionId 时，第二个请求应当
 * **拿到同一个 ClaudeSession 实例**（这才是用户期望——两台设备操作同一会话），
 * 只有真正的「另一个进程」才需要拒绝。所以用一张 Map 做单例表即可。
 *
 * ## 并发上限与空闲回收
 *
 * 每个子进程是完整 Node 程序，100-200MB 量级。个人机器 10 个上下并发无压力，
 * 但必须有上限，否则手机上手滑连开十几个会话能把机器打死。
 * 空闲回收关掉的是**子进程**，会话本身（jsonl）还在，随时可 resume——
 * 所以回收不该销毁 seq 序列（见 emitter.dropScope 的注释）。
 *
 * 名额满时再要新开（新建，或给不在跑的历史会话发消息），先挤掉最久没活动、
 * 且不忙的那个（`makeRoom`）：与空闲回收同一语义，只是不等超时。客户端没有
 * 「结束会话」的入口，单靠拒绝只会让用户干等 15 分钟回收。全都在忙才拒绝。
 */
import type { PermissionMode, SessionMeta, SessionState } from '@trine/core';
import {
  deleteSession,
  getSessionInfo,
  listSessions,
  renameSession,
  type SDKSessionInfo,
} from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter, scopedEmitter } from './emitter.ts';
import { ClaudeSession, type RewindPoint, type SessionRuntimeMeta } from './session.ts';
import type { HeadlessProbe } from './session-origin.ts';
import type { EventBody } from './types.ts';
import type { RateLimitPatch } from './usage.ts';

/**
 * 会话标记（归档 / 墓碑 / 未落盘标题）的只读视图 + 自动取消归档入口。
 * app 层的 SessionFlagsStore 实现它；bridge 层只认这个接口。
 */
export interface SessionFlags {
  archivedAt(sessionId: string): number | undefined;
  pinnedAt(sessionId: string): number | undefined;
  pendingTitle(sessionId: string): string | undefined;
  isDeleted(sessionId: string): boolean;
  /** 同步清掉归档标记（落盘在后台）——`#onMeta` 是同步回调，等不了写盘 */
  unarchiveNow(sessionId: string): void;
}

/** resume 历史会话时种进 meta 的非运行时字段（来自 SDK 的会话信息） */
export interface SessionSeed {
  title?: string;
  firstPrompt?: string;
  gitBranch?: string;
  createdAt?: number;
}

/** SDK 会话信息 → 显示标题（summary 本身已是「custom title → 自动摘要 → 首条输入」） */
export function titleFromInfo(info: SDKSessionInfo): string {
  return info.customTitle ?? info.summary ?? info.firstPrompt ?? '';
}

/** SDK 会话信息 → resume 种子 */
export function seedFromInfo(info: SDKSessionInfo): SessionSeed {
  return {
    title: titleFromInfo(info),
    ...(info.firstPrompt === undefined ? {} : { firstPrompt: info.firstPrompt }),
    ...(info.gitBranch === undefined ? {} : { gitBranch: info.gitBranch }),
    ...(info.createdAt === undefined ? {} : { createdAt: info.createdAt }),
  };
}

/** 运行中 / 等批准（「一轮还没跑完」） */
function inRun(state: SessionState): boolean {
  return state === 'running' || state === 'waiting_permission';
}

/**
 * 不能回收的会话：一轮没跑完、有排队输入，或有后台任务在跑（Bash
 * run_in_background / 后台子 agent）——回收会杀掉子进程，后台任务跟着死，
 * 且它完成后 CLI 还要自发开一轮回报结果。
 */
function isBusy(session: ClaudeSession): boolean {
  return inRun(session.state) || session.queueLength > 0 || session.bgRunningCount > 0;
}

export interface SessionManagerOptions {
  emitter: EventEmitter;
  /** 并发活跃会话上限（超出即拒绝新建，不静默排队） */
  maxConcurrent?: number;
  /** 空闲多久回收子进程（毫秒） */
  idleTimeoutMs?: number;
  now?: () => number;
  /** 注入 SDK listSessions，测试用 */
  listSessionsFn?: typeof listSessions;
  /** 注入 SDK getSessionInfo / renameSession / deleteSession，测试用（绝不能碰真 ~/.claude） */
  getSessionInfoFn?: typeof getSessionInfo;
  renameSessionFn?: typeof renameSession;
  deleteSessionFn?: typeof deleteSession;
  /** 注入 ClaudeSession 工厂，测试用假会话替换 */
  createSession?: (options: CreateSessionArgs) => ClaudeSession;
  /** 会话拉起的 claude 可执行文件（app 启动时解析）；不给 = SDK 内置 */
  claudeExecutable?: string;
  /** 会话的附件上传目录（会建好），加进 SDK additionalDirectories；不给 = 不加 */
  uploadsDir?: (sessionId: string) => string;
  /** 会话标记；不给则不合并 archived / pendingTitle、不过滤墓碑 */
  flags?: SessionFlags;
  /**
   * 本地记住的会话参数（app 接 state.json）。listSessions 不带模型 / 权限模式，
   * 内存缓存又随重启清空——不查这里，重启后列表里的会话全显示成「默认模型 /
   * default」，与下次 resume 实际用的参数对不上。
   */
  rememberedParams?: (sessionId: string) => { model: string; permissionMode: PermissionMode } | undefined;
  /**
   * 一轮跑完（running / waiting_permission → 其他状态）时回调。router 在这里
   * 补写 pendingTitle：首条消息的 jsonl 要等子进程处理后才落盘，input.send
   * 那一刻往往还没有文件。
   */
  onRunEnd?: (sessionId: string) => void;
  /**
   * 活跃会话的权限模式变了（来自 #onMeta 与缓存的比对）时回调，app 接到 router
   * 持久化进 state.json。覆盖两种来源：client 的 session.setPermissionMode，以及
   * CLI 自行切换（ExitPlanMode 批准后回报的 system/status，见 session.ts）——
   * 后者没有 client 命令经过 router，只能从 meta 变化这里接出去。
   */
  onPermissionModeChange?: (sessionId: string, mode: PermissionMode) => void;
  /**
   * 会话的对话截断点已生效（回退后的第一条回复到了）时回调，app 接到 state.json
   * 清掉持久化的截断点（见 session.ts「回退」）。
   */
  onRewindApplied?: (sessionId: string) => void;
  /** 日志出口，透传给会话（单条 SDK 消息处理失败等非致命异常） */
  log?: (line: string) => void;
  /**
   * 非交互会话探测（读转录开头的 entrypoint，见 session-origin.ts）。不给则
   * 不标 `headless`——测试默认不给，免得去读真 ~/.claude。
   */
  headlessProbe?: HeadlessProbe;
  /** 会话报来的订阅限额用量（账号级），app 汇总进 machine.info */
  onRateLimits?: (patch: RateLimitPatch) => void;
}

/** 建会话所需参数 */
export interface CreateSessionArgs {
  sessionId: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  emit: (body: EventBody) => void;
  resume?: boolean;
  /** 透传给 SDK 的 pathToClaudeCodeExecutable；不给 = SDK 内置 */
  pathToClaudeCodeExecutable?: string;
  onIdle?: () => void;
  onMeta?: (meta: SessionRuntimeMeta) => void;
  log?: (line: string) => void;
  /** 待生效的对话截断点（见 session.ts「回退」） */
  rewindPoint?: RewindPoint;
  onRewindApplied?: () => void;
  /** 额外可读目录（附件上传目录） */
  additionalDirectories?: string[];
  onRateLimits?: (patch: RateLimitPatch) => void;
}

const DEFAULT_MAX_CONCURRENT = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * `acquire()` 的结果。
 *
 * `reused` 让调用方知道拿到的是已存在的会话实例（因而本次传入的
 * cwd/model/permissionMode 没有被应用），而不是静默吞掉这个事实。
 */
export interface AcquireResult {
  session: ClaudeSession;
  reused: boolean;
}

/** 并发已满时抛出，调用方转成 error.fatal(config) 告知用户 */
export class ConcurrencyLimitError extends Error {
  constructor(readonly limit: number) {
    super(`活跃会话已达上限 ${limit} 且都在运行，请等其中一个跑完再试`);
    this.name = 'ConcurrencyLimitError';
  }
}

/**
 * 代理端的会话总管。单实例。
 */
export class SessionManager {
  readonly #emitter: EventEmitter;
  readonly #maxConcurrent: number;
  readonly #idleTimeoutMs: number;
  readonly #now: () => number;
  readonly #listSessions: typeof listSessions;
  readonly #getSessionInfo: typeof getSessionInfo;
  readonly #renameSession: typeof renameSession;
  readonly #deleteSession: typeof deleteSession;
  readonly #createSession: (options: CreateSessionArgs) => ClaudeSession;
  readonly #claudeExecutable: string | undefined;
  readonly #uploadsDir: ((sessionId: string) => string) | undefined;
  readonly #flags: SessionFlags | undefined;
  readonly #rememberedParams: SessionManagerOptions['rememberedParams'];
  readonly #onRunEnd: ((sessionId: string) => void) | undefined;
  readonly #onPermissionModeChange: ((sessionId: string, mode: PermissionMode) => void) | undefined;
  readonly #onRewindApplied: ((sessionId: string) => void) | undefined;
  readonly #log: ((line: string) => void) | undefined;
  readonly #headlessProbe: HeadlessProbe | undefined;
  readonly #onRateLimits: ((patch: RateLimitPatch) => void) | undefined;
  /** 已探明是非交互出身的 sessionId（出身不变，只增不减） */
  readonly #headless = new Set<string>();

  /** sessionId → 活跃会话。**这张表就是互斥锁** */
  readonly #sessions = new Map<string, ClaudeSession>();
  /** 会话元数据（含已关闭但仍在列表里的） */
  readonly #meta = new Map<string, SessionMeta>();
  /** 空闲回收定时器（按需起，unref） */
  #reapTimer: unknown = undefined;

  constructor(options: SessionManagerOptions) {
    this.#emitter = options.emitter;
    this.#maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#listSessions = options.listSessionsFn ?? listSessions;
    this.#getSessionInfo = options.getSessionInfoFn ?? getSessionInfo;
    this.#renameSession = options.renameSessionFn ?? renameSession;
    this.#deleteSession = options.deleteSessionFn ?? deleteSession;
    this.#flags = options.flags;
    this.#rememberedParams = options.rememberedParams;
    this.#claudeExecutable = options.claudeExecutable;
    this.#uploadsDir = options.uploadsDir;
    this.#onRunEnd = options.onRunEnd;
    this.#onPermissionModeChange = options.onPermissionModeChange;
    this.#onRewindApplied = options.onRewindApplied;
    this.#log = options.log;
    this.#headlessProbe = options.headlessProbe;
    this.#onRateLimits = options.onRateLimits;
    this.#createSession =
      options.createSession ?? ((args) => new ClaudeSession(args));
  }

  /** 当前活跃（持有实例的）会话数 */
  get activeCount(): number {
    return this.#sessions.size;
  }

  /** 活跃会话上限 */
  get maxConcurrent(): number {
    return this.#maxConcurrent;
  }

  /** 活跃会话 id 列表 */
  get activeSessionIds(): readonly string[] {
    return [...this.#sessions.keys()];
  }

  /**
   * 取或建一个会话——**互斥入口**。
   *
   * 已存在（无论是否在跑）直接返回同一实例；不存在才新建并计入并发。
   *
   * @throws {ConcurrencyLimitError} 需要新建但并发已满
   */
  acquire(args: {
    sessionId: string;
    cwd: string;
    model: string;
    permissionMode: PermissionMode;
    resume?: boolean;
    /**
     * resume 历史会话时的非运行时字段（title / firstPrompt / gitBranch / createdAt），
     * 由调用方从 listSessions 缓存或 getSessionInfo 取。不给则保留已有 meta 里的值
     * ——早先这里一律 `title: ''`，resume 一次标题就被广播成空（评审 B3）。
     */
    seed?: SessionSeed;
    /** 待生效的对话截断点（调用方从 state.json 取；见 session.ts「回退」） */
    rewindPoint?: RewindPoint;
  }): AcquireResult {
    const existing = this.#sessions.get(args.sessionId);
    if (existing !== undefined) {
      // 复用已有实例（互斥语义）。注意本次传入的 cwd/model/permissionMode
      // **不会**被应用——会话参数在运行中改要走 setModel/setPermissionMode，
      // 这里静默套用会让「另一台设备打开同一会话」意外改掉别人的会话设置。
      // 返回 reused 让调用方知情，可据此提示用户或主动下发变更。
      return { session: existing, reused: true };
    }

    if (this.#sessions.size >= this.#maxConcurrent) {
      throw new ConcurrencyLimitError(this.#maxConcurrent);
    }

    const scoped = scopedEmitter(this.#emitter, args.sessionId);
    const session = this.#createSession({
      sessionId: args.sessionId,
      cwd: args.cwd,
      model: args.model,
      permissionMode: args.permissionMode,
      emit: (body) => {
        scoped.emit(body);
      },
      ...(args.resume === undefined ? {} : { resume: args.resume }),
      ...(this.#claudeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.#claudeExecutable }),
      // 接上 onIdle：会话跑完一轮即触发一次回收检查。早先这个回调只声明未接线，
      // 加上 reapIdle 也没有任何东西驱动，整条空闲回收链路是死的——
      // 并发上限占满后永不释放，「子进程 100-200MB 要回收」的动机完全落空。
      onIdle: () => {
        this.#scheduleReap();
      },
      onMeta: (meta) => this.#onMeta(meta),
      ...(this.#log === undefined ? {} : { log: this.#log }),
      ...(args.rewindPoint === undefined ? {} : { rewindPoint: args.rewindPoint }),
      onRewindApplied: () => this.#onRewindApplied?.(args.sessionId),
      ...(this.#onRateLimits === undefined ? {} : { onRateLimits: this.#onRateLimits }),
      ...(this.#uploadsDir === undefined ? {} : { additionalDirectories: [this.#uploadsDir(args.sessionId)] }),
    });

    this.#sessions.set(args.sessionId, session);
    const previous = this.#meta.get(args.sessionId);
    const seed = args.seed;
    const title = nonEmpty(seed?.title) ?? previous?.title ?? '';
    const firstPrompt = seed?.firstPrompt ?? previous?.firstPrompt;
    const gitBranch = seed?.gitBranch ?? previous?.gitBranch;
    const createdAt = seed?.createdAt ?? previous?.createdAt;
    const meta: SessionMeta = {
      sessionId: args.sessionId,
      title,
      state: 'idle',
      lastActivityAt: this.#now(),
      cwd: args.cwd,
      model: args.model,
      permissionMode: args.permissionMode,
      costUsd: 0,
      // 与 #fromInfo 同口径：没有更新的摘要时用首条输入，下面广播的 updated 不会把摘要清空
      ...((previous?.lastEvent ?? seed?.firstPrompt) === undefined
        ? {}
        : { lastEvent: previous?.lastEvent ?? seed?.firstPrompt }),
      ...(firstPrompt === undefined ? {} : { firstPrompt }),
      ...(gitBranch === undefined ? {} : { gitBranch }),
      ...(createdAt === undefined ? {} : { createdAt }),
      // 新实例还没取过 context：沿用上次的值（子进程回收后 resume）
      ...(previous?.context === undefined ? {} : { context: previous.context }),
    };
    this.#meta.set(args.sessionId, meta);

    // 新会话广播（协议 §2 session.created）：其余客户端设备据此刷新列表。
    // 机器级帧——会话列表是机器维度的视图，且发起端还没「进入」该会话。
    // resume 已有会话不算新建，不广播。
    if (args.resume !== true) {
      this.#emitter.emit({ type: 'session.created', session: this.decorate(meta) }, null);
    } else {
      // resume 不算新建，但子进程起来了：广播 live，列表据此标出占名额的会话
      this.#emitter.emit({ type: 'session.updated', session: this.decorate(meta) }, null);
    }
    return { session, reused: false };
  }

  /** 取一个已存在的活跃会话；不存在返回 undefined（不隐式新建） */
  get(sessionId: string): ClaudeSession | undefined {
    return this.#sessions.get(sessionId);
  }

  /**
   * 借一个有子进程的会话查订阅限额用量（账号级，哪个会话都一样）。没有活跃子进程
   * 返回 undefined，调用方决定要不要临时起进程。
   */
  planUsage(): Promise<unknown> | undefined {
    for (const session of this.#sessions.values()) {
      if (!session.hasProcess) continue;
      const pending = session.planUsage();
      if (pending !== undefined) return pending;
    }
    return undefined;
  }

  /** 会话是否已有活跃实例（互斥判断） */
  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  /**
   * 关闭并移出一个会话（释放并发名额）。
   * 注意：**不** dropScope——会话可 resume，seq 必须继续单调。
   */
  async release(
    sessionId: string,
    reason = '会话已关闭',
    drainTimeoutMs?: number,
  ): Promise<void> {
    await this.#release(sessionId, reason, drainTimeoutMs, true);
  }

  /** `broadcast`：收尾后广播一次 session.updated（live 去掉）；进程退出时不广播 */
  async #release(
    sessionId: string,
    reason: string,
    drainTimeoutMs: number | undefined,
    broadcast: boolean,
  ): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    this.#sessions.delete(sessionId);
    await session.close(reason, drainTimeoutMs);
    if (!broadcast || this.#sessions.has(sessionId) || this.#flags?.isDeleted(sessionId) === true) return;
    const meta = this.metaOf(sessionId);
    if (meta !== undefined) this.#emitter.emit({ type: 'session.updated', session: meta }, null);
  }

  /**
   * 全部关闭（进程退出）。
   *
   * `drainTimeoutMs` 透传给每个会话的 close：退出流程有总时限，各会话并行
   * 收尾，这里的值就是整批的等待上限。
   */
  async closeAll(reason = 'agent 正在退出', drainTimeoutMs?: number): Promise<void> {
    this.stopReaper();
    const ids = [...this.#sessions.keys()];
    await Promise.all(ids.map((id) => this.#release(id, reason, drainTimeoutMs, false)));
  }

  /**
   * 空闲回收：把超过阈值没活动、且没在跑的会话关掉。
   * 由调用方周期驱动（或测试里手工调）。
   *
   * @returns 被回收的 sessionId 列表
   */
  async reapIdle(): Promise<string[]> {
    const now = this.#now();
    const reaped: string[] = [];
    for (const [id, session] of this.#sessions) {
      const idleFor = now - session.lastActivityAt;
      if (!isBusy(session) && idleFor >= this.#idleTimeoutMs) {
        reaped.push(id);
      }
    }
    for (const id of reaped) {
      await this.release(id, '会话空闲超时，子进程已回收（可随时恢复）');
    }
    return reaped;
  }

  /**
   * 名额已满时腾出一个：回收最久没活动、且不忙的会话（见文件头注释）。
   * 调用方在 `acquire` 新会话前 await 它——close 收尾完才算腾出，免得新旧子进程
   * 叠在一起。没满或全都在忙时什么都不做，交给 `acquire` 抛 ConcurrencyLimitError。
   *
   * @returns 被回收的 sessionId；没有回收返回 undefined
   */
  async makeRoom(): Promise<string | undefined> {
    if (this.#sessions.size < this.#maxConcurrent) return undefined;
    let victim: [string, ClaudeSession] | undefined;
    for (const entry of this.#sessions) {
      if (isBusy(entry[1])) continue;
      if (victim === undefined || entry[1].lastActivityAt < victim[1].lastActivityAt) victim = entry;
    }
    if (victim === undefined) return undefined;
    this.#log?.(`[manager] 活跃会话已满（${this.#maxConcurrent}），回收最久未活动的 ${victim[0]}`);
    await this.release(victim[0], '活跃会话已满，最久未活动的会话子进程已回收（可随时恢复）');
    return victim[0];
  }

  /**
   * 会话列表：SDK 的历史会话 + 本进程活跃会话的运行时状态合并。
   *
   * 用 SDK 的 `listSessions` 而不是自己解析 jsonl——官方 API 屏蔽格式演进
   * （调研报告 §4 的建议）。
   */
  async list(options?: { cwd?: string; limit?: number }): Promise<SessionMeta[]> {
    const infos = await this.#listSessions({
      ...(options?.cwd === undefined ? {} : { dir: options.cwd }),
      ...(options?.limit === undefined ? {} : { limit: options.limit }),
      includeWorktrees: true,
    });
    await this.#probeHeadless(infos);

    const out: SessionMeta[] = [];
    const seen = new Set<string>();

    for (const info of infos) {
      seen.add(info.sessionId);
      // 墓碑兜底：删除后子进程 re-stamp 等意外可能留下残缺 jsonl，别让它复活
      if (this.#flags?.isDeleted(info.sessionId) === true) continue;
      // 派生字段回填缓存（验收 V1）：之后 snapshot / #onMeta 的广播与本次列表同口径
      this.#backfill(info);
      out.push(this.decorate(this.#fromInfo(info), { hasCustomTitle: info.customTitle !== undefined }));
    }

    // 本进程新建但尚未落盘的会话（还没发过消息就不会有 jsonl）
    for (const [id, meta] of this.#meta) {
      if (seen.has(id)) continue;
      if (this.#flags?.isDeleted(id) === true) continue;
      const live = this.#sessions.get(id);
      out.push(
        this.decorate({
          ...meta,
          state: live?.state ?? meta.state,
          costUsd: live?.costUsd ?? meta.costUsd,
          lastActivityAt: live?.lastActivityAt ?? meta.lastActivityAt,
          ...bgRunningOf(live?.bgRunningCount ?? meta.bgRunning),
        }),
      );
    }

    out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return out;
  }

  /** 会话元数据快照（session.updated 广播用；已合并标记） */
  metaOf(sessionId: string): SessionMeta | undefined {
    const meta = this.#meta.get(sessionId);
    return meta === undefined ? undefined : this.decorate(meta);
  }

  /**
   * 所有产出 SessionMeta 的出口统一经过这里（评审 B3）：合并 flags store 的
   * archived / archivedAt / pinnedAt 与 pendingTitle。入参里若带着这几个字段一律丢弃
   * ——标记的唯一来源是 flags store。`headless` 同理，唯一来源是 #headless；
   * `live` 的唯一来源是 #sessions。
   *
   * pendingTitle 覆盖 title（不只在 title 为空时）：它是用户显式设过、还没来得及
   * 写进转录的标题，比 SDK 的自动摘要新。首条消息落盘到补写完成之间，
   * listSessions 会先给出 firstPrompt 摘要，不覆盖的话列表会闪一下。
   *
   * 例外：调用方明确知道转录里**已有** customTitle（`hasCustomTitle`，来自 SDK
   * 会话信息）时不覆盖——那是别处（本机 CLI `/rename`）写进去的正式标题，
   * 一条补写卡住的 pending 不该盖住它（评审 minor 1）。
   */
  decorate(meta: SessionMeta, options: { hasCustomTitle?: boolean } = {}): SessionMeta {
    const {
      archived: _archived,
      archivedAt: _archivedAt,
      pinnedAt: _pinnedAt,
      headless: _headless,
      live: _live,
      ...stripped
    } = meta;
    const rest: SessionMeta = {
      ...stripped,
      ...(this.#headless.has(meta.sessionId) ? { headless: true } : {}),
      ...(this.#sessions.has(meta.sessionId) ? { live: true } : {}),
    };
    const flags = this.#flags;
    if (flags === undefined) return rest;
    const pending = options.hasCustomTitle === true ? undefined : flags.pendingTitle(meta.sessionId);
    const at = flags.archivedAt(meta.sessionId);
    const pinnedAt = flags.pinnedAt(meta.sessionId);
    return {
      ...rest,
      ...(pending === undefined ? {} : { title: pending }),
      ...(at === undefined ? {} : { archived: true, archivedAt: at }),
      ...(pinnedAt === undefined ? {} : { pinnedAt }),
    };
  }

  /**
   * 局部更新缓存的 meta（rename 后改 title 等）。只改已有条目——历史会话不在
   * 缓存里就不插入：插进去的条目若之后转录没了，list() 第二个循环会把它当成
   * 「本进程新建未落盘」塞回列表。
   * @returns 更新后的（已合并标记的）meta；不在缓存里返回 undefined
   */
  updateMeta(
    sessionId: string,
    patch: Partial<Omit<SessionMeta, 'sessionId' | 'archived' | 'archivedAt' | 'pinnedAt'>>,
  ): SessionMeta | undefined {
    const current = this.#meta.get(sessionId);
    if (current === undefined) return undefined;
    const next = { ...current, ...patch, sessionId };
    this.#meta.set(sessionId, next);
    return this.decorate(next);
  }

  /**
   * 忘掉一个会话的缓存 meta（永久删除级联清理）。有活跃实例时拒绝——调用方
   * 应先 release。
   */
  forget(sessionId: string): void {
    if (this.#sessions.has(sessionId)) {
      throw new Error(`会话 ${sessionId} 仍有活跃实例，不能 forget`);
    }
    this.#meta.delete(sessionId);
  }

  /** SDK getSessionInfo（不传 dir：全项目目录查找） */
  sessionInfo(sessionId: string): Promise<SDKSessionInfo | undefined> {
    return this.#getSessionInfo(sessionId);
  }

  /**
   * 一个会话当前的完整 meta（已合并标记）：缓存里有用缓存，否则查 SDK。
   * 查不到返回 undefined。rename / archive 成功后广播 session.updated 用。
   *
   * 缓存条目缺派生字段（title 为空 / 没有 lastEvent——从没被 list() 回填过的
   * 会话，典型是本进程新建、发过消息、没手动改过名的）时先惰性查一次
   * getSessionInfo 回填再出（验收 V1）：web 对 session.updated 整份覆盖，
   * 贫瘠的 meta 会把列表标题退成短码、摘要清空。查询失败按缓存原样出。
   */
  async snapshot(sessionId: string): Promise<SessionMeta | undefined> {
    const current = this.#meta.get(sessionId);
    if (current !== undefined) {
      if (current.title === '' || current.lastEvent === undefined) {
        const info = await this.#getSessionInfo(sessionId).catch(() => undefined);
        if (info !== undefined) this.#backfill(info);
      }
      return this.metaOf(sessionId);
    }
    const info = await this.#getSessionInfo(sessionId);
    if (info !== undefined) await this.#probeHeadless([info]);
    return info === undefined
      ? undefined
      : this.decorate(this.#fromInfo(info), { hasCustomTitle: info.customTitle !== undefined });
  }

  /** 写转录的 custom-title（与 CLI `/rename` 同格式）。文件不存在 / 0 字节时 SDK 抛错 */
  renameTranscript(sessionId: string, title: string): Promise<void> {
    return this.#renameSession(sessionId, title);
  }

  /** 删转录 jsonl 与子代理目录。找不到时 SDK 抛错 */
  deleteTranscript(sessionId: string): Promise<void> {
    return this.#deleteSession(sessionId);
  }

  /**
   * 把 SDK 会话信息派生出的**非运行时**字段（title / lastEvent / firstPrompt /
   * gitBranch / createdAt）回填进已有的缓存条目——只填缺的，不覆盖已有值
   * （缓存里的 title 可能是刚改的名，比这份列表快照新）。不在缓存里的会话不插入
   * （理由同 updateMeta）。
   *
   * 例外是 title（评审 N3）：SDK 给出 customTitle 时以它为准**覆盖**缓存——那是
   * 转录里的正式标题（trine 的 rename 与本机 CLI `/rename` 写的是同一条记录），
   * 不跟进的话用户在本机改名后，每次状态迁移 / rename / archive 广播都会把 web
   * 的标题退回旧值。没有 customTitle 时 title 只是派生值（摘要 / 首条输入），
   * 仍只在缺失时回填。pendingTitle 的优先级不在这里管，见 decorate。
   *
   * 为什么需要（验收 V1）：`#fromInfo` 的派生值早先只在 list() 里现算、从不
   * 写回，而 snapshot()、`#onMeta` 都从缓存出 meta——没手动改过名的会话缓存
   * title 永远是 ''，rename / archive / 状态迁移广播出去的就是贫瘠版。
   */
  #backfill(info: SDKSessionInfo): void {
    const cached = this.#meta.get(info.sessionId);
    if (cached === undefined) return;
    const title = titleFromInfo(info);
    const patch: Partial<SessionMeta> = {};
    if (info.customTitle !== undefined) {
      if (cached.title !== info.customTitle) patch.title = info.customTitle;
    } else if (cached.title === '' && title !== '') {
      patch.title = title;
    }
    if (cached.lastEvent === undefined && info.firstPrompt !== undefined) patch.lastEvent = info.firstPrompt;
    if (cached.firstPrompt === undefined && info.firstPrompt !== undefined) patch.firstPrompt = info.firstPrompt;
    if (cached.gitBranch === undefined && info.gitBranch !== undefined) patch.gitBranch = info.gitBranch;
    if (cached.createdAt === undefined && info.createdAt !== undefined) patch.createdAt = info.createdAt;
    if (Object.keys(patch).length === 0) return;
    this.#meta.set(info.sessionId, { ...cached, ...patch });
  }

  /** 探测一批会话的出身，非交互的记进 #headless。探测失败当作不知道 */
  async #probeHeadless(infos: readonly SDKSessionInfo[]): Promise<void> {
    const probe = this.#headlessProbe;
    if (probe === undefined || infos.length === 0) return;
    try {
      const result = await probe(infos.map((info) => ({ sessionId: info.sessionId, cwd: info.cwd })));
      for (const [id, headless] of result) if (headless) this.#headless.add(id);
    } catch (err) {
      this.#log?.(`探测会话来源失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** SDK 会话信息 + 本进程运行时状态 → SessionMeta（未合并标记） */
  #fromInfo(info: SDKSessionInfo): SessionMeta {
    const live = this.#sessions.get(info.sessionId);
    const cached = this.#meta.get(info.sessionId);
    const remembered = cached === undefined ? this.#rememberedParams?.(info.sessionId) : undefined;
    const state = live?.state ?? cached?.state ?? 'idle';
    return {
      sessionId: info.sessionId,
      title: titleFromInfo(info),
      state,
      lastActivityAt: live?.lastActivityAt ?? info.lastModified,
      cwd: info.cwd ?? cached?.cwd ?? '',
      model: cached?.model ?? remembered?.model ?? '',
      permissionMode: cached?.permissionMode ?? remembered?.permissionMode ?? 'default',
      costUsd: live?.costUsd ?? cached?.costUsd ?? 0,
      // 缓存里的 waitingFor 由 #onMeta 随每次状态迁移 / 挂起项变化刷新，与 live 同步
      ...waitingForOf({ state, waitingFor: cached?.waitingFor }),
      ...bgRunningOf(live?.bgRunningCount ?? cached?.bgRunning),
      ...(cached?.context === undefined ? {} : { context: cached.context }),
      ...(info.firstPrompt === undefined ? {} : { lastEvent: info.firstPrompt }),
      ...(info.firstPrompt === undefined ? {} : { firstPrompt: info.firstPrompt }),
      ...(info.gitBranch === undefined ? {} : { gitBranch: info.gitBranch }),
      ...(info.createdAt === undefined ? {} : { createdAt: info.createdAt }),
    };
  }

  /**
   * 起一个定时器，在空闲阈值之后跑一次回收。
   *
   * 用「会话空闲时按需起一次」而不是常驻轮询：agent 大多数时间没有活跃会话，
   * 常驻定时器纯属白烧。定时器 unref，不拖住进程退出。
   */
  #scheduleReap(): void {
    if (this.#reapTimer !== undefined) return;
    const handle = setTimeout(() => {
      this.#reapTimer = undefined;
      void this.reapIdle().then(() => {
        // 还有会话没被回收（在跑，或还没到阈值）就继续排下一次检查
        if (this.#sessions.size > 0) this.#scheduleReap();
      });
    }, this.#idleTimeoutMs);
    (handle as { unref?: () => void }).unref?.();
    this.#reapTimer = handle;
  }

  /** 停掉回收定时器（进程退出前调，避免测试里留悬挂定时器） */
  stopReaper(): void {
    if (this.#reapTimer === undefined) return;
    clearTimeout(this.#reapTimer as ReturnType<typeof setTimeout>);
    this.#reapTimer = undefined;
  }

  /**
   * 运行时字段变化 → 增量合并进缓存 meta 并广播。
   *
   * 只覆盖运行时字段（state / lastActivityAt / cwd / model / permissionMode /
   * costUsd），其余（title / firstPrompt / gitBranch / createdAt / lastEvent）
   * 原样保留。早先这里显式重建、只带 title 与 lastEvent，新字段一活跃就丢
   * （评审 B3）；web 对 session.updated 是整份覆盖，丢了就真丢了。
   *
   * 自动取消归档的**唯一**收敛点（评审 M1）：进入 running 时清掉归档标记，随
   * 同一次 updated 广播出去。input.send、resumeAt 续跑、setCwd 重开、多设备
   * 发消息都会走到这里，不必在 router 各处重复判断。
   */
  #onMeta(runtime: SessionRuntimeMeta): void {
    const sid = runtime.sessionId;
    // 已永久删除：close 收尾等迟到的回调不能把它写回缓存（list 会复活它）
    if (this.#flags?.isDeleted(sid) === true) return;
    const previous = this.#meta.get(sid);
    // waitingFor / bgRunning 是运行时字段：以本次 runtime 为准，离开等待态 / 后台任务
    // 归零时要从缓存里去掉（否则列表会一直挂着「后台 1」）
    const { waitingFor: _stale, bgRunning: _staleBg, ...kept } = previous ?? { title: '' };
    const merged: SessionMeta = {
      ...kept,
      sessionId: sid,
      state: runtime.state,
      lastActivityAt: runtime.lastActivityAt,
      cwd: runtime.cwd,
      model: runtime.model,
      permissionMode: runtime.permissionMode,
      costUsd: runtime.costUsd,
      ...(runtime.waitingFor === undefined ? {} : { waitingFor: runtime.waitingFor }),
      ...bgRunningOf(runtime.bgRunning),
      // context 只在取到时覆盖；没带就保留缓存里的上一次值
      ...(runtime.context === undefined ? {} : { context: runtime.context }),
    };
    this.#meta.set(sid, merged);
    if (runtime.state === 'running' && this.#flags?.archivedAt(sid) !== undefined) {
      this.#flags.unarchiveNow(sid);
    }
    // 列表增量广播是机器级帧（客户端的会话列表页要看到所有会话的变化）
    this.#emitter.emit({ type: 'session.updated', session: this.decorate(merged) }, null);
    if (previous !== undefined && inRun(previous.state) && !inRun(runtime.state)) {
      this.#onRunEnd?.(sid);
    }
    if (previous !== undefined && previous.permissionMode !== runtime.permissionMode) {
      this.#onPermissionModeChange?.(sid, runtime.permissionMode);
    }
  }

  /** 记录一个会话的状态（测试/恢复用） */
  setMeta(meta: SessionMeta): void {
    this.#meta.set(meta.sessionId, meta);
  }
}

/** 等待态才带 waitingFor（非等待态的陈旧值不外泄） */
function waitingForOf(meta: Pick<SessionMeta, 'state' | 'waitingFor'> | undefined): Pick<SessionMeta, 'waitingFor'> {
  if (meta?.state !== 'waiting_permission' || meta.waitingFor === undefined) return {};
  return { waitingFor: meta.waitingFor };
}

/** 有后台任务在跑才带 bgRunning（0 / 未知不外泄，旧 client 也少一个字段） */
function bgRunningOf(count: number | undefined): Pick<SessionMeta, 'bgRunning'> {
  return count === undefined || count <= 0 ? {} : { bgRunning: count };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** 便捷类型再导出 */
export type { SessionState };

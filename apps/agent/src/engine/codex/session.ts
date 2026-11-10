/**
 * 一个活跃的 Codex 会话：trine 的会话语义 ↔ app-server 的 thread / turn / item。
 *
 * 帧序列对齐 ClaudeSession（client 不区分引擎）：user.message 在消息出队时发，
 * running → 工具与文本 → run.done → idle。排队用 trine 自己的 InputQueue，不用 turn/steer：
 * 与 Claude 语义一致，排队的消息可撤回。
 *
 * 权限模式缺省时不传覆盖：续接 CLI 里开的 thread 不能悄悄改掉它自己的沙箱设置。
 * 审批一律显式路由给用户（approvalsReviewer: user），否则会继承配置里的自动审核，绕过浏览器。
 */
import { randomUUID } from 'node:crypto';
import type {
  BgTask,
  ContextUsage,
  PermissionMode,
  PermissionOption,
  RewindErrorCode,
  RewindMode,
  SessionState,
  SubagentInfo,
  SubagentState,
} from '@trine/core';
import type { RewindDone, RewindFailure, RewindPreview } from '../../app/rewind.ts';
import type { PreparedInput } from '../../bridge/attachments.ts';
import { Heartbeat } from '../../bridge/heartbeat.ts';
import { AppServerError } from './app-server.ts';
import type { PendingPermissionSnapshot, PermissionVerdict } from '../../bridge/permission.ts';
import { InputQueue } from '../../bridge/queue.ts';
import type { SessionRuntimeMeta, StopBgTaskResult } from '../../bridge/session.ts';
import { toSingleLine } from '../../bridge/summarize.ts';
import type { EventBody } from '../../bridge/types.ts';
import type { EngineSession } from '../types.ts';
import { childStatesOf, codexItemToHistory, spawnOf, subagentLabels, unwrapShellCommand } from './history.ts';
import { CODEX_DEFAULT_MODEL } from './ids.ts';
import {
  isCodexMode,
  legacyFromMode,
  modeFromLegacy,
  modeFromThreadResponse,
  threadModeParams,
  turnModeParams,
  type CodexModeId,
} from './modes.ts';

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null;
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export interface CodexSessionClient {
  call(method: string, params: unknown): Promise<unknown>;
  /** 注册这个 thread 的通知与服务端请求；持有期间 app-server 不会空闲退出 */
  attach(threadId: string, session: CodexSessionEvents): void;
  /** 只解绑自己：回收等待期间可能已经建了新实例。返回是否真的解绑了 */
  detach(threadId: string, session: CodexSessionEvents): boolean;
  /** thread 的全部 item（旧的在前），带 turnId */
  readItems(threadId: string): Promise<unknown[]>;
  /** 这个目录下能用的 skill */
  skills(cwd: string): Promise<CodexSkill[]>;
  /** 模型支持的推理强度；模型目录还没拿到或没有这个模型时为 undefined */
  effortsOf(model: string): { efforts: readonly string[]; defaultEffort?: string | undefined } | undefined;
  /** 子 agent thread 的昵称 / 角色 / 模型（thread/read）；不支持或读不到 undefined */
  describeThread?(threadId: string): Promise<{ nickname?: string; role?: string; model?: string } | undefined>;
}

export interface CodexSkill {
  name: string;
  description: string;
  path: string;
  scope: string;
}

export interface CodexSessionEvents {
  onNotification(method: string, params: Rec): void;
  /**
   * 返回 false 表示不处理，由调用方回错误。`childThreadId`：请求来自这个会话的子 agent thread
   * （引擎按归属表转来），卡片挂在本会话，回复与撤销仍按子 thread 的请求处理
   */
  onServerRequest(id: unknown, method: string, params: Rec, reply: (result: unknown) => void, childThreadId?: string): boolean;
  /** 子 agent thread 的通知（引擎按归属表转来）：只更新卡片与审批，不动本会话的轮 */
  onChildNotification?(childThreadId: string, method: string, params: Rec): void;
  /** turnId 是不是本会话当前的轮（子 turn 的 rootTurnId 认亲用） */
  ownsTurn?(turnId: string): boolean;
  /** 子 agent 当前状态（读历史时校正派生卡用） */
  childStates?(): ReadonlyMap<string, SubagentState>;
  onExit(): void;
}

export interface CodexSessionOptions {
  sessionId: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  engineMode?: string | undefined;
  effort?: string | undefined;
  /** true = 磁盘上已有的 thread，要先 thread/resume；false = 刚 thread/start 的，已加载 */
  resume: boolean;
  client: CodexSessionClient;
  emit: (body: EventBody) => void;
  onMeta?: ((meta: SessionRuntimeMeta) => void) | undefined;
  onIdle?: (() => void) | undefined;
  log?: ((line: string) => void) | undefined;
  now?: () => number;
}

interface PendingApproval {
  requestId: string;
  rpcId: unknown;
  /** 请求所属的 thread（本会话，或它的子 agent thread）与 turn：撤销按它们判断 */
  threadId: string;
  turnId: string | undefined;
  /** 来自子 agent：它的派生卡 id（permission.request 的 parentToolUseId） */
  parentToolUseId: string | undefined;
  /** 来自子 agent 但对不上派生卡：子 thread id（permission.request 的 subagentId） */
  subagentId: string | undefined;
  /** 已了结记录的键（见 #handled） */
  key: string;
  toolName: string;
  input: Record<string, unknown>;
  requestedAt: number;
  options: PermissionOption[];
  decide: (verdict: 'allow' | 'deny', optionId: string | undefined) => unknown;
  reply: (result: unknown) => void;
}

/** 本会话时间线上的一张子 agent 派生卡 */
interface ChildAgent {
  cardId: string;
  argSummary: string;
  info: SubagentInfo;
  /** 已去查过昵称 / 角色（只查一次） */
  described: boolean;
}

/** 子 agent 记录上限（超了丢最早的） */
const MAX_CHILD_AGENTS = 200;

/** 审批请求属于哪个 thread / turn，来自子 agent 时挂哪张派生卡 */
interface RequestOrigin {
  threadId: string;
  turnId: string | undefined;
  parentToolUseId: string | undefined;
  subagentId: string | undefined;
  key: string;
}

/** 已了结请求 / 已结束轮记录的上限 */
const MAX_HANDLED = 500;
/** 改文件审批缺 diff 时补读子 thread item 的等待上限 */
const DIFF_LOOKUP_TIMEOUT_MS = 3_000;
/** 补不到 diff 时卡上显示的说明（只给拒绝） */
const NO_PREVIEW = '（无法预览改动内容：没有收到这次改动的详情，只能拒绝）';

const ALLOW_ONCE: PermissionOption = { id: 'accept', label: '批准', kind: 'allow_once' };
const ALLOW_SESSION: PermissionOption = { id: 'acceptForSession', label: '本会话都批准', kind: 'allow_session' };
const DENY: PermissionOption = { id: 'decline', label: '拒绝', kind: 'reject' };

/** Codex 给的可选决定 → trine 的选项；只认识的才显示，带修改策略的先不给 */
function optionsFrom(available: unknown): PermissionOption[] {
  if (!Array.isArray(available)) return [ALLOW_ONCE, ALLOW_SESSION, DENY];
  const out = [ALLOW_ONCE, ALLOW_SESSION, DENY].filter((o) => available.includes(o.id));
  // 协议变了也要能批准和拒绝
  if (!out.some((o) => o.kind === 'reject')) out.push(DENY);
  if (!out.some((o) => o.kind !== 'reject')) out.unshift(ALLOW_ONCE);
  return out;
}

function errorKind(info: unknown): 'quota' | 'auth' | 'config' | 'other' {
  if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded' || info === 'sessionBudgetExceeded') return 'quota';
  if (info === 'unauthorized') return 'auth';
  if (info === 'modelNotFound' || info === 'badRequest') return 'config';
  return 'other';
}

/** 压缩不是消息：Codex 有单独的接口。带参数时当普通消息，因为接口不接受压缩指引 */
const COMPACT_COMMAND = '/compact';
/** 消息开头的 `/name` 或 `$name`（路径如 /tmp/x 不算：名字后面必须是空白或结尾） */
const SKILL_INVOCATION = /^[/$]([A-Za-z0-9_:.-]+)(?=\s|$)/;
/** thread 级错误里表示「旧格式 thread 没有这个接口」 */
const METHOD_NOT_FOUND = -32601;

function rewindFail(code: RewindErrorCode, message: string): RewindFailure {
  return { ok: false, error: { code, message: toSingleLine(message, 300) } };
}

/** 带附件的内容（Claude 的内容块）→ Codex 的 UserInput */
export function toUserInput(text: string, prepared: PreparedInput['content'] | undefined): unknown[] {
  const textInput = (value: string): Rec => ({ type: 'text', text: value, text_elements: [] });
  if (prepared === undefined || typeof prepared === 'string') return [textInput(prepared ?? text)];
  const out: unknown[] = [];
  for (const block of prepared as unknown[]) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      out.push(textInput(block['text']));
    } else if (block['type'] === 'image' && isRecord(block['source'])) {
      const { media_type: media, data } = block['source'];
      if (typeof media === 'string' && typeof data === 'string') out.push({ type: 'image', url: `data:${media};base64,${data}` });
    }
  }
  return out.length === 0 ? [textInput(text)] : out;
}

export class CodexSession implements EngineSession, CodexSessionEvents {
  readonly sessionId: string;
  readonly #client: CodexSessionClient;
  readonly #emit: (body: EventBody) => void;
  readonly #onMeta: ((meta: SessionRuntimeMeta) => void) | undefined;
  readonly #onIdle: (() => void) | undefined;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #queue: InputQueue;
  readonly #heartbeat: Heartbeat;

  /** 这几个 Map 按轮清空 */
  readonly #pending = new Map<string, PendingApproval>();
  readonly #inFlightTools = new Map<string, number>();
  /** 改文件审批的请求里没有 diff，要从 item/started 取 */
  readonly #fileChanges = new Map<string, Rec>();
  /** 子 agent thread 的改文件 item（按子 thread 的轮清，不随本会话的轮清） */
  readonly #childFileChanges = new Map<string, Rec>();
  /**
   * 子 agent（直接子 thread）→ 它在本会话时间线上的派生卡。子 thread 的动态只更新这张卡的
   * subagent 信息（重发 tool.start），不另出卡；跨轮保留（子 agent 可能比派生它的轮活得久）
   */
  readonly #childAgents = new Map<string, ChildAgent>();
  /** 孙辈及更深的 thread → 它所属的直接子 thread（审批卡的来源标注用） */
  readonly #descendants = new Map<string, string>();
  /** 子 thread 正在进行的 turn（停止时按它中断；turn/completed 时删） */
  readonly #childTurns = new Map<string, string>();
  /**
   * app-server 进程代际：进程退出加一。请求 id 只在一个连接内唯一，新进程会复用同样的 id，
   * 所以已处理记录、已结束的轮都按代际隔离（评审 高1 / 中3）
   */
  #procGen = 0;
  /**
   * 已了结的请求（代际 + thread + 请求 id）→ 当时的回复（被撤销 / 作废的为 null）。同一请求
   * 再到达（重放）不再进 pending：答过的照原样再回一次，撤销过的不理（评审 中3）
   */
  readonly #handled = new Map<string, unknown>();
  /** 已结束的子 thread 轮（代际 + thread + turn）：之后才到的这一轮的请求 Codex 已不在等 */
  readonly #endedTurns = new Set<string>();

  readonly permissions = {
    snapshot: (): readonly PendingPermissionSnapshot[] =>
      [...this.#pending.values()].map((p) => ({
        requestId: p.requestId,
        toolName: p.toolName,
        input: p.input,
        requestedAt: p.requestedAt,
        options: p.options,
        // 重连补发时来源不能丢（评审 中8）
        ...(p.parentToolUseId === undefined ? {} : { parentToolUseId: p.parentToolUseId }),
        ...(p.subagentId === undefined ? {} : { subagentId: p.subagentId }),
      })),
  };

  #state: SessionState = 'idle';
  #cwd: string;
  #model: string;
  /** 用户明确选的模式，才会传给 Codex 覆盖；没选过就不传 */
  #mode: CodexModeId | undefined;
  /** thread 自己的设置对应哪一档，只用来显示 */
  #reportedMode: CodexModeId | undefined;
  #legacyMode: PermissionMode;
  /** 用户明确选的推理强度，才会传给 Codex 覆盖 */
  #effort: string | undefined;
  /** thread 自己的推理强度，只用来显示 */
  #reportedEffort: string | undefined;
  #context: ContextUsage | undefined;
  #loaded: boolean;
  #lastActivityAt: number;
  #turnId: string | undefined;
  /** 这一轮还在进行（含 turn/start 的 await 期间）*/
  #running = false;
  #stopping = false;
  #closed = false;
  #turnStartedAt = 0;
  #toolCount = 0;
  #permissionCount = 0;
  #firstPrompt: string | undefined;
  /** 每轮结束加一：await 回来发现代际变了，说明那一轮已结束（退出、关闭），不能再动状态 */
  #generation = 0;
  #lastCompletedTurnId: string | undefined;

  constructor(options: CodexSessionOptions) {
    this.sessionId = options.sessionId;
    this.#client = options.client;
    this.#emit = options.emit;
    this.#onMeta = options.onMeta;
    this.#onIdle = options.onIdle;
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? Date.now;
    this.#queue = new InputQueue({ now: this.#now });
    this.#heartbeat = new Heartbeat({ emit: this.#emit, now: this.#now });
    this.#cwd = options.cwd;
    this.#model = options.model;
    this.#mode = isCodexMode(options.engineMode) ? options.engineMode : undefined;
    this.#legacyMode = this.#mode === undefined ? options.permissionMode : legacyFromMode(this.#mode);
    this.#effort = this.#supportedEffort(options.effort);
    this.#loaded = !options.resume;
    this.#lastActivityAt = this.#now();
    this.#client.attach(this.sessionId, this);
  }

  get state(): SessionState {
    return this.#state;
  }
  get costUsd(): number {
    return 0;
  }
  get lastActivityAt(): number {
    return this.#lastActivityAt;
  }
  get queueLength(): number {
    return this.#queue.length;
  }
  get hasProcess(): boolean {
    return this.#loaded;
  }
  get bgRunningCount(): number {
    return 0;
  }
  get permissionMode(): PermissionMode {
    return this.#legacyMode;
  }
  /** 用户选的推理强度，要持久化的是它；thread 自己的只显示（meta().effort），不能变成覆盖 */
  get effort(): string | undefined {
    return this.#effort;
  }

  meta(): SessionRuntimeMeta {
    return {
      sessionId: this.sessionId,
      state: this.#state,
      costUsd: 0,
      lastActivityAt: this.#lastActivityAt,
      cwd: this.#cwd,
      model: this.#model,
      permissionMode: this.#legacyMode,
      ...((this.#mode ?? this.#reportedMode) === undefined ? {} : { engineMode: (this.#mode ?? this.#reportedMode)! }),
      ...((this.#effort ?? this.#reportedEffort) === undefined ? {} : { effort: (this.#effort ?? this.#reportedEffort)! }),
      ...(this.#state === 'waiting_permission' && this.#pending.size > 0 ? { waitingFor: 'permission' as const } : {}),
      ...(this.#context === undefined ? {} : { context: this.#context }),
      ...(this.#firstPrompt === undefined ? {} : { firstPrompt: this.#firstPrompt }),
    };
  }

  bgTasks(): BgTask[] {
    return [];
  }

  async stopBgTask(): Promise<StopBgTaskResult> {
    return { ok: false, code: 'not_found', message: '这个引擎没有后台任务' };
  }

  send(clientMsgId: string, text: string, prepared?: PreparedInput): { duplicate: boolean; uuid?: string } {
    this.#touch();
    // 停止还在进行时（turn id 没到、中断没回）不能撤销它，否则原来那一轮会接着跑
    if (!this.#running) this.#stopping = false;
    const result = this.#queue.enqueue(clientMsgId, text, prepared?.content);
    if (result.duplicate) {
      this.#emit({ type: 'input.queued', clientMsgId });
      return { duplicate: true };
    }
    this.#attachments.set(clientMsgId, prepared?.attachments ?? []);
    if (this.#running) this.#emit({ type: 'input.queued', clientMsgId });
    else void this.#runNext();
    return { duplicate: false };
  }

  readonly #attachments = new Map<string, NonNullable<PreparedInput['attachments']>>();

  recall(clientMsgId: string): boolean {
    this.#touch();
    if (!this.#queue.recall(clientMsgId)) return false;
    this.#attachments.delete(clientMsgId);
    this.#emit({ type: 'input.cancelled', clientMsgId, reason: 'recalled' });
    return true;
  }

  async #runNext(): Promise<void> {
    if (this.#running || this.#closed) return;
    const next = this.#queue.takeNext();
    if (next === undefined) return;
    this.#running = true;
    this.#queue.setRunning(true);
    this.#turnId = undefined;
    this.#turnStartedAt = this.#now();
    this.#toolCount = 0;
    this.#permissionCount = 0;
    const attachments = this.#attachments.get(next.clientMsgId) ?? [];
    // 带附件就是普通消息：压缩接口不接受输入，附件会被吞掉
    const compact = next.text.trim() === COMPACT_COMMAND && attachments.length === 0;
    if (!compact) this.#firstPrompt ??= toSingleLine(next.text);
    this.#attachments.delete(next.clientMsgId);
    this.#emit({
      type: 'user.message',
      messageId: next.clientMsgId,
      clientMsgId: next.clientMsgId,
      text: next.text,
      ...(attachments.length === 0 ? {} : { attachments }),
    });
    this.#setState('running');
    this.#heartbeat.start();
    const generation = this.#generation;
    const stale = (): boolean => generation !== this.#generation || this.#closed;
    try {
      await this.#ensureLoaded();
      if (stale()) return;
      if (compact) {
        // 回 {}，这一轮的 id 从 turn/started 来；之后和普通一轮一样以 turn/completed 结束
        await this.#client.call('thread/compact/start', { threadId: this.sessionId });
        if (stale()) return;
        if (this.#stopping) await this.#interrupt();
        return;
      }
      const input = await this.#withSkill(toUserInput(next.text, next.content));
      if (stale()) return;
      const result = await this.#client.call('turn/start', {
        threadId: this.sessionId,
        clientUserMessageId: next.clientMsgId,
        cwd: this.#cwd,
        input,
        approvalsReviewer: 'user',
        ...(this.#model === CODEX_DEFAULT_MODEL || this.#model === '' ? {} : { model: this.#model }),
        ...(this.#effort === undefined ? {} : { effort: this.#effort }),
        ...(this.#mode === undefined ? {} : turnModeParams(this.#mode)),
      });
      if (stale()) return;
      const turn = isRecord(result) ? result['turn'] : undefined;
      const id = isRecord(turn) ? str(turn['id']) : undefined;
      if (id !== undefined) this.#turnId ??= id;
      // turn/start 的 await 期间用户点了停止：那时还没有 turnId，补一次中断
      if (this.#stopping) await this.#interrupt();
    } catch (err) {
      // 这一轮已经结束了（比如进程退出时已报过），迟到的异常不能算到下一轮头上
      if (stale()) return;
      this.#failTurn('other', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * 消息以 `/name` 或 `$name` 开头且 name 是这个目录下的 skill：按 Codex 的形式调用，文本写成
   * `$name …` 并带上 skill 条目。读不到 skill 列表或没有这个 skill 就原样当普通消息发。
   */
  async #withSkill(input: unknown[]): Promise<unknown[]> {
    const first = input.find((part): part is Rec => isRecord(part) && part['type'] === 'text');
    const text = first === undefined ? undefined : str(first['text']);
    const match = text === undefined ? null : SKILL_INVOCATION.exec(text);
    if (first === undefined || text === undefined || match === null) return input;
    const name = match[1]!;
    const skills = await this.#client.skills(this.#cwd).catch((): CodexSkill[] => []);
    const skill = skills.find((s) => s.name === name);
    if (skill === undefined) return input;
    first['text'] = `$${name}${text.slice(match[0].length)}`;
    return [...input, { type: 'skill', name: skill.name, path: skill.path }];
  }

  /** 这个模型支持才用；模型目录没拿到时信任调用方（不支持的话 Codex 会在 turn/start 报错并显示） */
  #supportedEffort(effort: string | undefined): string | undefined {
    if (effort === undefined) return undefined;
    const catalog = this.#client.effortsOf(this.#model);
    return catalog === undefined || catalog.efforts.includes(effort) ? effort : undefined;
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    const response = await this.#client.call('thread/resume', {
      threadId: this.sessionId,
      excludeTurns: true,
      cwd: this.#cwd,
      approvalsReviewer: 'user',
      ...(this.#model === CODEX_DEFAULT_MODEL || this.#model === '' ? {} : { model: this.#model }),
      ...(this.#mode === undefined ? {} : threadModeParams(this.#mode)),
    });
    this.#loaded = true;
    // 没指定模式时如实回报这个 thread 自己的设置，但不拿它去覆盖：它可能比标准档更严
    // （如禁写 /tmp），按档位重发会放宽。对不上任何一档就不带 engineMode
    if (this.#mode === undefined) {
      this.#reportedMode = modeFromThreadResponse(response);
      if (this.#reportedMode !== undefined) this.#legacyMode = legacyFromMode(this.#reportedMode);
    }
    this.#reportedEffort = isRecord(response) ? str(response['reasoningEffort']) : undefined;
    if (isRecord(response) && typeof response['model'] === 'string' && response['model'] !== '') {
      this.#model = response['model'];
    }
    this.#onMeta?.(this.meta());
  }

  onNotification(method: string, params: Rec): void {
    switch (method) {
      case 'turn/started': {
        const turn = params['turn'];
        const id = isRecord(turn) ? str(turn['id']) : undefined;
        if (id !== undefined) this.#turnId = id;
        // 压缩的 turn id 只从这里来：之前点的停止当时没有 id 可中断，这里补上
        if (this.#stopping && this.#running) void this.#interrupt();
        return;
      }
      case 'item/agentMessage/delta': {
        const itemId = str(params['itemId']);
        const delta = str(params['delta']);
        if (itemId === undefined || delta === undefined) return;
        this.#heartbeat.noteActivity();
        this.#touch();
        this.#emit({ type: 'assistant.delta', messageId: itemId, text: delta });
        return;
      }
      case 'item/started':
        this.#itemStarted(params['item']);
        return;
      case 'item/completed':
        this.#itemCompleted(params['item']);
        return;
      case 'thread/tokenUsage/updated':
        this.#tokenUsage(params['tokenUsage']);
        return;
      case 'error': {
        // willRetry 是可恢复的；不可恢复的错误随后由 turn/completed 带来，不在这里重复报
        if (params['willRetry'] !== true) return;
        const error = params['error'];
        const message = isRecord(error) ? str(error['message']) : undefined;
        this.#emit({ type: 'error.transient', attempt: 1, reason: toSingleLine(message ?? 'Codex 正在重试', 200) });
        return;
      }
      case 'serverRequest/resolved':
        this.#requestResolved(this.sessionId, params['requestId']);
        return;
      case 'turn/completed':
        this.#turnCompleted(params['turn']);
        return;
      default:
        return;
    }
  }

  /** Codex 不再等某个请求了（别处回了 / 撤了）：按 (thread, 请求 id) 找，不跨 thread 误伤 */
  #requestResolved(threadId: string, requestId: unknown): void {
    const key = this.#requestKey(threadId, requestId);
    let found = false;
    for (const pending of [...this.#pending.values()]) {
      if (pending.key === key) {
        found = true;
        this.#invalidate(pending, 'Codex 已不再等待这个决定');
      }
    }
    // 请求还没发布（归属 / diff 还在查）就先被撤了：记下，发布前会看到（评审 高2）
    if (!found) this.#remember(key, null);
  }

  /** 已了结记录的键：进程代际 + thread + 原始请求 id（请求 id 在一个连接内唯一） */
  #requestKey(threadId: string, rpcId: unknown): string {
    return `${this.#procGen}|${threadId}|${JSON.stringify(rpcId) ?? ''}`;
  }

  #remember(key: string, result: unknown): void {
    if (this.#handled.has(key)) return;
    this.#handled.set(key, result);
    while (this.#handled.size > MAX_HANDLED) {
      const oldest = this.#handled.keys().next();
      if (oldest.done === true) break;
      this.#handled.delete(oldest.value);
    }
  }

  #turnKey(threadId: string, turnId: string): string {
    return `${this.#procGen}|${threadId}|${turnId}`;
  }

  ownsTurn(turnId: string): boolean {
    return this.#running && this.#turnId !== undefined && this.#turnId === turnId;
  }

  /**
   * 子 agent thread 的通知（spike S2：同一连接、带子 threadId）。只做三件事：派生卡上的子 agent
   * 状态、子 thread 审批的撤销 / 作废、子 thread 改文件的 diff。**不结束本会话的轮**——子 thread
   * 的 turn/completed 以前若漏进 #turnCompleted 会把父轮提前收掉。
   */
  onChildNotification(childThreadId: string, method: string, params: Rec): void {
    const direct = this.#childAgents.has(childThreadId) ? childThreadId : this.#descendants.get(childThreadId);
    switch (method) {
      case 'turn/started': {
        const turn = params['turn'];
        const turnId = isRecord(turn) ? str(turn['id']) : undefined;
        if (turnId !== undefined) this.#childTurns.set(childThreadId, turnId);
        if (direct === childThreadId) this.#setChildState(childThreadId, 'running');
        return;
      }
      case 'turn/completed': {
        const turn = params['turn'];
        const turnId = isRecord(turn) ? str(turn['id']) : undefined;
        const status = isRecord(turn) ? turn['status'] : undefined;
        if (turnId !== undefined) {
          this.#endedTurns.add(this.#turnKey(childThreadId, turnId));
          while (this.#endedTurns.size > MAX_HANDLED) {
            const oldest = this.#endedTurns.values().next();
            if (oldest.done === true) break;
            this.#endedTurns.delete(oldest.value);
          }
        }
        if (turnId === undefined || this.#childTurns.get(childThreadId) === turnId) this.#childTurns.delete(childThreadId);
        // 这一轮挂着的审批 Codex 不会再要了
        for (const pending of [...this.#pending.values()]) {
          if (pending.threadId === childThreadId && (turnId === undefined || pending.turnId === undefined || pending.turnId === turnId)) {
            this.#invalidate(pending, '子 agent 的这一轮已结束');
          }
        }
        for (const [id, item] of this.#childFileChanges) if (item['__thread'] === childThreadId) this.#childFileChanges.delete(id);
        if (direct === childThreadId) {
          const state: SubagentState = status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : 'completed';
          this.#setChildState(childThreadId, state);
        }
        return;
      }
      case 'thread/status/changed': {
        const status = params['status'];
        const type = isRecord(status) ? status['type'] : undefined;
        if (direct !== childThreadId) return;
        if (type === 'active') this.#setChildState(childThreadId, 'running');
        else if (type === 'systemError') this.#setChildState(childThreadId, 'failed');
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const item = params['item'];
        if (!isRecord(item)) return;
        const id = str(item['id']);
        if (method === 'item/started' && item['type'] === 'fileChange' && id !== undefined) {
          this.#childFileChanges.set(id, { ...item, __thread: childThreadId });
          while (this.#childFileChanges.size > MAX_CHILD_AGENTS) {
            const oldest = this.#childFileChanges.keys().next();
            if (oldest.done === true) break;
            this.#childFileChanges.delete(oldest.value);
          }
        }
        if (method === 'item/completed' && id !== undefined) this.#childFileChanges.delete(id);
        // 孙辈：审批卡的来源标到它所属的直接子 agent 上
        const owner = direct ?? childThreadId;
        for (const spawn of spawnOf(item)) {
          if (!this.#childAgents.has(spawn.childThreadId)) this.#descendants.set(spawn.childThreadId, owner);
        }
        while (this.#descendants.size > MAX_CHILD_AGENTS) {
          const oldest = this.#descendants.keys().next();
          if (oldest.done === true) break;
          this.#descendants.delete(oldest.value);
        }
        return;
      }
      case 'serverRequest/resolved':
        this.#requestResolved(childThreadId, params['requestId']);
        return;
      default:
        return;
    }
  }

  #itemStarted(item: unknown): void {
    if (!isRecord(item)) return;
    const id = str(item['id']);
    if (id === undefined) return;
    if (item['type'] === 'fileChange') this.#fileChanges.set(id, item);
    // 已知子 agent 的后续动态：并进它的派生卡，不另出卡
    if (this.#mergeChildActivity(item, false)) return;
    const converted = codexItemToHistory(item, this.#now());
    if (converted?.kind !== 'tool') return;
    const subagent = this.#rememberSpawns(item, converted.argSummary, converted.subagent) ?? converted.subagent;
    this.#touch();
    this.#inFlightTools.set(id, this.#now());
    this.#heartbeat.noteToolStart(id, converted.toolName);
    this.#emit({
      type: 'tool.start',
      toolUseId: id,
      toolName: converted.toolName,
      argSummary: converted.argSummary,
      ...(converted.filePath === undefined ? {} : { filePath: converted.filePath }),
      ...(converted.argDetail === undefined ? {} : { argDetail: converted.argDetail }),
      ...(subagent === undefined ? {} : { subagent }),
    });
  }

  /**
   * 派生 item（subAgentActivity started / spawnAgent）：记下子 thread → 派生卡，返回卡上该带的
   * 子 agent 信息；第一次见到某个子 agent 时去查昵称 / 角色。不是派生返回 undefined。
   */
  #rememberSpawns(item: Rec, argSummary: string, info: SubagentInfo | undefined): SubagentInfo | undefined {
    const spawns = spawnOf(item);
    if (spawns.length === 0) return undefined;
    let current: SubagentInfo | undefined;
    for (const { childThreadId, cardId } of spawns) {
      const known = this.#childAgents.get(childThreadId);
      if (known !== undefined && known.cardId === cardId) {
        // 已记过（item/started 之后的 item/completed）：保留之后更新过的状态（同一个对象，
        // 在途的昵称查询还认得它）
        known.info = { ...info, ...known.info };
        if (spawns.length === 1) current = known.info;
        continue;
      }
      const merged: SubagentInfo = { agentId: childThreadId.slice(-64), ...info };
      const agent: ChildAgent = { cardId, argSummary, info: merged, described: false };
      this.#childAgents.delete(childThreadId);
      this.#childAgents.set(childThreadId, agent);
      while (this.#childAgents.size > MAX_CHILD_AGENTS) {
        const oldest = this.#childAgents.keys().next();
        if (oldest.done === true) break;
        this.#childAgents.delete(oldest.value);
      }
      if (spawns.length === 1) current = merged;
      if (!agent.described) this.#describeChild(childThreadId, agent);
    }
    return current;
  }

  /** 查子 agent 的昵称 / 角色 / 模型，查到就更新派生卡（模型以 subAgentActivity 给的为准） */
  #describeChild(childThreadId: string, agent: ChildAgent): void {
    agent.described = true;
    const describe = this.#client.describeThread;
    if (describe === undefined) return;
    void describe
      .call(this.#client, childThreadId)
      .then((found) => {
        if (found === undefined || this.#closed || this.#childAgents.get(childThreadId) !== agent) return;
        const labels = subagentLabels(found);
        const next: SubagentInfo = { ...agent.info, ...labels, ...(agent.info.model === undefined ? {} : { model: agent.info.model }) };
        if (JSON.stringify(next) === JSON.stringify(agent.info)) return;
        agent.info = next;
        this.#emitChildCard(agent);
      })
      .catch(() => {});
  }

  /** 重发派生卡的 tool.start，只为更新子 agent 信息（client 原地合并，调用结果不动） */
  #emitChildCard(agent: ChildAgent): void {
    this.#emit({ type: 'tool.start', toolUseId: agent.cardId, toolName: 'SubAgent', argSummary: agent.argSummary, subagent: agent.info });
  }

  #setChildState(childThreadId: string, state: SubagentState): void {
    const agent = this.#childAgents.get(childThreadId);
    if (agent === undefined || agent.info.state === state) return;
    agent.info = { ...agent.info, state };
    this.#emitChildCard(agent);
  }

  /**
   * 子 agent 状态类的 item（非派生的 subAgentActivity、带 agentsStates 的 collab 调用）：
   * 更新已知子 agent 的派生卡。返回 true = 这条 item 已并进派生卡，不必另出卡（只有
   * subAgentActivity 会这样；collab 调用本身照常成卡）。
   */
  #mergeChildActivity(item: Rec, completed: boolean): boolean {
    const activity = item['type'] === 'subAgentActivity' && item['kind'] !== 'started';
    // collab 调用的 agentsStates 只看完成时的（进行中的那份多半是空的）
    if (!activity && !completed) return false;
    let merged = false;
    for (const [child, state] of childStatesOf(item)) {
      if (!this.#childAgents.has(child)) continue;
      this.#setChildState(child, state);
      merged = true;
    }
    return activity && merged;
  }

  #itemCompleted(item: unknown): void {
    if (!isRecord(item)) return;
    const id = str(item['id']);
    if (id === undefined) return;
    if (item['type'] === 'agentMessage') {
      this.#heartbeat.noteActivity();
      this.#emit({ type: 'assistant.done', messageId: id, text: str(item['text']) ?? '' });
      return;
    }
    if (this.#mergeChildActivity(item, true)) {
      // 它的 item/started 也被并掉了，没有在途卡要收
      this.#inFlightTools.delete(id);
      return;
    }
    const converted = codexItemToHistory(item, this.#now());
    if (converted?.kind !== 'tool') return;
    const subagent = this.#rememberSpawns(item, converted.argSummary, converted.subagent) ?? converted.subagent;
    const startedAt = this.#inFlightTools.get(id);
    this.#inFlightTools.delete(id);
    this.#fileChanges.delete(id);
    this.#toolCount += 1;
    this.#heartbeat.noteToolEnd(id);
    this.#touch();
    this.#emit({
      type: 'tool.end',
      toolUseId: id,
      status: converted.status ?? 'ok',
      durationMs: converted.durationMs ?? (startedAt === undefined ? 0 : Math.max(0, Math.round(this.#now() - startedAt))),
      resultSummary: converted.resultSummary ?? '',
      ...(converted.outputPreview === undefined ? {} : { outputPreview: converted.outputPreview }),
      ...(subagent === undefined ? {} : { subagent }),
    });
  }

  #tokenUsage(usage: unknown): void {
    if (!isRecord(usage) || !isRecord(usage['last'])) return;
    const used = usage['last']['totalTokens'];
    const max = usage['modelContextWindow'];
    if (typeof used !== 'number' || used < 0 || typeof max !== 'number' || max <= 0) return;
    this.#context = {
      usedTokens: Math.round(used),
      maxTokens: Math.round(max),
      percent: (used / max) * 100,
      at: this.#now(),
    };
  }

  #turnCompleted(turn: unknown): void {
    if (!isRecord(turn)) return;
    const id = str(turn['id']);
    // 其他轮的迟到通知（比如上一轮被中断后才到）不算这一轮结束。新一轮的 turn id 还没到时，
    // 靠「刚结束的那一轮」认出重复通知
    if (!this.#running || (this.#turnId !== undefined && id !== undefined && id !== this.#turnId)) return;
    if (id !== undefined && id === this.#lastCompletedTurnId) return;
    if (id !== undefined) this.#lastCompletedTurnId = id;
    const status = turn['status'];
    if (status === 'failed') {
      const error = turn['error'];
      this.#failTurn(
        errorKind(isRecord(error) ? error['codexErrorInfo'] : undefined),
        (isRecord(error) ? str(error['message']) : undefined) ?? 'Codex 这一轮失败了',
      );
      return;
    }
    this.#endTurn();
    if (this.#stopping || status === 'interrupted') {
      this.#stopping = false;
      this.#setState('stopped');
      this.#continueOrIdle();
      return;
    }
    this.#emit({
      type: 'run.done',
      durationMs: Math.max(0, Math.round(this.#now() - this.#turnStartedAt)),
      costUsd: 0,
      costUnknown: true,
      toolCount: this.#toolCount,
      permissionCount: this.#permissionCount,
    });
    this.#setState('idle');
    // 子 agent 还在等批准（它的请求不随本轮作废）：仍是等待批准
    if (this.#pending.size > 0) this.#setState('waiting_permission');
    this.#continueOrIdle();
  }

  #failTurn(kind: 'quota' | 'auth' | 'config' | 'other', message: string): void {
    this.#log(`[codex] 会话 ${this.sessionId} 这一轮失败：${message}`);
    this.#endTurn();
    this.#emit({ type: 'error.fatal', kind, message: toSingleLine(message, 500) });
    this.#setState('error');
    this.#continueOrIdle();
  }

  /** 这一轮结束的共同收尾：没跑完的工具卡收口，挂起的审批作废 */
  #endTurn(): void {
    this.#heartbeat.stop();
    for (const id of this.#inFlightTools.keys()) {
      this.#emit({ type: 'tool.end', toolUseId: id, status: 'warn', durationMs: 0, resultSummary: '已中断' });
    }
    this.#inFlightTools.clear();
    this.#fileChanges.clear();
    // 只作废本会话 thread 的：子 agent 的请求属于它自己的轮，由它的 turn/completed 处理
    for (const pending of [...this.#pending.values()]) {
      if (pending.threadId === this.sessionId) this.#invalidate(pending, '这一轮已结束');
    }
    this.#running = false;
    this.#generation += 1;
    this.#queue.setRunning(false);
    this.#turnId = undefined;
    this.#touch();
  }

  #continueOrIdle(): void {
    if (this.#closed) return;
    if (this.#queue.length > 0) void this.#runNext();
    else this.#onIdle?.();
  }

  onServerRequest(id: unknown, method: string, params: Rec, reply: (result: unknown) => void, childThreadId?: string): boolean {
    if (this.#closed) return false;
    const threadId = childThreadId ?? this.sessionId;
    const key = this.#requestKey(threadId, id);
    // 重连 / 重放的同一个请求：已有卡片，不再出第二张（回复仍走原来那张卡的 reply）
    for (const pending of this.#pending.values()) {
      if (pending.key === key) return true;
    }
    if (this.#handled.has(key)) {
      // 已经了结过：答过的照原样再回一次，被撤销 / 作废的不再理会（评审 中3）
      const previous = this.#handled.get(key);
      if (previous !== null && previous !== undefined) reply(previous);
      return true;
    }
    const turnId = str(params['turnId']);
    // 子 thread 的这一轮已经结束：Codex 不会再等这个请求（评审 高2：归属查询期间轮结束了）
    if (childThreadId !== undefined && turnId !== undefined && this.#endedTurns.has(this.#turnKey(threadId, turnId))) return true;
    const card = childThreadId === undefined ? undefined : this.#cardOf(childThreadId);
    const origin: RequestOrigin = {
      threadId,
      turnId,
      parentToolUseId: card,
      // 对不上派生卡（rootTurnId / thread/read 认的亲）：仍要标明来自子 agent（评审 中8）
      subagentId: childThreadId !== undefined && card === undefined ? childThreadId.slice(-128) : undefined,
      key,
    };
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const command = unwrapShellCommand(str(params['command']) ?? '');
        this.#request(origin, id, 'Shell', {
          command,
          ...(str(params['cwd']) === undefined ? {} : { cwd: str(params['cwd']) }),
          ...(str(params['reason']) === undefined ? {} : { reason: str(params['reason']) }),
        }, optionsFrom(params['availableDecisions']), reply, (verdict, optionId) => ({
          decision: verdict === 'deny' ? 'decline' : optionId === ALLOW_SESSION.id ? 'acceptForSession' : 'accept',
        }));
        return true;
      }
      case 'item/fileChange/requestApproval': {
        // diff 只在 item/started 里：子 thread 的另记一份（不随本会话的轮清掉）
        const itemId = str(params['itemId']) ?? '';
        const item = childThreadId === undefined ? this.#fileChanges.get(itemId) : this.#childFileChanges.get(itemId);
        if (item !== undefined) {
          this.#fileChangeRequest(origin, id, params, item, reply);
          return true;
        }
        // 没收到 item/started（归属确定前的通知丢了 / 乱序）：补读一次，补不到也不给可批准的空白卡（评审 高2）
        const gen = this.#procGen;
        void this.#lookupFileChange(threadId, itemId).then((found) => {
          if (gen !== this.#procGen || this.#closed) return;
          // 补读期间 Codex 可能已撤销、轮已结束或已有卡片：发布前再查一遍
          if (this.#handled.has(key) || [...this.#pending.values()].some((p) => p.key === key)) return;
          if (turnId !== undefined && this.#endedTurns.has(this.#turnKey(threadId, turnId))) return;
          this.#fileChangeRequest(origin, id, params, found, reply);
        });
        return true;
      }
      case 'item/permissions/requestApproval': {
        const requested = isRecord(params['permissions']) ? params['permissions'] : {};
        const granted: Rec = {};
        for (const [key, value] of Object.entries(requested)) if (value !== null) granted[key] = value;
        this.#request(origin, id, 'Permissions', {
          ...(str(params['reason']) === undefined ? {} : { reason: str(params['reason']) }),
          permissions: requested,
        }, [ALLOW_ONCE, ALLOW_SESSION, DENY], reply, (verdict, optionId) =>
          verdict === 'deny'
            ? { permissions: {}, scope: 'turn' }
            : { permissions: granted, scope: optionId === ALLOW_SESSION.id ? 'session' : 'turn' },
        );
        return true;
      }
      case 'mcpServer/elicitation/request': {
        // 还没有对应的界面：拒绝并留一条说明，否则这一轮会一直等下去
        this.#emit({
          type: 'error.transient',
          attempt: 1,
          reason: toSingleLine(`MCP 服务 ${str(params['serverName']) ?? ''} 请求输入，trine 暂不支持，已拒绝`, 200),
        });
        reply({ action: 'decline', content: null, _meta: null });
        return true;
      }
      default:
        return false;
    }
  }

  /** 改文件审批卡；没有 diff（item 为 undefined）时说明无法预览，只给拒绝 */
  #fileChangeRequest(origin: RequestOrigin, rpcId: unknown, params: Rec, item: Rec | undefined, reply: (result: unknown) => void): void {
    const changes = Array.isArray(item?.['changes']) ? (item['changes'] as unknown[]).filter(isRecord) : [];
    const paths = changes.map((c) => str(c['path'])).filter((p) => p !== undefined);
    const preview = paths.length > 0;
    this.#request(origin, rpcId, 'Edit', {
      file_path: !preview ? NO_PREVIEW : paths.length === 1 ? paths[0]! : `${paths[0]} 等 ${paths.length} 个文件`,
      new_string: changes.map((c) => str(c['diff']) ?? '').join('\n'),
      ...(str(params['reason']) === undefined ? {} : { reason: str(params['reason']) }),
      ...(str(params['grantRoot']) === undefined ? {} : { grantRoot: str(params['grantRoot']) }),
    }, preview ? [ALLOW_ONCE, ALLOW_SESSION, DENY] : [DENY], reply, (verdict, optionId) => ({
      decision: verdict === 'deny' ? 'decline' : optionId === ALLOW_SESSION.id ? 'acceptForSession' : 'accept',
    }));
  }

  /** 从 thread 的 item 里补读改文件的 item（限时）；读不到 undefined */
  async #lookupFileChange(threadId: string, itemId: string): Promise<Rec | undefined> {
    if (itemId === '') return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), DIFF_LOOKUP_TIMEOUT_MS);
    });
    try {
      const items = await Promise.race([this.#client.readItems(threadId), timeout]);
      const found = items?.find((it) => isRecord(it) && it['id'] === itemId && it['type'] === 'fileChange');
      return isRecord(found) ? found : undefined;
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 子 agent thread（含孙辈）在本会话时间线上的派生卡；不知道 undefined */
  #cardOf(threadId: string): string | undefined {
    const direct = this.#childAgents.has(threadId) ? threadId : this.#descendants.get(threadId);
    return direct === undefined ? undefined : this.#childAgents.get(direct)?.cardId;
  }

  #request(
    origin: RequestOrigin,
    rpcId: unknown,
    toolName: string,
    input: Record<string, unknown>,
    options: PermissionOption[],
    reply: (result: unknown) => void,
    decide: PendingApproval['decide'],
  ): void {
    // 不用计数器：会话重建后会重复，迟到的旧应答可能批准到新请求上
    const requestId = `codex-${randomUUID()}`;
    const requestedAt = this.#now();
    this.#pending.set(requestId, { requestId, rpcId, ...origin, toolName, input, requestedAt, options, decide, reply });
    this.#permissionCount += 1;
    if (this.#running) this.#heartbeat.setPhase('wait');
    this.#emit({
      type: 'permission.request',
      requestId,
      toolName,
      input,
      requestedAt,
      options,
      // 来自子 agent：client 在卡上标「来自子 agent：<派生卡描述>」
      ...(origin.parentToolUseId === undefined ? {} : { parentToolUseId: origin.parentToolUseId }),
      ...(origin.subagentId === undefined ? {} : { subagentId: origin.subagentId }),
    });
    this.#setState('waiting_permission');
    // 同状态下新增挂起项也要广播 meta（waitingFor）
    this.#onMeta?.(this.meta());
  }

  respondPermission(verdict: PermissionVerdict): boolean {
    this.#touch();
    const pending = this.#pending.get(verdict.requestId);
    if (pending === undefined) return false;
    this.#pending.delete(verdict.requestId);
    // Codex 不能改参数后执行。旧版网页可能发来「改了参数的批准」：放行就等于执行用户已经改掉的
    // 原命令，所以按拒绝处理，并说清楚
    const edited = verdict.verdict === 'allow' && verdict.updatedInput !== undefined;
    // 卡上只给了拒绝（如改文件看不到 diff）：旧标签页 / 手工帧发来的批准也按拒绝
    const allowOffered = pending.options.some((o) => o.kind !== 'reject');
    const effective = edited || !allowOffered ? 'deny' : verdict.verdict;
    if (edited) {
      this.#emit({ type: 'error.transient', attempt: 1, reason: 'Codex 不支持改参数后批准，已拒绝这次请求' });
    }
    // optionId 只能细化「批准」：不认识的选项按单次批准，绝不放宽
    const optionId = pending.options.some((o) => o.id === verdict.optionId) ? verdict.optionId : undefined;
    const result = pending.decide(effective, optionId);
    this.#remember(pending.key, result);
    pending.reply(result);
    this.#emit({
      type: 'permission.resolved',
      requestId: verdict.requestId,
      verdict: effective,
      ...(verdict.resolvedBy === undefined ? {} : { resolvedBy: verdict.resolvedBy }),
    });
    this.#afterPendingChanged();
    return true;
  }

  #invalidate(pending: PendingApproval, reason: string): void {
    if (!this.#pending.delete(pending.requestId)) return;
    this.#remember(pending.key, null);
    this.#emit({ type: 'permission.invalidated', requestId: pending.requestId, reason });
    this.#afterPendingChanged();
  }

  #afterPendingChanged(): void {
    if (this.#pending.size > 0 || this.#state !== 'waiting_permission') return;
    // 子 agent 的审批可能在本会话没有轮在跑时到来（它比派生它的轮活得久）：了结后回到空闲
    if (!this.#running) {
      this.#setState('idle');
      return;
    }
    this.#heartbeat.setPhase('run');
    this.#setState('running');
  }

  async stop(): Promise<void> {
    this.#touch();
    for (const dropped of this.#queue.clear()) {
      this.#attachments.delete(dropped.clientMsgId);
      this.#emit({ type: 'input.cancelled', clientMsgId: dropped.clientMsgId, reason: 'stopped' });
    }
    // 先了结全部审批（含子 agent 的）：父轮已结束时子审批可能还挂着（评审 中4）
    for (const pending of [...this.#pending.values()]) {
      const result = pending.decide('deny', undefined);
      this.#remember(pending.key, result);
      pending.reply(result);
      this.#invalidate(pending, '用户停止了当前任务');
    }
    // 还在跑的子 agent 轮也一并中断（中断父轮不保证带停子 thread）
    const childTurns = [...this.#childTurns];
    this.#childTurns.clear();
    const interrupts = childTurns.map(([threadId, turnId]) =>
      this.#client.call('turn/interrupt', { threadId, turnId }).catch(() => {
        // 子 thread 可能已经结束 / 卸载：不打扰用户
      }),
    );
    if (!this.#running) {
      this.#setState('stopped');
      await Promise.all(interrupts);
      return;
    }
    this.#stopping = true;
    await Promise.all([this.#interrupt(), ...interrupts]);
  }

  async #interrupt(): Promise<void> {
    if (this.#turnId === undefined) return;
    await this.#client.call('turn/interrupt', { threadId: this.sessionId, turnId: this.#turnId }).catch((err: unknown) => {
      this.#emit({
        type: 'error.transient',
        attempt: 1,
        reason: toSingleLine(`中断请求失败：${err instanceof Error ? err.message : String(err)}`),
      });
    });
  }

  async setPermissionMode(mode: PermissionMode, engineMode?: string): Promise<void> {
    this.#touch();
    // 下一轮 turn/start 带上。不认识的值按旧枚举映射，不会变成更宽的权限
    this.#mode = isCodexMode(engineMode) ? engineMode : modeFromLegacy(mode);
    this.#legacyMode = legacyFromMode(this.#mode);
    this.#onMeta?.(this.meta());
  }

  setCwd(cwd: string): void {
    this.#touch();
    this.#cwd = cwd;
    this.#onMeta?.(this.meta());
  }

  async setModel(model: string): Promise<void> {
    this.#touch();
    this.#model = model;
    // 新模型不支持当前强度：回到它的默认值，否则之后每一轮都会被拒绝
    if (this.#effort !== undefined && this.#supportedEffort(this.#effort) === undefined) {
      this.#effort = this.#client.effortsOf(model)?.defaultEffort;
    }
    this.#onMeta?.(this.meta());
  }

  async setEffort(effort: string | undefined): Promise<void> {
    this.#touch();
    // turn/start 的 effort 对后续轮次都生效，不传不能撤销之前的选择，所以「默认」要写成具体值
    this.#effort = effort === undefined ? this.#client.effortsOf(this.#model)?.defaultEffort : (this.#supportedEffort(effort) ?? this.#effort);
    if (effort === undefined && this.#effort === undefined) this.#reportedEffort = undefined;
    this.#onMeta?.(this.meta());
  }

  #rewindBusy(): string | undefined {
    if (this.#running || this.#pending.size > 0) return '这一轮还在进行，等它结束或先停止';
    if (this.#queue.length > 0) return '还有排队的消息，先撤回或等它们发完';
    return undefined;
  }

  /** 在 thread 的 item 里找到目标消息所在的轮；被撤掉的是整轮，所以它必须是这一轮的第一条用户消息 */
  async #locateTurn(targetMessageId: string): Promise<{ ok: true; turnId: string; text: string; ids: string[] } | RewindFailure> {
    let items: unknown[];
    try {
      items = await this.#client.readItems(this.sessionId);
    } catch (err) {
      if (err instanceof AppServerError && err.code === METHOD_NOT_FOUND) {
        return rewindFail('unavailable', '这个会话是旧格式（legacy thread），Codex 不支持回退它');
      }
      return rewindFail('io', `读取会话失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const users = items.filter((item): item is Rec => isRecord(item) && item['type'] === 'userMessage');
    const target = users.find((item) => item['id'] === targetMessageId || item['clientId'] === targetMessageId);
    if (target === undefined) return rewindFail('not_found', '对话里找不到这条消息（可能已经被回退）');
    const turnId = str(target['turnId']);
    if (turnId === undefined) return rewindFail('unavailable', 'Codex 没有给出这条消息所在的轮次');
    if (users.find((item) => item['turnId'] === turnId) !== target) {
      return rewindFail('invalid', '这条消息是在一轮进行中追加的，只能回退到这一轮的开头');
    }
    const converted = codexItemToHistory(target, 0);
    const ids = [targetMessageId, str(target['id']), str(target['clientId'])].filter((id) => id !== undefined);
    return { ok: true, turnId, text: converted?.kind === 'user' ? converted.text : '', ids: [...new Set(ids)] };
  }

  async previewThreadRewind(targetMessageId: string): Promise<RewindPreview | RewindFailure> {
    const busy = this.#rewindBusy();
    if (busy !== undefined) return rewindFail('busy', busy);
    const located = await this.#locateTurn(targetMessageId);
    if (!located.ok) return located;
    return {
      ok: true,
      text: located.text,
      conversation: { available: true },
      files: { available: false, reason: 'Codex 没有文件快照，文件保持现状' },
    };
  }

  async rewindThread(targetMessageId: string, mode: RewindMode): Promise<RewindDone | RewindFailure> {
    // 能力在 agent 端强制：旧标签页可能还发 code / both
    if (mode !== 'conversation') return rewindFail('unavailable', 'Codex 只能回退对话，不能还原文件');
    const busy = this.#rewindBusy();
    if (busy !== undefined) return rewindFail('busy', busy);
    const located = await this.#locateTurn(targetMessageId);
    if (!located.ok) return located;
    try {
      // 等待期间实例可能被回收：thread 已归别的实例或已卸载，不能再动它
      if (this.#closed) return rewindFail('busy', '会话刚被回收，请重试');
      await this.#ensureLoaded();
      if (this.#closed) return rewindFail('busy', '会话刚被回收，请重试');
      await this.#client.call('thread/revert', { threadId: this.sessionId, beforeTurnId: located.turnId });
    } catch (err) {
      return rewindFail('io', `Codex 回退失败：${err instanceof Error ? err.message : String(err)}`);
    }
    this.#touch();
    this.#log(`[codex] 会话 ${this.sessionId} 回退到轮次 ${located.turnId} 之前`);
    return { ok: true, text: located.text, rewound: { targetMessageIds: located.ids, mode } };
  }

  /**
   * app-server 退出（崩溃或 agent 关停）：thread 要重新加载，下一条消息会 resume。
   *
   * 旧进程的一切都作废（评审 高1 / 中7）：挂着的审批（含子 agent 的——它们的 reply 已经回不到
   * 新进程，新进程又会复用同样的请求 id）、子 thread 的轮与 diff；进程代际加一，已了结记录随之
   * 隔离。还在跑的子 agent 随进程一起没了，派生卡收口成「状态未知」，不永远转圈。
   */
  onExit(): void {
    this.#loaded = false;
    for (const pending of [...this.#pending.values()]) this.#invalidate(pending, 'Codex 进程已退出，这个请求已失效');
    this.#procGen += 1;
    this.#handled.clear();
    this.#endedTurns.clear();
    this.#childTurns.clear();
    this.#childFileChanges.clear();
    this.#descendants.clear();
    for (const [child, agent] of this.#childAgents) {
      const state = agent.info.state;
      if (state === undefined || state === 'running' || state === 'pending') this.#setChildState(child, 'unknown');
    }
    this.#childAgents.clear();
    if (this.#running) this.#failTurn('other', 'Codex 进程意外退出，发消息可继续');
    else this.#onMeta?.(this.meta());
  }

  /** 子 agent 当前状态（子 thread id → 状态）：读历史时让仍在跑的派生卡不被判成「状态未知」 */
  childStates(): ReadonlyMap<string, SubagentState> {
    const out = new Map<string, SubagentState>();
    for (const [child, agent] of this.#childAgents) if (agent.info.state !== undefined) out.set(child, agent.info.state);
    return out;
  }

  async close(_reason?: string, _drainTimeoutMs?: number): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#heartbeat.stop();
    for (const dropped of this.#queue.clear()) {
      this.#emit({ type: 'input.cancelled', clientMsgId: dropped.clientMsgId, reason: 'closed' });
    }
    for (const pending of [...this.#pending.values()]) {
      pending.reply(pending.decide('deny', undefined));
      this.#invalidate(pending, '会话已关闭');
    }
    if (this.#running) await this.#interrupt();
    const wasLoaded = this.#loaded;
    this.#loaded = false;
    this.#generation += 1;
    this.#running = false;
    // 已被新实例接管就不能卸载：thread 正归新实例用
    const detached = this.#client.detach(this.sessionId, this);
    if (wasLoaded && detached) {
      // 卸载失败不要紧：进程退出时一起没了
      await this.#client.call('thread/unsubscribe', { threadId: this.sessionId }).catch(() => {});
    }
  }

  #touch(): void {
    this.#lastActivityAt = this.#now();
  }

  #setState(state: SessionState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#emit({ type: 'run.state', state });
    this.#onMeta?.(this.meta());
  }
}

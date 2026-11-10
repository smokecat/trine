/**
 * Codex 引擎（multi-engine，DECISIONS D20）：经 app-server 列会话、读历史、读限额，建和管理
 * thread；活跃会话见 session.ts。列会话、读历史不加载 thread，不占活跃名额。
 */
import type { EngineModel, EngineRateWindow, EngineSummary, HistoryItem, PermissionMode, SessionMeta, SlashCommand } from '@trine/core';
import type { CreateSessionArgs } from '../../bridge/manager.ts';
import { AppServerClient, AppServerError, type AppServerClientOptions, type SpawnAppServer } from './app-server.ts';
import { codexItemsToHistory, spawnOf, subagentLabels } from './history.ts';
import { CODEX_MODES, isCodexMode, legacyFromMode, threadModeParams, DEFAULT_CODEX_MODE } from './modes.ts';
import { CODEX_DEFAULT_MODEL, CODEX_ENGINE_ID } from './ids.ts';
import { CodexSession, type CodexSessionClient, type CodexSessionEvents, type CodexSkill } from './session.ts';

export { CODEX_ENGINE_ID };

const THREAD_PAGE = 100;
const THREAD_MAX_PAGES = 10;
const ITEM_PAGE = 200;
const ITEM_MAX_PAGES = 50;
/** 查无此 thread 的结果缓存：Claude 会话也会走到 owns()，别每次都问一遍 */
const NOT_OWNED_TTL_MS = 60_000;
/** 列会话时顺带刷新账号信息的最小间隔 */
const ACCOUNT_REFRESH_MS = 5 * 60_000;
const THREAD_NOT_FOUND_CODE = -32600;
/** 列表的等待上限：要小于 client 的请求超时，Codex 卡住也不能拖住 Claude 的列表 */
const LIST_WAIT_MS = 3_000;
/** thread/list 默认只给交互来源；exec 也要，标成临时会话。子 agent 的 thread 不列 */
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer'];
const METHOD_NOT_FOUND = -32601;
/** 子 thread 归属表上限（超了丢最早的；一个会话很少派生上百个子 agent） */
const MAX_CHILD_LINKS = 1000;
/** 查子 thread 父级 / 昵称的等待上限 */
const PARENT_LOOKUP_TIMEOUT_MS = 3_000;
/** 逐级上溯的层数上限 */
const MAX_SPAWN_DEPTH = 8;
/** 读历史时最多给多少个子 agent 查昵称 */
const HISTORY_DESCRIBE_MAX = 8;

/** thread 的父 thread：parentThreadId，或 source.subAgent.thread_spawn.parent_thread_id（spike S2） */
export function parentThreadOf(thread: Rec): string | undefined {
  const direct = str(thread['parentThreadId']);
  if (direct !== undefined) return direct;
  const source = thread['source'];
  const sub = isRecord(source) ? source['subAgent'] : undefined;
  const spawn = isRecord(sub) ? sub['thread_spawn'] : undefined;
  return isRecord(spawn) ? str(spawn['parent_thread_id']) : undefined;
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null;
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
function secToMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : undefined;
}

/** thread（thread/list、thread/read 的元素）→ SessionMeta；缺关键字段返回 undefined */
export function threadToMeta(thread: unknown): SessionMeta | undefined {
  if (!isRecord(thread)) return undefined;
  const sessionId = str(thread['id']);
  if (sessionId === undefined) return undefined;
  const preview = str(thread['preview']);
  const createdAt = secToMs(thread['createdAt']);
  const updatedAt = secToMs(thread['recencyAt']) ?? secToMs(thread['updatedAt']) ?? createdAt ?? 0;
  const git = thread['gitInfo'];
  const branch = isRecord(git) ? str(git['branch']) : undefined;
  return {
    sessionId,
    title: str(thread['name']) ?? preview ?? '',
    state: 'idle',
    lastActivityAt: updatedAt,
    cwd: str(thread['cwd']) ?? '',
    model: str(thread['model']) ?? '',
    // 只读阶段拿不到这个 thread 的权限设置；Codex 会话的真值之后放 engineMode
    permissionMode: 'default',
    costUsd: 0,
    engine: CODEX_ENGINE_ID,
    ...(preview === undefined ? {} : { lastEvent: preview, firstPrompt: preview }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(branch === undefined ? {} : { gitBranch: branch }),
    ...(thread['source'] === 'exec' ? { headless: true } : {}),
  };
}

function windowOf(raw: unknown, id: string, bucket: string | undefined): EngineRateWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const percent = raw['usedPercent'];
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return undefined;
  const duration = raw['windowDurationMins'];
  const resetsAt = secToMs(raw['resetsAt']);
  return {
    id,
    percent,
    ...(bucket === undefined ? {} : { bucket }),
    ...(typeof duration === 'number' && Number.isInteger(duration) && duration > 0 ? { durationMins: duration } : {}),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** account/rateLimits/read → 窗口列表。多个桶才标桶名，常见的单桶不占显示位置 */
export function rateWindows(response: unknown): EngineRateWindow[] {
  if (!isRecord(response)) return [];
  const byId = response['rateLimitsByLimitId'];
  const snapshots: [string, unknown][] = isRecord(byId) ? Object.entries(byId) : [['default', response['rateLimits']]];
  const multiple = snapshots.length > 1;
  const out: EngineRateWindow[] = [];
  for (const [limitId, snapshot] of snapshots) {
    if (!isRecord(snapshot)) continue;
    const bucket = multiple ? (str(snapshot['limitName']) ?? limitId).slice(0, 64) : undefined;
    for (const key of ['primary', 'secondary']) {
      const window = windowOf(snapshot[key], `${limitId}:${key}`.slice(0, 64), bucket);
      if (window !== undefined) out.push(window);
    }
  }
  return out.slice(0, 16);
}

/** model/list 的元素 → 目录条目；id 缺失或隐藏的模型不要 */
export function modelFromList(model: unknown): EngineModel | undefined {
  if (!isRecord(model) || model['hidden'] === true) return undefined;
  const id = str(model['id']);
  if (id === undefined) return undefined;
  const efforts = Array.isArray(model['supportedReasoningEfforts'])
    ? model['supportedReasoningEfforts']
        .map((e: unknown) => (isRecord(e) ? str(e['reasoningEffort']) : undefined))
        .filter((e): e is string => e !== undefined && e.length <= 32)
        .slice(0, 16)
    : [];
  const defaultEffort = str(model['defaultReasoningEffort']);
  return {
    id: id.slice(0, 128),
    label: (str(model['displayName']) ?? id).slice(0, 128),
    ...(efforts.length === 0 ? {} : { efforts }),
    ...(defaultEffort === undefined || defaultEffort.length > 32 ? {} : { defaultEffort }),
    ...(model['isDefault'] === true ? { isDefault: true } : {}),
  };
}

/** skills/list → 启用的 skill；一个目录一组，这里只问了一个目录 */
export function skillsFromList(response: unknown): CodexSkill[] {
  const entries = isRecord(response) && Array.isArray(response['data']) ? response['data'] : [];
  const out: CodexSkill[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry['skills'])) continue;
    for (const skill of entry['skills']) {
      if (!isRecord(skill) || skill['enabled'] === false) continue;
      const name = str(skill['name']);
      const path = str(skill['path']);
      if (name === undefined || path === undefined) continue;
      out.push({
        name,
        path,
        description: str(skill['shortDescription']) ?? str(skill['description']) ?? '',
        scope: str(skill['scope']) ?? '',
      });
    }
  }
  return out;
}

export type CodexClient = Pick<AppServerClient, 'call' | 'userAgent' | 'dispose'> &
  Partial<Pick<AppServerClient, 'hold' | 'release' | 'recycle'>>;

export interface CodexEngineOptions {
  /** 给了 client 就用它（只测目录时）；否则按 spawn 建一个，并接上通知与审批 */
  client?: CodexClient;
  spawn?: SpawnAppServer;
  clientVersion?: string;
  clientOptions?: Pick<AppServerClientOptions, 'callTimeoutMs' | 'idleMs' | 'startRetryMs'>;
  now?: () => number;
  log?: (line: string) => void;
  /** summary 变了（登录状态、版本、限额）：调用方广播 machine.info */
  onChange?: () => void;
}

export class CodexEngine implements CodexSessionClient {
  readonly #client: CodexClient;
  /** threadId → 活跃会话 */
  readonly #sessions = new Map<string, CodexSessionEvents>();
  /** 子 thread → 根会话 thread（见「子 thread」一节） */
  readonly #childRoot = new Map<string, string>();
  readonly #resolving = new Map<string, Promise<string | undefined>>();
  #models: EngineModel[] = [];
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #onChange: () => void;
  readonly #owned = new Map<string, SessionMeta>();
  readonly #notOwned = new Map<string, number>();
  #accountAt: number | undefined;
  #refreshing: Promise<void> | undefined;
  #unavailableReason: string | undefined;
  #windows: EngineRateWindow[] = [];
  #rateAt = 0;
  #version: string | undefined;
  /** 更新后探测到的版本：跑着的 app-server 可能还是旧的，界面要显示磁盘上已装好的 */
  #installedVersion: string | undefined;

  constructor(options: CodexEngineOptions) {
    this.#now = options.now ?? Date.now;
    this.#client =
      options.client ??
      new AppServerClient({
        spawn: options.spawn ?? (() => {
          throw new AppServerError('没有 codex 可执行文件');
        }),
        clientVersion: options.clientVersion ?? '0',
        ...options.clientOptions,
        now: this.#now,
        ...(options.log === undefined ? {} : { log: options.log }),
        onNotification: (method, params) => this.#onNotification(method, params),
        onServerRequest: (id, method, params, reply, fail) => this.#onServerRequest(id, method, params, reply, fail),
        onExit: () => {
          for (const session of this.#sessions.values()) session.onExit();
        },
      });
    this.#log = options.log ?? (() => {});
    this.#onChange = options.onChange ?? (() => {});
  }

  summary(): EngineSummary {
    return {
      id: CODEX_ENGINE_ID,
      displayName: 'Codex',
      ...((this.#installedVersion ?? this.#version) === undefined ? {} : { version: (this.#installedVersion ?? this.#version)! }),
      available: this.#unavailableReason === undefined,
      ...(this.#unavailableReason === undefined ? {} : { unavailableReason: this.#unavailableReason.slice(0, 300) }),
      capabilities: { interactive: true, rewind: ['conversation'], attachments: true, mutations: true, effort: true },
      ...(this.#models.length === 0 ? {} : { models: this.#models }),
      modes: CODEX_MODES,
      ...(this.#windows.length === 0 ? {} : { rateLimits: { windows: this.#windows, updatedAt: this.#rateAt } }),
    };
  }

  call(method: string, params: unknown): Promise<unknown> {
    return this.#client.call(method, params);
  }

  attach(threadId: string, session: CodexSessionEvents): void {
    if (!this.#sessions.has(threadId)) this.#client.hold?.();
    this.#sessions.set(threadId, session);
  }

  detach(threadId: string, session: CodexSessionEvents): boolean {
    if (this.#sessions.get(threadId) !== session) return false;
    this.#sessions.delete(threadId);
    for (const [child, root] of this.#childRoot) if (root === threadId) this.#childRoot.delete(child);
    this.#client.release?.();
    return true;
  }

  // -------------------------------------------------------------------------
  // 子 thread（multi-agent，spike S2）
  //
  // 子 agent 是独立的 thread，通知与审批走同一条连接、带子 threadId，但**没有 thread/started**。
  // 归属表「子 thread → 根会话」的来源（不猜最近活跃会话）：
  // 1. 会话 thread（或已知子 thread）上的派生 item：subAgentActivity started 的 agentThreadId、
  //    spawnAgent 的 receiverThreadIds——先于子 thread 的任何帧到达；
  // 2. thread/started 带 parentThreadId（防御：实测没有）；
  // 3. 未知 thread 的 turn/started：`turn.rootTurnId` 是某个活跃会话当前的 turn；
  // 4. 未知 thread 的审批：限时 thread/read 取 parentThreadId，逐级上溯到活跃会话。
  // 都查不到才回 -32601（与旧行为相同）。
  // -------------------------------------------------------------------------

  /** 记一条归属：parent 是活跃会话或已知子 thread 才记；返回根会话 id */
  #link(child: string, parent: string): string | undefined {
    if (child === parent || this.#sessions.has(child)) return undefined;
    const root = this.#sessions.has(parent) ? parent : this.#childRoot.get(parent);
    if (root === undefined || root === child) return undefined;
    if (this.#childRoot.get(child) === root) return root;
    this.#childRoot.delete(child);
    this.#childRoot.set(child, root);
    while (this.#childRoot.size > MAX_CHILD_LINKS) {
      const oldest = this.#childRoot.keys().next();
      if (oldest.done === true) break;
      this.#childRoot.delete(oldest.value);
    }
    return root;
  }

  /** 这个 thread 归哪个活跃会话（会话自己或它的子孙）；不知道 undefined */
  rootOf(threadId: string): string | undefined {
    return this.#sessions.has(threadId) ? threadId : this.#childRoot.get(threadId);
  }

  #learnLinks(method: string, threadId: string, params: Rec): void {
    if (method === 'item/started' || method === 'item/completed') {
      for (const spawn of spawnOf(params['item'])) this.#link(spawn.childThreadId, threadId);
      return;
    }
    if (method === 'thread/started') {
      const thread = params['thread'];
      const id = isRecord(thread) ? str(thread['id']) : undefined;
      const parent = isRecord(thread) ? parentThreadOf(thread) : undefined;
      if (id !== undefined && parent !== undefined) this.#link(id, parent);
      return;
    }
    if (method === 'turn/started' && this.rootOf(threadId) === undefined) {
      const turn = params['turn'];
      const rootTurn = isRecord(turn) ? str(turn['rootTurnId']) : undefined;
      if (rootTurn === undefined || (isRecord(turn) && turn['id'] === rootTurn)) return;
      for (const [id, session] of this.#sessions) {
        if (session.ownsTurn?.(rootTurn) === true) {
          this.#link(threadId, id);
          return;
        }
      }
    }
  }

  #onServerRequest(
    id: unknown,
    method: string,
    params: Rec,
    reply: (result: unknown) => void,
    fail: (code: number, message: string) => void,
  ): boolean {
    const threadId = str(params['threadId']);
    if (threadId === undefined) return false;
    const own = this.#sessions.get(threadId);
    if (own !== undefined) return own.onServerRequest(id, method, params, reply);
    const root = this.#childRoot.get(threadId);
    if (root !== undefined) return this.#sessions.get(root)?.onServerRequest(id, method, params, reply, threadId) ?? false;
    if (this.#sessions.size === 0) return false;
    // 归属未知：查过再决定，期间请求挂着（Codex 那边本来就在等用户）
    void this.#resolveRoot(threadId).then((found) => {
      const session = found === undefined ? undefined : this.#sessions.get(found);
      const handled = session?.onServerRequest(id, method, params, reply, threadId) ?? false;
      if (!handled) fail(METHOD_NOT_FOUND, 'not supported by this client');
    });
    return true;
  }

  /** 限时 thread/read 逐级上溯，找到活跃会话就记下归属；查不到 undefined。同一 thread 并发只查一次 */
  #resolveRoot(threadId: string): Promise<string | undefined> {
    const running = this.#resolving.get(threadId);
    if (running !== undefined) return running;
    const task = (async (): Promise<string | undefined> => {
      const chain: string[] = [threadId];
      let current = threadId;
      for (let depth = 0; depth < MAX_SPAWN_DEPTH; depth++) {
        const parent = await this.#readParent(current);
        if (parent === undefined) return undefined;
        const root = this.rootOf(parent);
        if (root !== undefined) {
          // 从上往下记，每一级的 parent 都已在表里
          for (let i = chain.length - 1; i >= 0; i--) this.#link(chain[i]!, i === chain.length - 1 ? parent : chain[i + 1]!);
          return this.rootOf(threadId);
        }
        chain.push(parent);
        current = parent;
      }
      return undefined;
    })()
      .catch(() => undefined)
      .finally(() => this.#resolving.delete(threadId));
    this.#resolving.set(threadId, task);
    return task;
  }

  async #readParent(threadId: string): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), PARENT_LOOKUP_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([this.#client.call('thread/read', { threadId }), timeout]);
      const thread = isRecord(result) ? result['thread'] : undefined;
      return isRecord(thread) ? parentThreadOf(thread) : undefined;
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 子 thread 的昵称 / 角色 / 模型（thread/read）；读不到 undefined */
  async describeThread(threadId: string): Promise<{ nickname?: string; role?: string; model?: string } | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), PARENT_LOOKUP_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([this.#client.call('thread/read', { threadId }), timeout]);
      const thread = isRecord(result) ? result['thread'] : undefined;
      if (!isRecord(thread)) return undefined;
      const nickname = str(thread['agentNickname']);
      const role = str(thread['agentRole']);
      const model = str(thread['model']);
      return {
        ...(nickname === undefined ? {} : { nickname }),
        ...(role === undefined ? {} : { role }),
        ...(model === undefined ? {} : { model }),
      };
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** 建一个新 thread。thread 的 id 只能由 Codex 生成，首条消息之前不落盘（spike.md） */
  async startThread(args: {
    cwd: string;
    model: string;
    engineMode?: string | undefined;
  }): Promise<{ threadId: string; model: string; engineMode: string; permissionMode: PermissionMode }> {
    const mode = isCodexMode(args.engineMode) ? args.engineMode : DEFAULT_CODEX_MODE;
    const result = await this.#client.call('thread/start', {
      cwd: args.cwd,
      approvalsReviewer: 'user',
      ...threadModeParams(mode),
      ...(args.model === CODEX_DEFAULT_MODEL || args.model === '' ? {} : { model: args.model }),
    });
    const thread = isRecord(result) ? result['thread'] : undefined;
    const threadId = isRecord(thread) ? str(thread['id']) : undefined;
    if (threadId === undefined) throw new AppServerError('thread/start 没有返回 thread id');
    const model = (isRecord(result) ? str(result['model']) : undefined) ?? args.model;
    return { threadId, model, engineMode: mode, permissionMode: legacyFromMode(mode) };
  }

  /** 这个目录下启用的 skill */
  async skills(cwd: string): Promise<CodexSkill[]> {
    return skillsFromList(await this.#client.call('skills/list', { cwds: [cwd] }));
  }

  /** 斜杠菜单：压缩 + skills。读不到 skills 也要有压缩 */
  async slashCommands(cwd: string): Promise<SlashCommand[]> {
    const skills = await this.skills(cwd).catch((err: unknown) => {
      this.#log(`[codex] 读 skills 失败：${err instanceof Error ? err.message : String(err)}`);
      return [];
    });
    return [
      { name: 'compact', description: '压缩对话上下文', source: 'user' },
      ...skills
        .filter((s) => s.name !== 'compact')
        .map((s): SlashCommand => ({
          name: s.name,
          ...(s.description === '' ? {} : { description: s.description }),
          source: 'skill',
        })),
    ];
  }

  effortsOf(model: string): { efforts: readonly string[]; defaultEffort?: string | undefined } | undefined {
    const entry =
      model === CODEX_DEFAULT_MODEL || model === ''
        ? this.#models.find((m) => m.isDefault === true)
        : this.#models.find((m) => m.id === model);
    return entry === undefined ? undefined : { efforts: entry.efforts ?? [], defaultEffort: entry.defaultEffort };
  }

  /** `codex update` 跑完：记下装好的版本；没有活跃会话就换掉 app-server，下次调用起新版 */
  noteUpdated(version: string): void {
    if (/^\d/.test(version)) this.#installedVersion = version.slice(0, 64);
    this.#client.recycle?.();
    this.#onChange();
  }

  createSession(args: CreateSessionArgs): CodexSession {
    return new CodexSession({
      sessionId: args.sessionId,
      cwd: args.cwd,
      model: args.model,
      permissionMode: args.permissionMode,
      engineMode: args.engineMode,
      effort: args.effort,
      resume: args.resume === true,
      client: this,
      emit: args.emit,
      onMeta: args.onMeta,
      onIdle: args.onIdle,
      log: this.#log,
      now: this.#now,
    });
  }

  async rename(sessionId: string, title: string): Promise<void> {
    try {
      await this.#client.call('thread/name/set', { threadId: sessionId, name: title });
    } catch (err) {
      // 首条消息之前 thread 还没落盘：转成 mutations 认识的「not found」，标题先记着
      if (err instanceof AppServerError && err.code === THREAD_NOT_FOUND_CODE) throw new Error(`thread not found: ${sessionId}`);
      throw err;
    }
    const meta = this.#owned.get(sessionId);
    if (meta !== undefined) this.#owned.set(sessionId, { ...meta, title });
  }

  async delete(sessionId: string): Promise<void> {
    await this.#client.call('thread/delete', { threadId: sessionId });
    this.#owned.delete(sessionId);
  }

  #onNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'account/rateLimits/updated') {
      this.#applyRateUpdate(params['rateLimits']);
      return;
    }
    const threadId = typeof params['threadId'] === 'string' ? params['threadId'] : undefined;
    if (method === 'thread/name/updated' && threadId !== undefined) {
      const meta = this.#owned.get(threadId);
      const name = str(params['threadName']) ?? str(params['name']);
      if (meta !== undefined && name !== undefined) this.#owned.set(threadId, { ...meta, title: name });
    }
    if (threadId === undefined) return;
    this.#learnLinks(method, threadId, params);
    const own = this.#sessions.get(threadId);
    if (own !== undefined) {
      own.onNotification(method, params);
      return;
    }
    // 子 thread 的通知交给根会话（以前直接丢掉）；它的 turn/completed 不会结束父会话的轮
    const root = this.#childRoot.get(threadId);
    if (root !== undefined) this.#sessions.get(root)?.onChildNotification?.(threadId, method, params);
  }

  /** 更新是稀疏的：只替换这一桶带来的窗口，没带的保留。没见过的桶重读一次拿全 */
  #applyRateUpdate(snapshot: unknown): void {
    if (!isRecord(snapshot)) return;
    const limitId = str(snapshot['limitId']);
    if (limitId === undefined) return;
    const bucketWindows = this.#windows.filter((w) => w.id.startsWith(`${limitId}:`));
    if (bucketWindows.length === 0) {
      void this.refresh();
      return;
    }
    const before = JSON.stringify(this.#windows);
    const bucket = bucketWindows[0]?.bucket;
    const next = [...this.#windows];
    for (const key of ['primary', 'secondary']) {
      const window = windowOf(snapshot[key], `${limitId}:${key}`.slice(0, 64), bucket);
      if (window === undefined) continue;
      const index = next.findIndex((w) => w.id === window.id);
      if (index >= 0) next[index] = window;
      else next.push(window);
    }
    this.#windows = next;
    this.#rateAt = this.#now();
    if (JSON.stringify(next) !== before) this.#onChange();
  }

  /** 全部会话；app-server 不可用时抛错，调用方决定怎么降级 */
  async listSessions(): Promise<SessionMeta[]> {
    const metas: SessionMeta[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < THREAD_MAX_PAGES; page++) {
      const result = await this.#client.call('thread/list', {
        limit: THREAD_PAGE,
        sortKey: 'updated_at',
        useStateDbOnly: true,
        sourceKinds: SOURCE_KINDS,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!isRecord(result) || !Array.isArray(result['data'])) break;
      for (const thread of result['data']) {
        const meta = threadToMeta(thread);
        if (meta !== undefined) metas.push(meta);
      }
      cursor = str(result['nextCursor']);
      if (cursor === undefined) break;
    }
    this.#owned.clear();
    for (const meta of metas) this.#owned.set(meta.sessionId, meta);
    if (this.#accountAt === undefined || this.#now() - this.#accountAt >= ACCOUNT_REFRESH_MS) {
      void this.refresh();
    }
    return metas;
  }

  /**
   * 给列表用：等一小会儿，来不及或失败就用上次的结果。没等到的那次仍会跑完并更新缓存，
   * 下次列表就有了。
   */
  listSessionsBounded(waitMs = LIST_WAIT_MS): Promise<SessionMeta[]> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.cachedSessions()), waitMs);
      this.listSessions().then(
        (metas) => {
          clearTimeout(timer);
          resolve(metas);
        },
        (err: unknown) => {
          clearTimeout(timer);
          this.#log(`[codex] 列会话失败：${err instanceof Error ? err.message : String(err)}`);
          resolve(this.cachedSessions());
        },
      );
    });
  }

  /** 最近一次成功的结果；app-server 不可用时列表退回它 */
  cachedSessions(): SessionMeta[] {
    return [...this.#owned.values()];
  }

  /** 最近一次列表或查询到的 meta（同步：manager 的 snapshot / metaOf 用） */
  metaOf(sessionId: string): SessionMeta | undefined {
    return this.#owned.get(sessionId);
  }

  /** 这个 id 是不是 Codex 的会话。app-server 不可用时抛错 */
  async owns(sessionId: string): Promise<boolean> {
    if (this.#owned.has(sessionId)) return true;
    const missAt = this.#notOwned.get(sessionId);
    if (missAt !== undefined && this.#now() - missAt < NOT_OWNED_TTL_MS) return false;
    try {
      const result = await this.#client.call('thread/read', { threadId: sessionId });
      const meta = threadToMeta(isRecord(result) ? result['thread'] : undefined);
      if (meta !== undefined && meta.sessionId === sessionId) {
        this.#owned.set(sessionId, meta);
        this.#notOwned.delete(sessionId);
        return true;
      }
    } catch (err) {
      // 只有「invalid request」表示没有这个 thread（实测 -32600 thread not loaded）。
      // 内部错误、进程起不来、超时都不能当「不存在」：GC 会据此清掉归档和置顶标记
      if (!(err instanceof AppServerError) || err.code !== THREAD_NOT_FOUND_CODE) throw err;
    }
    this.#notOwned.set(sessionId, this.#now());
    return false;
  }

  /** 完整历史（旧的在前），分页由调用方做 */
  async history(sessionId: string): Promise<HistoryItem[]> {
    const fallbackTs = this.#owned.get(sessionId)?.createdAt ?? 0;
    const raw = await this.#readItems(sessionId);
    const items = codexItemsToHistory(raw, fallbackTs);
    await this.#describeCards(items);
    return items;
  }

  /** 派生卡补上子 agent 的昵称 / 角色（thread/read，限个数、限时；读不到就显示短 id） */
  async #describeCards(items: HistoryItem[]): Promise<void> {
    const targets = new Map<string, number[]>();
    items.forEach((item, at) => {
      const id = item.kind === 'tool' && item.toolName === 'SubAgent' ? item.subagent?.agentId : undefined;
      if (id === undefined || item.kind !== 'tool' || item.subagent?.nickname !== undefined) return;
      targets.set(id, [...(targets.get(id) ?? []), at]);
    });
    const ids = [...targets.keys()].slice(0, HISTORY_DESCRIBE_MAX);
    const described = await Promise.all(ids.map((id) => this.describeThread(id)));
    ids.forEach((id, k) => {
      const info = described[k];
      if (info === undefined) return;
      for (const at of targets.get(id) ?? []) {
        const item = items[at];
        if (item?.kind !== 'tool') continue;
        items[at] = { ...item, subagent: { ...item.subagent, ...subagentLabels(info), ...item.subagent } };
      }
    });
  }

  async #readItems(sessionId: string): Promise<unknown[]> {
    try {
      return await this.#readPaginatedItems(sessionId);
    } catch (err) {
      // legacy thread 没有分页接口（-32601）：退回一次读完整个 thread
      if (!(err instanceof AppServerError) || err.code !== -32601) throw err;
    }
    const result = await this.#client.call('thread/read', { threadId: sessionId, includeTurns: true });
    const thread = isRecord(result) ? result['thread'] : undefined;
    const turns = isRecord(thread) && Array.isArray(thread['turns']) ? thread['turns'] : [];
    return turns.flatMap((turn: unknown) => (isRecord(turn) && Array.isArray(turn['items']) ? turn['items'] : []));
  }

  readItems(threadId: string): Promise<unknown[]> {
    return this.#readPaginatedItems(threadId);
  }

  async #readPaginatedItems(sessionId: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < ITEM_MAX_PAGES; page++) {
      const result = await this.#client.call('thread/items/list', {
        threadId: sessionId,
        limit: ITEM_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!isRecord(result) || !Array.isArray(result['data'])) break;
      for (const entry of result['data']) {
        if (!isRecord(entry) || !isRecord(entry['item'])) continue;
        // 时间戳在外层，条目本身可能不带
        out.push({ startedAtMs: entry['startedAtMs'], turnId: entry['turnId'], ...entry['item'] });
      }
      cursor = str(result['nextCursor']);
      if (cursor === undefined) break;
    }
    return out;
  }

  /** 刷新登录状态、版本、限额；只读 app-server，不调模型。失败写进 summary，不抛 */
  refresh(): Promise<void> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<void> {
    const before = JSON.stringify(this.summary());
    this.#accountAt = this.#now();
    try {
      const account = await this.#client.call('account/read', {});
      const signedIn = isRecord(account) && isRecord(account['account']);
      const needsAuth = isRecord(account) && account['requiresOpenaiAuth'] === true;
      this.#unavailableReason = !signedIn && needsAuth ? 'Codex 未登录：在这台机器上运行 codex login' : undefined;
      const match = /\/(\d+\.\d+\.\d+[^\s]*)/.exec(this.#client.userAgent ?? '');
      if (match !== null) this.#version = match[1]!.slice(0, 64);
      if (this.#version === this.#installedVersion) this.#installedVersion = undefined;
      const models = await this.#client.call('model/list', { limit: 64 }).catch(() => undefined);
      const data = isRecord(models) && Array.isArray(models['data']) ? models['data'] : [];
      const list: EngineModel[] = [];
      for (const raw of data) {
        const model = modelFromList(raw);
        if (model !== undefined) list.push(model);
      }
      if (list.length > 0) this.#models = list.slice(0, 64);
      if (this.#unavailableReason === undefined) {
        // API key 等账号没有订阅限额，这里报错是正常的
        const limits = await this.#client.call('account/rateLimits/read', null).catch(() => undefined);
        if (limits !== undefined) {
          this.#windows = rateWindows(limits);
          this.#rateAt = this.#now();
        }
      } else {
        this.#windows = [];
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log(`[codex] 刷新账号信息失败：${message}`);
      this.#unavailableReason = `Codex 不可用：${message}`;
    }
    if (JSON.stringify(this.summary()) !== before) this.#onChange();
  }

  dispose(): void {
    this.#sessions.clear();
    this.#client.dispose();
  }
}

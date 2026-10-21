/**
 * 扩展服务：读取（缓存、订阅推送）、动作（token → plan → commit → 执行）、目录与配置。
 * router 只做分发，这里不碰命令链——需要进链的提交动作（建会话、发消息、广播 meta）经
 * ExtHost 交回 router 执行。扩展进程一律在链外跑（runner）。
 *
 * ## 安全底线（EXTENSIONS.md §安全）
 *
 * 读取 / 刷新 / 推送永远不执行效果。视图里需要 agent 执行的动作只是一个 token：
 * 只对签发设备有效、TOKEN_TTL_MS 过期、一次性、agent 重启即失效、扩展 reload / 配置变化即作废。
 * 点击 → prepare：按 token 里固定的效果生成执行计划，需要确认就把计划发给用户，commit 时
 * 只认 planId、不重新运行扩展，并在执行前复查前置条件（会话还在、cwd / 权限模式没变、
 * 扩展仍可用且代次没变），变了就 stale。
 *
 * ## invocation
 *
 * invocationId 由 client 生成；首次 prepare 就登记，同一 invocationId 重复到达返回当前状态
 * （running / awaiting_confirmation / done），不重复执行。记录只在内存，保留 INVOCATION_TTL_MS。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  EXT_API_VERSION,
  ExtActionOutputSchema,
  ExtBadgeOutputSchema,
  ExtErrorOutputSchema,
  ExtPickOutputSchema,
  ExtViewOutputSchema,
  isLocalEffect,
  type ClientToAgentEvent,
  type ExtBadge,
  type ExtCapability,
  type ExtEffect,
  type ExtError,
  type ExtErrorCode,
  type ExtLinkRef,
  type ExtLocalEffect,
  type ExtPlan,
  type ExtPlanStep,
  type ExtPoint,
  type ExtRawAction,
  type ExtRawPickItem,
  type ExtRawView,
  type ExtRemoteEffect,
  type ExtWireAction,
  type ExtWirePickItem,
  type ExtWireView,
  type PermissionMode,
  type SessionMeta,
} from '@trine/core';
import type { EventBody, EventBodyOf } from '../bridge/types.ts';
import type { SessionLinksStore } from './links-store.ts';
import type { SessionRecordsStore } from './records-store.ts';
import type { ExtensionRegistry, LoadedExtension } from './registry.ts';
import { ACTION_TIMEOUT_MS, READ_TIMEOUT_MS, type ExtensionRunner, type RunResult } from './runner.ts';

export const TOKEN_TTL_MS = 10 * 60_000;
export const PLAN_TTL_MS = 2 * 60_000;
export const INVOCATION_TTL_MS = 30 * 60_000;
export const READ_CACHE_TTL_MS = 15_000;
export const REFRESH_DEBOUNCE_MS = 1_000;
/** 一台设备最多同时持有多少个订阅 */
export const MAX_WATCHES_PER_DEVICE = 16;
/** linkedSessions 最多带多少个 */
export const MAX_LINKED_SESSIONS = 200;
/** token 表上限：超过时先清过期的，仍超就丢最老的 */
const MAX_TOKENS = 5_000;

/** composerAction（输入框入口）只允许这些效果：那里是编辑语境，点一下不该发出任何东西 */
const COMPOSER_EFFECTS: ReadonlySet<string> = new Set(['prompt.insert', 'links.add']);
/**
 * newSession（新建会话 sheet）只允许预填首条消息：会话由用户在 sheet 里自己建，
 * 关联取候选项的 link，经宿主的 session.links.update 写入（用户本人操作）。
 */
const NEW_SESSION_EFFECTS: ReadonlySet<string> = new Set(['prompt.insert']);

/** 贡献点允许的效果；undefined = 不另设限制 */
function pointEffects(point: ExtPoint): ReadonlySet<string> | undefined {
  if (point === 'composerAction') return COMPOSER_EFFECTS;
  if (point === 'newSession') return NEW_SESSION_EFFECTS;
  return undefined;
}

/** effect 类型 → 需要的能力（copy / refresh 不需要声明） */
function capabilityOf(type: ExtEffect['type']): ExtCapability | undefined {
  switch (type) {
    case 'prompt.insert':
      return 'prompt.insert';
    case 'prompt.send':
      return 'prompt.send';
    case 'session.create':
      return 'session.create';
    case 'links.add':
    case 'links.remove':
      return 'links.write';
    default:
      return undefined;
  }
}

type ReadEvent = Extract<ClientToAgentEvent, { type: 'ext.read' }>;
type ReadOp = ReadEvent['op'];

/** router 实现：需要进命令链 / 碰会话的操作 */
export interface ExtHost {
  machine(): { id: string; name: string };
  /** 会话最新 meta（可能查盘）；不存在返回 undefined */
  sessionMeta(sessionId: string): Promise<SessionMeta | undefined>;
  /** 只查缓存，不查盘 */
  cachedMeta(sessionId: string): SessionMeta | undefined;
  isDeleted(sessionId: string): boolean;
  createSession(args: {
    cwd: string;
    model: string;
    permissionMode: PermissionMode;
    title?: string;
    ext: string;
    links: readonly ExtLinkRef[];
    prompt: string;
    /** 在机器链上、真正建会话之前调：抛错则不建（扩展在排队期间被停用等） */
    precheck?: () => void;
  }): Promise<{ sessionId: string; clientMsgId?: string; sendError?: string }>;
  /**
   * 在该会话的命令链上执行 fn：前置条件复查与提交在同一环里完成，排在前面的改权限 / 改目录 /
   * 删除都已生效，排在后面的还没开始。fn 里用 api.send 发消息（不要再排一次链）。
   */
  withSession<T>(
    sessionId: string,
    fn: (api: { meta(): Promise<SessionMeta | undefined>; send(text: string): Promise<{ clientMsgId: string; queued: boolean }> }) => Promise<T>,
  ): Promise<T>;
  /** 关联改了：广播该会话的 session.updated */
  broadcastSession(sessionId: string): Promise<void>;
  /** 定向发给一台设备（机器级） */
  emitTo(deviceId: string, body: EventBody): void;
}

export interface ExtensionServiceDeps {
  registry: ExtensionRegistry;
  runner: Pick<ExtensionRunner, 'run'> & { dispose?: () => void };
  links: SessionLinksStore;
  /** 时间线记录卡；缺省不记 */
  records?: Pick<SessionRecordsStore, 'append'>;
  host: ExtHost;
  now?: () => number;
  uuid?: () => string;
  log?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface TokenRecord {
  ext: string;
  generation: number;
  point: ExtPoint;
  deviceId: string;
  targetSessionId: string | undefined;
  cwd: string;
  itemId: string | undefined;
  /** 条目标题（时间线记录卡用；工具栏动作没有） */
  itemTitle: string | undefined;
  action: { id: string; label: string; destructive: boolean; confirm: string | undefined };
  effects: ExtEffect[] | undefined;
  invoke: { params?: Record<string, unknown> } | undefined;
  expiresAt: number;
}

/** 已固定的执行步骤：plan 里给人看的 + 执行时要用的 */
interface ResolvedStep {
  view: ExtPlanStep;
  effect: ExtRemoteEffect | { type: 'invoke' };
  /** commit 时复查：会话的 cwd / 权限模式 */
  expectSession?: { sessionId: string; cwd: string; permissionMode: string };
}

interface PlanRecord {
  planId: string;
  invocationId: string;
  deviceId: string;
  token: TokenRecord;
  steps: ResolvedStep[];
  plan: ExtPlan;
  /** invoke 第二阶段：进程返回的本地效果，执行完一并交给发起设备 */
  local: ExtLocalEffect[];
  view: ExtWireView | undefined;
  viewRev: number | undefined;
  message: string | undefined;
  newSession: { model: string; permissionMode: PermissionMode } | undefined;
  expiresAt: number;
}

type ResultBody = EventBodyOf<'ext.action.result'>;

interface InvocationRecord {
  deviceId: string;
  state: 'running' | 'awaiting_confirmation' | 'done';
  planId?: string;
  result?: Omit<ResultBody, 'reqId' | 'type' | 'invocationId'>;
  at: number;
}

interface Lease {
  deviceId: string;
  read: ReadEvent;
  expiresAt: number;
}

interface CacheEntry {
  at: number;
  output: unknown;
}

class ExtFailure extends Error {
  constructor(
    readonly code: ExtErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExtFailure';
  }
}

export class ExtensionService {
  readonly #registry: ExtensionRegistry;
  readonly #runner: Pick<ExtensionRunner, 'run'> & { dispose?: () => void };
  readonly #links: SessionLinksStore;
  readonly #records: Pick<SessionRecordsStore, 'append'> | undefined;
  readonly #host: ExtHost;
  readonly #now: () => number;
  readonly #uuid: () => string;
  readonly #log: (line: string) => void;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;

  readonly #tokens = new Map<string, TokenRecord>();
  readonly #plans = new Map<string, PlanRecord>();
  readonly #invocations = new Map<string, InvocationRecord>();
  readonly #cache = new Map<string, CacheEntry>();
  /** 每个扩展的失效代次：动作完成、关联变化、配置变化时 +1；缓存键带它 */
  readonly #epoch = new Map<string, number>();
  readonly #leases = new Map<string, Lease>();
  readonly #dirty = new Set<string>();
  #disposed = false;
  #refreshTimer: unknown = undefined;
  /** 读取结果的 rev：从启动时刻起算，agent 重启后也不会比旧进程发出的小 */
  #rev: number;

  constructor(deps: ExtensionServiceDeps) {
    this.#registry = deps.registry;
    this.#runner = deps.runner;
    this.#links = deps.links;
    this.#records = deps.records;
    this.#host = deps.host;
    this.#now = deps.now ?? (() => Date.now());
    this.#uuid = deps.uuid ?? (() => randomUUID());
    this.#log = deps.log ?? (() => {});
    this.#setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return t;
      });
    this.#clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.#rev = this.#now() * 1_000;
  }

  /** 测试用 */
  get tokenCount(): number {
    return this.#tokens.size;
  }

  get watchCount(): number {
    return this.#leases.size;
  }

  // -------------------------------------------------------------------------
  // 目录与配置
  // -------------------------------------------------------------------------

  catalog(deviceId: string, reqId: string): void {
    this.#host.emitTo(deviceId, { type: 'ext.catalog.response', reqId, rev: this.#registry.rev, items: this.#registry.catalog() });
  }

  async setConfig(deviceId: string, event: Extract<ClientToAgentEvent, { type: 'ext.config.set' }>): Promise<void> {
    try {
      if (this.#registry.get(event.ext) === undefined) throw new ExtFailure('not_found', `没有扩展 ${event.ext}`);
      await this.#registry.setConfig(event.ext, {
        ...(event.enabled === undefined ? {} : { enabled: event.enabled }),
        ...(event.policy === undefined ? {} : { policy: event.policy }),
      });
      this.#host.emitTo(deviceId, { type: 'ext.config.response', reqId: event.reqId, ok: true });
    } catch (err) {
      this.#host.emitTo(deviceId, { type: 'ext.config.response', reqId: event.reqId, ok: false, error: toExtError(err) });
    }
  }

  /**
   * 扩展的目录项变了（registry.onChange 接到这里）：作废它的 token、plan、缓存。
   * 收紧权限、停用、移除、reload 之后，旧视图里的动作都不该再能执行。
   */
  invalidate(ext: string): void {
    for (const [token, record] of this.#tokens) if (record.ext === ext) this.#tokens.delete(token);
    for (const [planId, plan] of this.#plans) {
      if (plan.token.ext !== ext) continue;
      this.#plans.delete(planId);
      this.#finish(plan.invocationId, { ok: false, error: { code: 'stale', message: '扩展已变更，请重新操作' } });
    }
    this.#bumpEpoch(ext);
    if (this.#registry.usable(ext) === undefined) {
      for (const [key, lease] of this.#leases) if (lease.read.ext === ext) this.#leases.delete(key);
    } else {
      this.#markDirty((lease) => lease.read.ext === ext);
    }
  }

  /** 设备被撤销：清掉它的订阅与 token */
  forgetDevice(deviceId: string): void {
    for (const [key, lease] of this.#leases) if (lease.deviceId === deviceId) this.#leases.delete(key);
    for (const [token, record] of this.#tokens) if (record.deviceId === deviceId) this.#tokens.delete(token);
  }

  /** 会话一轮结束：目标是该会话或其 cwd 的订阅标脏 */
  onRunEnd(sessionId: string): void {
    const cwd = this.#host.cachedMeta(sessionId)?.cwd;
    const match = (lease: Lease): boolean => lease.read.targetSessionId === sessionId || (cwd !== undefined && lease.read.cwd === cwd);
    // 这一轮可能改了扩展读的文件：相关扩展的缓存作废，推送的才是新内容（同一轮的多个订阅仍只跑一次）
    for (const ext of new Set([...this.#leases.values()].filter(match).map((l) => l.read.ext))) this.#bumpEpoch(ext);
    this.#markDirty(match);
  }

  /** 宿主的「关联…」改了关联（session.links.update）：相关视图要重算 */
  onLinksChanged(ext: string): void {
    this.#bumpEpoch(ext);
    this.#markDirty((lease) => lease.read.ext === ext);
  }

  dispose(): void {
    this.#disposed = true;
    this.#runner.dispose?.();
    if (this.#refreshTimer !== undefined) this.#clearTimer(this.#refreshTimer);
    this.#refreshTimer = undefined;
    this.#leases.clear();
    this.#tokens.clear();
    this.#plans.clear();
  }

  // -------------------------------------------------------------------------
  // 读取
  // -------------------------------------------------------------------------

  async read(deviceId: string, event: ReadEvent): Promise<void> {
    const leaseKey = this.#leaseKey(deviceId, event);
    if (event.watch !== undefined) {
      if (event.watch.ttlMs === 0) {
        this.#leases.delete(leaseKey);
      } else {
        const own = [...this.#leases.values()].filter((l) => l.deviceId === deviceId).length;
        if (this.#leases.has(leaseKey) || own < MAX_WATCHES_PER_DEVICE) {
          this.#leases.set(leaseKey, { deviceId, read: { ...event, force: false }, expiresAt: this.#now() + event.watch.ttlMs });
        }
      }
    }
    const body = await this.#readOnce(deviceId, event, event.force === true);
    this.#host.emitTo(deviceId, { ...body, reqId: event.reqId });
  }

  async #readOnce(deviceId: string, event: ReadEvent, force: boolean): Promise<EventBodyOf<'ext.read.response'>> {
    const base = {
      type: 'ext.read.response' as const,
      ext: event.ext,
      op: event.op,
      point: event.point,
      ...(event.targetSessionId === undefined ? {} : { targetSessionId: event.targetSessionId }),
      ...(event.cwd === undefined ? {} : { cwd: event.cwd }),
    };
    // rev 在开始时分配：动作前启动、动作后才完成的旧读取拿到的是更小的 rev，client 会丢掉它
    const rev = ++this.#rev;
    try {
      const ext = this.#usable(event.ext);
      checkPoint(ext, event.op, event.point);
      const { cwd, context } = await this.#context(ext, event.targetSessionId, event.cwd);
      const input = {
        apiVersion: EXT_API_VERSION,
        op: event.op,
        point: event.point,
        locale: event.locale ?? 'zh-CN',
        context,
        args: event.args ?? {},
      };
      const key = cacheKey(ext, input);
      const epoch = this.#epochOf(ext.id);
      let output: unknown;
      const cached = force ? undefined : this.#cache.get(key);
      if (cached !== undefined && this.#now() - cached.at < READ_CACHE_TTL_MS) {
        output = cached.output;
      } else {
        output = await this.#runOp(ext, event.op, cwd, input, 'read');
        // 读取期间有动作 / 关联变化：结果可能是旧的，不写回缓存（这次照样返回）
        if (this.#epochOf(ext.id) === epoch) this.#cache.set(key, { at: this.#now(), output });
        this.#pruneCache();
      }
      const target = { ext, deviceId, point: event.point, targetSessionId: event.targetSessionId, cwd };
      switch (event.op) {
        case 'view': {
          const view = ExtViewOutputSchema.parse(output).view;
          return { ...base, rev, ok: true, view: this.#wireView(view, target) };
        }
        case 'badge': {
          const parsed = ExtBadgeOutputSchema.parse(output);
          if (parsed.links !== undefined && event.targetSessionId !== undefined) {
            if (this.#links.refreshLabels(event.targetSessionId, ext.id, parsed.links)) {
              void this.#host.broadcastSession(event.targetSessionId).catch(() => {});
            }
          }
          return { ...base, rev, ok: true, badge: parsed.badge };
        }
        case 'pick': {
          const items = ExtPickOutputSchema.parse(output).items;
          return { ...base, rev, ok: true, items: this.#wirePickItems(items, target) };
        }
      }
    } catch (err) {
      const error = toExtError(err);
      if (error.code !== 'disabled' && error.code !== 'not_found' && error.code !== 'unsupported') {
        this.#registry.noteError(event.ext, `${event.op}/${event.point}：${error.message}`);
      }
      return { ...base, rev, ok: false, error };
    }
  }

  /** 跑一次扩展 op，校验 stdout 形状（错误输出 / 进程失败都转成 ExtFailure） */
  async #runOp(ext: LoadedExtension, op: string, cwd: string, input: unknown, priority: 'read' | 'action'): Promise<unknown> {
    const result: RunResult = await this.#runner.run({
      ext: ext.id,
      argv: ext.argv!,
      dir: ext.dir,
      cwd,
      op,
      input,
      timeoutMs: priority === 'action' ? ACTION_TIMEOUT_MS : READ_TIMEOUT_MS,
      priority,
    });
    if (!result.ok) {
      if (result.stderr !== '') this.#log(`[ext] ${ext.id} ${op} stderr：${result.stderr.slice(-500)}`);
      throw new ExtFailure(result.code === 'not_found' ? 'not_found' : result.code, result.message);
    }
    const asError = ExtErrorOutputSchema.safeParse(result.output);
    if (asError.success) throw new ExtFailure('extension_error', asError.data.error.message || asError.data.error.code);
    return result.output;
  }

  async #context(
    ext: LoadedExtension,
    targetSessionId: string | undefined,
    requestedCwd: string | undefined,
  ): Promise<{ cwd: string; context: Record<string, unknown> }> {
    let session: SessionMeta | undefined;
    if (targetSessionId !== undefined) {
      if (this.#host.isDeleted(targetSessionId)) throw new ExtFailure('not_found', '会话已删除');
      session = await this.#host.sessionMeta(targetSessionId);
      if (session === undefined) throw new ExtFailure('not_found', '找不到会话');
    }
    const cwd = session?.cwd ?? requestedCwd;
    if (cwd === undefined || cwd === '') throw new ExtFailure('not_found', '缺少工作目录');
    const linked: Record<string, unknown>[] = [];
    for (const sid of this.#links.sessionsWith(ext.id)) {
      if (linked.length >= MAX_LINKED_SESSIONS) break;
      const meta = this.#host.cachedMeta(sid) ?? (sid === session?.sessionId ? session : undefined);
      if (meta === undefined || this.#host.isDeleted(sid)) continue;
      linked.push(sessionContext(meta, ext.id));
    }
    return {
      cwd,
      context: {
        machine: this.#host.machine(),
        cwd,
        ...(session === undefined ? {} : { session: sessionContext(session, ext.id) }),
        linkedSessions: linked,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Raw → Wire（签发 token）
  // -------------------------------------------------------------------------

  #wireView(
    view: ExtRawView,
    target: { ext: LoadedExtension; deviceId: string; point: ExtPoint; targetSessionId: string | undefined; cwd: string },
  ): ExtWireView {
    const wire = (action: ExtRawAction, item: { id: string; title: string } | undefined): ExtWireAction | undefined =>
      this.#wireAction(action, item, target);
    return {
      ...(view.title === undefined ? {} : { title: view.title }),
      ...(view.empty === undefined ? {} : { empty: view.empty }),
      ...(view.toolbar === undefined ? {} : { toolbar: compact(view.toolbar.map((a) => wire(a, undefined))) }),
      sections: view.sections.map((section) => ({
        ...section,
        items: section.items.map(({ actions, ...item }) => ({
          ...item,
          ...(actions === undefined ? {} : { actions: compact(actions.map((a) => wire(a, item))) }),
        })),
      })),
    };
  }

  #wirePickItems(
    items: readonly ExtRawPickItem[],
    target: { ext: LoadedExtension; deviceId: string; point: ExtPoint; targetSessionId: string | undefined; cwd: string },
  ): ExtWirePickItem[] {
    return items.map(({ effects, ...item }) => {
      if (effects === undefined) return item;
      const action = this.#wireAction({ id: `pick:${item.id}`, label: item.title, effects }, item, target);
      if (action === undefined) return item;
      return {
        ...item,
        ...(action.local === undefined ? {} : { local: action.local }),
        ...(action.token === undefined ? {} : { token: action.token }),
      };
    });
  }

  /** 不允许的动作（越过贡献点、能力被禁）直接不给，返回 undefined */
  #wireAction(
    action: ExtRawAction,
    item: { id: string; title: string } | undefined,
    target: { ext: LoadedExtension; deviceId: string; point: ExtPoint; targetSessionId: string | undefined; cwd: string },
  ): ExtWireAction | undefined {
    const { ext, point } = target;
    const common = {
      id: action.id,
      label: action.label,
      ...(action.primary === undefined ? {} : { primary: action.primary }),
      ...(action.destructive === undefined ? {} : { destructive: action.destructive }),
      ...(action.confirm === undefined ? {} : { confirm: action.confirm }),
    };
    if (action.effects !== undefined) {
      const allowed = pointEffects(point);
      for (const effect of action.effects) {
        if (allowed !== undefined && !allowed.has(effect.type)) return undefined;
        const capability = capabilityOf(effect.type);
        if (capability !== undefined && this.#registry.decide(ext.id, capability) === 'deny') return undefined;
        // 指向会话的效果，没有目标会话就不给
        if ((effect.type === 'prompt.send' || effect.type === 'links.add' || effect.type === 'links.remove') && target.targetSessionId === undefined) {
          return undefined;
        }
      }
      if (action.effects.every(isLocalEffect)) {
        return { ...common, local: action.effects.filter(isLocalEffect) };
      }
    } else {
      if (pointEffects(point) !== undefined) return undefined;
      if (this.#registry.decide(ext.id, 'invoke') === 'deny') return undefined;
    }
    const token = this.#issue({
      ext: ext.id,
      generation: ext.generation,
      point,
      deviceId: target.deviceId,
      targetSessionId: target.targetSessionId,
      cwd: target.cwd,
      itemId: item?.id,
      itemTitle: item?.title,
      action: { id: action.id, label: action.label, destructive: action.destructive === true, confirm: action.confirm },
      effects: action.effects,
      invoke: action.invoke,
      expiresAt: this.#now() + TOKEN_TTL_MS,
    });
    return { ...common, token };
  }

  #issue(record: TokenRecord): string {
    if (this.#tokens.size >= MAX_TOKENS) {
      const now = this.#now();
      for (const [t, r] of this.#tokens) if (r.expiresAt <= now) this.#tokens.delete(t);
      while (this.#tokens.size >= MAX_TOKENS) {
        const oldest = this.#tokens.keys().next().value;
        if (oldest === undefined) break;
        this.#tokens.delete(oldest);
      }
    }
    const token = this.#uuid();
    this.#tokens.set(token, record);
    return token;
  }

  // -------------------------------------------------------------------------
  // 动作
  // -------------------------------------------------------------------------

  async prepare(deviceId: string, event: Extract<ClientToAgentEvent, { type: 'ext.action.prepare' }>): Promise<void> {
    const reply = (body: Omit<ResultBody, 'reqId' | 'type' | 'invocationId'>): void =>
      this.#host.emitTo(deviceId, { type: 'ext.action.result', reqId: event.reqId, invocationId: event.invocationId, ...body });
    this.#pruneInvocations();
    const existing = this.#invocations.get(event.invocationId);
    if (existing !== undefined) {
      if (existing.deviceId !== deviceId) {
        reply({ ok: false, error: { code: 'denied', message: '这次操作不是本设备发起的' } });
        return;
      }
      this.#replyStatus(deviceId, event.reqId, event.invocationId);
      return;
    }
    const token = this.#tokens.get(event.token);
    // token 一次性：取到就删，失败也不留（重新点击会拿到新视图里的新 token）
    this.#tokens.delete(event.token);
    if (token === undefined || token.deviceId !== deviceId || token.expiresAt <= this.#now()) {
      reply({ ok: false, error: { code: 'stale', message: '这个操作已过期，请刷新后重试' } });
      return;
    }
    this.#invocations.set(event.invocationId, { deviceId, state: 'running', at: this.#now() });
    try {
      const ext = this.#usable(token.ext);
      if (ext.generation !== token.generation) throw new ExtFailure('stale', '扩展已变更，请刷新后重试');
      if (token.invoke !== undefined) {
        await this.#prepareInvoke(deviceId, event.reqId, event.invocationId, token, ext, event.newSession);
        return;
      }
      const effects = token.effects ?? [];
      const steps = await this.#resolveSteps(token, effects.filter((e): e is ExtRemoteEffect => !isLocalEffect(e)), event.newSession);
      const local = effects.filter(isLocalEffect);
      await this.#planOrRun(deviceId, event.reqId, event.invocationId, token, ext, steps, {
        local,
        view: undefined,
        viewRev: undefined,
        message: undefined,
        newSession: event.newSession,
        extraConfirm: !this.#registry.fullTrust(ext.id) && (token.action.destructive || token.action.confirm !== undefined),
      });
    } catch (err) {
      const result = { ok: false, error: toExtError(err) };
      this.#finish(event.invocationId, result);
      reply(result);
    }
  }

  async commit(deviceId: string, event: Extract<ClientToAgentEvent, { type: 'ext.action.commit' }>): Promise<void> {
    const plan = this.#plans.get(event.planId);
    const reply = (body: Omit<ResultBody, 'reqId' | 'type' | 'invocationId'>): void =>
      this.#host.emitTo(deviceId, { type: 'ext.action.result', reqId: event.reqId, invocationId: event.invocationId, ...body });
    if (plan === undefined || plan.deviceId !== deviceId || plan.invocationId !== event.invocationId) {
      // 已执行过的重复 commit：返回已有结果
      const inv = this.#invocations.get(event.invocationId);
      if (inv?.deviceId === deviceId && inv.state === 'done') {
        this.#replyStatus(deviceId, event.reqId, event.invocationId);
        return;
      }
      reply({ ok: false, error: { code: 'stale', message: '确认已过期，请重新操作' } });
      return;
    }
    this.#plans.delete(event.planId);
    const invocation = this.#invocations.get(plan.invocationId);
    if (invocation !== undefined) {
      invocation.state = 'running';
      delete invocation.planId;
    }
    try {
      if (plan.expiresAt <= this.#now()) throw new ExtFailure('stale', '确认已过期，请重新操作');
      const ext = this.#usable(plan.token.ext);
      if (ext.generation !== plan.token.generation) throw new ExtFailure('stale', '扩展已变更，请重新操作');
      await this.#checkPreconditions(plan.steps);
      if (plan.steps.length === 1 && plan.steps[0]!.effect.type === 'invoke') {
        // invoke 的确认在启动进程之前
        await this.#runInvoke(deviceId, event.reqId, plan.invocationId, plan.token, ext, plan.newSession);
        return;
      }
      const result = await this.#execute(plan.token, plan.steps, plan);
      this.#finish(plan.invocationId, result);
      reply(result);
    } catch (err) {
      const result = { ok: false, error: toExtError(err) };
      this.#finish(plan.invocationId, result);
      reply(result);
    }
  }

  cancel(deviceId: string, planId: string): void {
    const plan = this.#plans.get(planId);
    if (plan === undefined || plan.deviceId !== deviceId) return;
    this.#plans.delete(planId);
    this.#finish(plan.invocationId, { ok: false, error: { code: 'denied', message: '已取消' } });
  }

  status(deviceId: string, event: Extract<ClientToAgentEvent, { type: 'ext.action.status' }>): void {
    this.#replyStatus(deviceId, event.reqId, event.invocationId);
  }

  #replyStatus(deviceId: string, reqId: string, invocationId: string): void {
    const inv = this.#invocations.get(invocationId);
    const base = { type: 'ext.action.result' as const, reqId, invocationId };
    if (inv === undefined || inv.deviceId !== deviceId) {
      this.#host.emitTo(deviceId, { ...base, ok: false, error: { code: 'unknown_outcome', message: '查不到这次操作（可能已过期或 agent 重启过）' } });
      return;
    }
    if (inv.state === 'done' && inv.result !== undefined) {
      // 重放结果时不带本地效果：那只该在第一次收到时执行一次
      const { local: _local, ...rest } = inv.result;
      this.#host.emitTo(deviceId, { ...base, ...rest, state: 'done' });
      return;
    }
    const plan = inv.planId === undefined ? undefined : this.#plans.get(inv.planId);
    this.#host.emitTo(deviceId, {
      ...base,
      ok: false,
      state: inv.state,
      ...(plan === undefined ? {} : { pending: { planId: plan.planId, plan: plan.plan, expiresAt: plan.expiresAt } }),
    });
  }

  async #prepareInvoke(
    deviceId: string,
    reqId: string,
    invocationId: string,
    token: TokenRecord,
    ext: LoadedExtension,
    newSession: PlanRecord['newSession'],
  ): Promise<void> {
    const decision = this.#registry.decide(ext.id, 'invoke');
    if (decision === 'deny') throw new ExtFailure('denied', '这个扩展不允许执行操作');
    const needsConfirm =
      decision === 'confirm' || (!this.#registry.fullTrust(ext.id) && (token.action.destructive || token.action.confirm !== undefined));
    if (needsConfirm) {
      const step: ResolvedStep = {
        view: {
          type: 'invoke',
          actionLabel: token.action.label,
          destructive: token.action.destructive,
          ...(token.action.confirm === undefined ? {} : { confirm: token.action.confirm }),
        },
        effect: { type: 'invoke' },
      };
      this.#issuePlan(deviceId, reqId, invocationId, token, ext, [step], {
        local: [],
        view: undefined,
        viewRev: undefined,
        message: undefined,
        newSession,
      });
      return;
    }
    await this.#runInvoke(deviceId, reqId, invocationId, token, ext, newSession);
  }

  /** 跑扩展的 action op，再处理它返回的效果（返回的效果同样按能力与贡献点检查） */
  async #runInvoke(
    deviceId: string,
    reqId: string,
    invocationId: string,
    token: TokenRecord,
    ext: LoadedExtension,
    newSession: PlanRecord['newSession'],
  ): Promise<void> {
    this.#assertCurrent(token);
    const { cwd, context } = await this.#context(ext, token.targetSessionId, token.cwd);
    // 会话换了目录：扩展会在别的数据上执行，不跑。在会话链上确认一次，排在前面的切目录已生效
    if (cwd !== token.cwd) throw new ExtFailure('stale', '会话的工作目录已变化，请刷新后重试');
    if (token.targetSessionId !== undefined) {
      await this.#host.withSession(token.targetSessionId, async (api) => {
        const meta = await api.meta();
        if (meta === undefined) throw new ExtFailure('stale', '会话已不存在');
        if (meta.cwd !== token.cwd) throw new ExtFailure('stale', '会话的工作目录已变化，请刷新后重试');
      });
    }
    const output = await this.#runOp(
      ext,
      'action',
      cwd,
      {
        apiVersion: EXT_API_VERSION,
        op: 'action',
        point: token.point,
        locale: 'zh-CN',
        context,
        args: { actionId: token.action.id, itemId: token.itemId, params: token.invoke?.params ?? {}, invocationId },
      },
      'action',
    );
    // 扩展可能改了自己的数据：相关缓存全部作废
    this.#bumpEpoch(ext.id);
    // 进程跑的这段时间里扩展被停用 / 改了权限：返回的效果不再执行
    this.#assertCurrent(token);
    this.#markDirty((lease) => lease.read.ext === ext.id);
    const parsed = ExtActionOutputSchema.parse(output);
    if (!parsed.ok) throw new ExtFailure('extension_error', parsed.message ?? '扩展报告操作失败');
    const effects = parsed.effects ?? [];
    const allowed = pointEffects(token.point);
    for (const effect of effects) {
      if (allowed !== undefined && !allowed.has(effect.type)) {
        throw new ExtFailure('denied', `这个入口不允许 ${effect.type}`);
      }
    }
    let view: ExtWireView | undefined;
    let viewRev: number | undefined;
    if (parsed.view !== undefined) {
      view = this.#wireView(parsed.view, { ext, deviceId, point: token.point, targetSessionId: token.targetSessionId, cwd });
      viewRev = ++this.#rev;
    }
    const local = effects.filter(isLocalEffect);
    for (const effect of local) {
      const capability = capabilityOf(effect.type);
      if (capability !== undefined && this.#registry.decide(ext.id, capability) === 'deny') {
        throw new ExtFailure('denied', `扩展没有 ${capability} 权限`);
      }
    }
    const steps = await this.#resolveSteps(token, effects.filter((e): e is ExtRemoteEffect => !isLocalEffect(e)), newSession);
    await this.#planOrRun(deviceId, reqId, invocationId, token, ext, steps, {
      local,
      view,
      viewRev,
      message: parsed.message,
      newSession,
      extraConfirm: false,
    });
  }

  async #planOrRun(
    deviceId: string,
    reqId: string,
    invocationId: string,
    token: TokenRecord,
    ext: LoadedExtension,
    steps: ResolvedStep[],
    extra: Pick<PlanRecord, 'local' | 'view' | 'viewRev' | 'message' | 'newSession'> & { extraConfirm: boolean },
  ): Promise<void> {
    let needsConfirm = extra.extraConfirm && steps.length > 0;
    for (const step of steps) {
      const capabilities: ExtCapability[] = [];
      const capability = capabilityOf(step.effect.type as ExtEffect['type']);
      if (capability !== undefined) capabilities.push(capability);
      // 新会话顺带的关联同样要 links.write
      if (step.effect.type === 'session.create' && (step.effect.links?.length ?? 0) > 0) capabilities.push('links.write');
      for (const cap of capabilities) {
        const decision = this.#registry.decide(ext.id, cap);
        if (decision === 'deny') throw new ExtFailure('denied', `扩展没有 ${cap} 权限`);
        if (decision === 'confirm') needsConfirm = true;
      }
    }
    if (needsConfirm) {
      this.#issuePlan(deviceId, reqId, invocationId, token, ext, steps, extra);
      return;
    }
    const result = await this.#execute(token, steps, extra);
    this.#finish(invocationId, result);
    this.#host.emitTo(deviceId, { type: 'ext.action.result', reqId, invocationId, ...result });
  }

  #issuePlan(
    deviceId: string,
    reqId: string,
    invocationId: string,
    token: TokenRecord,
    ext: LoadedExtension,
    steps: ResolvedStep[],
    extra: Pick<PlanRecord, 'local' | 'view' | 'viewRev' | 'message' | 'newSession'>,
  ): void {
    const planId = this.#uuid();
    const plan: ExtPlan = {
      ext: ext.id,
      extName: ext.manifest?.name ?? ext.id,
      extVersion: ext.manifest?.version ?? '',
      actionLabel: token.action.label,
      steps: steps.map((s) => s.view),
    };
    const expiresAt = this.#now() + PLAN_TTL_MS;
    this.#plans.set(planId, { planId, invocationId, deviceId, token, steps, plan, ...extra, expiresAt });
    const inv = this.#invocations.get(invocationId);
    if (inv !== undefined) {
      inv.state = 'awaiting_confirmation';
      inv.planId = planId;
    }
    this.#host.emitTo(deviceId, { type: 'ext.action.plan', reqId, invocationId, planId, plan, expiresAt });
  }

  /** 把远端效果固定成执行步骤（确认的就是这些内容） */
  async #resolveSteps(
    token: TokenRecord,
    effects: readonly ExtRemoteEffect[],
    newSession: PlanRecord['newSession'],
  ): Promise<ResolvedStep[]> {
    const steps: ResolvedStep[] = [];
    let target: SessionMeta | undefined;
    const needTarget = async (): Promise<SessionMeta> => {
      if (target !== undefined) return target;
      if (token.targetSessionId === undefined) throw new ExtFailure('not_found', '这个操作需要在会话里使用');
      if (this.#host.isDeleted(token.targetSessionId)) throw new ExtFailure('not_found', '会话已删除');
      const meta = await this.#host.sessionMeta(token.targetSessionId);
      if (meta === undefined) throw new ExtFailure('not_found', '找不到会话');
      target = meta;
      return meta;
    };
    for (const effect of effects) {
      switch (effect.type) {
        case 'session.create': {
          if (newSession === undefined) throw new ExtFailure('unsupported', '缺少新会话默认值（请升级 web）');
          steps.push({
            effect,
            view: {
              type: 'session.create',
              cwd: effect.cwd ?? token.cwd,
              ...(effect.title === undefined ? {} : { title: effect.title }),
              prompt: effect.prompt,
              model: newSession.model,
              permissionMode: newSession.permissionMode,
              links: effect.links ?? [],
            },
          });
          break;
        }
        case 'prompt.send': {
          const meta = await needTarget();
          steps.push({
            effect,
            view: {
              type: 'prompt.send',
              targetSessionId: meta.sessionId,
              sessionTitle: meta.title,
              cwd: meta.cwd,
              permissionMode: meta.permissionMode,
              busy: meta.state === 'running' || meta.state === 'waiting_permission',
              text: effect.text,
            },
            expectSession: { sessionId: meta.sessionId, cwd: meta.cwd, permissionMode: meta.permissionMode },
          });
          break;
        }
        case 'links.add': {
          const meta = await needTarget();
          steps.push({
            effect,
            view: { type: 'links.add', targetSessionId: meta.sessionId, links: effect.links },
            expectSession: { sessionId: meta.sessionId, cwd: meta.cwd, permissionMode: meta.permissionMode },
          });
          break;
        }
        case 'links.remove': {
          const meta = await needTarget();
          steps.push({
            effect,
            view: { type: 'links.remove', targetSessionId: meta.sessionId, refs: effect.refs },
            expectSession: { sessionId: meta.sessionId, cwd: meta.cwd, permissionMode: meta.permissionMode },
          });
          break;
        }
      }
    }
    return steps;
  }

  async #checkPreconditions(steps: readonly ResolvedStep[]): Promise<void> {
    for (const step of steps) {
      const expect = step.expectSession;
      if (expect === undefined) continue;
      if (this.#host.isDeleted(expect.sessionId)) throw new ExtFailure('stale', '会话已删除');
      const meta = await this.#host.sessionMeta(expect.sessionId);
      if (meta === undefined) throw new ExtFailure('stale', '会话已不存在');
      if (meta.cwd !== expect.cwd || meta.permissionMode !== expect.permissionMode) {
        throw new ExtFailure('stale', '会话的工作目录或权限模式已变化，请重新确认');
      }
    }
  }

  async #execute(
    token: TokenRecord,
    steps: readonly ResolvedStep[],
    extra: Pick<PlanRecord, 'local' | 'view' | 'viewRev' | 'message' | 'newSession'>,
  ): Promise<Omit<ResultBody, 'reqId' | 'type' | 'invocationId'>> {
    const result: Omit<ResultBody, 'reqId' | 'type' | 'invocationId'> = { ok: true };
    const touched = new Set<string>();
    let warning: string | undefined;
    this.#assertCurrent(token);
    for (const step of steps) {
      const effect = step.effect;
      switch (effect.type) {
        case 'session.create': {
          const view = step.view as Extract<ExtPlanStep, { type: 'session.create' }>;
          this.#assertCurrent(token);
          const created = await this.#host.createSession({
            cwd: view.cwd,
            model: view.model,
            permissionMode: view.permissionMode as PermissionMode,
            ...(view.title === undefined ? {} : { title: view.title }),
            ext: token.ext,
            links: view.links,
            prompt: view.prompt,
            precheck: () => this.#assertCurrent(token),
          });
          result.createdSessionId = created.sessionId;
          if (created.sendError !== undefined) warning = `会话已建好，但接续消息没有发出去（${created.sendError}），请在新会话里重发`;
          break;
        }
        case 'prompt.send': {
          const view = step.view as Extract<ExtPlanStep, { type: 'prompt.send' }>;
          const sent = await this.#host.withSession(view.targetSessionId, async (api) => {
            await this.#verifyInChain(token, step, api);
            return api.send(view.text);
          });
          result.sent = { targetSessionId: view.targetSessionId, clientMsgId: sent.clientMsgId, text: view.text, queued: sent.queued };
          break;
        }
        case 'links.add':
        case 'links.remove': {
          const sid = token.targetSessionId!;
          const changed = await this.#host.withSession(sid, async (api) => {
            await this.#verifyInChain(token, step, api);
            return this.#links.update(
              sid,
              token.ext,
              effect.type === 'links.add' ? effect.links : [],
              effect.type === 'links.remove' ? effect.refs : [],
              this.#now(),
            );
          });
          if (changed) touched.add(sid);
          break;
        }
        case 'invoke':
          break;
      }
    }
    for (const sid of touched) await this.#host.broadcastSession(sid).catch(() => {});
    // 会话面板里扩展自己的操作成功了：在该会话时间线留一条记录（关联的增删由 links store 另记）
    if (token.invoke !== undefined && token.point === 'sessionPanel' && token.targetSessionId !== undefined) {
      this.#record(token, extra.message);
    }
    this.#bumpEpoch(token.ext);
    this.#markDirty((lease) => lease.read.ext === token.ext);
    if (extra.local.length > 0) result.local = extra.local;
    if (extra.view !== undefined) result.view = extra.view;
    if (extra.viewRev !== undefined) result.viewRev = extra.viewRev;
    const message = [extra.message, warning].filter((m): m is string => m !== undefined).join('；');
    if (message !== '') result.message = message;
    return result;
  }

  #record(token: TokenRecord, message: string | undefined): void {
    if (this.#records === undefined || token.targetSessionId === undefined) return;
    // 扩展进程在会话链外跑：期间会话可能已被永久删除（记录已清），不能再写回去
    if (this.#host.isDeleted(token.targetSessionId)) return;
    try {
      const ext = this.#registry.get(token.ext);
      this.#records.append(token.targetSessionId, {
        ext: token.ext,
        extName: ext?.manifest?.name ?? token.ext,
        kind: 'action',
        label: token.action.label,
        ...(token.itemTitle === undefined ? {} : { subject: token.itemTitle }),
        ...(message === undefined || message === '' ? {} : { message }),
      });
    } catch (err) {
      this.#log(`[ext] 写时间线记录失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 扩展仍可用、代次没变（停用 / 改权限 / reload 后在途的动作不再提交） */
  #assertCurrent(token: TokenRecord): void {
    if (this.#disposed) throw new ExtFailure('stale', 'agent 正在退出');
    const ext = this.#registry.get(token.ext);
    if (ext === undefined || !ext.enabled || ext.manifest === undefined || ext.generation !== token.generation) {
      throw new ExtFailure('stale', '扩展已变更，请重新操作');
    }
  }

  /** 会话链上的复查：会话还在、目录与权限模式与确认时一致、扩展没变 */
  async #verifyInChain(token: TokenRecord, step: ResolvedStep, api: { meta(): Promise<SessionMeta | undefined> }): Promise<void> {
    this.#assertCurrent(token);
    const expect = step.expectSession;
    if (expect === undefined) return;
    const meta = await api.meta();
    if (meta === undefined) throw new ExtFailure('stale', '会话已不存在');
    if (meta.cwd !== expect.cwd || meta.permissionMode !== expect.permissionMode) {
      throw new ExtFailure('stale', '会话的工作目录或权限模式已变化，请重新确认');
    }
  }

  #finish(invocationId: string, result: Omit<ResultBody, 'reqId' | 'type' | 'invocationId'>): void {
    const inv = this.#invocations.get(invocationId);
    if (inv === undefined) return;
    inv.state = 'done';
    inv.result = result;
    delete inv.planId;
    inv.at = this.#now();
  }

  #pruneInvocations(): void {
    const now = this.#now();
    for (const [id, inv] of this.#invocations) if (now - inv.at > INVOCATION_TTL_MS) this.#invocations.delete(id);
    for (const [id, plan] of this.#plans) {
      if (plan.expiresAt > now) continue;
      this.#plans.delete(id);
      this.#finish(plan.invocationId, { ok: false, error: { code: 'stale', message: '确认已过期' } });
    }
    for (const [t, r] of this.#tokens) if (r.expiresAt <= now) this.#tokens.delete(t);
  }

  // -------------------------------------------------------------------------
  // 订阅推送
  // -------------------------------------------------------------------------

  #leaseKey(deviceId: string, e: ReadEvent): string {
    return JSON.stringify([deviceId, e.ext, e.op, e.point, e.targetSessionId ?? '', e.cwd ?? '', e.args?.query ?? '', e.locale ?? '']);
  }

  #markDirty(match: (lease: Lease) => boolean): void {
    let any = false;
    for (const [key, lease] of this.#leases) {
      if (match(lease)) {
        this.#dirty.add(key);
        any = true;
      }
    }
    if (!any || this.#refreshTimer !== undefined) return;
    this.#refreshTimer = this.#setTimer(() => {
      this.#refreshTimer = undefined;
      void this.#flushDirty();
    }, REFRESH_DEBOUNCE_MS);
  }

  async #flushDirty(): Promise<void> {
    const keys = [...this.#dirty];
    this.#dirty.clear();
    const now = this.#now();
    for (const key of keys) {
      const lease = this.#leases.get(key);
      if (lease === undefined) continue;
      if (lease.expiresAt <= now) {
        this.#leases.delete(key);
        continue;
      }
      try {
        // 同一轮里相同的读取命中缓存（键相同），不会重复起进程
        const body = await this.#readOnce(lease.deviceId, lease.read, false);
        if (this.#leases.get(key) === lease) this.#host.emitTo(lease.deviceId, body);
      } catch (err) {
        this.#log(`[ext] 推送刷新失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // -------------------------------------------------------------------------

  #usable(id: string): LoadedExtension {
    const ext = this.#registry.get(id);
    if (ext === undefined) throw new ExtFailure('not_found', `没有扩展 ${id}`);
    if (!ext.enabled) throw new ExtFailure('disabled', `扩展 ${id} 已停用`);
    if (ext.manifest === undefined || ext.argv === undefined) throw new ExtFailure('unsupported', ext.lastError ?? `扩展 ${id} 不可用`);
    return ext;
  }

  #epochOf(ext: string): number {
    return this.#epoch.get(ext) ?? 0;
  }

  #bumpEpoch(ext: string): void {
    this.#epoch.set(ext, this.#epochOf(ext) + 1);
    for (const key of [...this.#cache.keys()]) if (key.startsWith(`${ext}\n`)) this.#cache.delete(key);
  }

  #pruneCache(): void {
    if (this.#cache.size < 500) return;
    const now = this.#now();
    for (const [key, entry] of this.#cache) if (now - entry.at >= READ_CACHE_TTL_MS) this.#cache.delete(key);
  }
}

function checkPoint(ext: LoadedExtension, op: ReadOp, point: ExtPoint): void {
  const contributes = ext.manifest!.contributes;
  const ok =
    (op === 'view' && (point === 'sessionPanel' || point === 'workspacePanel')) ||
    (op === 'badge' && point === 'sessionBadge') ||
    (op === 'pick' && (point === 'linkPicker' || point === 'composerAction' || point === 'newSession'));
  const declared = point === 'sessionBadge' ? contributes.sessionBadge === true : contributes[point] !== undefined;
  if (!ok || !declared) throw new ExtFailure('unsupported', `扩展没有提供 ${point}`);
}

function sessionContext(meta: SessionMeta, ext: string): Record<string, unknown> {
  return {
    id: meta.sessionId,
    title: meta.title,
    state: meta.state,
    cwd: meta.cwd,
    archived: meta.archived === true,
    links: (meta.links ?? []).filter((l) => l.ext === ext).map((l) => ({ ref: l.ref, label: l.label })),
  };
}

function cacheKey(ext: LoadedExtension, input: unknown): string {
  return `${ext.id}\n${ext.generation}\n${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

function compact<T>(items: readonly (T | undefined)[]): T[] {
  return items.filter((i): i is T => i !== undefined);
}

function toExtError(err: unknown): ExtError {
  if (err instanceof ExtFailure) return { code: err.code, message: err.message.slice(0, 1_000) };
  if (err instanceof Error && err.name === 'ZodError') {
    return { code: 'invalid_output', message: `扩展返回了无法识别的内容：${err.message.slice(0, 800)}` };
  }
  if (err instanceof Error && err.name === 'LinkLimitError') return { code: 'denied', message: err.message };
  return { code: 'io', message: (err instanceof Error ? err.message : String(err)).slice(0, 1_000) };
}

export type { ExtBadge };

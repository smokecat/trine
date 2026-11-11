/**
 * 扩展的 web 侧模型（纯逻辑，有单测）：目录缓存、读取结果的新旧判断、动作执行流程。
 *
 * 浏览器不执行扩展的任何代码，只渲染 agent 给的视图数据（lib 之外的 components/ext/）。
 * 动作分两类：
 * - 带 `local` 的：本地效果（插入输入框、复制、刷新），由点击的设备直接执行；
 * - 带 `token` 的：交给 agent 执行。prepare →（需要确认时）展示 agent 固定好的计划 → commit。
 *   web 不会把扩展给的效果转成普通的 input.send / session.create。
 */
import {
  negotiateExtFeatures,
  parseExtCatalog,
  type AgentToClientEvent,
  type ExtCatalogItem,
  type ExtFeature,
  type ExtFilesOpenEffect,
  type ExtLocalEffect,
  type ExtPlan,
  type ExtPoint,
  type ExtRecord,
  type MachineInfo,
  type PermissionMode,
} from '@trine/core';

export type ExtReadResponse = Extract<AgentToClientEvent, { type: 'ext.read.response' }>;
export type ExtActionResult = Extract<AgentToClientEvent, { type: 'ext.action.result' }>;
export type ExtActionPlanEvent = Extract<AgentToClientEvent, { type: 'ext.action.plan' }>;

/** agent 支持时间线记录卡（agent ≥ 0.17.0 在摘要里带 records） */
export function supportsExtRecords(info: MachineInfo | null | undefined): boolean {
  return info?.extensions?.records === true;
}

/** agent 支持扩展：machine.info 带 extensions 摘要（不按版本号判断） */
export function supportsExtensions(info: MachineInfo | null | undefined): boolean {
  return info?.extensions !== undefined;
}

/** 已启用、可用、提供了某个贡献点的扩展 */
export function extensionsFor(items: readonly ExtCatalogItem[], point: ExtPoint): ExtCatalogItem[] {
  return items.filter((e) => {
    if (!e.enabled || e.status !== 'ok') return false;
    return point === 'sessionBadge' ? e.contributes.sessionBadge === true : e.contributes[point] !== undefined;
  });
}

// ---------------------------------------------------------------------------
// 目录缓存（按机器，rev 变了才重拉）
// ---------------------------------------------------------------------------

export interface CatalogState {
  rev: string;
  items: ExtCatalogItem[];
}

export class ExtCatalogCache {
  readonly #state = new Map<string, CatalogState>();
  readonly #inflight = new Map<string, Promise<CatalogState>>();
  readonly #listeners = new Set<() => void>();

  constructor(private readonly fetchCatalog: (machineId: string) => Promise<{ rev: string; items: unknown[] }>) {}

  get(machineId: string): CatalogState | undefined {
    return this.#state.get(machineId);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 确保拿到 rev 对应的目录；rev 没变不重复拉，拉取中的复用同一个请求 */
  ensure(machineId: string, rev: string): Promise<CatalogState> {
    const current = this.#state.get(machineId);
    if (current?.rev === rev) return Promise.resolve(current);
    const key = `${machineId}\n${rev}`;
    const inflight = this.#inflight.get(key);
    if (inflight !== undefined) return inflight;
    const promise = this.fetchCatalog(machineId)
      .then((res) => {
        const next = { rev: res.rev, items: parseExtCatalog(res.items) };
        this.#state.set(machineId, next);
        for (const l of this.#listeners) l();
        return next;
      })
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, promise);
    return promise;
  }

  /** 改配置后立即重拉（agent 会广播新 rev，这里不等它） */
  invalidate(machineId: string): void {
    this.#state.delete(machineId);
    for (const l of this.#listeners) l();
  }
}

// ---------------------------------------------------------------------------
// 读取结果：按 rev 丢弃晚到的旧结果
// ---------------------------------------------------------------------------

export interface ReadTarget {
  machineId: string;
  ext: string;
  op: 'view' | 'badge' | 'pick';
  point: ExtPoint;
  targetSessionId?: string;
  cwd?: string;
  /**
   * 本设备声明的特性（webExtFeatures，已按 agent 支持与贡献点协商过，等于 agent 会回的有效集）。
   * 进 readKey：特性集变了就是另一份结果，切换期间不会拿旧特性集下的动作来显示。
   */
  features?: readonly ExtFeature[];
}

/** 特性集的规范形式：去重、排序、逗号连接 */
export function featureKey(features: readonly string[] | undefined): string {
  return [...new Set(features ?? [])].sort().join(',');
}

export function readKey(t: ReadTarget): string {
  return [t.machineId, t.ext, t.op, t.point, t.targetSessionId ?? '', t.cwd ?? '', featureKey(t.features)].join('\n');
}

/** 推送 / 应答对应哪个读取目标 */
export function responseKey(machineId: string, res: ExtReadResponse): string {
  return readKey({
    machineId,
    ext: res.ext,
    op: res.op,
    point: res.point,
    ...(res.targetSessionId === undefined ? {} : { targetSessionId: res.targetSessionId }),
    ...(res.targetSessionId === undefined && res.cwd !== undefined ? { cwd: res.cwd } : {}),
    // agent 回的有效特性集（旧 agent 不带 = 空，与 web 不声明时一致）
    ...(res.features === undefined ? {} : { features: res.features as ExtFeature[] }),
  });
}

/** 新结果是否该替换已显示的：rev 更大才替换 */
export function isNewer(current: { rev: number } | undefined, next: { rev: number }): boolean {
  return current === undefined || next.rev > current.rev;
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

export interface ExtActionDeps {
  prepare: (token: string, invocationId: string, newSession: { model: string; permissionMode: PermissionMode }) => Promise<ExtActionPlanEvent | ExtActionResult>;
  commit: (planId: string, invocationId: string) => Promise<ExtActionResult>;
  cancel: (planId: string) => void;
  /** 展示计划给用户确认；true = 确认 */
  confirm: (plan: ExtPlan) => Promise<boolean>;
  newSessionDefaults: () => { model: string; permissionMode: PermissionMode };
  uuid: () => string;
}

export type ActionOutcome =
  | { kind: 'done'; result: ExtActionResult }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string; code?: string };

/** 一次点击：prepare →（需要时）确认 → commit。invoke 可能有第二阶段计划，循环处理 */
export async function runTokenAction(token: string, deps: ExtActionDeps): Promise<ActionOutcome> {
  const invocationId = deps.uuid();
  let res: ExtActionPlanEvent | ExtActionResult;
  try {
    res = await deps.prepare(token, invocationId, deps.newSessionDefaults());
    for (let stage = 0; res.type === 'ext.action.plan' && stage < 3; stage++) {
      const confirmed = await deps.confirm(res.plan);
      if (!confirmed) {
        deps.cancel(res.planId);
        return { kind: 'cancelled' };
      }
      const committed: ExtActionPlanEvent | ExtActionResult = await deps.commit(res.planId, invocationId);
      res = committed;
    }
  } catch (err) {
    return { kind: 'failed', message: err instanceof Error ? err.message : String(err), code: 'unknown_outcome' };
  }
  if (res.type !== 'ext.action.result') return { kind: 'failed', message: '确认步骤过多' };
  if (!res.ok) {
    if (res.error?.code === 'denied' && res.error.message === '已取消') return { kind: 'cancelled' };
    return { kind: 'failed', message: res.error?.message ?? '操作失败', ...(res.error === undefined ? {} : { code: res.error.code }) };
  }
  return { kind: 'done', result: res };
}

/** 本地效果的执行器（由界面提供） */
export interface LocalEffectHandlers {
  insert: (text: string) => void;
  copy: (text: string) => Promise<boolean>;
  refresh: () => void;
  /**
   * 打开文件 / 浏览目录（files.open）。只在会话页、agent 支持文件查看时提供；不提供时本设备
   * 也不声明 files.open 特性（agent 就不会给带它的动作），万一收到也忽略。
   */
  filesOpen?: (effect: ExtFilesOpenEffect) => void;
}

export async function applyLocalEffects(effects: readonly ExtLocalEffect[], handlers: LocalEffectHandlers): Promise<void> {
  for (const effect of effects) {
    if (effect.type === 'prompt.insert') handlers.insert(effect.text);
    else if (effect.type === 'copy') await handlers.copy(effect.text);
    else if (effect.type === 'files.open') handlers.filesOpen?.(effect);
    else handlers.refresh();
  }
}

/**
 * 本页面实例 id（每次加载页面生成），随 ext.read / ext.action.prepare 发给 agent：同一设备换了
 * 页面（别的标签页接管、旧版页面接管）时，agent 据此作废旧实例的订阅与带特性的在途结果。
 */
export const EXT_CLIENT_INSTANCE: string =
  typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2, 14);

/**
 * 本设备在某个贡献点声明的特性 =本页有处理器的 ∩ agent 在 machine.info.extensions.features 里
 * 列出的 ∩ 贡献点能执行的（与 agent 同一个 negotiateExtFeatures）。所以声明的就是 agent 会回的
 * 有效集，请求与应答的缓存键一致；旧 agent 不列 features，就什么都不声明。
 */
export function webExtFeatures(point: ExtPoint, handlers: { filesOpen?: unknown }, agentFeatures: readonly string[] | undefined): ExtFeature[] {
  const mine: ExtFeature[] = handlers.filesOpen !== undefined ? ['files.open'] : [];
  return negotiateExtFeatures(mine, agentFeatures ?? [], point);
}

/**
 * 本地动作能不能整条执行：用到的特性本页都有处理器。不能就整条不执行（不只执行其中一部分）。
 * 返回缺的特性；undefined = 可以执行。
 */
export function missingLocalHandler(effects: readonly ExtLocalEffect[], handlers: { filesOpen?: unknown }): string | undefined {
  return effects.some((e) => e.type === 'files.open') && handlers.filesOpen === undefined ? 'files.open' : undefined;
}

export interface LocalActionDeps {
  /** **当前**的执行器：每一步都重新取，不用点击时捕获的（处理器可能在等待期间没了） */
  handlers: () => LocalEffectHandlers;
  /** 浏览器还在发起动作的会话（地址里含机器与会话） */
  stillHere: () => boolean;
  /** 整条或剩余部分没执行：missing = 本页没有这个特性的处理器；left = 已离开发起的会话 */
  blocked: (reason: 'missing' | 'left', detail?: string) => void;
}

/**
 * 执行一个动作的本地效果：
 * - 先按当前处理器检查**整个动作**，缺特性就一条都不执行；
 * - 带 files.open 的动作绑定发起会话：开始前、每个 await 之后、打开前都复查，离开了就丢弃剩余效果；
 * - 同一动作的多段插入合成一次（逐段插入会被 React 合批成只剩最后一段）；
 * - 多个 files.open 只打开最后一个（抽屉是单视图，逐个打开只会多留几条历史）。
 */
export async function executeLocalAction(effects: readonly ExtLocalEffect[], deps: LocalActionDeps): Promise<void> {
  const bound = effects.some((e) => e.type === 'files.open');
  const missing = missingLocalHandler(effects, deps.handlers());
  if (missing !== undefined) return deps.blocked('missing', missing);
  if (bound && !deps.stillHere()) return deps.blocked('left');
  const inserts: string[] = [];
  let open: ExtFilesOpenEffect | undefined;
  for (const effect of effects) {
    if (effect.type === 'prompt.insert') inserts.push(effect.text);
    else if (effect.type === 'files.open') open = effect;
    else if (effect.type === 'refresh') deps.handlers().refresh();
    else {
      await deps.handlers().copy(effect.text);
      if (bound && !deps.stillHere()) return deps.blocked('left');
    }
  }
  if (open !== undefined) {
    if (!deps.stillHere()) return deps.blocked('left');
    const filesOpen = deps.handlers().filesOpen;
    if (filesOpen === undefined) return deps.blocked('missing', 'files.open');
    filesOpen(open);
  }
  if (inserts.length > 0) deps.handlers().insert(inserts.join('\n'));
}

/**
 * files.open 绑定发起的会话：结果回来时浏览器已经在别的会话（或别的页面）就丢掉，
 * 不把扩展要打开的路径打开到另一个会话里（文件查看按会话鉴权、相对路径按会话 cwd 解析）。
 */
export function filesOpenTarget(originPath: string, currentPath: string): 'open' | 'drop' {
  return originPath === currentPath ? 'open' : 'drop';
}

/** 计划步骤的人话（确认弹窗用） */
export function permissionModeLabel(mode: string): string {
  switch (mode) {
    case 'bypassPermissions':
      return 'bypass（跳过所有权限确认）';
    case 'acceptEdits':
      return 'acceptEdits（自动接受编辑）';
    case 'plan':
      return 'plan（只规划）';
    default:
      return 'default（逐项确认）';
  }
}

// ---------------------------------------------------------------------------
// 时间线记录卡（U8）
// ---------------------------------------------------------------------------

/** 合并记录（拉取的与实时推送的可能交错到达）：按 id 去重、按时间正序 */
export function mergeRecords(current: readonly ExtRecord[] | undefined, incoming: readonly ExtRecord[]): ExtRecord[] {
  const byId = new Map<string, ExtRecord>();
  for (const r of current ?? []) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => a.at - b.at);
}

export interface RecordPlacement {
  /** 条目下标 → 排在它前面的记录 */
  before: Map<number, ExtRecord[]>;
  /** 比全部条目都晚的记录 */
  tail: ExtRecord[];
}

/**
 * 按时间把记录插进时间线：每条记录排在第一条比它晚的条目前面。
 * hideOlder：更早的历史还没加载时，早于已加载最早条目的记录先不显示（等翻到那里再出现）。
 */
export function placeRecords(entries: readonly { ts: number }[], records: readonly ExtRecord[], hideOlder: boolean): RecordPlacement {
  const before = new Map<number, ExtRecord[]>();
  const tail: ExtRecord[] = [];
  const first = entries[0]?.ts;
  let i = 0;
  for (const record of records) {
    if (hideOlder && first !== undefined && record.at < first) continue;
    while (i < entries.length && entries[i]!.ts <= record.at) i++;
    if (i >= entries.length) tail.push(record);
    else before.set(i, [...(before.get(i) ?? []), record]);
  }
  return { before, tail };
}

/** 记录卡的文字（宿主文案；扩展给的 label / subject / message 都当纯文本） */
export function recordText(record: ExtRecord): string {
  switch (record.kind) {
    case 'linked':
      return `已关联 ${record.label}`;
    case 'unlinked':
      return `已取消关联 ${record.label}`;
    default: {
      const head = record.subject === undefined ? record.label : `${record.label} · ${record.subject}`;
      return record.message === undefined ? head : `${head}：${record.message}`;
    }
  }
}

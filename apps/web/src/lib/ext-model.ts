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
  parseExtCatalog,
  type AgentToClientEvent,
  type ExtCatalogItem,
  type ExtLocalEffect,
  type ExtPlan,
  type ExtPoint,
  type MachineInfo,
  type PermissionMode,
} from '@trine/core';

export type ExtReadResponse = Extract<AgentToClientEvent, { type: 'ext.read.response' }>;
export type ExtActionResult = Extract<AgentToClientEvent, { type: 'ext.action.result' }>;
export type ExtActionPlanEvent = Extract<AgentToClientEvent, { type: 'ext.action.plan' }>;

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
}

export function readKey(t: ReadTarget): string {
  return [t.machineId, t.ext, t.op, t.point, t.targetSessionId ?? '', t.cwd ?? ''].join('\n');
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
}

export async function applyLocalEffects(effects: readonly ExtLocalEffect[], handlers: LocalEffectHandlers): Promise<void> {
  for (const effect of effects) {
    if (effect.type === 'prompt.insert') handlers.insert(effect.text);
    else if (effect.type === 'copy') await handlers.copy(effect.text);
    else handlers.refresh();
  }
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

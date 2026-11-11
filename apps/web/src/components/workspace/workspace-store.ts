/**
 * 工作区持久化：localStorage，按「机器 + 会话工作目录」隔离（同目录的会话共享 tab），带 schema 版本，
 * 限条数（最久没用的先删）。只存 tab 元数据、dockview 布局与小的内容状态，不存内容与 Blob URL。
 * localStorage 不可用或满额时退回内存（本页有效）。
 *
 * 另有 `WorkspaceViewStore`：tab 的内容状态（模式、换行、滚动）与一次性的锚点定位请求，
 * dockview 外的一份可订阅数据，tab 组件、窄屏抽屉、持久化都读它。
 */
import { readSnapshot, SNAPSHOT_VERSION, type TabViewState, type WorkspaceSnapshot } from './workspace-model.ts';

const PREFIX = `trine.workspace.v${SNAPSHOT_VERSION}:`;
const INDEX_KEY = `trine.workspace.v${SNAPSHOT_VERSION}.index`;
/** 最多记这么多个「机器 + 目录」的工作区 */
export const WORKSPACE_STORE_MAX = 30;

export function workspaceKey(machineId: string, cwd: string): string {
  return `${machineId}\n${cwd}`;
}

export interface KvLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultKv(): KvLike | null {
  try {
    const ls = globalThis.localStorage;
    return ls === undefined || ls === null ? null : ls;
  } catch {
    return null;
  }
}

export class WorkspaceStore {
  readonly #kv: KvLike | null;
  /** 写不进 localStorage 时的内存副本（也用作读缓存） */
  readonly #memory = new Map<string, string>();
  readonly #max: number;

  constructor(kv: KvLike | null = defaultKv(), max = WORKSPACE_STORE_MAX) {
    this.#kv = kv;
    this.#max = max;
  }

  load(key: string): WorkspaceSnapshot | null {
    let raw = this.#memory.get(key) ?? null;
    if (raw === null) {
      try {
        raw = this.#kv?.getItem(PREFIX + key) ?? null;
      } catch {
        raw = null;
      }
    }
    if (raw === null) return null;
    try {
      return readSnapshot(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  save(key: string, snap: WorkspaceSnapshot): void {
    if (snap.tabs.length === 0) return this.remove(key);
    const text = JSON.stringify(snap);
    try {
      if (this.#kv === null) throw new Error('no storage');
      this.#kv.setItem(PREFIX + key, text);
      this.#memory.delete(key);
      this.#touch(key);
    } catch {
      // 满额 / 隐私模式：本页内存里留一份，同样按条数上限淘汰最久没写的
      this.#memory.delete(key);
      this.#memory.set(key, text);
      while (this.#memory.size > this.#max) this.#memory.delete(this.#memory.keys().next().value!);
    }
  }

  remove(key: string): void {
    this.#memory.delete(key);
    try {
      this.#kv?.removeItem(PREFIX + key);
      const index = this.#index().filter((k) => k !== key);
      this.#kv?.setItem(INDEX_KEY, JSON.stringify(index));
    } catch {
      // 忽略：最多留一条孤儿，下次 touch 时按上限清掉
    }
  }

  #index(): string[] {
    try {
      const raw = this.#kv?.getItem(INDEX_KEY);
      const parsed: unknown = raw == null ? [] : JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
    } catch {
      return [];
    }
  }

  /** 把 key 挪到最新；超出上限删最旧的 */
  #touch(key: string): void {
    const index = this.#index().filter((k) => k !== key);
    index.push(key);
    while (index.length > this.#max) {
      const old = index.shift()!;
      this.#kv?.removeItem(PREFIX + old);
    }
    this.#kv?.setItem(INDEX_KEY, JSON.stringify(index));
  }
}

/**
 * 一次性重挂请求：nonce 每次递增，tab 据此重挂视图（按 store 里的内容状态重新定位）；
 * 带 fragment 时加载后跳到锚点。每个 nonce 只被消费一次（tab 隐藏再显示不重复跳）。
 */
export interface MountRequest {
  fragment?: string | undefined;
  nonce: number;
}

/**
 * tab 的内容状态（模式、换行、滚动）：工作区 tab 与窄屏抽屉**订阅同一份**，任何一处改了另一处跟着变。
 * 一份工作区（机器 + cwd）一个实例：锚点消费记录也在这里，不跨工作区串扰。
 */
export class WorkspaceViewStore {
  readonly #view = new Map<string, TabViewState>();
  readonly #mounts = new Map<string, MountRequest>();
  /** id → 已消费到的 nonce */
  readonly #consumed = new Map<string, number>();
  /** 已关闭的 tab：卸载时迟到的滚动上报不能把状态写回来 */
  readonly #closed = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #nonce = 0;
  /** 内容状态变了（滚动停下、切模式）：控制器据此安排保存 */
  onChange: (() => void) | null = null;

  get(id: string): TabViewState | undefined {
    return this.#view.get(id);
  }

  patch(id: string, patch: TabViewState): void {
    if (this.#closed.has(id)) return;
    this.#view.set(id, { ...this.#view.get(id), ...patch });
    this.#emit();
    this.onChange?.();
  }

  /** 整体替换某个 tab 的状态（抽屉交接带来的） */
  set(id: string, state: TabViewState): void {
    this.#closed.delete(id);
    this.#view.set(id, { ...state });
    this.#emit();
    this.onChange?.();
  }

  /** tab 关闭：丢掉状态与请求，并拒绝之后的迟到上报 */
  delete(id: string): void {
    this.#view.delete(id);
    this.#mounts.delete(id);
    this.#consumed.delete(id);
    this.#closed.add(id);
  }

  /** 同一 id 的 tab 重新打开 */
  revive(id: string): void {
    this.#closed.delete(id);
  }

  entries(): ReadonlyMap<string, TabViewState> {
    return this.#view;
  }

  replaceAll(view: Record<string, TabViewState>): void {
    this.#view.clear();
    for (const [id, s] of Object.entries(view)) this.#view.set(id, s);
    this.#emit();
  }

  /** 让 tab 重挂视图（可带锚点） */
  requestMount(id: string, fragment?: string): void {
    this.#nonce += 1;
    this.#mounts.set(id, { fragment, nonce: this.#nonce });
    this.#emit();
  }

  /** 兼容旧名：带锚点的重挂 */
  requestFragment(id: string, fragment: string): void {
    this.requestMount(id, fragment);
  }

  mount(id: string): MountRequest | undefined {
    return this.#mounts.get(id);
  }

  /** 兼容旧名 */
  fragment(id: string): MountRequest | undefined {
    return this.#mounts.get(id);
  }

  /** 视图挂载时调用：这次请求还没消费过就返回它的锚点（并记为已消费），否则 undefined */
  consumeFragment(id: string, request: MountRequest | undefined): string | undefined {
    if (request === undefined || (this.#consumed.get(id) ?? 0) >= request.nonce) return undefined;
    this.#consumed.set(id, request.nonce);
    return request.fragment;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}

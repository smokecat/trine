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
      // 满额 / 隐私模式：本页内存里留一份
      this.#memory.set(key, text);
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

/** 一次性定位请求：nonce 每次递增，tab 据此重挂文件视图并跳到锚点 */
export interface FragmentRequest {
  fragment: string;
  nonce: number;
}

export class WorkspaceViewStore {
  readonly #view = new Map<string, TabViewState>();
  readonly #fragments = new Map<string, FragmentRequest>();
  readonly #listeners = new Set<() => void>();
  #nonce = 0;
  /** 内容状态变了（滚动停下、切模式）：控制器据此安排保存 */
  onChange: (() => void) | null = null;

  get(id: string): TabViewState | undefined {
    return this.#view.get(id);
  }

  patch(id: string, patch: TabViewState): void {
    this.#view.set(id, { ...this.#view.get(id), ...patch });
    this.onChange?.();
  }

  /** 新 tab 带着抽屉交接来的状态 */
  set(id: string, state: TabViewState): void {
    this.#view.set(id, { ...state });
  }

  delete(id: string): void {
    this.#view.delete(id);
    this.#fragments.delete(id);
  }

  entries(): ReadonlyMap<string, TabViewState> {
    return this.#view;
  }

  replaceAll(view: Record<string, TabViewState>): void {
    this.#view.clear();
    for (const [id, s] of Object.entries(view)) this.#view.set(id, s);
  }

  requestFragment(id: string, fragment: string): void {
    this.#nonce += 1;
    this.#fragments.set(id, { fragment, nonce: this.#nonce });
    for (const l of this.#listeners) l();
  }

  fragment(id: string): FragmentRequest | undefined {
    return this.#fragments.get(id);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

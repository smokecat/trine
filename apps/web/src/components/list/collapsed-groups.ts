/**
 * 工作空间分组的折叠状态（session-list-v2 §4.3）。
 *
 * 存 localStorage（本设备的界面偏好，不值得进 prefs 走 client），读写全部
 * try/catch：隐私模式 / 配额满 / 站点数据被禁时退化成「只在内存里记」，
 * 列表照常渲染。模块级单例 + `useSyncExternalStore`：列表页、PC 侧栏、
 * 归档视图同时挂着时折叠一处、各处同步。
 *
 * 折叠只是「想收起」的意图；有待批准的组仍强制展开（`isGroupExpanded`）。
 */
import { useCallback, useSyncExternalStore } from 'react';

export const COLLAPSED_GROUPS_KEY = 'trine.list.collapsed';
/** 键上限：组 key 含 cwd，长期使用会积累已不存在的目录，别让它无限长 */
const MAX_KEYS = 200;

let cache: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read(): ReadonlySet<string> {
  if (cache !== null) return cache;
  let keys: string[] = [];
  try {
    const raw = storage()?.getItem(COLLAPSED_GROUPS_KEY) ?? null;
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    if (Array.isArray(parsed)) keys = parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    keys = [];
  }
  cache = new Set(keys);
  return cache;
}

function write(next: ReadonlySet<string>): void {
  cache = next;
  try {
    storage()?.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...next].slice(-MAX_KEYS)));
  } catch {
    /* 写不进去就只在内存里记 */
  }
  for (const l of listeners) l();
}

/** 测试用：读当前折叠集合（组件里用 useCollapsedGroups） */
export function readCollapsedGroupsForTest(): ReadonlySet<string> {
  return read();
}

export function setGroupCollapsed(key: string, collapsed: boolean): void {
  const current = read();
  if (current.has(key) === collapsed) return;
  const next = new Set(current);
  if (collapsed) next.add(key);
  else next.delete(key);
  write(next);
}

/** 测试用：丢掉内存缓存，下次从 storage 重读 */
export function resetCollapsedGroupsForTest(): void {
  cache = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCollapsedGroups(): readonly [ReadonlySet<string>, (key: string, collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(subscribe, read, read);
  const set = useCallback((key: string, value: boolean) => setGroupCollapsed(key, value), []);
  return [collapsed, set] as const;
}

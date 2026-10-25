/**
 * 子 agent 工具树（subagent-view）的纯函数：带 `parentToolUseId` 的 tool 帧挂到父
 * Agent/Task 条目的 `children` 下，嵌套子 agent 自然成树。零 I/O、不可变更新。
 *
 * ## 为什么父条目可能不在
 *
 * - 帧乱序 / 补发窗口：子工具的 tool.start 先于父 Agent 的 tool.start 到达；
 * - 父在更早的历史页里（本机转录回看还没翻到那一页）；
 * - 本地时间线被裁（TIMELINE_MAX_ENTRIES）裁掉了父条目。
 *
 * 这时子条目先按 parent 分组暂存在 `pendingChildren`，父条目一出现（实时帧、
 * 历史合并、子转录回看）就并进去。暂存区有界：组数与每组条数都封顶。
 */
import type { HistoryItem } from '@trine/core';
import type { TimelineEntry, ToolEntry } from './reducer.ts';

/** 每个父条目下最多保留的子工具条数（超了丢最旧的已完成项；总数另记 childCount） */
export const MAX_TOOL_CHILDREN = 200;
/** 暂存区最多保留的父 id 组数（超了丢最早的组） */
export const MAX_PENDING_PARENTS = 50;

/** 父 id → 等父条目出现的子条目 */
export type PendingChildren = Record<string, ToolEntry[]>;

/** 在一棵子树里按 id 找工具条目 */
function findInTools(tools: readonly ToolEntry[], id: string): ToolEntry | undefined {
  for (const t of tools) {
    if (t.id === id) return t;
    if (t.children !== undefined) {
      const hit = findInTools(t.children, id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** 在整条时间线（含所有子树）里按 id 找工具条目 */
export function findTool(entries: readonly TimelineEntry[], id: string): ToolEntry | undefined {
  for (const e of entries) {
    if (e.kind !== 'tool') continue;
    if (e.id === id) return e;
    if (e.children !== undefined) {
      const hit = findInTools(e.children, id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** 子树里按 id 原地改一个条目；没找到返回 undefined（引用不变的判据） */
function updateInTools(tools: ToolEntry[], id: string, fn: (t: ToolEntry) => ToolEntry): ToolEntry[] | undefined {
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i]!;
    if (t.id === id) {
      const out = tools.slice();
      out[i] = fn(t);
      return out;
    }
    if (t.children !== undefined) {
      const children = updateInTools(t.children, id, fn);
      if (children !== undefined) {
        const out = tools.slice();
        out[i] = { ...t, children };
        return out;
      }
    }
  }
  return undefined;
}

/**
 * 整条时间线里按 id 改一个工具条目（顶层或任意深度的子条目）。
 * 没找到返回 undefined。
 */
export function updateTool(
  entries: TimelineEntry[],
  id: string,
  fn: (t: ToolEntry) => ToolEntry,
): TimelineEntry[] | undefined {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.kind !== 'tool') continue;
    if (e.id === id) {
      const out = entries.slice();
      out[i] = fn(e);
      return out;
    }
    if (e.children !== undefined) {
      const children = updateInTools(e.children, id, fn);
      if (children !== undefined) {
        const out = entries.slice();
        out[i] = { ...e, children };
        return out;
      }
    }
  }
  return undefined;
}

/** 子条目数（封顶前的总数） */
export function childTotal(entry: ToolEntry): number {
  return Math.max(entry.childCount ?? 0, entry.children?.length ?? 0);
}

/**
 * 往父条目下并入子条目（按 id 去重：已有的原地合并，新的加入），维护 childCount
 * 与封顶。`added` 里与已有条目同 id 的，以已有的为主、补上缺的结果字段。
 *
 * 并入后按 ts **稳定排序**：实时只收到一截（中途连上 / 补发窗口外）再并回看时，
 * 回看补进来的更早条目要排到前面，而不是追加在实时条目后面（评审 M3）。实时帧 ts
 * 与子转录 timestamp 都是代理机时钟，同一时基。
 *
 * `fromHistory`：回看是那次子 agent 的完整记录，总数取「已知总数」与并集大小的较大者；
 * 实时追加则按新 id 数累加（children 封顶后 childCount 仍准）。
 */
export function appendChildren(parent: ToolEntry, added: readonly ToolEntry[], options: { fromHistory?: boolean } = {}): ToolEntry {
  if (added.length === 0) return parent;
  let children = parent.children ?? [];
  let fresh = 0;
  for (const child of added) {
    const idx = children.findIndex((c) => c.id === child.id);
    if (idx >= 0) {
      let merged = mergeToolEntry(children[idx]!, child);
      // 回看与实时同一次调用：排序用转录时间——回看内部时间自洽，实时帧 ts 是发帧时刻，
      // 两者混用会让补进来的条目与实时条目错位（评审 M3）
      if (options.fromHistory === true && merged.ts !== child.ts) merged = { ...merged, ts: child.ts };
      if (merged !== children[idx]) {
        children = children.slice();
        children[idx] = merged;
      }
      continue;
    }
    children = [...children, child];
    fresh += 1;
  }
  const count = options.fromHistory === true ? Math.max(childTotal(parent), children.length) : childTotal(parent) + fresh;
  return { ...parent, children: capChildren(sortByTs(children)), ...(count > 0 ? { childCount: count } : {}) };
}

/** 按 ts 稳定排序；已有序时原样返回 */
function sortByTs(children: ToolEntry[]): ToolEntry[] {
  for (let i = 1; i < children.length; i++) {
    if (children[i]!.ts < children[i - 1]!.ts) {
      return children.map((c, idx) => ({ c, idx })).sort((a, b) => a.c.ts - b.c.ts || a.idx - b.idx).map((x) => x.c);
    }
  }
  return children;
}

/** 超过 MAX_TOOL_CHILDREN：先丢最旧的已完成项，全在跑就丢最旧的 */
function capChildren(children: ToolEntry[]): ToolEntry[] {
  if (children.length <= MAX_TOOL_CHILDREN) return children;
  let out = children;
  while (out.length > MAX_TOOL_CHILDREN) {
    const doneIdx = out.findIndex((c) => c.status !== undefined);
    const drop = doneIdx >= 0 ? doneIdx : 0;
    out = [...out.slice(0, drop), ...out.slice(drop + 1)];
  }
  return out;
}

/**
 * 同一个工具调用的两份记录合并（实时帧 × 回看）：`base` 的字段优先，缺的从 `extra`
 * 补；children 递归合并。没有可补的原样返回 base（引用相等）。
 */
function mergeToolEntry(base: ToolEntry, extra: ToolEntry): ToolEntry {
  let out = base;
  const fill = <K extends 'status' | 'durationMs' | 'resultSummary' | 'outputPreview' | 'filePath'>(key: K): void => {
    if (out[key] === undefined && extra[key] !== undefined) out = { ...out, [key]: extra[key] };
  };
  fill('status');
  fill('durationMs');
  fill('resultSummary');
  fill('outputPreview');
  fill('filePath');
  if ((out.toolName === '?' || out.toolName === '') && extra.toolName !== '?' && extra.toolName !== '') {
    out = { ...out, toolName: extra.toolName, argSummary: extra.argSummary };
  }
  if (extra.children !== undefined && extra.children.length > 0) out = appendChildren(out, extra.children);
  if (extra.childrenLoaded === true && out.childrenLoaded !== true) out = { ...out, childrenLoaded: true };
  return out;
}

/** 把一个子条目放进暂存区（同 id 合并），并维持组数封顶 */
export function stashChild(pending: PendingChildren | undefined, parentId: string, child: ToolEntry): PendingChildren {
  const group = pending?.[parentId] ?? [];
  const idx = group.findIndex((c) => c.id === child.id);
  let nextGroup: ToolEntry[];
  if (idx >= 0) {
    nextGroup = group.slice();
    nextGroup[idx] = mergeToolEntry(child, group[idx]!);
  } else {
    nextGroup = capChildren([...group, child]);
  }
  const { [parentId]: _old, ...rest } = pending ?? {};
  const next: PendingChildren = { ...rest, [parentId]: nextGroup };
  const keys = Object.keys(next);
  for (let i = 0; i < keys.length - MAX_PENDING_PARENTS; i++) delete next[keys[i]!];
  return next;
}

/** 暂存区里等某个 id 的子条目；没有返回 undefined */
export function pendingFor(pending: PendingChildren | undefined, parentId: string): ToolEntry[] | undefined {
  const group = pending?.[parentId];
  return group === undefined || group.length === 0 ? undefined : group;
}

/** 从暂存区删掉一组；删空了返回 undefined（Timeline 上就不留这个字段） */
export function dropPending(pending: PendingChildren | undefined, parentId: string): PendingChildren | undefined {
  if (pending === undefined || !(parentId in pending)) return pending;
  const { [parentId]: _drop, ...rest } = pending;
  return Object.keys(rest).length === 0 ? undefined : rest;
}

/**
 * 暂存区里有哪些组的父条目已经在时间线上了，就并过去（历史合并 / 子转录回看之后调）。
 * 被并入的子条目本身也可能是别组的父（嵌套），所以循环到没有进展为止。
 */
export function adoptPending(
  entries: TimelineEntry[],
  pending: PendingChildren | undefined,
): { entries: TimelineEntry[]; pending: PendingChildren | undefined } {
  let outEntries = entries;
  let outPending = pending;
  for (let progress = true; progress && outPending !== undefined; ) {
    progress = false;
    for (const parentId of Object.keys(outPending)) {
      const group = outPending[parentId]!;
      const updated = updateTool(outEntries, parentId, (p) => appendChildren(p, group));
      if (updated === undefined) continue;
      outEntries = updated;
      outPending = dropPending(outPending, parentId);
      progress = true;
      if (outPending === undefined) break;
    }
  }
  return { entries: outEntries, pending: outPending };
}

/** 子 agent 回看的一条工具项 → 子工具条目（seq 0，同历史条目） */
export function historyToolEntry(item: Extract<HistoryItem, { kind: 'tool' }>): ToolEntry {
  return {
    kind: 'tool',
    id: item.id,
    toolName: item.toolName,
    argSummary: item.argSummary,
    ...(item.filePath === undefined ? {} : { filePath: item.filePath }),
    ...(item.status === undefined ? {} : { status: item.status }),
    ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
    ...(item.resultSummary === undefined ? {} : { resultSummary: item.resultSummary }),
    ...(item.outputPreview === undefined ? {} : { outputPreview: item.outputPreview }),
    seq: 0,
    ts: item.ts,
  };
}

/** Agent / Task：会有子工具的那两个工具名 */
export function isSubagentTool(toolName: string): boolean {
  return toolName === 'Agent' || toolName === 'Task';
}

/**
 * 折叠态要显示的「当前子工具」：最新一个还在跑的；都跑完了取最后一个。
 * 只看直接子条目（孙条目由它自己的卡片表达）。
 */
export function currentChild(entry: ToolEntry): ToolEntry | undefined {
  const children = entry.children;
  if (children === undefined || children.length === 0) return undefined;
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i]!.status === undefined) return children[i];
  }
  return children[children.length - 1];
}

/**
 * 会话列表的过滤管线（session-list-v2 方案 §4.2 / §4.3，评审 S4 / M5）。
 *
 * 顺序固定：**机器 → 归档视图 → 临时会话 → 状态 → 搜索 → 分组 → compareSessions**。
 * 顺序本身是语义：空态要按「在哪一步被筛空」给出不同的下一步提示
 * （搜索无结果 / 筛选无结果 / 全部已归档），所以每一步之后都要能数得出剩多少。
 *
 * 列表页、PC 侧栏、归档视图、机器详情四个调用点共用这一个函数；零 React、
 * 零浏览器全局，全部单测覆盖（filtering.test.ts）。
 */
import type { SessionMeta, SessionState } from '@trine/core';
import { comparePinned, compareSessions, STATE_RANK, type SessionRowData } from './sorting.ts';

/**
 * 状态 chip。「进行中」与 `countActiveSessions` / 机器 chip 的 activeCount
 * 同一口径（运行中 ∪ 待批准，评审 S4），否则 chip 上的数字与点进来的结果对不上。
 */
export const STATUS_FILTERS = ['all', 'active', 'waiting', 'idle', 'ended'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: '全部',
  active: '进行中',
  waiting: '待批准',
  idle: '空闲',
  ended: '出错/已停止',
};

export function matchesStatus(state: SessionState, filter: StatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'active':
      return state === 'running' || state === 'waiting_permission';
    case 'waiting':
      return state === 'waiting_permission';
    case 'idle':
      return state === 'idle';
    case 'ended':
      return state === 'error' || state === 'stopped';
  }
}

export type ListGroupBy = 'none' | 'workspace';

export interface ListQuery {
  /** null = 全部机器 */
  machine: string | null;
  /** 看未归档的（默认视图）还是归档视图 */
  archived: boolean;
  /** 是否显示临时会话（isTempSession）；默认不显示 */
  showTemp: boolean;
  status: StatusFilter;
  /** 原始输入；内部 trim + 不分大小写 */
  search: string;
  groupBy: ListGroupBy;
}

export const DEFAULT_LIST_QUERY: ListQuery = {
  machine: null,
  archived: false,
  showTemp: false,
  status: 'all',
  search: '',
  groupBy: 'workspace',
};

/** 工作空间分组 */
export interface SessionGroup {
  /** `machineId` + NUL + 去尾 `/` 的 cwd——折叠状态按它存 */
  key: string;
  machineId: string;
  /** 规范化后的 cwd；'' = 未知目录 */
  cwd: string;
  rows: SessionRowData[];
  /** 组内最高优先级（min STATE_RANK） */
  rank: number;
  /** 组内最近活动（max lastActivityAt） */
  lastActivityAt: number;
  /** 工作区创建时间（见 workspaceCreatedAt）；组序依据之一 */
  createdAt: number;
  /** 工作区置顶时间；省略 = 未置顶 */
  pinnedAt?: number;
  waitingCount: number;
  runningCount: number;
}

/**
 * 为什么列表是空的——决定空态文案。
 * - `no-sessions`：一个会话都没有（全部机器）
 * - `machine-empty`：选中的机器上没有会话
 * - `all-archived`：有会话，但全都归档了
 * - `archived-empty`：归档视图里没有东西
 * - `all-temp`：剩下的全是被隐藏的临时会话
 * - `status`：被状态 chip 筛空
 * - `search`：被搜索词筛空
 */
export type EmptyReason =
  | 'no-sessions'
  | 'machine-empty'
  | 'all-archived'
  | 'archived-empty'
  | 'all-temp'
  | 'status'
  | 'search';

export interface FilterResult {
  /** 排好序的扁平行（groupBy 为 none 时直接渲染它） */
  rows: SessionRowData[];
  /** groupBy 为 workspace 时的分组；否则 null */
  groups: SessionGroup[] | null;
  /** 机器范围内的已归档会话数（「已归档 (n)」入口的 n），不受状态/搜索影响 */
  archivedCount: number;
  /** 当前视图里因「不显示临时会话」被藏起来的数量（showTemp 时为 0），不受状态/搜索影响 */
  tempHidden: number;
  /** 当前视图里因「显示临时会话」而放出来的数量（不 showTemp 时为 0），不受状态/搜索影响 */
  tempShown: number;
  /** 非空时为 null */
  empty: EmptyReason | null;
}

/** cwd 规范化：去尾 `/`，但根目录 `/` 保持为 `/` */
export function normalizeCwd(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  return trimmed === '' && cwd !== '' ? '/' : trimmed;
}

export function groupKey(machineId: string, cwd: string): string {
  return `${machineId}\u0000${normalizeCwd(cwd)}`;
}

/** 组头显示的目录：'' → 「未知目录」（评审 M5：manager 可能给出空串） */
export function groupLabel(cwd: string): string {
  return cwd === '' ? '未知目录' : cwd;
}

/**
 * 搜索：title / firstPrompt / lastEvent / cwd / gitBranch，「全部机器」视图下
 * 再加机器名；不分大小写的 contains。标题为空时卡片显示的是 sessionId 短码，
 * 所以短码也算进 title——用户照着卡片上看到的字搜，应当搜得到。
 */
export function matchesSearch(
  row: SessionRowData,
  needle: string,
  machineName: string | undefined,
): boolean {
  if (needle === '') return true;
  const { meta } = row;
  const fields: (string | undefined)[] = [
    meta.title.trim() === '' ? meta.sessionId.slice(0, 8) : meta.title,
    meta.firstPrompt,
    meta.lastEvent,
    meta.cwd,
    meta.gitBranch,
    machineName,
  ];
  return fields.some((f) => f !== undefined && f.toLowerCase().includes(needle));
}

/** 机器 → 置顶的工作区（cwd → 置顶时间）；来源 `cwd.updated.pinned` */
export type PinnedCwds = Record<string, Record<string, number> | undefined>;

/**
 * 每个工作区（组 key）的创建时间：该机器该 cwd 下**全部**会话（含已归档、临时）里
 * 最早的 createdAt（缺省退回 lastActivityAt）。工作区不是实体，只能这样推；
 * 取全量而不是当前筛选后的行，组的位置才不随搜索 / 状态 chip / 归档变化。
 */
export function workspaceCreatedAt(sessions: Record<string, Record<string, SessionMeta>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [machineId, map] of Object.entries(sessions)) {
    for (const meta of Object.values(map)) {
      const key = groupKey(machineId, meta.cwd);
      const at = meta.createdAt ?? meta.lastActivityAt;
      const prev = out.get(key);
      if (prev === undefined || at < prev) out.set(key, at);
    }
  }
  return out;
}

/** 某机器的置顶工作区按规范化 cwd 查（agent 按字面存，旧数据可能带尾 `/`） */
function pinnedLookup(pinned: PinnedCwds, machineId: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [cwd, at] of Object.entries(pinned[machineId] ?? {})) out.set(normalizeCwd(cwd), at);
  return out;
}

/**
 * 按工作空间分组。组序：置顶（越晚置顶越靠上）→ 工作区创建时间倒序（新的在上）→ key。
 * 刻意不看组内状态与最后活动——组不该因为某个会话开始跑或在等批准就跳位置
 * （sidebar-pin）；待批准靠组头角标和强制展开提示。组内 compareSessions。
 *
 * `createdAt` 给了就按它（全量会话推出来的，见 workspaceCreatedAt），没给的组用组内行算。
 */
export function groupRows(
  rows: SessionRowData[],
  ctx: { pinned?: PinnedCwds; createdAt?: ReadonlyMap<string, number> } = {},
): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  const pins = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const cwd = normalizeCwd(row.meta.cwd);
    const key = groupKey(row.machineId, cwd);
    let g = map.get(key);
    if (g === undefined) {
      let machinePins = pins.get(row.machineId);
      if (machinePins === undefined) {
        machinePins = pinnedLookup(ctx.pinned ?? {}, row.machineId);
        pins.set(row.machineId, machinePins);
      }
      const pinnedAt = machinePins.get(cwd);
      g = {
        key,
        machineId: row.machineId,
        cwd,
        rows: [],
        rank: Number.POSITIVE_INFINITY,
        lastActivityAt: 0,
        createdAt: ctx.createdAt?.get(key) ?? Number.POSITIVE_INFINITY,
        ...(pinnedAt === undefined ? {} : { pinnedAt }),
        waitingCount: 0,
        runningCount: 0,
      };
      map.set(key, g);
    }
    g.rows.push(row);
    g.rank = Math.min(g.rank, STATE_RANK[row.meta.state]);
    g.lastActivityAt = Math.max(g.lastActivityAt, row.meta.lastActivityAt);
    if (ctx.createdAt?.get(key) === undefined) {
      g.createdAt = Math.min(g.createdAt, row.meta.createdAt ?? row.meta.lastActivityAt);
    }
    if (row.meta.state === 'waiting_permission') g.waitingCount += 1;
    if (row.meta.state === 'running') g.runningCount += 1;
  }
  const groups = [...map.values()];
  for (const g of groups) g.rows.sort(compareSessions);
  return groups.sort(
    (a, b) =>
      comparePinned(a.pinnedAt, b.pinnedAt) ||
      b.createdAt - a.createdAt ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/**
 * 组是否展开：有待批准的组**强制展开**（评审 M5：折叠不能把等待批准埋掉，
 * 列表是推送之外发现待批准的主要入口）。
 */
/**
 * 组是否展开。有待批准强制展开（评审 M5）；搜索 / 状态筛选生效时也一律展开
 * （评审 minor 3：命中的行藏在折叠组里，用户只看到组头计数会以为没搜到）。
 * 只影响渲染，不改持久化的折叠集合——清掉筛选后恢复原来的折叠。
 */
export function isGroupExpanded(
  group: SessionGroup,
  collapsed: ReadonlySet<string>,
  query?: Pick<ListQuery, 'search' | 'status'>,
): boolean {
  if (query !== undefined && isFiltering(query)) return true;
  return group.waitingCount > 0 || !collapsed.has(group.key);
}

/** 搜索词非空或状态 chip 不是「全部」 */
export function isFiltering(query: Pick<ListQuery, 'search' | 'status'>): boolean {
  return query.search.trim() !== '' || query.status !== 'all';
}

/**
 * cwd 是否在系统临时目录下：Linux `/tmp`、`/var/tmp`，macOS 的 `/private/tmp` 与
 * `$TMPDIR`（`/var/folders/…`、`/private/var/folders/…`）。按路径段比，`/tmpfoo` 不算。
 */
export function isTempCwd(cwd: string): boolean {
  return /^(?:\/private)?(?:\/var)?\/tmp(?:\/|$)|^(?:\/private)?\/var\/folders\//.test(cwd);
}

/**
 * 临时会话：工作目录在临时目录下，或是脚本跑出来的非交互会话（agent 报的
 * `headless`，即 `claude -p` / Python SDK）。列表默认不显示。
 */
export function isTempSession(meta: Pick<SessionMeta, 'cwd' | 'headless'>): boolean {
  return meta.headless === true || isTempCwd(meta.cwd);
}

export function isArchived(meta: SessionMeta): boolean {
  return meta.archived === true;
}

/** 机器范围内的已归档数（「已归档 (n)」入口；不跑整条管线） */
export function countArchived(
  sessions: Record<string, Record<string, SessionMeta>>,
  machine: string | null,
): number {
  let n = 0;
  for (const [machineId, map] of Object.entries(sessions)) {
    if (machine !== null && machineId !== machine) continue;
    for (const meta of Object.values(map)) if (isArchived(meta)) n += 1;
  }
  return n;
}

/** 整条管线 */
export function filterSessions(
  sessions: Record<string, Record<string, SessionMeta>>,
  query: ListQuery,
  machineNames: Record<string, string> = {},
  pinnedCwds: PinnedCwds = {},
): FilterResult {
  // 1. 机器
  const scoped: SessionRowData[] = [];
  for (const [machineId, map] of Object.entries(sessions)) {
    if (query.machine !== null && machineId !== query.machine) continue;
    for (const meta of Object.values(map)) scoped.push({ machineId, meta });
  }

  // 2. 归档视图
  let archivedCount = 0;
  const viewRows: SessionRowData[] = [];
  for (const row of scoped) {
    const archived = isArchived(row.meta);
    if (archived) archivedCount += 1;
    if (archived === query.archived) viewRows.push(row);
  }

  // 3. 临时会话
  let tempCount = 0;
  const kept = viewRows.filter((r) => {
    const temp = isTempSession(r.meta);
    if (temp) tempCount += 1;
    return query.showTemp || !temp;
  });
  const tempHidden = query.showTemp ? 0 : tempCount;
  const tempShown = query.showTemp ? tempCount : 0;

  // 4. 状态
  const statusRows = kept.filter((r) => matchesStatus(r.meta.state, query.status));

  // 5. 搜索（机器名只在「全部机器」视图下参与——选定机器时每行机器名都一样）
  const needle = query.search.trim().toLowerCase();
  const searched = statusRows.filter((r) =>
    matchesSearch(r, needle, query.machine === null ? machineNames[r.machineId] : undefined),
  );

  // 6 + 7. 分组 / 排序
  const rows = searched.sort(compareSessions);
  const groups =
    query.groupBy === 'workspace'
      ? groupRows(rows, { pinned: pinnedCwds, createdAt: workspaceCreatedAt(sessions) })
      : null;

  let empty: EmptyReason | null = null;
  if (rows.length === 0) {
    if (scoped.length === 0) empty = query.machine === null ? 'no-sessions' : 'machine-empty';
    else if (viewRows.length === 0) empty = query.archived ? 'archived-empty' : 'all-archived';
    else if (kept.length === 0) empty = 'all-temp';
    else if (statusRows.length === 0) empty = 'status';
    else empty = 'search';
  }

  return { rows, groups, archivedCount, tempHidden, tempShown, empty };
}

/**
 * 空态文案（评审 m8 + S4）。`compact` 决定「新建」入口指向哪里：
 * 手机是右下角「+」，PC 侧栏是底部「新建」。
 */
export function emptyText(
  reason: EmptyReason,
  opts: { compact: boolean; archivedCount: number; tempHidden?: number; search: string },
): string {
  switch (reason) {
    case 'no-sessions':
      return opts.compact
        ? '还没有会话，点下方「新建」开一个。'
        : '还没有会话，点右下角「+」新建一个。';
    case 'machine-empty':
      return '这台机器上还没有会话。';
    case 'all-archived':
      return `会话都已归档（有 ${opts.archivedCount} 个已归档会话）。`;
    case 'archived-empty':
      return '没有已归档的会话。';
    case 'all-temp':
      return `只有临时会话（${opts.tempHidden ?? 0} 个，已隐藏）。`;
    case 'status':
      return '没有符合筛选条件的会话。';
    case 'search':
      return `没有匹配「${opts.search.trim()}」的会话。`;
  }
}

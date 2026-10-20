/**
 * 会话列表的纯逻辑：排序、过滤、lastEvent 摘要前缀。
 *
 * 抽出来的理由是它被三处共用（列表页、侧栏紧凑变体、将来的搜索），而且
 * 是「排序即优先级」这条产品判断的落点（方案 §5「会话列表」、原型
 * `NOTES.list`「排序即优先级：等待批准置顶 > 运行中 > 其余按最后活动时间」；
 * 用户置顶的会话再排在这些之前，见 sidebar-pin），值得单测钉住。零 React、零浏览器全局。
 */
import type { SessionMeta, SessionState } from '@trine/core';

/** 列表里的一行：会话 meta + 它属于哪台机器 */
export interface SessionRowData {
  machineId: string;
  meta: SessionMeta;
}

/**
 * 状态优先级。error / stopped / idle 同档——对用户的下一步动作是同一件事
 * （都可以继续发消息），再细分只会让列表在「刚跑完」与「闲着」之间跳动。
 */
export const STATE_RANK: Record<SessionState, number> = {
  waiting_permission: 0,
  running: 1,
  idle: 2,
  error: 2,
  stopped: 2,
};

/**
 * 置顶优先：置顶的排在未置顶的前面，越晚置顶越靠上（sidebar-pin）。会话与工作区共用。
 */
export function comparePinned(a: number | undefined, b: number | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return b - a;
}

/**
 * 列表比较器：置顶（越晚置顶越靠上）> 等待批准 > 运行中 > 其余按 lastActivityAt 倒序。
 *
 * 同档内也按 lastActivityAt 倒序（两条都在等批准时，先等的那条更急——
 * 但 lastActivityAt 是「最后活动」不是「开始等待」，倒序意味着刚请求的在上；
 * 这与聊天页「未读优先」的直觉一致，也避免列表因为计时而重排）。
 * 置顶会话之间只按置顶时间排，不随状态跳。
 * sessionId 兜底保证全序，避免 React key 顺序在等值时抖动。
 */
export function compareSessions(a: SessionRowData, b: SessionRowData): number {
  return (
    comparePinned(a.meta.pinnedAt, b.meta.pinnedAt) ||
    STATE_RANK[a.meta.state] - STATE_RANK[b.meta.state] ||
    b.meta.lastActivityAt - a.meta.lastActivityAt ||
    (a.meta.sessionId < b.meta.sessionId ? -1 : a.meta.sessionId > b.meta.sessionId ? 1 : 0)
  );
}

/**
 * 把 store 的 `sessions`（machineId → sessionId → meta）摊平、过滤、排序。
 * `filter === null` 表示「全部」。
 */
export function selectSessionRows(
  sessions: Record<string, Record<string, SessionMeta>>,
  filter: string | null,
): SessionRowData[] {
  const rows: SessionRowData[] = [];
  for (const [machineId, map] of Object.entries(sessions)) {
    if (filter !== null && machineId !== filter) continue;
    for (const meta of Object.values(map)) rows.push({ machineId, meta });
  }
  return rows.sort(compareSessions);
}

/**
 * lastEvent 的行首标记（原型 `.sess .r2` 的「✋ Bash: …」「🔧 正在编辑 …」）。
 *
 * 状态决定标记而不是事件内容决定：lastEvent 是 agent 给的自由文本，
 * 在 client 侧按文本猜类型会在措辞变化时失灵。
 */
export function lastEventPrefix(state: SessionState): string {
  switch (state) {
    case 'waiting_permission':
      return '✋';
    case 'running':
      return '🔧';
    case 'error':
      return '🛑';
    default:
      return '';
  }
}

/** 会话卡标题：agent 给的 title，空则退回 sessionId 短码 */
export function sessionTitle(meta: SessionMeta): string {
  return meta.title.trim() === '' ? meta.sessionId.slice(0, 8) : meta.title;
}

/**
 * cwd 尾段（原型 r3 的「mbp-m3 · ~/workspace/repo/trine」在窄屏放不下全路径）。
 * 保留最后两段，前面用 `…/` 省略；本来就短的原样返回。
 */
export function shortCwd(cwd: string, maxSegments = 2): string {
  const trimmed = cwd.replace(/\/+$/, '');
  if (trimmed === '') return cwd;
  const segments = trimmed.split('/');
  if (segments.length <= maxSegments) return trimmed;
  return `…/${segments.slice(-maxSegments).join('/')}`;
}

/** 历史会话 model 为空串时显示「默认」（方案 §5） */
export function displayModel(model: string): string {
  return model.trim() === '' ? '默认' : model;
}

/**
 * 紧凑处显示的模型短名：`claude-opus-5-5` → `opus 5.5`、`claude-fable-5-1` → `fable 5.1`、
 * `claude-haiku-4-5-20251001` → `haiku 4.5`（日期后缀忽略）；家族后无版本只留家族名；
 * 认不出来的原样显示。带版本是为了让 opus 5 与 opus 5.5 在 chip 上分得开。
 */
export function shortModel(model: string): string {
  if (model.trim() === '') return '默认';
  const m = /claude-(fable|opus|sonnet|haiku)(?:-(\d+)(?:-(\d))?)?/.exec(model);
  if (!m) return model;
  const [, family, major, minor] = m;
  if (major === undefined) return family ?? model;
  return minor === undefined ? `${family} ${major}` : `${family} ${major}.${minor}`;
}

/**
 * 别名会话（`opus` / `opus[1m]` 等）实际跑的具体模型；不是别名、或对不上则 undefined。
 *
 * `reported` 取自 session.capabilities.models（SDK init 时的模型），会话中途
 * `/model` 切换后它不会刷新——所以要求家族与 `[…]` 后缀都对得上才认，切到别的
 * 家族后宁可不显示，也不显示一个过时的值。
 */
export function resolvedAliasModel(model: string, reported: readonly string[] | undefined): string | undefined {
  const alias = /^(fable|opus|sonnet|haiku)(\[[^\]]*\])?$/.exec(model.trim());
  if (!alias) return undefined;
  const [, family, suffix = ''] = alias;
  return reported?.find((r) => r.startsWith(`claude-${family}-`) && (/\[[^\]]*\]$/.exec(r)?.[0] ?? '') === suffix);
}

/** 机器过滤 chip 的一项数据 */
export interface MachineFilterItem {
  machineId: string;
  name: string;
  online: boolean | null;
  /** 运行中 + 等待批准的会话数（原型 chip 上的「· 2」） */
  activeCount: number;
  /** 离线排队数（原型 chip 角标） */
  parkedCount: number;
}

/**
 * 机器过滤 chip 的数据。在线机器排前面，同档按名字——列表顶部的 chip 行
 * 会随在线状态变化重排，但那正是用户想要的（能用的机器在手边）。
 */
export function selectMachineFilterItems(
  machines: Record<string, { machineId: string; name: string; online: boolean | null; parkedCount: number }>,
  sessions: Record<string, Record<string, SessionMeta>>,
): MachineFilterItem[] {
  return Object.values(machines)
    .map((m) => ({
      machineId: m.machineId,
      name: m.name,
      online: m.online,
      activeCount: countActiveSessions(sessions[m.machineId]),
      parkedCount: m.parkedCount,
    }))
    .sort(
      (a, b) =>
        Number(b.online === true) - Number(a.online === true) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
}

/** 「活跃」= 运行中或等待批准（机器卡与过滤 chip 同一口径） */
export function countActiveSessions(map: Record<string, SessionMeta> | undefined): number {
  if (map === undefined) return 0;
  let n = 0;
  for (const meta of Object.values(map)) {
    if (meta.state === 'running' || meta.state === 'waiting_permission') n += 1;
  }
  return n;
}

/**
 * 有子进程（占活跃名额）的会话数——`meta.live`，agent ≥ 0.10.0 才带。与「活跃」
 * （运行中 / 等批准）不同口径：空闲但子进程还没回收的也算。归档的也算（有后台
 * 任务时归档不回收子进程）。
 */
export function countLiveSessions(map: Record<string, SessionMeta> | undefined): number {
  if (map === undefined) return 0;
  let n = 0;
  for (const meta of Object.values(map)) if (meta.live === true) n += 1;
  return n;
}

/**
 * 「子进程 3/10」：上限来自 machine.info.maxSessions（agent ≥ 0.10.0）。旧 agent
 * 不发上限也不发 live，返回空串（调用方不显示）。
 */
export function liveSessionsLine(live: number, maxSessions: number | undefined): string {
  if (maxSessions === undefined) return live > 0 ? `子进程 ${live}` : '';
  return `子进程 ${live}/${maxSessions}`;
}

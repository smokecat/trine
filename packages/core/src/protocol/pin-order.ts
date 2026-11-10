/**
 * 置顶工作区的手动顺序（pin-order）：agent 存、client 乐观更新共用的纯函数。
 *
 * - `normalizePinOrder`：只留字符串、去重、剔除没置顶的；pinned 里有而顺序里没有的按置顶时间倒序
 *   补到末尾。结果与 pinned 的键一一对应。没有 pinOrder（旧 agent）时就是纯时间序。
 * - `movePinOrder`：`cwd.pin.move` 的语义——把 path 移到 before 之前（null = 末尾）。
 */

/**
 * 工作区的目录身份：去尾 `/`（根目录保持 `/`）。与 client 分组同一口径；置顶、取消、移动、
 * 乐观更新都按它认「同一个目录」，`/a/` 与 `/a` 是一个工作区。
 */
export function normalizeCwdPath(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  return trimmed === '' && cwd !== '' ? '/' : trimmed;
}

/**
 * pinned 按目录身份合并：键换成规范化路径，同一目录的多种拼写（旧数据可能带尾 `/`）只留一条，
 * 保留较早的置顶时间。空路径丢掉。fromEntries 建自有属性，`__proto__` 不会改到原型。
 */
export function mergePinnedCwds(pinned: Record<string, number>): Record<string, number> {
  const merged = new Map<string, number>();
  for (const [raw, at] of Object.entries(pinned)) {
    const key = normalizeCwdPath(raw);
    if (key === '') continue;
    const prev = merged.get(key);
    if (prev === undefined || at < prev) merged.set(key, at);
  }
  return Object.fromEntries(merged);
}

/** 时间序：越晚置顶越靠前，同时间按路径 */
function byPinnedAtDesc(pinned: Record<string, number>): (a: string, b: string) => number {
  return (a, b) => pinned[b]! - pinned[a]! || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * 有效顺序（规范化路径）：先按目录身份合并 pinned（mergePinnedCwds），pinOrder 里的项也规范化后
 * 去重、剔除没置顶的，缺的按置顶时间倒序补到末尾。结果与 mergePinnedCwds(pinned) 的键一一对应。
 */
export function normalizePinOrder(raw: unknown, pinned: Record<string, number>): string[] {
  const merged = mergePinnedCwds(pinned);
  const seen = new Set<string>();
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const p = normalizeCwdPath(item);
      if (seen.has(p) || !Object.hasOwn(merged, p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  const missing = Object.keys(merged).filter((k) => !seen.has(k));
  missing.sort(byPinnedAtDesc(merged));
  return [...out, ...missing];
}

/** movePinOrder 拒绝的原因（与 `cwd.pin.move.response` 的错误码同名） */
export type PinMoveRejection = 'not_pinned' | 'before_not_pinned' | 'invalid';

/**
 * 把 `path` 移到 `before` 之前（null = 末尾）。order 是规范化路径（normalizePinOrder 的结果），
 * path / before 在这里同样规范化后比较——同一目录的不同拼写算「移到自己前面」。
 * 返回新数组；不合法时返回拒绝原因——不隐式置顶。顺序没变也返回新数组（内容相同），调用方按需比较。
 */
export function movePinOrder(order: readonly string[], rawPath: string, rawBefore: string | null): string[] | PinMoveRejection {
  const path = normalizeCwdPath(rawPath);
  const before = rawBefore === null ? null : normalizeCwdPath(rawBefore);
  if (!order.includes(path)) return 'not_pinned';
  if (before !== null && !order.includes(before)) return 'before_not_pinned';
  if (before === path) return 'invalid';
  const next = order.filter((p) => p !== path);
  next.splice(before === null ? next.length : next.indexOf(before), 0, path);
  return next;
}

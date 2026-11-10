/**
 * 置顶工作区的手动顺序（pin-order）：agent 存、client 乐观更新共用的纯函数。
 *
 * - `normalizePinOrder`：只留字符串、去重、剔除没置顶的；pinned 里有而顺序里没有的按置顶时间倒序
 *   补到末尾。结果与 pinned 的键一一对应。没有 pinOrder（旧 agent）时就是纯时间序。
 * - `movePinOrder`：`cwd.pin.move` 的语义——把 path 移到 before 之前（null = 末尾）。
 */

/** 时间序：越晚置顶越靠前，同时间按路径 */
function byPinnedAtDesc(pinned: Record<string, number>): (a: string, b: string) => number {
  return (a, b) => pinned[b]! - pinned[a]! || (a < b ? -1 : a > b ? 1 : 0);
}

export function normalizePinOrder(raw: unknown, pinned: Record<string, number>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const p of raw) {
      if (typeof p !== 'string' || seen.has(p) || !Object.hasOwn(pinned, p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  const missing = Object.keys(pinned).filter((k) => !seen.has(k));
  missing.sort(byPinnedAtDesc(pinned));
  return [...out, ...missing];
}

/** movePinOrder 拒绝的原因（与 `cwd.pin.move.response` 的错误码同名） */
export type PinMoveRejection = 'not_pinned' | 'before_not_pinned' | 'invalid';

/**
 * 把 `path` 移到 `before` 之前（null = 末尾）。返回新数组；不合法时返回拒绝原因——不隐式置顶。
 * 顺序没变也返回新数组（内容相同），调用方按需比较。
 */
export function movePinOrder(order: readonly string[], path: string, before: string | null): string[] | PinMoveRejection {
  if (!order.includes(path)) return 'not_pinned';
  if (before !== null && !order.includes(before)) return 'before_not_pinned';
  if (before === path) return 'invalid';
  const next = order.filter((p) => p !== path);
  next.splice(before === null ? next.length : next.indexOf(before), 0, path);
  return next;
}

/**
 * 时间线的时间标记：像聊天工具一样，只在「有信息量」的地方插一条居中的时间，
 * 而不是给每条记录都挂时间——连续的工具调用间隔是秒级，不会被时间撑开。
 *
 * - 第一条有效记录前、跨天时：日期 + 时刻（`day`）
 * - 同一天里与上一条间隔 ≥ 10 分钟：只给时刻（`gap`）
 *
 * `ts <= 0` 是历史里缺 timestamp 的行（见 agent bridge/history），不参与计算。
 * 多个时钟来源（agent / 浏览器 / transcript）可能让 ts 回退，所以基准取已见最大值，
 * 回退的那条不产生标记。
 */
import { isSameDay } from './format.ts';

export const GAP_MARKER_MS = 10 * 60_000;

export type TimeMarker = { kind: 'day' | 'gap'; at: number };

export function timeMarkers(entries: readonly { ts: number }[]): (TimeMarker | undefined)[] {
  let last: number | undefined;
  return entries.map(({ ts }) => {
    if (!(ts > 0)) return undefined;
    const prev = last;
    if (prev === undefined || ts > prev) last = ts;
    if (prev === undefined) return { kind: 'day', at: ts };
    if (ts <= prev) return undefined;
    if (!isSameDay(ts, prev)) return { kind: 'day', at: ts };
    return ts - prev >= GAP_MARKER_MS ? { kind: 'gap', at: ts } : undefined;
  });
}

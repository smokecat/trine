/**
 * 时间线条目里三种 kind 的类型别名。
 *
 * `lib/reducer.ts` 直接导出了 UserEntry / AssistantEntry / ToolEntry /
 * PermissionEntry，但 run_state / run_done / error 三种只导出了 schema。
 * 这里从**已导出的** `TimelineEntry` 判别联合里摘出来——协议层一个字不用改，
 * 判别键仍是同一份真相（reducer 改了这里跟着编译报错，不会悄悄漂移）。
 */
import type { TimelineEntry } from '@/lib/reducer.ts';

export type RunStateEntry = Extract<TimelineEntry, { kind: 'run_state' }>;
export type RunDoneEntry = Extract<TimelineEntry, { kind: 'run_done' }>;
export type ErrorEntry = Extract<TimelineEntry, { kind: 'error' }>;

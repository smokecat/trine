/**
 * 用量展示的纯逻辑（usage-display）：context 用量、订阅限额（5 小时 / 7 天）的文案与色调。
 * 零 React 依赖，`bun test` 覆盖。
 *
 * 口径：
 * - 百分比取整显示；≥ 80% 提醒色，≥ 95% 告警色。
 * - 重置时间：今天给「14:39」，7 天内给「周日 03:59」，再远给「10-26 03:59」。
 * - 重置时间已过的窗口：数据是上一个窗口的，百分比不再可信——显示「已重置」，不显示旧百分比。
 * - 手动刷新要 agent ≥ 0.12.0（旧 agent 收到不认识的帧静默丢弃，web 只能等超时）。
 */
import type { ContextUsage, MachineInfo, RateLimitWindow } from '@trine/core';
import { compareVersions } from '@/components/list/session-actions.ts';
import { formatClock, formatRelativeTime, isSameDay } from '@/lib/format.ts';

/** 首个上报用量、支持 machine.usage.request 的 agent 版本 */
export const USAGE_MIN_AGENT = '0.12.0';

/** 首个支持 session.context.request（手动刷新 context）的 agent 版本 */
export const CONTEXT_REFRESH_MIN_AGENT = '0.13.0';

export function supportsContextRefresh(info: Pick<MachineInfo, 'agentVersion'> | null | undefined): boolean {
  if (info === null || info === undefined) return false;
  const cmp = compareVersions(info.agentVersion, CONTEXT_REFRESH_MIN_AGENT);
  return cmp !== null && cmp >= 0;
}

export function supportsUsageRefresh(info: Pick<MachineInfo, 'agentVersion'> | null | undefined): boolean {
  if (info === null || info === undefined) return false;
  const cmp = compareVersions(info.agentVersion, USAGE_MIN_AGENT);
  return cmp !== null && cmp >= 0;
}

export type UsageTone = 'normal' | 'warn' | 'danger';

export function usageTone(percent: number): UsageTone {
  if (percent >= 95) return 'danger';
  if (percent >= 80) return 'warn';
  return 'normal';
}

export function percentText(percent: number): string {
  return `${Math.round(percent)}%`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const DAY = 24 * 60 * 60 * 1000;

/** 重置时刻：今天「14:39」、7 天内「周日 03:59」、更远「10-26 03:59」 */
export function resetClockText(resetsAt: number, now: number): string {
  const clock = formatClock(resetsAt);
  if (isSameDay(resetsAt, now)) return clock;
  const d = new Date(resetsAt);
  if (resetsAt - now < 7 * DAY) return `${WEEKDAYS[d.getDay()]} ${clock}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clock}`;
}

export interface WindowView {
  /** 「62%」；已重置时为「—」 */
  percent: string;
  tone: UsageTone;
  /** 「14:39 重置」/「已重置」/ 空串（不知道重置时间） */
  reset: string;
  expired: boolean;
}

export function windowView(window: RateLimitWindow, now: number): WindowView {
  if (window.resetsAt !== undefined && window.resetsAt <= now) {
    return { percent: '—', tone: 'normal', reset: '已重置', expired: true };
  }
  return {
    percent: percentText(window.percent),
    tone: usageTone(window.percent),
    reset: window.resetsAt === undefined ? '' : `${resetClockText(window.resetsAt, now)} 重置`,
    expired: false,
  };
}

/** 距重置还有多久，紧凑写法：「1h20m」「2d5h」「35m」「<1m」；已过返回 undefined */
export function remainingShort(resetsAt: number, now: number): string | undefined {
  const ms = resetsAt - now;
  if (ms <= 0) return undefined;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/** 距重置还有多久，给人读的写法：「1 小时 20 分」「2 天 5 小时」「35 分钟」「不到 1 分钟」 */
export function remainingLong(resetsAt: number, now: number): string | undefined {
  const ms = resetsAt - now;
  if (ms <= 0) return undefined;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return mins > 0 ? `${hours} 小时 ${mins} 分` : `${hours} 小时`;
  return `${mins} 分钟`;
}

/**
 * 限额窗口的悬停提示：「5h 已用 62% · 14:39 重置（还有 1 小时 20 分）· 数据更新于 3 分钟前」。
 * 限额只有百分比和重置时间，没有 token 数（订阅限额不按 token 公开），所以提示里没有。
 */
export function windowTitle(label: string, window: RateLimitWindow, updatedAt: number | undefined, now: number): string {
  const view = windowView(window, now);
  const parts = [view.expired ? `${label} 窗口已重置，等待新数据` : `${label} 已用 ${view.percent}`];
  if (!view.expired && window.resetsAt !== undefined) {
    parts.push(`${resetClockText(window.resetsAt, now)} 重置（还有 ${remainingLong(window.resetsAt, now)}）`);
  }
  if (updatedAt !== undefined) parts.push(`数据更新于 ${formatRelativeTime(updatedAt, now)}`);
  return parts.join(' · ');
}

/** token 数：12.4k / 1.2M */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(tokens);
}

export interface ContextView {
  percent: string;
  tone: UsageTone;
  /** 悬停提示：「上下文 50k / 200k tokens」 */
  title: string;
}

export function contextView(context: ContextUsage): ContextView {
  return {
    percent: percentText(context.percent),
    tone: usageTone(context.percent),
    title: `上下文 ${formatTokens(context.usedTokens)} / ${formatTokens(context.maxTokens)} tokens`,
  };
}

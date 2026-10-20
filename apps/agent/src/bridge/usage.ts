/**
 * 用量数据的解析（usage-display）：SDK 的三种来源 → 协议的 ContextUsage / RateLimits。
 * 纯函数，形状不认识一律返回 undefined（调用方不展示），不抛。
 *
 * ## 来源（SDK 0.3.251 / Claude Code 2.1.304 实测）
 *
 * - `Query.getContextUsage()`：`{ totalTokens, maxTokens, percentage, ... }`，不消耗
 *   模型 token，要求会话的 query 活着。
 * - `rate_limit_event`：CLI 每次 API 请求后发一帧。`rate_limit_info` 顶层只说明「当前
 *   最紧的那个窗口」（`rateLimitType` + 可选 `utilization`），但实测还带一个类型定义里
 *   没有的 `unifiedWindows: { five_hour: { utilization, resetsAt }, seven_day: {...} }`，
 *   两个窗口一次给齐。`utilization` 是 0–1 的小数，`resetsAt` 是 epoch **秒**。未公开
 *   字段随时可能变，所以顶层字段作退路，两者都没有就不更新。
 * - `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`（/usage 的数据）：
 *   `rate_limits.five_hour / seven_day: { utilization: 0–100, resets_at: ISO }`，
 *   `rate_limits_available: false` 表示账号没有订阅限额。API 名就写明了不稳定。
 */
import type { ContextUsage, RateLimitWindow } from '@trine/core';

/** 限额的部分更新：只带这次知道的窗口 */
export interface RateLimitPatch {
  fiveHour?: RateLimitWindow;
  sevenDay?: RateLimitWindow;
}

/** usage 接口的解析结果 */
export type PlanUsageResult = { available: false } | { available: true; limits: RateLimitPatch };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 百分比保留一位小数，负数按 0 */
function roundPercent(percent: number): number {
  return Math.max(0, Math.round(percent * 10) / 10);
}

/** epoch 秒 → 毫秒（非正数 / 非数字 → undefined） */
function fromEpochSeconds(value: unknown): number | undefined {
  const seconds = finite(value);
  return seconds === undefined || seconds <= 0 ? undefined : Math.round(seconds * 1000);
}

/** 0–1 的小数 + epoch 秒 → 窗口 */
function windowFromFraction(utilization: unknown, resetsAt: unknown): RateLimitWindow | undefined {
  const fraction = finite(utilization);
  if (fraction === undefined) return undefined;
  const resets = fromEpochSeconds(resetsAt);
  return { percent: roundPercent(fraction * 100), ...(resets === undefined ? {} : { resetsAt: resets }) };
}

/** `getContextUsage()` 的应答 → ContextUsage */
export function contextUsageFrom(response: unknown, now: number): ContextUsage | undefined {
  const r = record(response);
  const used = finite(r?.['totalTokens']);
  const max = finite(r?.['maxTokens']);
  if (used === undefined || max === undefined || used < 0 || max <= 0) return undefined;
  const percent = finite(r?.['percentage']) ?? (used / max) * 100;
  return { usedTokens: Math.round(used), maxTokens: Math.round(max), percent: roundPercent(percent), at: now };
}

/** `rate_limit_event` 的 rate_limit_info → 限额更新；认不出任何窗口返回 undefined */
export function rateLimitPatchFromEvent(info: unknown): RateLimitPatch | undefined {
  const r = record(info);
  if (r === undefined) return undefined;
  const patch: RateLimitPatch = {};
  const unified = record(r['unifiedWindows']);
  if (unified !== undefined) {
    const five = record(unified['five_hour']);
    const seven = record(unified['seven_day']);
    const fiveHour = five === undefined ? undefined : windowFromFraction(five['utilization'], five['resetsAt']);
    const sevenDay = seven === undefined ? undefined : windowFromFraction(seven['utilization'], seven['resetsAt']);
    if (fiveHour !== undefined) patch.fiveHour = fiveHour;
    if (sevenDay !== undefined) patch.sevenDay = sevenDay;
  }
  if (patch.fiveHour === undefined && patch.sevenDay === undefined) {
    // 退路：顶层只描述一个窗口
    const window = windowFromFraction(r['utilization'], r['resetsAt']);
    if (window !== undefined && r['rateLimitType'] === 'five_hour') patch.fiveHour = window;
    if (window !== undefined && r['rateLimitType'] === 'seven_day') patch.sevenDay = window;
  }
  return patch.fiveHour === undefined && patch.sevenDay === undefined ? undefined : patch;
}

/** usage 接口的单个窗口：utilization 0–100，resets_at ISO */
function windowFromUsage(value: unknown): RateLimitWindow | undefined {
  const r = record(value);
  const percent = finite(r?.['utilization']);
  if (percent === undefined) return undefined;
  const resetsRaw = r?.['resets_at'];
  const resets = typeof resetsRaw === 'string' ? Date.parse(resetsRaw) : Number.NaN;
  return { percent: roundPercent(percent), ...(Number.isFinite(resets) && resets > 0 ? { resetsAt: resets } : {}) };
}

/** usage 接口的应答 → 解析结果；形状不认识返回 undefined */
export function planUsageFrom(response: unknown): PlanUsageResult | undefined {
  const r = record(response);
  if (r === undefined) return undefined;
  if (r['rate_limits_available'] === false) return { available: false };
  const limits = record(r['rate_limits']);
  if (limits === undefined) return undefined;
  const fiveHour = windowFromUsage(limits['five_hour']);
  const sevenDay = windowFromUsage(limits['seven_day']);
  if (fiveHour === undefined && sevenDay === undefined) return undefined;
  return {
    available: true,
    limits: { ...(fiveHour === undefined ? {} : { fiveHour }), ...(sevenDay === undefined ? {} : { sevenDay }) },
  };
}

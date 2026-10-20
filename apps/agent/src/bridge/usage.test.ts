import { describe, expect, test } from 'bun:test';
import { contextUsageFrom, planUsageFrom, rateLimitPatchFromEvent } from './usage.ts';

describe('contextUsageFrom', () => {
  test('取 totalTokens / maxTokens / percentage，百分比保留一位小数', () => {
    expect(contextUsageFrom({ totalTokens: 12_364, maxTokens: 1_000_000, percentage: 1.236 }, 5)).toEqual({
      usedTokens: 12_364,
      maxTokens: 1_000_000,
      percent: 1.2,
      at: 5,
    });
  });

  test('缺 percentage 时自己算；超窗 > 100 照给', () => {
    expect(contextUsageFrom({ totalTokens: 210_000, maxTokens: 200_000 }, 0)?.percent).toBe(105);
  });

  test('形状不认识返回 undefined', () => {
    expect(contextUsageFrom(undefined, 0)).toBeUndefined();
    expect(contextUsageFrom({ totalTokens: 1 }, 0)).toBeUndefined();
    expect(contextUsageFrom({ totalTokens: 1, maxTokens: 0 }, 0)).toBeUndefined();
    expect(contextUsageFrom({ totalTokens: '1', maxTokens: 10 }, 0)).toBeUndefined();
  });
});

describe('rateLimitPatchFromEvent', () => {
  test('unifiedWindows：0–1 小数 → 百分比，epoch 秒 → 毫秒', () => {
    expect(
      rateLimitPatchFromEvent({
        status: 'allowed',
        rateLimitType: 'five_hour',
        unifiedWindows: {
          five_hour: { utilization: 0.62, resetsAt: 1_792_478_400 },
          seven_day: { utilization: 0.155, resetsAt: 1_792_958_400 },
        },
      }),
    ).toEqual({
      fiveHour: { percent: 62, resetsAt: 1_792_478_400_000 },
      sevenDay: { percent: 15.5, resetsAt: 1_792_958_400_000 },
    });
  });

  test('没有 unifiedWindows 时退回顶层的单个窗口', () => {
    expect(rateLimitPatchFromEvent({ rateLimitType: 'seven_day', utilization: 0.9, resetsAt: 100 })).toEqual({
      sevenDay: { percent: 90, resetsAt: 100_000 },
    });
    expect(rateLimitPatchFromEvent({ rateLimitType: 'five_hour', utilization: 0.5 })).toEqual({
      fiveHour: { percent: 50 },
    });
  });

  test('认不出任何窗口返回 undefined（只有 status / 别的窗口类型 / 没有用量）', () => {
    expect(rateLimitPatchFromEvent({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1 })).toBeUndefined();
    expect(rateLimitPatchFromEvent({ rateLimitType: 'overage', utilization: 0.5 })).toBeUndefined();
    expect(rateLimitPatchFromEvent({ unifiedWindows: { five_hour: { resetsAt: 1 } } })).toBeUndefined();
    expect(rateLimitPatchFromEvent(null)).toBeUndefined();
  });
});

describe('planUsageFrom', () => {
  test('utilization 0–100，resets_at ISO → 毫秒；null 窗口跳过', () => {
    expect(
      planUsageFrom({
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 60, resets_at: '2026-10-20T06:40:00.121344+00:00' },
          seven_day: { utilization: 16, resets_at: null },
          seven_day_opus: null,
        },
      }),
    ).toEqual({
      available: true,
      limits: {
        fiveHour: { percent: 60, resetsAt: Date.parse('2026-10-20T06:40:00.121Z') },
        sevenDay: { percent: 16 },
      },
    });
  });

  test('rate_limits_available=false → 不可用', () => {
    expect(planUsageFrom({ rate_limits_available: false, rate_limits: null })).toEqual({ available: false });
  });

  test('形状不认识返回 undefined', () => {
    expect(planUsageFrom(undefined)).toBeUndefined();
    expect(planUsageFrom({ rate_limits_available: true, rate_limits: null })).toBeUndefined();
    expect(planUsageFrom({ rate_limits_available: true, rate_limits: { five_hour: { utilization: null } } })).toBeUndefined();
  });
});

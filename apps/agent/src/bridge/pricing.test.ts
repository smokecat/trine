/**
 * 价目表单测（离线）：峰谷判定、单价选择、token 计价。
 * 价目表是 trine 侧成本估算的唯一依据，算错会直接显示假数字，所以逐项覆盖。
 */
import { describe, expect, test } from 'bun:test';
import { costOfTokens, isPeak, PriceTableSchema, ratesFor, ZERO_TOKENS } from './pricing.ts';

const table = PriceTableSchema.parse({
  models: {
    'free-model': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
    'peak-model': {
      peak: { input: 2, output: 4, cacheRead: 0.02, cacheWrite: 2 },
      offPeak: { input: 1, output: 2, cacheRead: 0.01, cacheWrite: 1 },
    },
  },
});

/** 2026-11-10 是周二；这些时刻都按 UTC 解释 */
const utc = (iso: string): number => Date.parse(iso);

describe('isPeak', () => {
  test('工作日峰时区间内（左闭右开）', () => {
    expect(isPeak(utc('2026-11-10T01:00:00Z'), table)).toBe(true);
    expect(isPeak(utc('2026-11-10T03:59:00Z'), table)).toBe(true);
    expect(isPeak(utc('2026-11-10T06:00:00Z'), table)).toBe(true);
    expect(isPeak(utc('2026-11-10T09:59:00Z'), table)).toBe(true);
  });

  test('工作日非峰时', () => {
    expect(isPeak(utc('2026-11-10T04:00:00Z'), table)).toBe(false);
    expect(isPeak(utc('2026-11-10T05:59:00Z'), table)).toBe(false);
    expect(isPeak(utc('2026-11-10T10:00:00Z'), table)).toBe(false);
    expect(isPeak(utc('2026-11-10T00:59:00Z'), table)).toBe(false);
  });

  test('周末全天不算峰时', () => {
    expect(isPeak(utc('2026-11-14T02:00:00Z'), table)).toBe(false); // 周六
    expect(isPeak(utc('2026-11-15T02:00:00Z'), table)).toBe(false); // 周日
  });

  test('峰值模型在峰时用 peak 价、其余用 offPeak 价', () => {
    expect(ratesFor(table.models['peak-model']!, utc('2026-11-10T02:00:00Z'), table).input).toBe(2);
    expect(ratesFor(table.models['peak-model']!, utc('2026-11-10T20:00:00Z'), table).input).toBe(1);
  });

  test('单一单价模型全天同价', () => {
    expect(ratesFor(table.models['free-model']!, utc('2026-11-10T02:00:00Z'), table).input).toBe(1);
    expect(ratesFor(table.models['free-model']!, utc('2026-11-10T20:00:00Z'), table).input).toBe(1);
  });
});

describe('costOfTokens', () => {
  test('四类 token 各自计价（美元 / 百万）', () => {
    const cost = costOfTokens(
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
      { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 3 },
    );
    expect(cost).toBeCloseTo(6.1, 10);
  });

  test('零 token = 零成本', () => {
    expect(costOfTokens(ZERO_TOKENS, { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 })).toBe(0);
  });
});

describe('PriceTableSchema', () => {
  test('缺省峰时规则按 DeepSeek 的 1-4 / 6-10', () => {
    expect(table.peakHoursUtc).toEqual([[1, 4], [6, 10]]);
    expect(table.peakWeekdaysOnly).toBe(true);
  });

  test('负单价被拒', () => {
    expect(() =>
      PriceTableSchema.parse({ models: { m: { input: -1, output: 1, cacheRead: 1, cacheWrite: 1 } } }),
    ).toThrow();
  });
});

import { describe, expect, test } from 'bun:test';
import {
  contextView,
  formatTokens,
  remainingLong,
  remainingShort,
  resetClockText,
  supportsContextRefresh,
  supportsUsageRefresh,
  usageTone,
  windowTitle,
  windowView,
} from './usage-model.ts';

/** 本地时区的某个时刻，测试不依赖运行环境的时区 */
function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi).getTime();
}

const now = at(2026, 10, 20, 13, 0);

describe('usage-model', () => {
  test('能力探测：agent ≥ 0.12.0', () => {
    expect(supportsUsageRefresh({ agentVersion: '0.12.0' })).toBe(true);
    expect(supportsUsageRefresh({ agentVersion: '0.11.9' })).toBe(false);
    expect(supportsUsageRefresh({ agentVersion: 'dev' })).toBe(false);
    expect(supportsUsageRefresh(null)).toBe(false);
  });

  test('色调：≥80 提醒、≥95 告警', () => {
    expect(usageTone(79.9)).toBe('normal');
    expect(usageTone(80)).toBe('warn');
    expect(usageTone(95)).toBe('danger');
  });

  test('重置时刻：今天只给时刻、7 天内带星期、更远给日期', () => {
    expect(resetClockText(at(2026, 10, 20, 14, 39), now)).toBe('14:39');
    expect(resetClockText(at(2026, 10, 26, 3, 59), now)).toBe('周一 03:59');
    expect(resetClockText(at(2026, 11, 3, 8, 0), now)).toBe('11-03 08:00');
  });

  test('窗口：百分比取整 + 重置时间；已过重置时间显示「已重置」不给旧百分比', () => {
    expect(windowView({ percent: 61.6, resetsAt: at(2026, 10, 20, 14, 39) }, now)).toEqual({
      percent: '62%',
      tone: 'normal',
      reset: '14:39 重置',
      expired: false,
    });
    expect(windowView({ percent: 97 }, now)).toEqual({ percent: '97%', tone: 'danger', reset: '', expired: false });
    expect(windowView({ percent: 97, resetsAt: now - 1 }, now)).toEqual({
      percent: '—',
      tone: 'normal',
      reset: '已重置',
      expired: true,
    });
  });

  test('context：百分比与 token 提示', () => {
    expect(contextView({ usedTokens: 50_000, maxTokens: 200_000, percent: 25, at: 1 })).toEqual({
      percent: '25%',
      tone: 'normal',
      title: '上下文 50k / 200k tokens',
    });
    expect(formatTokens(12_364)).toBe('12.4k');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(950)).toBe('950');
  });

  test('倒计时：紧凑与可读两种写法；已过返回 undefined', () => {
    const min = 60_000;
    expect(remainingShort(now + 80 * min, now)).toBe('1h20m');
    expect(remainingShort(now + 120 * min, now)).toBe('2h');
    expect(remainingShort(now + (2 * 1440 + 5 * 60 + 30) * min, now)).toBe('2d5h');
    expect(remainingShort(now + 35 * min + 10_000, now)).toBe('35m');
    expect(remainingShort(now + 30_000, now)).toBe('<1m');
    expect(remainingShort(now, now)).toBeUndefined();
    expect(remainingLong(now + 80 * min, now)).toBe('1 小时 20 分');
    expect(remainingLong(now + 3 * 1440 * min, now)).toBe('3 天');
    expect(remainingLong(now + 30_000, now)).toBe('不到 1 分钟');
  });

  test('窗口提示：百分比、重置时刻与倒计时、数据更新时间；已重置单独说明', () => {
    const resetsAt = at(2026, 10, 20, 14, 20);
    expect(windowTitle('5h', { percent: 62, resetsAt }, now - 3 * 60_000, now)).toBe(
      '5h 已用 62% · 14:20 重置（还有 1 小时 20 分） · 数据更新于 3 分钟前',
    );
    expect(windowTitle('1w', { percent: 16 }, undefined, now)).toBe('1w 已用 16%');
    expect(windowTitle('5h', { percent: 90, resetsAt: now - 1 }, now, now)).toBe('5h 窗口已重置，等待新数据 · 数据更新于 刚刚');
  });

  test('ctx 刷新的能力探测：agent ≥ 0.13.0', () => {
    expect(supportsContextRefresh({ agentVersion: '0.13.0' })).toBe(true);
    expect(supportsContextRefresh({ agentVersion: '0.12.0' })).toBe(false);
  });
});

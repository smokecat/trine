import { describe, expect, test } from 'bun:test';
import type { MachineStats } from '@trine/core';
import {
  formatMemoryPair,
  formatRate,
  formatUptime,
  fullestDisk,
  isStatsStale,
  leaseTtlMs,
  percentTone,
  sparklinePoints,
  StatsWatchCoordinator,
  supportsMachineStats,
} from './stats-model.ts';

describe('文案与色调', () => {
  test('阈值：≥80 提醒，≥90 告警', () => {
    expect([79.9, 80, 89.9, 90].map(percentTone)).toEqual(['normal', 'warn', 'warn', 'danger']);
  });

  test('格式化', () => {
    expect(formatRate(100)).toBe('0 KB/s');
    expect(formatRate(1.5 * 1024 * 1024)).toBe('1.5 MB/s');
    expect(formatUptime(3 * 86_400 + 4 * 3_600)).toBe('3天4小时');
    expect(formatUptime(5 * 3_600 + 12 * 60)).toBe('5小时12分');
    expect(formatUptime(8 * 60)).toBe('8分');
    expect(formatMemoryPair(4.1 * 1024 ** 3, 7.7 * 1024 ** 3)).toBe('4.1/7.7 GB');
    expect(formatMemoryPair(300 * 1024 ** 2, 512 * 1024 ** 2)).toBe('300/512 MB');
  });

  test('fullestDisk 按 used / (used + avail)', () => {
    const stats: MachineStats = {
      at: 0,
      disks: [
        { label: '/', totalBytes: 100, usedBytes: 50, availBytes: 50 },
        { label: '~', totalBytes: 100, usedBytes: 90, availBytes: 5 },
      ],
    };
    expect(fullestDisk(stats)?.label).toBe('~');
    expect(fullestDisk({ at: 0 })).toBeUndefined();
  });

  test('isStatsStale：离线即过时；否则超过 3 个间隔（至少 2 分钟）', () => {
    const s: MachineStats = { at: 0 };
    expect(isStatsStale(s, 1, false, 60_000)).toBe(true);
    expect(isStatsStale(s, 179_000, true, 60_000)).toBe(false);
    expect(isStatsStale(s, 181_000, true, 60_000)).toBe(true);
    expect(isStatsStale(s, 119_000, true, 5_000)).toBe(false);
    expect(isStatsStale(s, 10 ** 9, true, null)).toBe(false);
  });

  test('sparklinePoints：0–100 映射到高度、x 均分', () => {
    expect(sparklinePoints([0, 100], 10, 20)).toBe('0,20 10,0');
    expect(sparklinePoints([50], 10, 20)).toBe('0,10 10,10');
    expect(sparklinePoints([], 10, 20)).toBe('');
  });

  test('版本探测与租约时长', () => {
    expect(supportsMachineStats({ agentVersion: '0.14.0' })).toBe(true);
    expect(supportsMachineStats({ agentVersion: '0.13.0' })).toBe(false);
    expect(supportsMachineStats(null)).toBe(false);
    expect(leaseTtlMs(5_000)).toBe(120_000);
    expect(leaseTtlMs(60_000)).toBe(180_000);
  });
});

function harness() {
  const sent: string[] = [];
  let now = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let next = 1;
  const c = new StatsWatchCoordinator({
    send: (id, w) => sent.push(`${id}:${w.intervalMs}/${w.ttlMs}`),
    setTimer: (fn, ms) => {
      timers.set(next, { fn, at: now + ms });
      return next++;
    },
    clearTimer: (h) => timers.delete(h as number),
  });
  const advance = (ms: number): void => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return { c, sent, timers, advance };
}

describe('StatsWatchCoordinator', () => {
  test('只对在线且支持的机器订阅；取最短间隔；变短立即重发，注销后恢复', () => {
    const h = harness();
    const offList = h.c.register('m', 60_000);
    expect(h.sent).toEqual([]);
    h.c.setEligible(new Set(['m']));
    expect(h.sent).toEqual(['m:60000/180000']);
    const offDetail = h.c.register('m', 5_000);
    expect(h.c.activeInterval('m')).toBe(5_000);
    offDetail();
    expect(h.c.activeInterval('m')).toBe(60_000);
    expect(h.sent).toEqual(['m:60000/180000', 'm:5000/120000', 'm:60000/180000']);
    // 同间隔重复登记不重发
    const again = h.c.register('m', 60_000);
    again();
    expect(h.sent).toHaveLength(3);
    offList();
    expect(h.sent.at(-1)).toBe('m:60000/0');
    expect(h.timers.size).toBe(0);
  });

  test('到期前（ttl 一半）续租', () => {
    const h = harness();
    h.c.setEligible(new Set(['m']));
    h.c.register('m', 60_000);
    h.advance(90_000);
    h.advance(90_000);
    expect(h.sent).toEqual(['m:60000/180000', 'm:60000/180000', 'm:60000/180000']);
  });

  test('页面隐藏退订，回前台重订；离线不发，重新上线重订', () => {
    const h = harness();
    h.c.setEligible(new Set(['m']));
    h.c.register('m', 10_000);
    h.c.setVisible(false);
    expect(h.sent.at(-1)).toBe('m:10000/0');
    h.c.setVisible(true);
    expect(h.sent.at(-1)).toBe('m:10000/120000');
    const count = h.sent.length;
    h.c.setEligible(new Set());
    expect(h.sent).toHaveLength(count);
    expect(h.c.activeInterval('m')).toBeUndefined();
    h.c.setEligible(new Set(['m']));
    expect(h.sent.at(-1)).toBe('m:10000/120000');
  });
});

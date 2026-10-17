import { describe, expect, test } from 'bun:test';
import {
  formatBytes,
  formatCost,
  formatDuration,
  formatLineDelta,
  formatLines,
  formatRelativeTime,
  formatSeconds,
  truncate,
} from './format.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('format · 相对时间', () => {
  // 2026-06-15T12:00:00Z 附近，用本地时区构造避免测试机时区影响断言
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime();

  test('不足 1 分钟为「刚刚」', () => {
    expect(formatRelativeTime(now, now)).toBe('刚刚');
    expect(formatRelativeTime(now - 59_000, now)).toBe('刚刚');
  });

  test('分 / 时 / 天各档取下整', () => {
    expect(formatRelativeTime(now - 2 * MINUTE, now)).toBe('2 分钟前');
    expect(formatRelativeTime(now - 59 * MINUTE - 59_000, now)).toBe('59 分钟前');
    expect(formatRelativeTime(now - 3 * HOUR, now)).toBe('3 小时前');
    expect(formatRelativeTime(now - 23 * HOUR - 59 * MINUTE, now)).toBe('23 小时前');
    expect(formatRelativeTime(now - 6 * DAY, now)).toBe('6 天前');
  });

  test('超过 7 天退回绝对日期；同年不带年份，跨年带', () => {
    expect(formatRelativeTime(new Date(2026, 2, 14, 9, 0, 0).getTime(), now)).toBe('03-14');
    expect(formatRelativeTime(new Date(2025, 11, 31, 9, 0, 0).getTime(), now)).toBe('2025-12-31');
  });

  test('未来时间（时钟漂移）按「刚刚」而不是负数', () => {
    expect(formatRelativeTime(now + 3 * MINUTE, now)).toBe('刚刚');
  });
});

describe('format · 耗时', () => {
  test('不足 1 分钟给秒', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(59_999)).toBe('59s');
  });

  test('≥1 分钟给 m:ss，秒补零', () => {
    expect(formatDuration(60_000)).toBe('1:00');
    expect(formatDuration(154_000)).toBe('2:34'); // 原型心跳 footer 的例子
    expect(formatDuration(65_000)).toBe('1:05');
  });

  test('≥1 小时给 h:mm:ss，免得 73:20 被读成 73 秒', () => {
    expect(formatDuration(3600_000)).toBe('1:00:00');
    expect(formatDuration(4400_000)).toBe('1:13:20');
  });

  test('负数按 0 处理', () => {
    expect(formatDuration(-5)).toBe('0s');
  });

  test('formatSeconds 只给整秒', () => {
    expect(formatSeconds(0)).toBe('0s');
    expect(formatSeconds(61_900)).toBe('61s');
    expect(formatSeconds(-1)).toBe('0s');
  });
});

describe('format · 成本', () => {
  test('两位小数加 $ 前缀', () => {
    expect(formatCost(0.21)).toBe('$0.21');
    expect(formatCost(12.5)).toBe('$12.50');
  });

  test('0 与「极小但非 0」区分开——后者不能显示成 $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.0004)).toBe('<$0.01');
    expect(formatCost(0.005)).toBe('$0.01');
  });
});

describe('format · 字节', () => {
  test('1024 以下给 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  test('逐级进位，<10 留一位小数、≥10 取整', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(256 * 1024)).toBe('256 KB');
    expect(formatBytes(5.5 * 1024 * 1024)).toBe('5.5 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });

  test('负数按 0', () => {
    expect(formatBytes(-10)).toBe('0 B');
  });
});

describe('format · 行数', () => {
  test('增删摘要只显示非 0 的一侧', () => {
    expect(formatLineDelta(9, 2)).toBe('+9 −2');
    expect(formatLineDelta(9, 0)).toBe('+9');
    expect(formatLineDelta(0, 2)).toBe('−2');
    expect(formatLineDelta(0, 0)).toBe('无改动');
  });

  test('行数带千分位', () => {
    expect(formatLines(0)).toBe('0 行');
    expect(formatLines(1234)).toBe('1,234 行');
  });
});

describe('format · truncate', () => {
  test('压成单行并规整空白', () => {
    expect(truncate('a\n  b\tc', 20)).toBe('a b c');
  });

  test('超长截断后总长度恰好等于 max', () => {
    const out = truncate('x'.repeat(50), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
  });

  test('恰好等于 max 时不截断', () => {
    expect(truncate('12345', 5)).toBe('12345');
  });
});

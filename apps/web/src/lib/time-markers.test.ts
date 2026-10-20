import { describe, expect, test } from 'bun:test';
import { timeMarkers } from './time-markers.ts';

const MINUTE = 60_000;
// 本地时区构造，避免测试机时区影响「跨天」判定
const t0 = new Date(2026, 9, 20, 14, 0, 0).getTime();
const at = (...ts: number[]) => ts.map((x) => ({ ts: x }));

describe('timeMarkers', () => {
  test('第一条有效记录前给日期标记', () => {
    expect(timeMarkers(at(t0, t0 + 1000))).toEqual([{ kind: 'day', at: t0 }, undefined]);
  });

  test('密集记录（秒级 / 不足 10 分钟）不插标记', () => {
    const ms = timeMarkers(at(t0, t0 + 2000, t0 + 5000, t0 + 9 * MINUTE, t0 + 18 * MINUTE));
    expect(ms.slice(1)).toEqual([undefined, undefined, undefined, undefined]);
  });

  test('间隔 ≥ 10 分钟给时刻标记', () => {
    expect(timeMarkers(at(t0, t0 + 10 * MINUTE))[1]).toEqual({ kind: 'gap', at: t0 + 10 * MINUTE });
  });

  test('跨天给日期标记，即使间隔很短', () => {
    const late = new Date(2026, 9, 20, 23, 59, 0).getTime();
    const early = new Date(2026, 9, 21, 0, 1, 0).getTime();
    expect(timeMarkers(at(late, early))[1]).toEqual({ kind: 'day', at: early });
  });

  test('ts <= 0 不显示也不参与计算', () => {
    expect(timeMarkers(at(0, t0, 0, t0 + 11 * MINUTE))).toEqual([
      undefined,
      { kind: 'day', at: t0 },
      undefined,
      { kind: 'gap', at: t0 + 11 * MINUTE },
    ]);
  });

  test('时钟回退的记录不产生标记，基准不倒退', () => {
    const ms = timeMarkers(at(t0 + 20 * MINUTE, t0, t0 + 25 * MINUTE));
    expect(ms.slice(1)).toEqual([undefined, undefined]);
  });
});

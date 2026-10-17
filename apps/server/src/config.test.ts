import { describe, expect, test } from 'bun:test';
import { assertConfigInvariants, loadConfig } from './config.ts';

describe('配置不变量（B1 第二道防线）', () => {
  test('默认配置满足全部不变量', () => {
    expect(() => loadConfig()).not.toThrow();
  });

  test('relayMaxPerStream < parkedMaxPerMachine 时拒绝启动', () => {
    // 这正是评审复现 B1 的那种配置：留存窗口比排队配额还小，
    // 排队帧会被挤出留存窗口
    expect(() =>
      loadConfig({ relayMaxPerStream: 10, parkedMaxPerMachine: 500 }),
    ).toThrow(/TRINE_RELAY_MAX_PER_STREAM/);
  });

  test('两者相等是允许的边界', () => {
    expect(() =>
      loadConfig({ relayMaxPerStream: 100, parkedMaxPerMachine: 100 }),
    ).not.toThrow();
  });

  test('空闲阈值必须大于心跳间隔', () => {
    expect(() =>
      loadConfig({ idleTimeoutMs: 30_000, heartbeatIntervalMs: 30_000 }),
    ).toThrow(/TRINE_IDLE_TIMEOUT_MS/);
    expect(() =>
      loadConfig({ idleTimeoutMs: 10_000, heartbeatIntervalMs: 30_000 }),
    ).toThrow(/TRINE_IDLE_TIMEOUT_MS/);
  });

  test('hwm TTL 必须长于 relay 留存（基线不能先于帧蒸发）', () => {
    expect(() => loadConfig({ dbPath: ':memory:', hwmTtlMs: 1000, relayRetentionMs: 1000 })).toThrow(
      /TRINE_HWM_TTL_MS/,
    );
    expect(() => loadConfig({ dbPath: ':memory:', hwmTtlMs: 2000, relayRetentionMs: 1000 })).not.toThrow();
  });

  test('assertConfigInvariants 可对已有配置单独校验', () => {
    const good = loadConfig();
    expect(() => assertConfigInvariants(good)).not.toThrow();
    expect(() =>
      assertConfigInvariants({ ...good, relayMaxPerStream: 1 }),
    ).toThrow();
  });

  test('错误信息点名具体环境变量与实际取值', () => {
    expect(() =>
      loadConfig({ relayMaxPerStream: 7, parkedMaxPerMachine: 9 }),
    ).toThrow(/\(7\).*\(9\)/s);
  });
});

describe('环境变量解析', () => {
  test('非法整数直接抛错而不是静默取默认值', () => {
    const prev = process.env.TRINE_PORT;
    process.env.TRINE_PORT = 'not-a-number';
    try {
      expect(() => loadConfig()).toThrow(/TRINE_PORT/);
    } finally {
      if (prev === undefined) delete process.env.TRINE_PORT;
      else process.env.TRINE_PORT = prev;
    }
  });

  test('overrides 优先于环境变量', () => {
    expect(loadConfig({ port: 12345 }).port).toBe(12345);
  });

  test('trustProxyHeader 默认开启（既定部署形态是反代后）', () => {
    expect(loadConfig().trustProxyHeader).toBe(true);
  });
});

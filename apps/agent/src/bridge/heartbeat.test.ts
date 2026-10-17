/**
 * 心跳（决策 4：2-5s，仅运行中）。
 *
 * 用注入的假定时器 + 假时钟，测试不真的等秒。
 */
import { describe, expect, test } from 'bun:test';
import { Heartbeat } from './heartbeat.ts';
import type { EventBody } from './types.ts';

function makeHeartbeat(intervalMs = 3_000) {
  const events: EventBody[] = [];
  let clock = 0;
  let fire: (() => void) | undefined;
  let cleared = false;

  const heartbeat = new Heartbeat({
    emit: (body) => events.push(body),
    intervalMs,
    now: () => clock,
    setInterval: (fn) => {
      fire = fn;
      return 'handle';
    },
    clearInterval: () => {
      cleared = true;
      fire = undefined;
    },
  });

  return {
    heartbeat,
    events,
    tick: () => fire?.(),
    advance: (ms: number) => {
      clock += ms;
    },
    get cleared() {
      return cleared;
    },
    get armed() {
      return fire !== undefined;
    },
  };
}

describe('Heartbeat', () => {
  test('start 前不发帧（协议：仅运行中发）', () => {
    const h = makeHeartbeat();
    expect(h.armed).toBe(false);
    expect(h.events).toHaveLength(0);
  });

  test('start 后定时器触发即发 run.heartbeat', () => {
    const h = makeHeartbeat();
    h.heartbeat.start();
    h.advance(3_000);
    h.tick();

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: 'run.heartbeat',
      runElapsedMs: 3_000,
      phase: 'run',
    });
  });

  test('stop 后不再发帧', () => {
    const h = makeHeartbeat();
    h.heartbeat.start();
    h.heartbeat.stop();

    expect(h.cleared).toBe(true);
    expect(h.armed).toBe(false);
    expect(h.heartbeat.running).toBe(false);
  });

  test('重复 start 不叠加定时器', () => {
    const h = makeHeartbeat();
    h.heartbeat.start();
    h.heartbeat.start();
    h.tick();
    expect(h.events).toHaveLength(1);
  });

  test('silentMs 反映无输出时长，noteActivity 归零', () => {
    const h = makeHeartbeat();
    h.heartbeat.start();

    h.advance(5_000);
    h.tick();
    expect(h.events[0]).toMatchObject({ silentMs: 5_000 });

    h.heartbeat.noteActivity();
    h.advance(1_000);
    h.tick();
    expect(h.events[1]).toMatchObject({ silentMs: 1_000, runElapsedMs: 6_000 });
  });

  test('工具运行中带 currentTool 与 tool 阶段', () => {
    const h = makeHeartbeat();
    h.heartbeat.start();
    h.heartbeat.noteToolStart('tu_1', 'Bash');

    h.advance(2_500);
    h.tick();

    expect(h.events[0]).toMatchObject({
      phase: 'tool',
      currentTool: { toolUseId: 'tu_1', name: 'Bash', elapsedMs: 2_500 },
    });
  });

  test('工具结束后回到 run 阶段且不再带 currentTool', () => {
    const h = makeHeartbeat();
    h.heartbeat.start();
    h.heartbeat.noteToolStart('tu_1', 'Bash');
    h.heartbeat.noteToolEnd('tu_1');
    h.tick();

    const event = h.events[0] as { phase: string; currentTool?: unknown };
    expect(event.phase).toBe('run');
    expect(event.currentTool).toBeUndefined();
  });

  test('结束的不是当前工具时不清空（并发工具场景）', () => {
    const h = makeHeartbeat();
    h.heartbeat.start();
    h.heartbeat.noteToolStart('tu_1', 'Bash');
    h.heartbeat.noteToolEnd('other');
    h.tick();

    expect(h.events[0]).toMatchObject({ phase: 'tool' });
  });

  test('setPhase 可切到 wait（等待权限）', () => {
    const h = makeHeartbeat();
    h.heartbeat.start();
    h.heartbeat.setPhase('wait');
    h.tick();

    expect(h.events[0]).toMatchObject({ phase: 'wait' });
  });

  test('stop 后 start 重置计时', () => {
    const h = makeHeartbeat();
    h.heartbeat.start();
    h.advance(10_000);
    h.heartbeat.stop();

    h.heartbeat.start();
    h.advance(1_000);
    h.tick();

    expect(h.events[0]).toMatchObject({ runElapsedMs: 1_000 });
  });

  test('所有计时字段非负（协议 schema 要求 nonnegative）', () => {
    const h = makeHeartbeat();
    h.heartbeat.start();
    h.tick();

    const event = h.events[0] as { runElapsedMs: number; silentMs: number };
    expect(event.runElapsedMs).toBeGreaterThanOrEqual(0);
    expect(event.silentMs).toBeGreaterThanOrEqual(0);
  });
});

import { describe, expect, test } from 'bun:test';
import type { Options, query } from '@anthropic-ai/claude-agent-sdk';
import { PlanUsageTracker, REBROADCAST_MS } from './plan-usage.ts';

const usageResponse = {
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 60, resets_at: '2026-10-20T06:40:00Z' },
    seven_day: { utilization: 16, resets_at: '2026-10-25T20:00:00Z' },
  },
};

/** 假 query：记下 options 与是否关闭；usage 接口按给定实现应答 */
function fakeQuery(usage: () => Promise<unknown>) {
  const calls: { options: Options | undefined; closed: boolean }[] = [];
  const queryFn = ((params: { options?: Options }) => {
    const record = { options: params.options, closed: false };
    calls.push(record);
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
      close: () => {
        record.closed = true;
      },
    };
  }) as unknown as typeof query;
  return { queryFn, calls };
}

function makeTracker(options: {
  live?: () => Promise<unknown> | undefined;
  usage?: () => Promise<unknown>;
  timeoutMs?: number;
  now?: () => number;
}) {
  let changes = 0;
  const fake = fakeQuery(options.usage ?? (() => Promise.resolve(usageResponse)));
  const tracker = new PlanUsageTracker({
    liveUsage: options.live ?? (() => undefined),
    onChange: () => {
      changes += 1;
    },
    queryFn: fake.queryFn,
    pathToClaudeCodeExecutable: '/opt/claude',
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    now: options.now ?? (() => 1_000),
  });
  return { tracker, calls: fake.calls, changes: () => changes };
}

describe('PlanUsageTracker · apply', () => {
  test('合并窗口；值变了才广播，值不变超过间隔也重新广播', () => {
    let clock = 1_000;
    const { tracker, changes } = makeTracker({ now: () => clock });
    tracker.apply({ fiveHour: { percent: 10, resetsAt: 5 } });
    expect(tracker.current).toEqual({ fiveHour: { percent: 10, resetsAt: 5 }, updatedAt: 1_000 });
    expect(changes()).toBe(1);

    clock = 2_000;
    tracker.apply({ sevenDay: { percent: 3 } });
    expect(tracker.current).toEqual({ fiveHour: { percent: 10, resetsAt: 5 }, sevenDay: { percent: 3 }, updatedAt: 2_000 });
    expect(changes()).toBe(2);

    clock = 3_000;
    tracker.apply({ fiveHour: { percent: 10, resetsAt: 5 } });
    expect(changes()).toBe(2);
    expect(tracker.current?.updatedAt).toBe(3_000);

    clock = 2_000 + REBROADCAST_MS;
    tracker.apply({ fiveHour: { percent: 10, resetsAt: 5 } });
    expect(changes()).toBe(3);
  });
});

describe('PlanUsageTracker · refresh', () => {
  test('有活跃会话就借它，不起临时进程', async () => {
    const { tracker, calls, changes } = makeTracker({ live: () => Promise.resolve(usageResponse) });
    expect(await tracker.refresh()).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
    expect(tracker.current?.fiveHour?.percent).toBe(60);
    expect(changes()).toBe(1);
  });

  test('没有活跃会话：临时起一个不落盘的空 query，用完即关；值没变也广播', async () => {
    const { tracker, calls, changes } = makeTracker({});
    expect(await tracker.refresh()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.closed).toBe(true);
    expect(calls[0]!.options).toMatchObject({ persistSession: false, pathToClaudeCodeExecutable: '/opt/claude' });
    expect(calls[0]!.options?.abortController?.signal.aborted).toBe(true);
    expect(tracker.current?.sevenDay?.percent).toBe(16);

    await tracker.refresh();
    expect(changes()).toBe(2);
  });

  test('单飞：并发刷新只起一个进程', async () => {
    let release!: (v: unknown) => void;
    const { tracker, calls } = makeTracker({ usage: () => new Promise((r) => (release = r)) });
    const a = tracker.refresh();
    const b = tracker.refresh();
    expect(a).toBe(b);
    await Bun.sleep(0);
    release(usageResponse);
    expect(await a).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  test('账号没有订阅限额：清掉已有数据并广播，回 unavailable', async () => {
    const { tracker, changes } = makeTracker({ usage: () => Promise.resolve({ rate_limits_available: false, rate_limits: null }) });
    tracker.apply({ fiveHour: { percent: 1 } });
    expect(await tracker.refresh()).toMatchObject({ ok: false, code: 'unavailable' });
    expect(tracker.current).toBeUndefined();
    expect(changes()).toBe(2);
  });

  test('出错 / 超时 / 形状不认识 → failed，不抛，进程照样关', async () => {
    const thrown = makeTracker({ usage: () => Promise.reject(new Error('boom')) });
    expect(await thrown.tracker.refresh()).toMatchObject({ ok: false, code: 'failed' });
    expect(thrown.calls[0]!.closed).toBe(true);

    const slow = makeTracker({ usage: () => new Promise(() => {}), timeoutMs: 10 });
    expect(await slow.tracker.refresh()).toMatchObject({ ok: false, code: 'failed' });
    await Bun.sleep(20);
    expect(slow.calls[0]!.closed).toBe(true);

    const odd = makeTracker({ usage: () => Promise.resolve({ something: 'else' }) });
    expect(await odd.tracker.refresh()).toMatchObject({ ok: false, code: 'failed' });
    expect(odd.tracker.current).toBeUndefined();
  });
});

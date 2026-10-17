/**
 * 时间线的**重渲染计数**测试（评审 N4）。
 *
 * minor m4 想消灭的浪费是「工具运行期间，每秒 tick 让 500 条时间线整表重画」。
 * 上一轮的修法是 `now={needsTick(entry) ? now : 0}`——想法对，但同一个 `Entry`
 * 还收着 `runningTool={{toolUseId, elapsedMs}}` 这个**每次渲染新建的对象**，
 * `memo` 的浅比较必然不等，于是全部条目照样重渲染，那层用心被完全旁路。
 * commit 2f2cf2c 声称「其余拿常量 0 从而被 memo 挡住」，与实际不符。
 *
 * 纯逻辑测试抓不住这种事——它是「React 到底重画了几个组件」的问题。所以这里
 * 真的把 `<Timeline>` 挂进 DOM，用 `onEntryRender` 钩子数每个条目的渲染次数，
 * 然后推进一次 tick，断言**只有该走秒的那一两条**被重画。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';
import type { TimelineEntry } from '@/lib/reducer.ts';
import { Timeline, type TimelineHandlers } from './Timeline.tsx';

const handlers: TimelineHandlers = {
  onUserAction: () => {},
  onRespondPermission: () => {},
  onResumeAt: () => {},
  onStop: () => {},
};

const T0 = 1_700_000_000_000;

/** 一条长时间线：n 条 assistant + 1 条运行中的工具 + 1 条 pending 权限卡 */
function makeEntries(n: number): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (let i = 0; i < n; i++) {
    entries.push({ kind: 'assistant', id: `a-${i}`, text: `第 ${i} 条`, done: true, thinking: false, seq: i, ts: T0 + i });
  }
  entries.push({
    kind: 'tool',
    id: 'tool-running',
    toolName: 'Bash',
    argSummary: 'sleep 100',
    seq: n,
    ts: T0 + n,
  });
  entries.push({
    kind: 'permission',
    id: 'perm-1',
    toolName: 'Write',
    input: { file_path: '/tmp/a' },
    state: 'pending',
    requestedAt: T0,
    seq: n + 1,
    ts: T0 + n + 1,
  });
  return entries;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/**
 * 挂载 Timeline，返回「渲染一帧 → 本帧各条目的渲染次数」的驱动器。
 *
 * `onEntryRender` 必须是**跨帧稳定的同一个函数**——它自己就是 `Entry` 的一个
 * prop，每帧换新引用的话 memo 一样会被打穿，测出来的就全是这个钩子的锅。
 * 所以捕获一个固定闭包，写进当帧的 map（`current`）里。
 */
function mount(
  entries: TimelineEntry[],
  opts: { runningToolId?: string | null } = {},
): (props: { now: number; runningElapsedMs: number }) => Map<string, number> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  let current = new Map<string, number>();
  const onEntryRender = (id: string): void => void current.set(id, (current.get(id) ?? 0) + 1);
  return ({ now, runningElapsedMs }) => {
    current = new Map<string, number>();
    act(() => {
      root?.render(
        <Timeline
          entries={entries}
          syncing={undefined}
          deviceId="web-1"
          now={now}
          runningToolId={opts.runningToolId === undefined ? 'tool-running' : opts.runningToolId}
          runningElapsedMs={runningElapsedMs}
          handlers={handlers}
          onEntryRender={onEntryRender}
        />,
      );
    });
    return current;
  };
}

describe('Timeline 重渲染计数（N4）', () => {
  test('500 条时间线：一次 tick 只重画走秒的那两条', () => {
    const entries = makeEntries(500);
    const render = mount(entries);

    // 首帧：全部 502 条都画一次，这是应该的
    const first = render({ now: T0 + 1_000, runningElapsedMs: 1_000 });
    expect(first.size).toBe(502);

    // 下一秒的 tick：now 与 runningElapsedMs 都变了
    const second = render({ now: T0 + 2_000, runningElapsedMs: 2_000 });

    // 只有「运行中的工具卡」与「pending 权限卡」重画——
    // 500 条 assistant 全被 memo 挡住
    expect([...second.keys()].sort()).toEqual(['permission:perm-1', 'tool:tool-running']);
    expect(second.size).toBeLessThanOrEqual(2);
  });

  test('没有工具在跑时，tick 只重画权限卡', () => {
    const render = mount(makeEntries(50), { runningToolId: null });
    expect(render({ now: T0 + 1_000, runningElapsedMs: 0 }).size).toBe(52);
    expect([...render({ now: T0 + 2_000, runningElapsedMs: 0 }).keys()]).toEqual(['permission:perm-1']);
  });

  test('条目内容真变了还是要重画（memo 没把正确更新一并挡掉）', () => {
    const entries = makeEntries(3);
    const render = mount(entries);
    render({ now: T0, runningElapsedMs: 0 });
    // 改一条 assistant 的文本（流式追加就是这个形状：新对象换进数组）
    entries[1] = { ...(entries[1] as TimelineEntry & { kind: 'assistant' }), text: '改过了' };
    const after = render({ now: T0, runningElapsedMs: 0 });
    expect([...after.keys()]).toContain('assistant:a-1');
  });
});

describe('Timeline · 自发轮标记', () => {
  test('run.state running 带 detail → 一行「⟳ …，Claude 继续」；不带 detail 的 running 不画', () => {
    const entries: TimelineEntry[] = [
      { kind: 'run_state', id: 'rs-1', state: 'running', seq: 1, ts: T0 },
      { kind: 'run_state', id: 'rs-2', state: 'running', detail: '后台任务“跑测试”已完成', seq: 2, ts: T0 + 1 },
      { kind: 'assistant', id: 'a-1', text: '测试都过了', done: true, thinking: false, seq: 3, ts: T0 + 2 },
    ];
    const render = mount(entries, { runningToolId: null });
    render({ now: T0, runningElapsedMs: 0 });
    const notes = Array.from(host!.querySelectorAll('[data-testid="entry-run-trigger"]'));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toBe('⟳ 后台任务“跑测试”已完成，Claude 继续');
    expect(host!.querySelectorAll('[data-testid="entry-run-state"]')).toHaveLength(0);
  });
});

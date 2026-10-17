/**
 * BgTaskBar 渲染：行 / 状态文案 / 停止按钮的版本门槛 / 全部结束后折叠。
 * 与其他 DOM 测试同款：先注册 happy-dom，再动态 import react-dom（见 learnings）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { BgTask } from '@trine/core';

await import('@/lib/dom-test-env.ts');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
type Root = ReturnType<typeof createRoot>;
const { BgTaskBar, collapsedLabel, statusText } = await import('./BgTaskBar.tsx');

const T0 = 1_700_000_000_000;
const task = (over: Partial<BgTask> = {}): BgTask => ({
  taskId: 'bd4zj554r',
  kind: 'bash',
  description: '在后台等待 25 秒',
  status: 'running',
  startedAt: T0,
  toolUseId: 'toolu_1',
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(props: { tasks: BgTask[]; now?: number; canStop?: boolean; onStop?: (id: string) => void; stale?: boolean }): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <BgTaskBar
        tasks={props.tasks}
        now={props.now ?? T0 + 12_000}
        canStop={props.canStop ?? true}
        onStop={props.onStop ?? (() => {})}
        {...(props.stale === undefined ? {} : { stale: props.stale })}
      />,
    );
  });
  return host;
}
const $ = (el: HTMLElement, id: string): HTMLElement | null => el.querySelector(`[data-testid="${id}"]`);
const $$ = (el: HTMLElement, id: string): HTMLElement[] => Array.from(el.querySelectorAll(`[data-testid="${id}"]`));

describe('BgTaskBar', () => {
  test('没有任务不渲染', () => {
    const el = mount({ tasks: [] });
    expect($(el, 'bgtask-bar')).toBeNull();
  });

  test('运行中：一行一个任务，时长按 now - startedAt 走秒，有停止按钮', () => {
    const stopped: string[] = [];
    const el = mount({ tasks: [task(), task({ taskId: 'ag', kind: 'agent', description: '子 agent', lastToolName: 'Bash', toolUses: 3 })], onStop: (id) => stopped.push(id) });
    const rows = $$(el, 'bgtask-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.dataset['status']).toBe('running');
    expect($(rows[0]!, 'bgtask-status')!.textContent).toBe('运行中 12s');
    expect($(rows[1]!, 'bgtask-status')!.textContent).toBe('运行中 12s · Bash ×3');
    const buttons = $$(el, 'bgtask-stop');
    expect(buttons).toHaveLength(2);
    act(() => buttons[1]!.click());
    expect(stopped).toEqual(['ag']);
    expect($(el, 'bgtask-bar')!.dataset['running']).toBe('2');
  });

  test('agent < 0.7.0（canStop=false）不显示停止按钮', () => {
    const el = mount({ tasks: [task()], canStop: false });
    expect($$(el, 'bgtask-stop')).toHaveLength(0);
    expect($$(el, 'bgtask-row')).toHaveLength(1);
  });

  test('全部结束后折成一行，点开可看每条的摘要，再点收起', () => {
    const el = mount({
      tasks: [
        task({ status: 'completed', endedAt: T0 + 5_000, summary: 'Background command "x" completed (exit code 0)' }),
        task({ taskId: 'f', status: 'failed', endedAt: T0 + 6_000 }),
        task({ taskId: 's', status: 'stopped', endedAt: T0 + 7_000 }),
      ],
    });
    const collapsed = $(el, 'bgtask-collapsed')!;
    expect(collapsed.textContent).toContain('后台任务 1 个已完成 · 1 个失败 · 1 个已停止');
    expect($$(el, 'bgtask-row')).toHaveLength(0);
    act(() => collapsed.click());
    const rows = $$(el, 'bgtask-row');
    expect(rows.map((r) => $(r, 'bgtask-status')!.textContent)).toEqual([
      '✓ Background command "x" completed (exit code 0)',
      '✗ 失败',
      '⊘ 已停止',
    ]);
    expect($$(el, 'bgtask-stop')).toHaveLength(0);
    act(() => $(el, 'bgtask-collapse')!.click());
    expect($$(el, 'bgtask-row')).toHaveLength(0);
  });

  test('statusText / collapsedLabel 纯函数口径', () => {
    expect(statusText(task(), T0 - 5_000)).toEqual({ text: '运行中 0s', tone: 'run' });
    expect(statusText(task({ status: 'completed' }), T0)).toEqual({ text: '✓ 完成', tone: 'ok' });
    expect(collapsedLabel([task({ status: 'completed' }), task({ status: 'completed' })])).toBe('后台任务 2 个已完成');
  });

  test('stale（评审 M2）：快照里的 running 显示成状态未知、不走秒、无停止按钮、条按全部结束折叠', () => {
    const el = mount({ tasks: [task(), task({ taskId: 'done', status: 'completed', endedAt: T0 + 1 })], stale: true });
    expect($(el, 'bgtask-bar')!.dataset['running']).toBe('0');
    expect($(el, 'bgtask-bar')!.dataset['stale']).toBe('true');
    const collapsed = $(el, 'bgtask-collapsed')!;
    expect(collapsed.textContent).toContain('1 个已完成 · 1 个状态未知');
    act(() => collapsed.click());
    const rows = $$(el, 'bgtask-row');
    expect($(rows[0]!, 'bgtask-status')!.textContent).toBe('? 状态未知（agent 已重启）');
    expect($$(el, 'bgtask-stop')).toHaveLength(0);
  });
});

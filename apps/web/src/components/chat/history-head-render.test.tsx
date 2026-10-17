/**
 * 时间线顶部的历史回看行：四种状态各自的渲染与按钮回调，且确实挂在时间线最顶部。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';
import type { TimelineEntry } from '@/lib/reducer.ts';
import { HistoryHead, type HistoryHeadState } from './Messages.tsx';
import { Timeline, type TimelineHandlers } from './Timeline.tsx';

const handlers: TimelineHandlers = {
  onUserAction: () => {},
  onRespondPermission: () => {},
  onResumeAt: () => {},
  onStop: () => {},
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(state: HistoryHeadState, calls: string[], entries: TimelineEntry[] = []): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <Timeline
        entries={entries}
        syncing={undefined}
        deviceId={null}
        now={0}
        runningToolId={null}
        runningElapsedMs={0}
        handlers={handlers}
        head={<HistoryHead state={state} onLoadMore={() => calls.push('more')} onRetry={() => calls.push('retry')} />}
      />,
    ),
  );
  return host;
}

describe('HistoryHead', () => {
  test('more：「加载更早」在时间线最顶部，点击回调', () => {
    const calls: string[] = [];
    const entries: TimelineEntry[] = [
      { kind: 'user', id: 'u1', text: '老消息', local: false, seq: 0, ts: 1 },
    ];
    const el = render({ kind: 'more' }, calls, entries);
    const list = el.querySelector('[data-testid="timeline"]')!;
    expect(list.firstElementChild?.querySelector('[data-testid="history-more"]')).not.toBeNull();
    act(() => (el.querySelector('[data-testid="history-more"]') as HTMLButtonElement).click());
    expect(calls).toEqual(['more']);
  });

  test('loading / error（带重试） / none', () => {
    const calls: string[] = [];
    let el = render({ kind: 'loading' }, calls);
    expect(el.querySelector('[data-testid="history-loading"]')?.textContent).toContain('正在加载本机历史');
    act(() => root?.unmount());
    host?.remove();

    el = render({ kind: 'error', message: '请求超时' }, calls);
    const err = el.querySelector('[data-testid="history-error"]')!;
    expect(err.textContent).toContain('请求超时');
    act(() => (err.querySelector('button') as HTMLButtonElement).click());
    expect(calls).toEqual(['retry']);
    act(() => root?.unmount());
    host?.remove();

    el = render({ kind: 'none' }, calls);
    expect(el.querySelector('[data-testid^="history-"]')).toBeNull();
  });
});

/**
 * 用量组件的渲染：会话头部 ctx / 5h / 1w、机器的 5h / 1w + 重置时间；没数据不渲染。
 * PlanUsageStrip / 刷新按钮依赖运行时（store + client），不在这里挂。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PlanUsageLine, SessionUsage } = await import('./PlanUsage.tsx');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: React.ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const now = new Date(2026, 9, 20, 13, 0).getTime();
const rateLimits = {
  fiveHour: { percent: 62, resetsAt: new Date(2026, 9, 20, 14, 39).getTime() },
  sevenDay: { percent: 96, resetsAt: new Date(2026, 9, 26, 3, 59).getTime() },
  updatedAt: now,
};

describe('SessionUsage', () => {
  test('ctx / 5h / 1w 百分比，不带重置时间', () => {
    const el = render(
      <SessionUsage context={{ usedTokens: 50_000, maxTokens: 200_000, percent: 25, at: 1 }} rateLimits={rateLimits} now={now} />,
    );
    expect(el.textContent).toBe('ctx 25%5h62%1w96%');
    expect(el.querySelector('[data-testid="session-context"]')?.getAttribute('title')).toBe('上下文 50k / 200k tokens');
    expect(el.querySelector('.text-red')?.textContent).toBe('96%');
  });

  test('只有限额没有 context 也显示；都没有不渲染', () => {
    expect(render(<SessionUsage context={undefined} rateLimits={rateLimits} now={now} />).textContent).toBe('5h62%1w96%');
    act(() => root?.unmount());
    expect(render(<SessionUsage context={undefined} rateLimits={undefined} now={now} />).innerHTML).toBe('');
  });
});

describe('PlanUsageLine', () => {
  test('带重置时间；重置时间已过显示「已重置」', () => {
    const el = render(<PlanUsageLine rateLimits={rateLimits} now={now} />);
    expect(el.textContent).toBe('5h62%14:39 重置1w96%周一 03:59 重置');
    act(() => root?.unmount());
    const later = render(<PlanUsageLine rateLimits={rateLimits} now={new Date(2026, 9, 20, 15, 0).getTime()} />);
    expect(later.textContent).toContain('5h—已重置');
  });

  test('没有数据不渲染', () => {
    expect(render(<PlanUsageLine rateLimits={undefined} now={now} />).innerHTML).toBe('');
  });
});

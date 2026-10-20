/**
 * 本地命令输出卡：/usage 画进度条、分组默认收起；其他命令等宽原样、长了先折起来。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { CommandOutputCard } = await import('./CommandOutputCard.tsx');

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

const USAGE = `You are on a subscription

Current session: 96% used · resets Oct 20, 2:39pm (Asia/Singapore)
Current week (all models): 16% used · resets Oct 26, 3:59am (Asia/Singapore)

Last 24h · 120 requests · 3 sessions
  80% of your usage was at >150k context`;

describe('CommandOutputCard', () => {
  test('/usage：进度条 + 告警色，分组点开才显示', () => {
    const el = render(<CommandOutputCard command="usage" text={USAGE} />);
    const windows = el.querySelectorAll('[data-testid="usage-window"]');
    expect(windows).toHaveLength(2);
    expect(windows[0]!.textContent).toContain('5 小时窗口96%');
    expect(windows[0]!.textContent).toContain('Oct 20, 2:39pm 重置');
    expect(windows[0]!.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('96');
    expect(windows[0]!.querySelector('.bg-red')).not.toBeNull();
    expect(windows[1]!.querySelector('.bg-brand')).not.toBeNull();

    expect(el.querySelector('[data-testid="usage-sections"]')).toBeNull();
    act(() => (el.querySelector('[data-testid="usage-sections-toggle"]') as HTMLElement).click());
    expect(el.querySelector('[data-testid="usage-sections"]')?.textContent).toContain('80% of your usage was at >150k context');
  });

  test('/usage 解析不了、其他命令：等宽原样，保住换行与缩进', () => {
    const el = render(<CommandOutputCard command="cost" text={'Total cost: $0.12\n  detail'} />);
    expect(el.querySelector('[data-testid="command-output-text"]')?.textContent).toBe('Total cost: $0.12\n  detail');
    expect(el.textContent).toContain('/cost');
    act(() => root?.unmount());
    const odd = render(<CommandOutputCard command="usage" text="Usage unavailable" />);
    expect(odd.querySelector('[data-testid="usage-report"]')).toBeNull();
    expect(odd.querySelector('[data-testid="command-output-text"]')?.textContent).toBe('Usage unavailable');
  });

  test('长输出先折起来，展开看全部；不知道命令名显示「本地命令」', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const el = render(<CommandOutputCard command="" text={text} />);
    expect(el.textContent).toContain('本地命令');
    expect(el.querySelector('[data-testid="command-output-text"]')?.textContent?.split('\n')).toHaveLength(16);
    act(() => (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('展开全部')) as HTMLElement).click());
    expect(el.querySelector('[data-testid="command-output-text"]')?.textContent).toBe(text);
  });
});

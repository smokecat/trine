/**
 * 用量组件的渲染：会话头部 ctx / 5h / 1w、机器的 5h / 1w + 重置时间；没数据不渲染。
 * PlanUsageStrip / 刷新按钮依赖运行时（store + client），不在这里挂。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MachineUsageRows, PlanUsageLine, SessionUsage, sessionModelWindows } = await import('./PlanUsage.tsx');

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
      <SessionUsage context={{ usedTokens: 50_000, maxTokens: 200_000, percent: 25, at: now }} rateLimits={rateLimits} now={now} />,
    );
    expect(el.textContent).toBe('ctx 25%5h62%1w96%');
    expect(el.querySelector('[data-testid="session-context"]')?.getAttribute('title')).toBe('上下文 50k / 200k tokens · 取于 刚刚');
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

describe('SessionUsage · 手动刷新 ctx', () => {
  test('给了 onRefreshContext：ctx 是按钮，没有值显示「—」；点击转圈，完成后恢复', async () => {
    let release!: () => void;
    let calls = 0;
    const el = render(
      <SessionUsage
        context={undefined}
        rateLimits={undefined}
        now={now}
        onRefreshContext={() => {
          calls += 1;
          return new Promise<void>((r) => (release = r));
        }}
      />,
    );
    const button = el.querySelector('button[data-testid="session-context"]') as HTMLButtonElement;
    expect(button.textContent).toBe('ctx —');
    expect(button.title).toContain('点击刷新');
    act(() => button.click());
    expect(calls).toBe(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('ctx …');
    await act(async () => release());
    expect(button.disabled).toBe(false);
  });

  test('不能刷新时 ctx 不是按钮', () => {
    const el = render(
      <SessionUsage context={{ usedTokens: 1, maxTokens: 10, percent: 10, at: now }} rateLimits={undefined} now={now} />,
    );
    expect(el.querySelector('button')).toBeNull();
    expect(el.querySelector('[data-testid="session-context"]')?.getAttribute('title')).toContain('取于 刚刚');
  });
});

describe('限额窗口：悬停提示与点击切换', () => {
  test('会话头部：5h / 1w 有详细提示，点击在百分比和倒计时之间切换', () => {
    const el = render(<SessionUsage context={undefined} rateLimits={rateLimits} now={now} />);
    const [five] = Array.from(el.querySelectorAll('button[data-testid="usage-window-value"]')) as HTMLButtonElement[];
    expect(five!.title).toBe('5h 已用 62% · 14:39 重置（还有 1 小时 39 分） · 数据更新于 刚刚 · 点击切换百分比 / 剩余时间');
    expect(five!.textContent).toBe('5h62%');
    act(() => five!.click());
    expect(five!.textContent).toBe('5h1h39m');
    act(() => five!.click());
    expect(five!.textContent).toBe('5h62%');
  });

  test('全局：可切换；interactive=false（机器卡）不是按钮但仍有提示', () => {
    const el = render(<PlanUsageLine rateLimits={rateLimits} now={now} />);
    const buttons = el.querySelectorAll('button[data-testid="usage-window-value"]');
    expect(buttons).toHaveLength(2);
    act(() => (buttons[1] as HTMLButtonElement).click());
    expect(buttons[1]!.textContent).toBe('1w5d14h周一 03:59 重置');
    act(() => root?.unmount());
    const card = render(<PlanUsageLine rateLimits={rateLimits} now={now} interactive={false} />);
    expect(card.querySelector('button')).toBeNull();
    expect(card.querySelector('[data-testid="usage-window-value"]')?.getAttribute('title')).toContain('5h 已用 62%');
  });

  test('没有重置时间的窗口点了也只显示百分比', () => {
    const el = render(<SessionUsage context={undefined} rateLimits={{ sevenDay: { percent: 16 }, updatedAt: now }} now={now} />);
    const button = el.querySelector('button[data-testid="usage-window-value"]') as HTMLButtonElement;
    act(() => button.click());
    expect(button.textContent).toBe('1w16%');
  });
});

describe('按模型的周限额（Fable）', () => {
  const withFable = { ...rateLimits, models: [{ name: 'Fable', percent: 40, resetsAt: new Date(2026, 9, 26, 3, 59).getTime() }] };

  test('PlanUsageLine 在 1w 后面显示，悬停写明是周限额', () => {
    const el = render(<PlanUsageLine rateLimits={withFable} now={now} />);
    expect(el.textContent).toBe('5h62%14:39 重置1w96%周一 03:59 重置Fable40%周一 03:59 重置');
    const values = el.querySelectorAll('[data-testid="usage-window-value"]');
    expect(values[2]!.getAttribute('title')).toContain('Fable 周限额 已用 40%');
  });

  test('只有按模型的窗口也渲染', () => {
    expect(render(<PlanUsageLine rateLimits={{ models: [{ name: 'Fable', percent: 3 }], updatedAt: now }} now={now} />).textContent).toBe('Fable3%');
  });

  test('会话头部只在会话用这个模型时显示', () => {
    expect(render(<SessionUsage context={undefined} rateLimits={withFable} model="claude-fable-5" now={now} />).textContent).toBe('5h62%1w96%Fable40%');
    act(() => root?.unmount());
    expect(render(<SessionUsage context={undefined} rateLimits={withFable} model="claude-opus-5-5" now={now} />).textContent).toBe('5h62%1w96%');
    expect(sessionModelWindows(withFable.models, undefined)).toEqual([]);
    expect(sessionModelWindows(withFable.models, 'fable')).toHaveLength(1);
  });
});

describe('MachineUsageRows', () => {
  const codex = {
    id: 'codex',
    displayName: 'Codex',
    available: true,
    capabilities: {},
    rateLimits: { windows: [{ id: 'w', durationMins: 10080, percent: 5 }], updatedAt: now },
  };
  const claude = { id: 'claude', displayName: 'Claude Code', available: true, capabilities: {} };

  test('每个引擎一行，行首图标 + 名字', () => {
    const el = render(<MachineUsageRows info={{ agentVersion: '0.25.0', rateLimits, engines: [claude, codex] }} now={now} />);
    const rows = Array.from(el.querySelectorAll('[data-testid="usage-row"]')) as HTMLElement[];
    expect(rows.map((r) => r.dataset['engine'])).toEqual(['claude', 'codex']);
    expect(rows[0]!.querySelector('[data-testid="usage-engine-label"]')!.textContent).toBe('Claude');
    expect(rows[0]!.querySelector('[data-engine-icon="claude"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-testid="usage-engine-label"]')!.textContent).toBe('Codex');
    expect(rows[1]!.querySelector('[data-engine-icon="codex"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-testid="engine-usage"]')!.textContent).toBe('1w5%');
  });

  test('Claude 还没有数据但支持刷新：给提示行；都没有不渲染', () => {
    const el = render(<MachineUsageRows info={{ agentVersion: '0.25.0', engines: [claude] }} now={now} />);
    expect(el.textContent).toBe('Claude暂无数据，会话活动后更新');
    act(() => root?.unmount());
    expect(render(<MachineUsageRows info={{ agentVersion: '0.11.0', engines: [claude] }} now={now} />).innerHTML).toBe('');
  });
});

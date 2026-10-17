/**
 * SessionList 的 DOM 行为：行「⋯」菜单（评审 M6）与工作空间分组折叠（M5）。
 *
 * 最要紧的一条：**点菜单项不触发导航**。Radix 菜单内容在 portal 里，但 React
 * 合成事件沿组件树冒泡——菜单若嵌在 NavLink 里，点「重命名」会冒到 NavLink
 * 的 onClick 把人带进聊天页。纯函数测不到这件事，只能真挂 DOM。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';
import type { SessionMeta, SessionState } from '@trine/core';
import type { MachineState } from '@/store/types.ts';

// react-dom（及引用它的 react-router）必须在 DOM 环境装好**之后**再加载：它在
// 模块初始化时探测 canUseDOM / `oninput` 支持，静态 import 会先于 dom-test-env
// 求值，退到旧式 polyfill 路径，受控 input 的 onChange 就不触发
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { createMemoryRouter, RouterProvider } = await import('react-router');
const { SessionList } = await import('./SessionList.tsx');
const { DEFAULT_LIST_QUERY, groupKey } = await import('./filtering.ts');
const { resetCollapsedGroupsForTest, setGroupCollapsed } = await import('./collapsed-groups.ts');
const { RENAME_INPUT_SOFT_MAX } = await import('./RenameDialog.tsx');
type Actions = import('./SessionRowMenu.tsx').SessionRowActions;
type Query = import('./filtering.ts').ListQuery;

function meta(over: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  return {
    title: '',
    state: 'idle' as SessionState,
    lastActivityAt: 1,
    cwd: '/home/me/repo',
    model: '',
    permissionMode: 'default',
    costUsd: 0,
    ...over,
  };
}

const machines = {
  m: { machineId: 'm', name: 'MBP', online: true, lastSeenAt: 1, parkedCount: 0 },
} as unknown as Record<string, MachineState>;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let router: ReturnType<typeof createMemoryRouter> | null = null;

function render(
  sessions: Record<string, Record<string, SessionMeta>>,
  opts: { actions?: Actions; query?: Partial<Query>; at?: '/' | '/archived' } = {},
): void {
  const query: Query = { ...DEFAULT_LIST_QUERY, groupBy: 'none', ...opts.query };
  const list = (
    <SessionList
      sessions={sessions}
      machines={machines}
      query={query}
      now={2}
      {...(opts.actions === undefined ? {} : { actions: opts.actions })}
    />
  );
  router = createMemoryRouter(
    [
      { path: '/', element: list },
      { path: '/archived', element: list },
      { path: '/s/:machineId/:sessionId', element: <div data-testid="chat-page" /> },
    ],
    { initialEntries: [opts.at ?? '/'] },
  );
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<RouterProvider router={router!} />));
}

function $(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}
function $$(testId: string): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
}

/** Radix 触发器在 pointerdown（左键、无 ctrl）时开合 */
function openMenu(trigger: HTMLElement): void {
  act(() => {
    trigger.dispatchEvent(
      new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }),
    );
  });
}

/**
 * 受控 input 改值：React 用 `_valueTracker` 判断值变没变，直接改 `.value`
 * 会同步更新 tracker、onChange 就不触发。先改值、再把 tracker 拨回旧值。
 */
function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const previous = input.value;
    input.value = value;
    (input as unknown as { _valueTracker?: { setValue(v: string): void } })._valueTracker?.setValue(previous);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function click(el: HTMLElement): void {
  act(() => el.click());
}

beforeEach(() => {
  resetCollapsedGroupsForTest();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  router = null;
  document.body.innerHTML = '';
});

describe('行「⋯」菜单（回调壳）', () => {
  test('没有注入任何回调时不渲染「⋯」', () => {
    render({ m: { a: meta({ sessionId: 'a' }) } });
    expect($$('session-row')).toHaveLength(1);
    expect($('session-row-menu')).toBeNull();
  });

  test('「⋯」是 NavLink 的兄弟而不是后代（不嵌在 <a> 里）', () => {
    render({ m: { a: meta({ sessionId: 'a' }) } }, { actions: { onRename: () => {} } });
    const button = $('session-row-menu')!;
    expect(button).not.toBeNull();
    expect(button.closest('a')).toBeNull();
    expect($('session-row-link')!.tagName).toBe('A');
  });

  test('点「重命名」不触发导航，打开共享对话框，提交调 onRename', () => {
    const onRename = mock((_m: string, _s: string, _t: string) => {});
    render({ m: { a: meta({ sessionId: 'a', title: '旧标题' }) } }, { actions: { onRename } });

    openMenu($('session-row-menu')!);
    const item = $('menu-rename');
    expect(item).not.toBeNull();
    click(item!);

    expect(router!.state.location.pathname).toBe('/');
    expect($('chat-page')).toBeNull();
    const dialog = $('rename-dialog');
    expect(dialog).not.toBeNull();

    const input = $('rename-dialog-input') as HTMLInputElement;
    expect(input.value).toBe('旧标题');
    typeInto(input, '  新标题  ');
    click($('rename-dialog-confirm')!);
    expect(onRename).toHaveBeenCalledWith('m', 'a', '新标题');
    expect(router!.state.location.pathname).toBe('/');
  });

  test('重命名输入软上限：误粘贴大段文本截到 400 码元；超过 200 码点提示由 agent 截断；200 个 emoji 不被截（S3）', () => {
    const onRename = mock((_m: string, _s: string, _t: string) => {});
    render({ m: { a: meta({ sessionId: 'a', title: '旧标题' }) } }, { actions: { onRename } });
    openMenu($('session-row-menu')!);
    click($('menu-rename')!);
    const input = $('rename-dialog-input') as HTMLInputElement;
    expect(input.maxLength).toBe(RENAME_INPUT_SOFT_MAX);

    const emoji = '😀'.repeat(200);
    typeInto(input, emoji);
    expect(input.value).toBe(emoji);
    expect($('rename-dialog-too-long')).toBeNull();

    typeInto(input, 'x'.repeat(5_000));
    expect(input.value).toHaveLength(RENAME_INPUT_SOFT_MAX);
    expect($('rename-dialog-too-long')).not.toBeNull();
    click($('rename-dialog-confirm')!);
    expect(onRename).toHaveBeenCalledWith('m', 'a', 'x'.repeat(RENAME_INPUT_SOFT_MAX));
  });

  test('supports 逐机器判（新旧 agent 混排）：旧 agent 的行不出「⋯」', () => {
    render(
      { m: { a: meta({ sessionId: 'a' }) }, old: { b: meta({ sessionId: 'b' }) } },
      { actions: { supports: (id) => id === 'm', onRename: () => {}, onArchive: () => {} } },
    );
    expect($$('session-row')).toHaveLength(2);
    expect($$('session-row-menu')).toHaveLength(1);
  });

  test('点卡片本身照常导航', () => {
    render({ m: { a: meta({ sessionId: 'a' }) } }, { actions: { onRename: () => {} } });
    click($('session-row-link')!);
    expect(router!.state.location.pathname).toBe('/s/m/a');
    expect(router!.state.location.state).toBeNull();
  });

  test('从归档视图点进会话：location.state 带来源，聊天页据此返回 /archived（评审 minor 9）', () => {
    render({ m: { a: meta({ sessionId: 'a', archived: true }) } }, { at: '/archived', query: { archived: true } });
    click($('session-row-link')!);
    expect(router!.state.location.pathname).toBe('/s/m/a');
    expect(router!.state.location.state).toEqual({ from: '/archived' });
  });

  test('未归档行：只有「归档」；运行中灰显但仍可点（以 agent 应答为准）', () => {
    const onArchive = mock((_m: string, _s: string, _a: boolean) => {});
    render(
      { m: { a: meta({ sessionId: 'a', state: 'running' }) } },
      { actions: { onArchive, onDelete: () => {} } },
    );
    openMenu($('session-row-menu')!);
    expect($('menu-unarchive')).toBeNull();
    expect($('menu-delete')).toBeNull();
    const archive = $('menu-archive')!;
    expect(archive.dataset['likelyBusy']).toBe('true');
    click(archive);
    expect(onArchive).toHaveBeenCalledWith('m', 'a', true);
    expect(router!.state.location.pathname).toBe('/');
  });

  test('归档视图：取消归档 + 永久删除（两击确认）', () => {
    const onArchive = mock((_m: string, _s: string, _a: boolean) => {});
    const onDelete = mock((_m: string, _s: string) => {});
    render(
      { m: { a: meta({ sessionId: 'a', archived: true }) } },
      { actions: { onArchive, onDelete }, query: { archived: true } },
    );
    openMenu($('session-row-menu')!);
    expect($('menu-archive')).toBeNull();
    click($('menu-delete')!);
    // 第一击只开确认框
    expect(onDelete).not.toHaveBeenCalled();
    expect($('confirm-delete-session')).not.toBeNull();
    click($('confirm-delete-session-confirm')!);
    expect(onDelete).toHaveBeenCalledWith('m', 'a');
    expect(router!.state.location.pathname).toBe('/');

    openMenu($('session-row-menu')!);
    click($('menu-unarchive')!);
    expect(onArchive).toHaveBeenCalledWith('m', 'a', false);
  });
});

describe('工作空间分组', () => {
  const sessions = {
    m: {
      a: meta({ sessionId: 'a', cwd: '/w/one', state: 'running', lastActivityAt: 5 }),
      b: meta({ sessionId: 'b', cwd: '/w/two', lastActivityAt: 9 }),
      c: meta({ sessionId: 'c', cwd: '', lastActivityAt: 1 }),
    },
  };

  test('按 cwd 分组；空 cwd 显示「未知目录」', () => {
    render(sessions, { query: { groupBy: 'workspace' } });
    const groups = $$('session-group');
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.textContent)).toEqual([
      expect.stringContaining('one'),
      expect.stringContaining('two'),
      expect.stringContaining('未知目录'),
    ]);
  });

  test('点组头折叠，折叠后显示运行中角标', () => {
    render(sessions, { query: { groupBy: 'workspace' } });
    const header = $$('session-group-header')[0]!;
    click(header);
    const first = $$('session-group')[0]!;
    expect(first.dataset['expanded']).toBe('false');
    expect(first.querySelectorAll('[data-testid="session-row"]')).toHaveLength(0);
    expect(first.querySelector('[data-testid="session-group-badges"]')?.textContent).toContain('🔧1');
  });

  test('会话行的等待 pill 按 meta.waitingFor 区分；没有该字段（旧 agent）按普通权限', () => {
    render({
      m: {
        q: meta({ sessionId: 'q', state: 'waiting_permission', waitingFor: 'question' }),
        p: meta({ sessionId: 'p', state: 'waiting_permission', waitingFor: 'plan' }),
        o: meta({ sessionId: 'o', state: 'waiting_permission' }),
      },
    });
    const pill = (sid: string) =>
      $$('session-row').find((r) => r.dataset['sessionId'] === sid)?.querySelector('[data-testid="state-pill"]')?.textContent;
    expect(pill('q')).toBe('等待回答');
    expect(pill('p')).toBe('等待批准计划');
    expect(pill('o')).toBe('等待批准');
  });

  test('会话行：空闲但有后台任务在跑 → 「后台 N」弱提示；运行中 / 旧 agent 不显示', () => {
    render({
      m: {
        a: meta({ sessionId: 'a', state: 'idle', bgRunning: 2 }),
        b: meta({ sessionId: 'b', state: 'running', bgRunning: 1 }),
        c: meta({ sessionId: 'c', state: 'idle' }),
      },
    });
    const badge = (sid: string) =>
      $$('session-row').find((r) => r.dataset['sessionId'] === sid)?.querySelector('[data-testid="bg-running-badge"]')?.textContent;
    expect(badge('a')).toBe('后台 2');
    expect(badge('b')).toBeUndefined();
    expect(badge('c')).toBeUndefined();
  });

    test('有待批准的组即便被折叠过也强制展开', () => {
    setGroupCollapsed(groupKey('m', '/w/wait'), true);
    render(
      { m: { w: meta({ sessionId: 'w', cwd: '/w/wait', state: 'waiting_permission' }) } },
      { query: { groupBy: 'workspace' } },
    );
    const group = $$('session-group')[0]!;
    expect(group.dataset['expanded']).toBe('true');
    click($$('session-group-header')[0]!);
    expect($$('session-group')[0]!.dataset['expanded']).toBe('true');
    expect($$('session-row')).toHaveLength(1);
  });

  test('搜索 / 状态筛选中：折叠过的组一律展开且点组头不收；清掉筛选后恢复折叠（评审 minor 3）', () => {
    setGroupCollapsed(groupKey('m', '/w/two'), true);
    render(sessions, { query: { groupBy: 'workspace', search: 'b' } });
    const two = () => $$('session-group').find((g) => g.dataset['groupKey'] === groupKey('m', '/w/two'))!;
    expect(two().dataset['expanded']).toBe('true');
    click(two().querySelector<HTMLElement>('[data-testid="session-group-header"]')!);
    expect(two().dataset['expanded']).toBe('true');
    act(() => root!.unmount());
    host!.remove();
    render(sessions, { query: { groupBy: 'workspace', status: 'idle' } });
    expect(two().dataset['expanded']).toBe('true');
    act(() => root!.unmount());
    host!.remove();
    render(sessions, { query: { groupBy: 'workspace' } });
    expect(two().dataset['expanded']).toBe('false');
  });

  test('空态按原因给文案', () => {
    render({ m: { a: meta({ sessionId: 'a', archived: true }) } });
    expect($('session-list-empty')!.dataset['reason']).toBe('all-archived');
  });
});

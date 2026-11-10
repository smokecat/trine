/**
 * 新建会话的一次性预选 intent（plan §3）：`?new=1&nm=&ncwd=` 每次打开时消费、覆盖上次选择；
 * 指定机器离线 / 不存在时说明原因，不静默换机器；关闭时清掉这几个参数，保留其他查询与 location.state。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { createMemoryRouter, RouterProvider } = await import('react-router');
const { runtimeState, store } = await import('@/app/runtime.ts');
const { NewSessionSheetRoute, nextNewSessionParams, readNewSessionIntent } = await import('./new-session-route.tsx');
const { resolveNewSessionIntent } = await import('./NewSessionSheet.tsx');

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let router: ReturnType<typeof createMemoryRouter> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  router = null;
  act(() => runtimeState.setState({ client: null }));
});

function machine(id: string, online: boolean) {
  return {
    machineId: id,
    name: id.toUpperCase(),
    online,
    lastSeenAt: 1,
    parkedCount: 0,
    info: { name: id.toUpperCase() },
    cwd: { favorites: [`/repo/${id}`], defaultCwd: `/repo/${id}` },
    lastError: null,
    stats: null,
    statsHistory: [],
  };
}

const stubClient = {
  on: () => () => {},
  request: () => Promise.resolve({ type: 'cwd.list.response' }),
  send: () => true,
  extRequest: async () => ({ type: 'ext.catalog.response', rev: 'r1', items: [] }),
};

function setup(entry: { search: string; state?: unknown }, online: { a: boolean; b: boolean } = { a: true, b: true }): void {
  act(() => {
    runtimeState.setState({ client: stubClient as never });
    store.setState({
      machines: { a: machine('a', online.a), b: machine('b', online.b) } as never,
      sessions: {},
    });
  });
  router = createMemoryRouter([{ path: '/', element: <NewSessionSheetRoute /> }], {
    initialEntries: [{ pathname: '/', search: entry.search, state: entry.state ?? null }],
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<RouterProvider router={router!} />));
}

const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const selectedMachine = () =>
  document.querySelector<HTMLElement>('[data-testid="ns-machine"][data-selected="true"]')?.dataset.machineId ?? null;
const selectedCwd = () =>
  document.querySelector<HTMLElement>('[data-testid="cwd-pick"][data-selected="true"]')?.textContent ?? null;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}

describe('intent 参数', () => {
  test('读取：要求 new=1 且有 nm', () => {
    expect(readNewSessionIntent(new URLSearchParams('new=1&nm=a&ncwd=/x'))).toEqual({ machineId: 'a', cwd: '/x' });
    expect(readNewSessionIntent(new URLSearchParams('nm=a&ncwd=/x'))).toBeNull();
    expect(readNewSessionIntent(new URLSearchParams('new=1'))).toBeNull();
  });

  test('打开写 intent、不带 intent 打开清掉旧的、关闭全清；其他参数保留', () => {
    const base = new URLSearchParams('file=/a.md&new=1&nm=old&ncwd=/old');
    expect(nextNewSessionParams(base, true, { machineId: 'm', cwd: '/p q' }).toString()).toBe(
      new URLSearchParams({ file: '/a.md', new: '1', nm: 'm', ncwd: '/p q' }).toString(),
    );
    expect(nextNewSessionParams(base, true).toString()).toBe('file=%2Fa.md&new=1');
    expect(nextNewSessionParams(base, false).toString()).toBe('file=%2Fa.md');
  });

  test('解析：机器不存在 → missing，不选机器', () => {
    expect(resolveNewSessionIntent({ machineId: 'x', cwd: '/p' }, { a: {} })).toEqual({ machineId: '', cwd: '', missing: true });
    expect(resolveNewSessionIntent({ machineId: 'a', cwd: '/p' }, { a: {} })).toEqual({ machineId: 'a', cwd: '/p', missing: false });
  });
});

describe('NewSessionSheet 消费 intent', () => {
  test('预选机器 + 目录；取消后清掉参数，保留其他查询与 location.state', async () => {
    setup({ search: '?keep=1&new=1&nm=b&ncwd=/repo/b', state: { fileDepth: 2 } });
    await flush();
    expect(selectedMachine()).toBe('b');
    expect(selectedCwd()).toBe('/repo/b');
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="new-session-sheet"] button')].find(
      (b) => b.textContent === '取消',
    )!;
    act(() => cancel.click());
    await flush();
    expect(router!.state.location.search).toBe('?keep=1');
    expect(router!.state.location.state).toEqual({ fileDepth: 2 });
    expect($('new-session-sheet')).toBeNull();
  });

  test('再次打开时用新的 intent 覆盖上次选择', async () => {
    setup({ search: '?new=1&nm=b&ncwd=/repo/b' });
    await flush();
    expect(selectedMachine()).toBe('b');
    await act(async () => router!.navigate('/'));
    await act(async () => router!.navigate('/?new=1&nm=a&ncwd=/elsewhere'));
    await flush();
    expect(selectedMachine()).toBe('a');
    expect($('cwd-custom')?.textContent).toContain('/elsewhere');
  });

  test('指定的机器离线：照选它并提示离线，不换成在线的机器', async () => {
    setup({ search: '?new=1&nm=b&ncwd=/repo/b' }, { a: true, b: false });
    await flush();
    expect(selectedMachine()).toBe('b');
    expect($('ns-offline')).not.toBeNull();
    expect(($('ns-create') as HTMLButtonElement).disabled).toBe(true);
  });

  test('指定的机器不存在：说明原因，不自动选别的机器', async () => {
    setup({ search: '?new=1&nm=gone&ncwd=/repo/x' });
    await flush();
    expect(selectedMachine()).toBeNull();
    expect($('ns-intent-missing')).not.toBeNull();
    expect(($('ns-create') as HTMLButtonElement).disabled).toBe(true);
    // 手动选一台后提示消失
    act(() => document.querySelector<HTMLElement>('[data-testid="ns-machine"][data-machine-id="a"]')!.click());
    await flush();
    expect(selectedMachine()).toBe('a');
    expect($('ns-intent-missing')).toBeNull();
  });

  test('无效机器 intent → 关闭 → 普通打开：照常默认选机器', async () => {
    setup({ search: '?new=1&nm=gone&ncwd=/repo/x' });
    await flush();
    expect(selectedMachine()).toBeNull();
    await act(async () => router!.navigate('/'));
    await flush();
    await act(async () => router!.navigate('/?new=1'));
    await flush();
    expect($('ns-intent-missing')).toBeNull();
    expect(selectedMachine()).toBe('a');
    expect(($('ns-create') as HTMLButtonElement).disabled).toBe(false);
  });

  test('没有常用目录但 intent 预填了目录：不再提示「还没有常用目录…」', async () => {
    setup({ search: '?new=1&nm=b&ncwd=/repo/elsewhere' });
    act(() => {
      store.setState((s) => ({
        machines: { ...s.machines, b: { ...s.machines['b']!, cwd: { favorites: [], defaultCwd: '/repo/b' } } } as never,
      }));
    });
    await flush();
    expect($('cwd-custom')?.textContent).toContain('/repo/elsewhere');
    expect($('cwd-empty-hint')).toBeNull();
  });

  test('不带 intent 打开：沿用默认（在线优先的第一台）', async () => {
    setup({ search: '?new=1' }, { a: false, b: true });
    await flush();
    expect(selectedMachine()).toBe('b');
  });
});

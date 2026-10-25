/**
 * 文件面板的历史导航：从关着打开 → 关闭退回打开前；深链进来再跳转 → 关闭就地清参数（不重新打开）。
 */
import { afterEach, describe, expect, test } from 'bun:test';

await import('@/lib/dom-test-env.ts');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter, useLocation } = await import('react-router');
const { useFilePanelRoute } = await import('./use-file-panel.ts');

type Api = ReturnType<typeof useFilePanelRoute> & { search: string };
let api: Api | null = null;
function Probe(): null {
  const route = useFilePanelRoute();
  api = { ...route, search: useLocation().search };
  return null;
}

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  api = null;
});

function mount(initial: string): void {
  const host = document.createElement('div');
  root = createRoot(host);
  act(() =>
    root?.render(
      <MemoryRouter initialEntries={[initial]}>
        <Probe />
      </MemoryRouter>,
    ),
  );
}

describe('useFilePanelRoute', () => {
  test('从关着打开、面板内跳两次，关闭一次退回打开前', () => {
    mount('/s/m/s1');
    act(() => api!.open({ kind: 'file', path: 'docs/a.md' }));
    act(() => api!.open({ kind: 'dir', path: '/w/docs' }));
    act(() => api!.open({ kind: 'file', path: '/w/docs/b.md' }));
    expect(api!.view).toEqual({ kind: 'file', path: '/w/docs/b.md' });
    act(() => api!.close());
    expect(api!.view).toBeNull();
    expect(api!.search).toBe('');
  });

  test('深链进来再跳转：关闭不会退回仍带面板的起点', () => {
    mount('/s/m/s1?file=%2Fw%2Fa.md');
    expect(api!.view).toEqual({ kind: 'file', path: '/w/a.md' });
    act(() => api!.open({ kind: 'dir', path: '/w' }));
    act(() => api!.close());
    expect(api!.view).toBeNull();
    expect(api!.search).toBe('');
  });
});

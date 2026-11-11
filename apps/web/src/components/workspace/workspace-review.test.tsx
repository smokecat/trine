/**
 * 评审修复的组合场景（不起 dockview）：
 * - 首次测量与深链 effect：窄窗口首次进入不消费 `?file=`，变宽后才转成 tab；
 * - 抽屉交接到已有 tab：应用交接状态并让正文重挂；
 * - 分栏布局的聚合最小宽度参与窄屏判断；
 * - 窄屏抽屉（Peek）：源码 / 换行切换与工作区共用状态并即时更新；正文链接就地导航（不叠抽屉、不写历史）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { FsFile } from '@trine/core';
import type { OpenedFile } from '@/lib/client.ts';
import type { DockHandle, OpenRequest, TabMeta, WorkspaceSnapshot } from './workspace-model.ts';
import type { WorkspaceController } from './use-workspace.ts';
import type { KvLike } from './workspace-store.ts';

await import('@/lib/dom-test-env.ts');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter, useLocation } = await import('react-router');
const { runtimeState } = await import('@/app/runtime.ts');
const { useWorkspace } = await import('./use-workspace.ts');
const { WorkspaceStore, WorkspaceViewStore, workspaceKey } = await import('./workspace-store.ts');
const { useDrawerHandoff, useWorkspaceDeepLink } = await import('./use-drawer-handoff.ts');
const { WorkspacePeek } = await import('./WorkspacePeek.tsx');
const { useFilePanelRoute } = await import('@/components/files/use-file-panel.ts');

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => runtimeState.setState({ client: null }));
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await act(() => new Promise<void>((r) => setTimeout(r, 0)));
};

function memoryKv(): KvLike {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

function snap(tabs: TabMeta[], layout: unknown = null): WorkspaceSnapshot {
  return { v: 1, layout: layout as never, tabs, view: {}, active: tabs[0]?.id, collapsed: false };
}

/** 假句柄：记录打开请求；已开的同一 id 返回 activated */
function fakeHandle(initial: TabMeta[] = []): DockHandle & { opened: OpenRequest[] } {
  const tabs = [...initial];
  const opened: OpenRequest[] = [];
  return {
    opened,
    api: {} as never,
    ctx: {} as never,
    open(req) {
      opened.push(req);
      const id = req.kind === 'file' ? `file:${req.path}` : 'dir:1';
      if (tabs.some((t) => t.id === id)) return { kind: 'activated', id };
      tabs.push({ id, kind: req.kind, path: req.path, preview: false });
      return { kind: 'opened', id };
    },
    snapshot: (collapsed) => ({ v: 1, layout: null, tabs: [...tabs], view: {}, active: tabs.at(-1)?.id, collapsed }),
    resetLayout() {},
    closeAll() {},
    focus: () => false,
  };
}

describe('首次测量 × 深链', () => {
  test('窄窗口首次进入：测量前、测量为窄时都不消费 ?file；变宽后才转成 tab 并去掉参数', () => {
    const store = new WorkspaceStore(memoryKv());
    store.save(workspaceKey('m', '/w'), snap([{ id: 'file:/w/b.md', kind: 'file', path: '/w/b.md', preview: false }]));
    let ws: WorkspaceController | null = null;
    let search = '';
    const created: string[] = [];
    function H(): null {
      ws = useWorkspace({ machineId: 'm', sessionId: 's1', cwd: '/w', enabled: true, store });
      const panel = useFilePanelRoute();
      const loc = useLocation();
      search = loc.search;
      const handoff = useDrawerHandoff((h) => created.push(h.intent.dir === true ? 'dir' : h.intent.path));
      const fromClosed = (loc.state as { fileFromClosed?: unknown } | null)?.fileFromClosed === true;
      useWorkspaceDeepLink(ws.shown, panel.view, fromClosed, handoff);
      return null;
    }
    root = createRoot(document.createElement('div'));
    act(() =>
      root!.render(
        <MemoryRouter initialEntries={['/s/m/s1?file=%2Fw%2Fa.md']}>
          <H />
        </MemoryRouter>,
      ),
    );
    // 还没测量：工作区虽是展开状态，也不能当成「显示着」
    expect(search).toBe('?file=%2Fw%2Fa.md');
    act(() => ws!.setMainWidth(700));
    expect(ws!.narrow).toBe(true);
    expect(search).toBe('?file=%2Fw%2Fa.md');
    expect(created).toEqual([]);
    act(() => ws!.setMainWidth(1400));
    expect(search).toBe('');
    expect(created).toEqual(['/w/a.md']);
  });
});

describe('控制器', () => {
  function harness(store: InstanceType<typeof WorkspaceStore>): { readonly ws: WorkspaceController } {
    let ws: WorkspaceController | null = null;
    function H(): null {
      ws = useWorkspace({ machineId: 'm', sessionId: 's1', cwd: '/w', enabled: true, store });
      return null;
    }
    root = createRoot(document.createElement('div'));
    act(() => root!.render(<H />));
    return {
      get ws() {
        return ws!;
      },
    };
  }

  test('抽屉交接到已打开的 tab：应用交接来的状态，并请求正文重挂', () => {
    const store = new WorkspaceStore(memoryKv());
    const tab: TabMeta = { id: 'file:/w/a.md', kind: 'file', path: '/w/a.md', preview: false };
    store.save(workspaceKey('m', '/w'), snap([tab]));
    const h = harness(store);
    act(() => h.ws.dock!.onReady(fakeHandle([tab]), 'restored'));
    act(() => h.ws.view.set(tab.id, { scrollTop: 10 }));
    act(() => h.ws.openWithState({ path: '/w/a.md', target: 'side' }, { scrollTop: 380, mode: 'source' }));
    expect(h.ws.view.get(tab.id)).toEqual({ scrollTop: 380, mode: 'source' });
    expect(h.ws.view.mount(tab.id)).toBeDefined();
  });

  test('关掉全部 tab 后：多组布局的最小宽度复位为单组，窄一些的主区也能再开工作区', () => {
    const store = new WorkspaceStore(memoryKv());
    const leaf = (id: string, v: string) => ({ type: 'leaf', data: { id, views: [v], activeView: v } });
    const tabs: TabMeta[] = ['a', 'b', 'c', 'd'].map((n) => ({ id: `file:/w/${n}.md`, kind: 'file', path: `/w/${n}.md`, preview: false }));
    const layout = {
      grid: { root: { type: 'branch', data: tabs.map((t, i) => leaf(String(i + 1), t.id)) }, width: 900, height: 600, orientation: 'HORIZONTAL' },
      panels: Object.fromEntries(tabs.map((t) => [t.id, { id: t.id, contentComponent: 'file', params: { kind: 'file', path: t.path, preview: false } }])),
    };
    store.save(workspaceKey('m', '/w'), snap(tabs, layout));
    const h = harness(store);
    expect(h.ws.minWidth).toBe(880);
    // dockview 就绪后用户关掉了所有 tab
    const empty: DockHandle = { ...fakeHandle(), snapshot: (collapsed) => ({ v: 1, layout: null, tabs: [], view: {}, collapsed }) };
    act(() => h.ws.dock!.onReady(empty, 'restored'));
    expect(h.ws.status).toBe('absent');
    expect(h.ws.minWidth).toBe(360);
    act(() => h.ws.setMainWidth(1100));
    expect(h.ws.narrow).toBe(false);
    expect(h.ws.route).not.toBeNull();
  });

  test('重置布局（丢弃布局）后最小宽度同样回到单组', () => {
    const store = new WorkspaceStore(memoryKv());
    const leaf = (id: string, v: string) => ({ type: 'leaf', data: { id, views: [v], activeView: v } });
    const tabs: TabMeta[] = ['a', 'b', 'c'].map((n) => ({ id: `file:/w/${n}.md`, kind: 'file', path: `/w/${n}.md`, preview: false }));
    const layout = {
      grid: { root: { type: 'branch', data: tabs.map((t, i) => leaf(String(i + 1), t.id)) }, width: 900, height: 600, orientation: 'HORIZONTAL' },
      panels: Object.fromEntries(tabs.map((t) => [t.id, { id: t.id, contentComponent: 'file', params: { kind: 'file', path: t.path, preview: false } }])),
    };
    store.save(workspaceKey('m', '/w'), snap(tabs, layout));
    const h = harness(store);
    expect(h.ws.minWidth).toBe(660);
    act(() => h.ws.resetLayout());
    expect(h.ws.minWidth).toBe(360);
  });

  test('分栏布局的聚合最小宽度参与窄屏判断与最小宽度', () => {
    const store = new WorkspaceStore(memoryKv());
    const leaf = (id: string, v: string) => ({ type: 'leaf', data: { id, views: [v], activeView: v } });
    const tabs: TabMeta[] = ['a', 'b', 'c'].map((n) => ({ id: `file:/w/${n}.md`, kind: 'file', path: `/w/${n}.md`, preview: false }));
    const layout = {
      grid: { root: { type: 'branch', data: tabs.map((t, i) => leaf(String(i + 1), t.id)) }, width: 900, height: 600, orientation: 'HORIZONTAL' },
      panels: Object.fromEntries(tabs.map((t) => [t.id, { id: t.id, contentComponent: 'file', params: { kind: 'file', path: t.path, preview: false } }])),
    };
    store.save(workspaceKey('m', '/w'), snap(tabs, layout));
    const h = harness(store);
    expect(h.ws.minWidth).toBe(660);
    // 只按 360 的固定最小宽，1100 是放得下的；三组并排放不下
    act(() => h.ws.setMainWidth(1100));
    expect(h.ws.narrow).toBe(true);
    act(() => h.ws.setMainWidth(1200));
    expect(h.ws.narrow).toBe(false);
  });
});

function fsFile(path: string, kind: 'text' | 'markdown', content: string): OpenedFile {
  const f: FsFile = {
    path,
    root: '/w',
    name: path.slice(path.lastIndexOf('/') + 1),
    size: new TextEncoder().encode(content).length,
    mtime: 1,
    mime: kind === 'markdown' ? 'text/markdown' : 'text/plain',
    kind,
    blobId: 'b'.repeat(22),
    key: 'k'.repeat(43),
  };
  return { file: f, blob: new Blob([content]), url: `blob:test/${path}` };
}

describe('抽屉交接抓取此刻的滚动', () => {
  test('滚完立即点「在工作区打开」：拿到的是当前位置（不等防抖上报），且不再带锚点', async () => {
    const { FilePanel } = await import('@/components/files/FilePanel.tsx');
    const client = {
      on: () => () => {},
      openFile: async () => fsFile('/w/notes.txt', 'text', Array.from({ length: 200 }, (_, i) => `行 ${i}`).join('\n')),
    };
    act(() => runtimeState.setState({ client: client as never }));
    const handoffs: unknown[] = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <MemoryRouter initialEntries={['/s/m/s1']}>
          <FilePanel
            machineId="m"
            sessionId="s1"
            view={{ kind: 'file', path: '/w/notes.txt', fragment: '某节' }}
            onNavigate={() => {}}
            onClose={() => {}}
            onHandoff={(h) => handoffs.push(h)}
          />
        </MemoryRouter>,
      ),
    );
    await settle();
    const scroller = document.querySelector<HTMLElement>('[data-testid="file-panel"] [data-testid="file-scroll"]')!;
    act(() => {
      scroller.scrollTop = 380;
      scroller.dispatchEvent(new window.Event('scroll'));
    });
    act(() => document.querySelector<HTMLElement>('[data-testid="file-to-workspace"]')!.click());
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ view: { kind: 'file', path: '/w/notes.txt' }, state: { scrollTop: 380 } });
    expect((handoffs[0] as { view: { fragment?: string } }).view.fragment).toBeUndefined();
  });
});

describe('抽屉交接与锚点', () => {
  async function mountDrawer(openFile: () => Promise<OpenedFile>, fragment: string): Promise<unknown[]> {
    const { FilePanel } = await import('@/components/files/FilePanel.tsx');
    act(() => runtimeState.setState({ client: { on: () => () => {}, openFile } as never }));
    const handoffs: unknown[] = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <MemoryRouter initialEntries={['/s/m/s1']}>
          <FilePanel machineId="m" sessionId="s1" view={{ kind: 'file', path: '/w/a.md', fragment }} onNavigate={() => {}} onClose={() => {}} onHandoff={(h) => handoffs.push(h)} />
        </MemoryRouter>,
      ),
    );
    await settle();
    return handoffs;
  }

  test('锚点还没定位（文件还在读取）：保留 fragment 交给工作区，不带滚动位置', async () => {
    const handoffs = await mountDrawer(() => new Promise(() => {}), '架构');
    expect(document.querySelector('[data-testid="file-panel"]')?.textContent).toContain('正在读取');
    act(() => document.querySelector<HTMLElement>('[data-testid="file-to-workspace"]')!.click());
    expect(handoffs[0]).toMatchObject({ view: { kind: 'file', path: '/w/a.md', fragment: '架构' } });
    expect((handoffs[0] as { state: { scrollTop?: number } }).state.scrollTop).toBeUndefined();
  });

  test('锚点已定位：用当前滚动位置代替 fragment', async () => {
    const doc = fsFile('/w/a.md', 'markdown', ['# 总览', '', '正文', '', '## 架构', '', '内容', ''].join('\n'));
    const handoffs = await mountDrawer(async () => doc, '架构');
    await settle();
    act(() => document.querySelector<HTMLElement>('[data-testid="file-to-workspace"]')!.click());
    expect(handoffs[0]).toMatchObject({ view: { kind: 'file', path: '/w/a.md' } });
    expect((handoffs[0] as { view: { fragment?: string } }).view.fragment).toBeUndefined();
    expect(typeof (handoffs[0] as { state: { scrollTop?: number } }).state.scrollTop).toBe('number');
  });
});

describe('窄屏抽屉（Peek）', () => {
  const files: Record<string, OpenedFile> = {
    '/w/notes.txt': fsFile('/w/notes.txt', 'text', '第一行\n第二行'),
    '/w/README.md': fsFile('/w/README.md', 'markdown', '# 示例\n\n见 [设计](docs/design.md#架构)。\n'),
    '/w/docs/design.md': fsFile('/w/docs/design.md', 'markdown', '# 设计\n\n## 架构\n\n内容\n'),
  };

  function mountPeek(tabs: TabMeta[], view: InstanceType<typeof WorkspaceViewStore>): { readonly search: string } {
    const client = {
      on: () => () => {},
      openFile: async (_m: string, _s: string, path: string) => {
        const f = files[path];
        if (f === undefined) throw new Error('不存在');
        return f;
      },
      listFiles: async () => ({ path: '/w', root: '/w', truncated: false, entries: [] }),
    };
    act(() => runtimeState.setState({ client: client as never }));
    let search = '';
    function Probe(): null {
      search = useLocation().search;
      return null;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <MemoryRouter initialEntries={['/s/m/s1']}>
          <Probe />
          <WorkspacePeek open onClose={() => {}} machineId="m" sessionId="s1" tabs={tabs} active={tabs[0]!.id} view={view} />
        </MemoryRouter>,
      ),
    );
    return {
      get search() {
        return search;
      },
    };
  }

  test('换行切换：写进共用的 view store，界面即时更新；store 被别处改了也跟着变', async () => {
    const view = new WorkspaceViewStore();
    const tab: TabMeta = { id: 'file:/w/notes.txt', kind: 'file', path: '/w/notes.txt', preview: false };
    mountPeek([tab], view);
    await settle();
    const wrapBtn = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="ws-peek"] button[title="自动换行"]')!;
    expect(wrapBtn().getAttribute('aria-pressed')).toBe('false');
    act(() => wrapBtn().click());
    expect(view.get(tab.id)?.wrap).toBe(true);
    expect(wrapBtn().getAttribute('aria-pressed')).toBe('true');
    // 工作区那边改回来（整体替换）：抽屉跟着变
    act(() => view.set(tab.id, { wrap: false }));
    expect(wrapBtn().getAttribute('aria-pressed')).toBe('false');
  });

  test('源码 / 渲染切换同样走共用状态', async () => {
    const view = new WorkspaceViewStore();
    const tab: TabMeta = { id: 'file:/w/README.md', kind: 'file', path: '/w/README.md', preview: false };
    mountPeek([tab], view);
    await settle();
    act(() => document.querySelector<HTMLElement>('[data-testid="ws-peek"] [data-testid="file-toggle-source"]')!.click());
    expect(view.get(tab.id)?.mode).toBe('source');
    expect(document.querySelector('[data-testid="ws-peek"] [data-testid="file-toggle-source"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  test('正文里的文件链接：在抽屉里就地切换（带锚点），不叠文件抽屉、不写历史', async () => {
    const view = new WorkspaceViewStore();
    const tab: TabMeta = { id: 'file:/w/README.md', kind: 'file', path: '/w/README.md', preview: false };
    const p = mountPeek([tab], view);
    await settle();
    const link = document.querySelector<HTMLElement>('[data-testid="ws-peek"] [data-testid="file-link"]');
    expect(link?.dataset.path).toBe('/w/docs/design.md');
    act(() => link!.click());
    await settle();
    expect(p.search).toBe('');
    expect(document.querySelector('[data-testid="file-panel"]')).toBeNull();
    expect(document.querySelector('[data-testid="ws-peek"] h2, [data-testid="ws-peek"] [data-slot="sheet-title"]')?.textContent).toContain('design.md');
  });
});

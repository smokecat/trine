/**
 * 文件工作区（dockview 实例，happy-dom + StrictMode）：打开规则与预览位、上限、可见性门控的重内容、
 * Backspace 拦截、快照往返与恢复失败重建、恢复期间不自动保存、<Activity> 收起、懒加载重试。
 * 注：happy-dom 无布局（getBoundingClientRect 全 0），尺寸相关的用 api.layout() 手动驱动；
 * 空间邻组查询拿不到时走模型里记录的「右侧组」关系。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { FsFile } from '@trine/core';
import type { OpenedFile } from '@/lib/client.ts';
import type { DockHandle, RestoreResult, WorkspaceSnapshot } from './workspace-model.ts';

await import('@/lib/dom-test-env.ts');
const React = await import('react');
const { act, StrictMode, Activity } = React;
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router');
const { runtimeState } = await import('@/app/runtime.ts');
const { default: WorkspaceDock } = await import('./WorkspaceDock.tsx');
const { LazyWorkspace } = await import('./LazyWorkspace.tsx');
const { WorkspaceViewStore } = await import('./workspace-store.ts');
const model = await import('./workspace-model.ts');

let root: ReturnType<typeof createRoot> | null = null;
let hostEl: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  hostEl?.remove();
  root = null;
  hostEl = null;
  act(() => runtimeState.setState({ client: null }));
});

function opened(path: string): OpenedFile {
  const f: FsFile = { path, root: '/w', name: path.slice(path.lastIndexOf('/') + 1), size: 4, mtime: 1, mime: 'text/plain', kind: 'text', blobId: 'b'.repeat(22), key: 'k'.repeat(43) };
  return { file: f, blob: new Blob(['text']), url: `blob:test/${path}` };
}

function fakeClient(): { retained: Map<string, number> } {
  const retained = new Map<string, number>();
  const client = {
    on: () => () => {},
    openFile: async (_m: string, _s: string, path: string) => opened(path),
    listFiles: async (_m: string, _s: string, path?: string) => ({
      path: path ?? '/w',
      root: '/w',
      truncated: false,
      entries: [{ name: 'child.md', type: 'file', size: 1, mtime: 1 }],
    }),
    retainFileUrl: (url: string) => {
      retained.set(url, (retained.get(url) ?? 0) + 1);
      return () => retained.set(url, (retained.get(url) ?? 1) - 1);
    },
  };
  act(() => runtimeState.setState({ client: client as never }));
  return { retained };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await act(() => new Promise<void>((r) => setTimeout(r, 0)));
};

interface Mounted {
  readonly h: DockHandle;
  readyCalls: number;
  layoutChanges: number;
  limits: number;
  results: RestoreResult[];
  view: InstanceType<typeof WorkspaceViewStore>;
}

function mount(initial: WorkspaceSnapshot | null = null, wrap?: (el: React.ReactNode) => React.ReactNode): Mounted {
  hostEl = document.createElement('div');
  document.body.appendChild(hostEl);
  root = createRoot(hostEl);
  let handle: DockHandle | null = null;
  const m = {
    get h() {
      if (handle === null) throw new Error('not ready');
      return handle;
    },
    readyCalls: 0,
    layoutChanges: 0,
    limits: 0,
    results: [] as RestoreResult[],
    view: new WorkspaceViewStore(),
  };
  const dock = (
    <div style={{ width: 1000, height: 600 }}>
      <WorkspaceDock
        machineId="m"
        sessionId="s1"
        initial={initial}
        view={m.view}
        onReady={(h, r) => {
          m.readyCalls += 1;
          m.results.push(r);
          handle = h;
          h.api.layout(1000, 600);
        }}
        onLayoutChange={() => (m.layoutChanges += 1)}
        onLimit={() => (m.limits += 1)}
      />
    </div>
  );
  act(() => root!.render(<StrictMode><MemoryRouter>{wrap === undefined ? dock : wrap(dock)}</MemoryRouter></StrictMode>));
  return m;
}

const file = (path: string, placement: 'auto' | 'side' = 'auto', extra: { keep?: boolean; fromGroupId?: string } = {}) => ({ kind: 'file' as const, path, placement, ...extra });
const ids = (m: Mounted): string[] => m.h.api.panels.map((p) => p.id).sort();

describe('打开规则与预览位', () => {
  test('StrictMode 下 onReady 只调一次', () => {
    fakeClient();
    const m = mount();
    expect(m.readyCalls).toBe(1);
    expect(m.results).toEqual(['empty']);
  });

  test('auto 替换同组预览 tab（位置不变）；同一路径只激活；保留按钮与双击转保留', () => {
    fakeClient();
    const m = mount();
    act(() => void m.h.open(file('/w/keep.md', 'auto', { keep: true })));
    act(() => void m.h.open(file('/w/p1.md')));
    let r: ReturnType<DockHandle['open']> | undefined;
    act(() => void (r = m.h.open(file('/w/p2.md'))));
    expect(r).toEqual({ kind: 'opened', id: 'file:/w/p2.md', replaced: 'file:/w/p1.md' });
    expect(m.h.api.groups[0]!.panels.map((p) => p.id)).toEqual(['file:/w/keep.md', 'file:/w/p2.md']);
    act(() => m.h.api.getPanel('file:/w/keep.md')!.api.setActive());
    act(() => void (r = m.h.open(file('/w/p2.md'))));
    expect(r).toEqual({ kind: 'activated', id: 'file:/w/p2.md' });
    expect(m.h.api.activePanel!.id).toBe('file:/w/p2.md');
    // 预览 tab 斜体 + 保留按钮
    const tab = (): HTMLElement => document.querySelector<HTMLElement>('[data-tab="file:/w/p2.md"]')!;
    expect(tab().dataset.preview).toBe('true');
    expect(tab().querySelector('span.italic')).not.toBeNull();
    act(() => tab().querySelector<HTMLButtonElement>('[data-testid="ws-tab-keep"]')!.click());
    expect(tab().dataset.preview).toBe('false');
    act(() => void m.h.open(file('/w/p3.md')));
    expect(m.h.api.totalPanels).toBe(3);
    // 双击同样转保留
    act(() => {
      document.querySelector<HTMLElement>('[data-tab="file:/w/p3.md"]')!.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    });
    expect(m.h.api.getPanel('file:/w/p3.md')!.params).toMatchObject({ preview: false });
  });

  test('目录 tab 里点文件：在其右侧文件组打开（无则新建，有则复用并替换预览位）；目录 tab 不被文件替换', async () => {
    fakeClient();
    const m = mount();
    act(() => void m.h.open({ kind: 'dir', path: '', placement: 'auto' }));
    await settle();
    const dirGroup = m.h.api.groups[0]!;
    // 真实点目录列表里的文件
    const entry = [...document.querySelectorAll<HTMLButtonElement>('[data-panel="dir:1"] button')].find((b) => b.textContent?.includes('child.md'));
    expect(entry).toBeDefined();
    act(() => entry!.click());
    expect(m.h.api.groups.length).toBe(2);
    const fileGroup = m.h.api.getPanel('file:/w/child.md')!.group;
    expect(fileGroup.id).not.toBe(dirGroup.id);
    act(() => void m.h.open(file('/w/other.md', 'auto', { fromGroupId: dirGroup.id })));
    expect(m.h.api.groups.length).toBe(2);
    expect(fileGroup.panels.map((p) => p.id)).toEqual(['file:/w/other.md']);
    expect(dirGroup.panels.map((p) => p.id)).toEqual(['dir:1']);
  });

  test('side：活动组右侧（有则复用），保留；重复 side 同一路径只激活', () => {
    fakeClient();
    const m = mount();
    act(() => void m.h.open(file('/w/a.md')));
    act(() => void m.h.open(file('/w/b.md', 'side')));
    expect(m.h.api.groups.length).toBe(2);
    expect(m.h.api.getPanel('file:/w/b.md')!.params).toMatchObject({ preview: false });
    act(() => m.h.api.getPanel('file:/w/a.md')!.api.setActive());
    act(() => void m.h.open(file('/w/c.md', 'side')));
    expect(m.h.api.groups.length).toBe(2);
    expect(m.h.api.getPanel('file:/w/c.md')!.group.id).toBe(m.h.api.getPanel('file:/w/b.md')!.group.id);
  });

  test('目录：auto 就地导航已有目录 tab；没有时新建；在文件里「所在目录」也是就地导航', () => {
    fakeClient();
    const m = mount();
    act(() => void m.h.open(file('/w/a.md')));
    act(() => void m.h.open({ kind: 'dir', path: '/w/docs', placement: 'auto' }));
    expect(m.h.api.groups.length).toBe(2);
    act(() => void m.h.open({ kind: 'dir', path: '/w/src', placement: 'auto' }));
    const dirs = m.h.api.panels.filter((p) => model.paramsOf(p).kind === 'dir');
    expect(dirs.length).toBe(1);
    expect(dirs[0]!.params).toMatchObject({ path: '/w/src', preview: false });
    expect(dirs[0]!.api.title).toBe('src');
  });

  test('拖出分栏 / 移到别组的 tab 自动转保留', () => {
    fakeClient();
    const m = mount();
    act(() => void m.h.open(file('/w/a.md', 'auto', { keep: true })));
    act(() => void m.h.open(file('/w/b.md')));
    const b = m.h.api.getPanel('file:/w/b.md')!;
    act(() => b.api.moveTo({ group: b.group, position: 'right' }));
    expect(m.h.api.groups.length).toBe(2);
    expect(m.h.api.getPanel('file:/w/b.md')!.params).toMatchObject({ preview: false });
  });

  test('上限 20：先淘汰隐藏且未保留的；都保留时返回 limit 并通知', () => {
    fakeClient();
    const m = mount();
    act(() => void m.h.open(file('/w/p.md')));
    for (let i = 0; i < 19; i++) act(() => void m.h.open(file(`/w/k${i}.md`, 'auto', { keep: true })));
    expect(m.h.api.totalPanels).toBe(20);
    let r: ReturnType<DockHandle['open']> | undefined;
    act(() => void (r = m.h.open(file('/w/x.md', 'auto', { keep: true }))));
    expect(r).toMatchObject({ kind: 'opened', evicted: 'file:/w/p.md' });
    act(() => void (r = m.h.open(file('/w/y.md', 'auto', { keep: true }))));
    expect(r).toEqual({ kind: 'limit' });
    expect(m.limits).toBe(1);
    expect(m.h.api.totalPanels).toBe(20);
  });
});

describe('渲染与资源', () => {
  test('隐藏 tab 卸掉重内容（释放 Blob URL 占用），切回重挂；滚动从 view store 回填', async () => {
    const { retained } = fakeClient();
    const m = mount();
    act(() => void m.h.open(file('/w/a.md', 'auto', { keep: true })));
    await settle();
    expect(retained.get('blob:test//w/a.md')).toBe(1);
    act(() => m.view.patch('file:/w/a.md', { scrollTop: 0, wrap: true }));
    act(() => void m.h.open(file('/w/b.md', 'auto', { keep: true })));
    await settle();
    // a 被同组的 b 盖住：panel DOM 摘下、重内容卸载
    expect(document.querySelector('[data-panel="file:/w/a.md"]')).toBeNull();
    expect(retained.get('blob:test//w/a.md')).toBe(0);
    expect(retained.get('blob:test//w/b.md')).toBe(1);
    act(() => m.h.api.getPanel('file:/w/a.md')!.api.setActive());
    await settle();
    expect(retained.get('blob:test//w/a.md')).toBe(1);
    expect(retained.get('blob:test//w/b.md')).toBe(0);
    // 换行状态来自 view store
    expect(document.querySelector('[data-panel="file:/w/a.md"] [aria-pressed="true"][title="自动换行"]')).not.toBeNull();
  });

  test('定位请求：已开的文件 tab 再带锚点打开会重挂视图（不重复消费）', async () => {
    fakeClient();
    const m = mount();
    act(() => void m.h.open(file('/w/a.md')));
    await settle();
    const before = document.querySelector('[data-panel="file:/w/a.md"] [data-testid="file-scroll"]');
    act(() => m.view.requestFragment('file:/w/a.md', '安装'));
    await settle();
    const after = document.querySelector('[data-panel="file:/w/a.md"] [data-testid="file-scroll"]');
    expect(after).not.toBe(before);
  });

  test('tab 上 Backspace 不关闭（拦截），Delete 照常', () => {
    fakeClient();
    const m = mount();
    act(() => void m.h.open(file('/w/a.md', 'auto', { keep: true })));
    const tab = document.querySelector<HTMLElement>('.dv-tab')!;
    act(() => {
      tab.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    });
    expect(m.h.api.totalPanels).toBe(1);
  });

  test('<Activity mode="hidden"> 收起：实例保留、不重新 onReady，重内容卸载，恢复后重挂', async () => {
    const { retained } = fakeClient();
    let mode: 'visible' | 'hidden' = 'visible';
    let rerender: () => void = () => {};
    const m = mount(null, (dock) => {
      function Toggle(): React.JSX.Element {
        const [, force] = React.useState(0);
        rerender = () => force((n) => n + 1);
        return <Activity mode={mode}>{dock}</Activity>;
      }
      return <Toggle />;
    });
    act(() => void m.h.open(file('/w/a.md')));
    await settle();
    expect(retained.get('blob:test//w/a.md')).toBe(1);
    mode = 'hidden';
    act(() => rerender());
    await settle();
    expect(retained.get('blob:test//w/a.md')).toBe(0);
    expect(m.h.api.totalPanels).toBe(1);
    mode = 'visible';
    act(() => rerender());
    await settle();
    expect(m.readyCalls).toBe(1);
    expect(retained.get('blob:test//w/a.md')).toBe(1);
  });
});

describe('持久化', () => {
  test('快照往返：组、tab、预览标记、内容状态；恢复期间不触发自动保存，之后的操作照常', async () => {
    fakeClient();
    const m = mount();
    act(() => void m.h.open({ kind: 'dir', path: '', placement: 'auto' }));
    act(() => void m.h.open(file('/w/a.md', 'side')));
    act(() => void m.h.open(file('/w/b.md')));
    act(() => m.view.patch('file:/w/a.md', { mode: 'source', scrollTop: 40 }));
    const snap = model.readSnapshot(JSON.parse(JSON.stringify(m.h.snapshot(false))))!;
    expect(snap.layout).not.toBeNull();
    expect(snap.view['file:/w/a.md']).toEqual({ mode: 'source', scrollTop: 40 });
    act(() => root!.unmount());

    const m2 = mount(snap);
    expect(m2.results).toEqual(['restored']);
    expect(m2.h.api.groups.length).toBe(2);
    expect(ids(m2)).toEqual(['dir:1', 'file:/w/a.md', 'file:/w/b.md']);
    expect(m2.h.api.getPanel('file:/w/b.md')!.params).toEqual({ kind: 'file', path: '/w/b.md', preview: true });
    await settle();
    expect(m2.layoutChanges).toBe(0);
    act(() => void m2.h.open(file('/w/c.md')));
    await settle();
    expect(m2.layoutChanges).toBe(1);
    // 新目录 tab 的序号接在恢复出来的之后
    act(() => void m2.h.open({ kind: 'dir', path: '/w/x', placement: 'side' }));
    expect(m2.h.api.getPanel('dir:2')).toBeDefined();
  });

  test('布局坏了：按元数据重建单组，tab 都在；恢复期间同样不保存', async () => {
    fakeClient();
    const m = mount();
    act(() => void m.h.open(file('/w/a.md', 'auto', { keep: true })));
    act(() => void m.h.open(file('/w/b.md', 'side')));
    const raw = JSON.parse(JSON.stringify(m.h.snapshot(false)));
    act(() => root!.unmount());
    raw.layout.grid.root.data[0].data.views.push('file:/ghost');
    const snap = model.readSnapshot(raw)!;
    expect(snap.layout).toBeNull();
    const m2 = mount(snap);
    expect(m2.results).toEqual(['rebuilt']);
    expect(m2.h.api.groups.length).toBe(1);
    expect(ids(m2)).toEqual(['file:/w/a.md', 'file:/w/b.md']);
    await settle();
    expect(m2.layoutChanges).toBe(0);
  });

  test('fromJSON 自己抛错（校验漏网）：同样落到重建，不留空布局', () => {
    fakeClient();
    const m = mount();
    act(() => void m.h.open(file('/w/a.md')));
    const snap = m.h.snapshot(false);
    act(() => root!.unmount());
    // 绕过 readSnapshot，给 dockview 一个它会拒绝的布局
    const bad = { ...snap, layout: { ...snap.layout!, grid: { ...snap.layout!.grid, root: { type: 'leaf' } } } } as unknown as WorkspaceSnapshot;
    const m2 = mount(bad);
    expect(m2.results).toEqual(['rebuilt']);
    expect(ids(m2)).toEqual(['file:/w/a.md']);
  });

  test('重置布局：多组合并为一组，tab 不丢', async () => {
    fakeClient();
    const m = mount();
    act(() => void m.h.open(file('/w/a.md')));
    act(() => void m.h.open(file('/w/b.md', 'side')));
    expect(m.h.api.groups.length).toBe(2);
    act(() => m.h.resetLayout());
    await settle();
    expect(m.h.api.groups.length).toBe(1);
    expect(ids(m)).toEqual(['file:/w/a.md', 'file:/w/b.md']);
    expect(m.layoutChanges).toBeGreaterThanOrEqual(1);
  });
});

describe('懒加载', () => {
  test('加载失败显示重试，重试换新 lazy 实例后成功', async () => {
    fakeClient();
    let calls = 0;
    const load = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('chunk 404'));
      return import('./WorkspaceDock.tsx');
    };
    hostEl = document.createElement('div');
    document.body.appendChild(hostEl);
    root = createRoot(hostEl);
    const origError = console.error;
    console.error = () => {};
    try {
      await act(async () =>
        root!.render(
          <MemoryRouter>
            <LazyWorkspace
              machineId="m"
              sessionId="s"
              initial={null}
              view={new WorkspaceViewStore()}
              onReady={() => {}}
              onLayoutChange={() => {}}
              onLimit={() => {}}
              onResetLayout={() => {}}
              load={load}
            />
          </MemoryRouter>,
        ),
      );
      await settle();
      expect(hostEl.querySelector('[data-testid="ws-retry"]')).not.toBeNull();
      await act(async () => hostEl!.querySelector<HTMLButtonElement>('[data-testid="ws-retry"]')!.click());
      await settle();
    } finally {
      console.error = origError;
    }
    expect(calls).toBe(2);
    expect(hostEl.querySelector('.dv-dockview')).not.toBeNull();
  });
});

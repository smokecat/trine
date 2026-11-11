/**
 * 工作区控制器（不起 dockview，用假句柄）：可用性与窄屏自动收起、打开请求在就绪前排队、
 * 收起 / 恢复的持久化、关掉最后一个 tab 即消失、按「机器 + cwd」隔离；
 * 历史：抽屉 → 工作区按 depth 消费历史后再建 tab、深链就地 replace；窄屏抽屉一条可退回的历史。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { DockHandle, OpenRequest, TabMeta } from './workspace-model.ts';
import type { WorkspaceController } from './use-workspace.ts';
import type { KvLike } from './workspace-store.ts';

await import('@/lib/dom-test-env.ts');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter, useLocation } = await import('react-router');
const { useWorkspace } = await import('./use-workspace.ts');
const { WorkspaceStore, workspaceKey } = await import('./workspace-store.ts');
const { useDrawerHandoff } = await import('./use-drawer-handoff.ts');
const { useWorkspacePeekRoute } = await import('./WorkspacePeek.tsx');
const { useFilePanelRoute } = await import('@/components/files/use-file-panel.ts');
const { clampWorkspaceWidth, workspaceFits, CHAT_MIN_WIDTH, WORKSPACE_MIN_WIDTH } = await import('@/lib/layout-prefs.ts');

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function memoryKv(): KvLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

/** 假 dockview 句柄：只记 tab 列表 */
function fakeHandle(): DockHandle & { tabs: TabMeta[]; opened: OpenRequest[] } {
  const tabs: TabMeta[] = [];
  const opened: OpenRequest[] = [];
  return {
    tabs,
    opened,
    api: {} as never,
    ctx: {} as never,
    open(req) {
      opened.push(req);
      const id = req.kind === 'file' ? `file:${req.path}` : `dir:${tabs.length + 1}`;
      if (!tabs.some((t) => t.id === id)) tabs.push({ id, kind: req.kind, path: req.path, preview: req.placement === 'auto' && req.keep !== true && req.kind === 'file' });
      return { kind: 'opened', id };
    },
    snapshot(collapsed) {
      return { v: 1, layout: null, tabs: [...tabs], view: {}, active: tabs.at(-1)?.id, collapsed };
    },
    resetLayout() {},
    closeAll() {
      tabs.length = 0;
    },
    focus: () => false,
  };
}

interface Props {
  machineId?: string;
  cwd?: string | undefined;
  enabled?: boolean;
}

function harness(store: InstanceType<typeof WorkspaceStore>, initial: Props = {}): { readonly ws: WorkspaceController; rerender: (p: Props) => void } {
  let current: WorkspaceController | null = null;
  let props: Props = { machineId: 'm', cwd: '/w', enabled: true, ...initial };
  function H(p: Props): null {
    current = useWorkspace({ machineId: p.machineId ?? 'm', sessionId: 's1', cwd: p.cwd, enabled: p.enabled ?? true, store });
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(<H {...props} />));
  return {
    get ws() {
      return current!;
    },
    rerender: (p) => {
      props = { ...props, ...p };
      act(() => root!.render(<H {...props} />));
    },
  };
}

describe('layout-prefs：工作区宽度', () => {
  test('放得下两栏才显示；宽度默认取一半并夹在 [最小, 主区 − 聊天最小]', () => {
    expect(workspaceFits(CHAT_MIN_WIDTH + 8 + WORKSPACE_MIN_WIDTH)).toBe(true);
    expect(workspaceFits(CHAT_MIN_WIDTH + 8 + WORKSPACE_MIN_WIDTH - 1)).toBe(false);
    expect(clampWorkspaceWidth(null, 1400)).toBe(696);
    expect(clampWorkspaceWidth(2000, 1400)).toBe(1400 - CHAT_MIN_WIDTH - 8);
    expect(clampWorkspaceWidth(10, 1400)).toBe(WORKSPACE_MIN_WIDTH);
  });
});

describe('useWorkspace', () => {
  test('不可用（手机 / 不支持文件 / 不知道 cwd）：没有路由，全部走抽屉', () => {
    const store = new WorkspaceStore(memoryKv());
    const h = harness(store, { enabled: false });
    expect(h.ws.route).toBeNull();
    h.rerender({ enabled: true, cwd: undefined });
    expect(h.ws.route).toBeNull();
    h.rerender({ cwd: '/w' });
    expect(h.ws.route).not.toBeNull();
    expect(h.ws.status).toBe('absent');
    // 没有工作区时 auto 走抽屉
    expect(h.ws.route!.expanded()).toBe(false);
  });

  test('side 打开：工作区出现并展开，请求排队到 dockview 就绪后执行；就绪后计数同步并保存', async () => {
    const kv = memoryKv();
    const store = new WorkspaceStore(kv);
    const h = harness(store);
    act(() => h.ws.route!.open({ path: 'docs/a.md', target: 'side' }));
    expect(h.ws.status).toBe('expanded');
    expect(h.ws.mounted).toBe(true);
    expect(h.ws.count).toBe(0);
    const handle = fakeHandle();
    act(() => h.ws.dock!.onReady(handle, 'empty'));
    expect(handle.opened).toEqual([{ kind: 'file', path: 'docs/a.md', placement: 'side' }]);
    expect(h.ws.count).toBe(1);
    // 主区还没测量：不算显示（不做深链交接）
    expect(h.ws.shown).toBe(false);
    act(() => h.ws.setMainWidth(1400));
    expect(h.ws.shown).toBe(true);
    // 已展开：auto 也进工作区
    expect(h.ws.route!.expanded()).toBe(true);
    await act(() => new Promise((r) => setTimeout(r, 350)));
    expect(store.load(workspaceKey('m', '/w'))?.tabs.map((t) => t.id)).toEqual(['file:docs/a.md']);
  });

  test('抽屉交接：开成保留 tab，带着内容状态；锚点作为一次性定位请求', () => {
    const h = harness(new WorkspaceStore(memoryKv()));
    const handle = fakeHandle();
    act(() => h.ws.openWithState({ path: '/w/a.md', fragment: '用法', target: 'side' }, { mode: 'source', scrollTop: 80 }));
    act(() => h.ws.dock!.onReady(handle, 'empty'));
    expect(handle.opened[0]).toMatchObject({ kind: 'file', path: '/w/a.md', keep: true });
    expect(h.ws.view.get('file:/w/a.md')).toEqual({ mode: 'source', scrollTop: 80 });
    expect(h.ws.view.fragment('file:/w/a.md')?.fragment).toBe('用法');
  });

  test('收起：保留 tab，持久化；重新进入同一 cwd 恢复为收起（不加载 dockview），展开后挂载', () => {
    const kv = memoryKv();
    const store = new WorkspaceStore(kv);
    const h = harness(store);
    act(() => h.ws.route!.open({ path: '/w/a.md', target: 'side' }));
    act(() => h.ws.dock!.onReady(fakeHandle(), 'empty'));
    act(() => h.ws.collapse());
    expect(h.ws.status).toBe('collapsed');
    expect(h.ws.mounted).toBe(true); // 实例还挂着（Activity 隐藏）
    expect(h.ws.route!.expanded()).toBe(false); // 收起时 auto 走抽屉
    act(() => root!.unmount());

    const h2 = harness(store);
    expect(h2.ws.status).toBe('collapsed');
    expect(h2.ws.count).toBe(1);
    expect(h2.ws.mounted).toBe(false);
    act(() => h2.ws.expand());
    expect(h2.ws.status).toBe('expanded');
    expect(h2.ws.mounted).toBe(true);
    expect(h2.ws.dock!.initial?.tabs.map((t) => t.id)).toEqual(['file:/w/a.md']);
  });

  test('关掉最后一个 tab：工作区消失、存档删除', () => {
    const kv = memoryKv();
    const store = new WorkspaceStore(kv);
    const h = harness(store);
    const handle = fakeHandle();
    act(() => h.ws.route!.open({ path: '/w/a.md', target: 'side' }));
    act(() => h.ws.dock!.onReady(handle, 'empty'));
    act(() => h.ws.collapse());
    act(() => h.ws.expand());
    handle.tabs.length = 0;
    act(() => h.ws.dock!.onLayoutChange());
    expect(h.ws.status).toBe('absent');
    expect(h.ws.mounted).toBe(false);
    expect(store.load(workspaceKey('m', '/w'))).toBeNull();
  });

  test('窄屏：主区放不下两栏 → 自动收起（不改用户的收起状态），没有工作区路由；变宽后还原', () => {
    const h = harness(new WorkspaceStore(memoryKv()));
    act(() => h.ws.route!.open({ path: '/w/a.md', target: 'side' }));
    act(() => h.ws.dock!.onReady(fakeHandle(), 'empty'));
    act(() => h.ws.setMainWidth(1200));
    expect(h.ws.shown).toBe(true);
    act(() => h.ws.setMaximized(true));
    expect(h.ws.maximized).toBe(true);
    act(() => h.ws.setMainWidth(700));
    expect(h.ws.narrow).toBe(true);
    expect(h.ws.shown).toBe(false);
    expect(h.ws.maximized).toBe(false);
    expect(h.ws.status).toBe('expanded');
    expect(h.ws.route).toBeNull();
    act(() => h.ws.setMainWidth(1200));
    expect(h.ws.shown).toBe(true);
  });

  test('按「机器 + cwd」隔离：换目录先保存旧的，再按新目录的存档恢复', () => {
    const store = new WorkspaceStore(memoryKv());
    const h = harness(store);
    act(() => h.ws.route!.open({ path: '/w/a.md', target: 'side' }));
    act(() => h.ws.dock!.onReady(fakeHandle(), 'empty'));
    h.rerender({ cwd: '/other' });
    expect(h.ws.status).toBe('absent');
    expect(store.load(workspaceKey('m', '/w'))?.tabs.length).toBe(1);
    h.rerender({ cwd: '/w' });
    expect(h.ws.count).toBe(1);
    h.rerender({ machineId: 'm2' });
    expect(h.ws.count).toBe(0);
  });
});

describe('历史', () => {
  type Probe = { panel: ReturnType<typeof useFilePanelRoute>; loc: ReturnType<typeof useLocation>; handoff: ReturnType<typeof useDrawerHandoff>; peek: ReturnType<typeof useWorkspacePeekRoute> };
  let probe: Probe | null = null;
  function Harness({ onCreate }: { onCreate: (path: string) => void }): null {
    const panel = useFilePanelRoute();
    const loc = useLocation();
    const handoff = useDrawerHandoff((h) => onCreate(h.intent.dir === true ? `dir:${h.intent.path ?? ''}` : h.intent.path));
    const peek = useWorkspacePeekRoute();
    probe = { panel, loc, handoff, peek };
    return null;
  }
  const mountAt = (url: string, created: string[]): void => {
    root = createRoot(document.createElement('div'));
    act(() =>
      root!.render(
        <MemoryRouter initialEntries={[url]}>
          <Harness onCreate={(p) => created.push(p)} />
        </MemoryRouter>,
      ),
    );
  };

  test('从关着打开、抽屉里跳了 2 步：先退回 depth 步，回到无抽屉后才建 tab，无残留历史', () => {
    const created: string[] = [];
    mountAt('/s/m/s1', created);
    act(() => probe!.panel.open({ kind: 'dir' }));
    act(() => probe!.panel.open({ kind: 'file', path: '/w/a.md', fragment: '用法' }));
    expect(probe!.loc.state).toMatchObject({ fileDepth: 2, fileFromClosed: true, fileFragment: '用法' });
    act(() => probe!.handoff({ intent: { path: '/w/a.md', target: 'side' }, state: { scrollTop: 40 } }));
    expect(probe!.panel.view).toBeNull();
    expect(probe!.loc.key).toBe('default');
    expect(created).toEqual(['/w/a.md']);
  });

  test('深链进来：replace 去掉参数（保留其他查询与 state）后建 tab', () => {
    const created: string[] = [];
    mountAt('/s/m/s1?file=%2Fw%2Fa.md&x=1', created);
    act(() => probe!.handoff({ intent: { path: '/w/a.md', target: 'side' }, state: {} }));
    expect(probe!.loc.search).toBe('?x=1');
    expect(probe!.loc.key).not.toBe('default');
    expect(created).toEqual(['/w/a.md']);
  });

  test('窄屏抽屉：打开 push 一条，关闭退回去；重复打开不叠加', () => {
    mountAt('/s/m/s1', []);
    act(() => probe!.peek.show());
    expect(probe!.peek.open).toBe(true);
    const key = probe!.loc.key;
    act(() => probe!.peek.show());
    expect(probe!.loc.key).toBe(key);
    act(() => probe!.peek.close());
    expect(probe!.peek.open).toBe(false);
    expect(probe!.loc.key).toBe('default');
  });
});

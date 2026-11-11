/**
 * 文件面板的往上浏览与信任目录（trusted-browse-dirs）：面包屑从 / 开始、上一级、范围外的说明卡片
 * （新 agent 给信任入口，密钥类不给）、确认对话框的 home 警告、位置菜单、机器详情页一节。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import type { FilesRoot } from '@trine/core';
import '@/lib/dom-test-env.ts';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router');
const { runtimeState, store } = await import('@/app/runtime.ts');
const { FsRequestError } = await import('@/lib/client.ts');
const { FilePanel } = await import('./FilePanel.tsx');
const { TrustedDirsSection } = await import('./TrustedDirsSection.tsx');

const MACHINE = 'mbp';
const HOME = '/home/u';
const CWD = '/home/u/w/repo';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => runtimeState.setState({ client: null }));
});

interface Calls {
  lists: (string | undefined)[];
  trusted: [string, boolean][];
}

function setup(options: { roots?: FilesRoot[] | undefined; trusted?: string[] } = {}): Calls {
  const calls: Calls = { lists: [], trusted: [] };
  const trusted = new Set(options.trusted ?? []);
  const client = {
    on: () => () => {},
    listFiles: async (_m: string, _s: string, path?: string) => {
      calls.lists.push(path);
      const p = path ?? CWD;
      const root = p.startsWith(CWD) ? CWD : [...trusted].find((t) => p === t || p.startsWith(`${t}/`));
      // 与 agent 同序：字面密钥类先于范围判断
      if (p.split('/').includes('.ssh')) throw new FsRequestError('denied', '密钥类文件不提供查看', 'sensitive');
      if (root === undefined) throw new FsRequestError('denied', '不在可浏览的范围内（会话目录或信任目录）', 'out_of_scope');
      return { path: p, root, entries: [{ name: 'a.md', type: 'file', size: 1, mtime: 1 }], truncated: false };
    },
    openFile: async (_m: string, _s: string, path: string) => {
      if (path.split('/').includes('.ssh')) throw new FsRequestError('denied', '密钥类文件不提供查看', 'sensitive');
      // 只模拟拒绝：能打开的文件不在这组用例里
      throw new FsRequestError('denied', '不在可浏览的范围内（会话目录或信任目录）', 'out_of_scope');
    },
    setDirTrusted: async (_m: string, path: string, on: boolean) => {
      calls.trusted.push([path, on]);
      if (on) trusted.add(path);
      return path;
    },
  };
  act(() => {
    runtimeState.setState({ client: client as never });
    store.setState({
      machines: {
        [MACHINE]: {
          machineId: MACHINE,
          name: 'MBP',
          online: true,
          lastSeenAt: 1,
          parkedCount: 0,
          info: { name: 'MBP', files: { maxBytes: 1024, ...('roots' in options && options.roots === undefined ? {} : { roots: options.roots ?? [], home: HOME }) } },
          cwd: null,
          lastError: null,
          stats: null,
          statsHistory: [],
        },
      } as never,
      sessions: {},
    });
  });
  return calls;
}

const tick = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 0)));
const $ = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);
const $$ = (id: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

/** 面板受控：onNavigate 改 path 后重渲染；`file` = 先打开文件 */
async function mountPanel(initial: string | undefined, file?: string): Promise<{ nav: (string | undefined)[] }> {
  const nav: (string | undefined)[] = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const render = (path: string | undefined, filePath?: string): void =>
    root!.render(
      <MemoryRouter>
        <FilePanel
          machineId={MACHINE}
          sessionId="s1"
          view={filePath !== undefined ? { kind: 'file', path: filePath } : { kind: 'dir', ...(path === undefined ? {} : { path }) }}
          onNavigate={(v) => {
            nav.push(v.path);
            act(() => (v.kind === 'file' ? render(undefined, v.path) : render(v.path)));
          }}
          onClose={() => {}}
        />
      </MemoryRouter>,
    );
  act(() => render(initial, file));
  await tick();
  return { nav };
}

describe('文件面板 · 往上浏览', () => {
  test('面包屑从 / 开始，根之上的段不是 inScope；会话目录也有上一级', async () => {
    setup();
    const { nav } = await mountPanel(undefined);
    const crumbs = $$('file-crumb');
    expect(crumbs.map((c) => c.textContent)).toEqual(['/', 'home', 'u', 'w', 'repo']);
    expect(crumbs.map((c) => c.dataset['inScope'] === 'true')).toEqual([false, false, false, false, true]);
    act(() => $('file-panel-up')!.click());
    await tick();
    expect(nav).toEqual(['/home/u/w']);
  });

  test('范围外：说明卡片 → 信任此目录 → 确认后重新加载就能看', async () => {
    const calls = setup();
    await mountPanel('/home/u/w');
    expect($('file-out-of-scope')).not.toBeNull();
    expect($('file-error')).toBeNull();
    act(() => $('file-trust-open')!.click());
    await tick();
    expect($('trust-dir-dialog')).not.toBeNull();
    // /home/u/w 在 home 之下：没有加强提示
    expect($('trust-dir-risk')).toBeNull();
    act(() => $('trust-dir-confirm')!.click());
    await tick();
    expect(calls.trusted).toEqual([['/home/u/w', true]]);
    expect($('file-out-of-scope')).toBeNull();
    expect($$('file-entry').map((e) => e.dataset['name'])).toEqual(['a.md']);
  });

  test('信任 home 或其上级：对话框有加强提示', async () => {
    setup();
    await mountPanel('/home');
    act(() => $('file-trust-open')!.click());
    await tick();
    expect($('trust-dir-risk')?.textContent).toContain('包含 agent 用户的 home');
  });

  test('密钥类目录只报错，不给信任入口', async () => {
    setup();
    await mountPanel('/home/u/.ssh');
    expect($('file-out-of-scope')).toBeNull();
    expect($('file-error')?.textContent).toContain('密钥类');
  });

  test('范围外的文件：「浏览所在目录」→ 目录的范围外说明与信任入口（不自动信任）', async () => {
    const calls = setup();
    const { nav } = await mountPanel(undefined, '/srv/notes/task/README.md');
    expect($('file-error')).not.toBeNull();
    act(() => $('file-browse-parent')!.click());
    await tick();
    expect(nav).toEqual(['/srv/notes/task']);
    expect($('file-out-of-scope')).not.toBeNull();
    expect($('file-trust-open')).not.toBeNull();
    expect(calls.trusted).toEqual([]);
  });

  test('密钥类文件：只报错，没有「浏览所在目录」', async () => {
    setup();
    await mountPanel(undefined, '/home/u/.ssh/id_rsa');
    expect($('file-error')?.textContent).toContain('密钥类');
    expect($('file-browse-parent')).toBeNull();
  });

  test('相对路径按会话 cwd、`~/` 按 agent home 解析后浏览所在目录；不知道 cwd 时不给', async () => {
    setup();
    const remount = async (file: string): Promise<(string | undefined)[]> => {
      act(() => root?.unmount());
      host?.remove();
      root = null;
      return (await mountPanel(undefined, file)).nav;
    };
    // 会话还不在本地列表里：相对路径无从解析
    let nav = await remount('../notes/README.md');
    expect($('file-error')).not.toBeNull();
    expect($('file-browse-parent')).toBeNull();
    act(() => store.setState({ sessions: { [MACHINE]: { s1: { sessionId: 's1', cwd: CWD } } } as never }));
    nav = await remount('../notes/README.md');
    act(() => $('file-browse-parent')!.click());
    await tick();
    expect(nav).toEqual(['/home/u/w/notes']);
    expect($('file-out-of-scope')).not.toBeNull();
    nav = await remount('~/notes/README.md');
    act(() => $('file-browse-parent')!.click());
    await tick();
    expect(nav).toEqual(['/home/u/notes']);
  });

  test('旧 agent（没有 roots）：范围外照样说明，但没有信任入口和位置菜单', async () => {
    setup({ roots: undefined });
    await mountPanel('/home/u/w');
    expect($('file-out-of-scope')?.textContent).toContain('TRINE_FILES_ALLOW');
    expect($('file-trust-open')).toBeNull();
    expect($('file-locations')).toBeNull();
  });
});

describe('信任确认对话框 · 规范化', () => {
  test('`~/..`、末尾 / 按规范化后的路径提示；/ 不能确认', async () => {
    setup();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const { TrustDirDialog } = await import('./TrustDir.tsx');
    const show = (path: string): void =>
      act(() =>
        root!.render(
          <MemoryRouter>
            <TrustDirDialog key={path} machineId={MACHINE} path={path} open onOpenChange={() => {}} />
          </MemoryRouter>,
        ),
      );
    show('~/..');
    expect($('trust-dir-path')?.textContent).toBe('/home');
    expect($('trust-dir-risk')?.textContent).toContain('包含 agent 用户的 home');
    show('/home/u/');
    expect($('trust-dir-risk')?.textContent).toContain('home 目录');
    show('~/../..');
    expect($('trust-dir-path')?.textContent).toBe('/');
    expect(($('trust-dir-confirm') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('机器详情页 · 信任目录', () => {
  test('env 来源不能删；trusted 来源可以删（确认后）；添加走确认对话框', async () => {
    const calls = setup();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const roots: FilesRoot[] = [
      { path: '/srv/shared', source: 'env' },
      { path: '/home/u/w', source: 'trusted', addedAt: 1 },
    ];
    act(() =>
      root!.render(
        <MemoryRouter>
          <TrustedDirsSection machineId={MACHINE} online roots={roots} />
        </MemoryRouter>,
      ),
    );
    const rows = $$('trusted-dir');
    expect(rows.map((r) => [r.dataset['path'], r.querySelector('[data-testid="trusted-dir-remove"]') !== null])).toEqual([
      ['/srv/shared', false],
      ['/home/u/w', true],
    ]);
    act(() => (rows[1]!.querySelector('[data-testid="trusted-dir-remove"]') as HTMLElement).click());
    await tick();
    act(() => $('trusted-dir-remove-confirm-confirm')!.click());
    await tick();
    expect(calls.trusted).toEqual([['/home/u/w', false]]);
  });
});

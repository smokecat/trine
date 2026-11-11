/**
 * 文件视图（与容器无关）的 markdown 目录与锚点（§6）：目录按钮 + 弹层、≥3 个标题才出现、
 * 同文件锚点在预览容器内定位、intent 带来的锚点加载后定位、找不到给提示、源码/渲染切换、
 * 刷新后标题变化、两个预览实例 id 不冲突。抽屉外壳另测（面板仍有 Dialog 标题）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { FsFile } from '@trine/core';
import type { OpenedFile } from '@/lib/client.ts';
import type { FileOpenIntent } from './file-links.ts';
import type { FileDocModel } from './view-model.ts';

await import('@/lib/dom-test-env.ts');
const { act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router');
const { runtimeState } = await import('@/app/runtime.ts');
const { FileLinksContext } = await import('./file-links.ts');
const { FileDocView } = await import('./FileDocView.tsx');
const { FilePanel, resetDrawerState } = await import('./FilePanel.tsx');
const { DEFAULT_DOC_MODEL } = await import('./view-model.ts');

type Root = ReturnType<typeof createRoot>;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => runtimeState.setState({ client: null }));
  resetDrawerState();
});

const DOC = ['# 总览', '', '正文', '', '## 安装步骤', '', '跳到 [用法](#%E7%94%A8%E6%B3%95) 或 [不存在](#nope)', '', '## 用法', '', '### 用法', ''].join('\n');

function opened(path: string, content: string): OpenedFile {
  const f: FsFile = {
    path,
    root: '/w/repo',
    name: path.slice(path.lastIndexOf('/') + 1),
    size: new TextEncoder().encode(content).length,
    mtime: 1,
    mime: 'text/markdown',
    kind: 'markdown',
    blobId: 'b'.repeat(22),
    key: 'k'.repeat(43),
  };
  return { file: f, blob: new Blob([content]), url: 'blob:test/1' };
}

/** 假 client：按路径给内容；`contents` 可在测试中改（模拟刷新后文件变了） */
function setup(contents: Record<string, string>): { opens: string[] } {
  const calls = { opens: [] as string[] };
  const client = {
    on: () => () => {},
    openFile: async (_m: string, _s: string, path: string) => {
      calls.opens.push(path);
      const c = contents[path];
      if (c === undefined) throw new Error('不存在');
      return opened(path, c);
    },
  };
  act(() => runtimeState.setState({ client: client as never }));
  return calls;
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await act(() => new Promise<void>((r) => setTimeout(r, 0)));
};
const $ = (id: string, el: ParentNode = document): HTMLElement | null => el.querySelector(`[data-testid="${id}"]`);
const $$ = (id: string, el: ParentNode = document): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

function Doc({ path, fragment, initial }: { path: string; fragment?: string; initial?: Partial<FileDocModel> }): React.JSX.Element {
  const [model, setModel] = useState<FileDocModel>({ ...DEFAULT_DOC_MODEL, ...initial });
  return (
    <div data-testid="doc-host">
      <FileDocView
        machineId="m"
        sessionId="s1"
        path={path}
        {...(fragment === undefined ? {} : { fragment })}
        model={model}
        onModelChange={(p) => setModel((m) => ({ ...m, ...p }))}
        onBrowse={() => {}}
      />
    </div>
  );
}

/** 记录滚动：happy-dom 不做布局，scrollTo 换成记录 */
function spyScroll(el: HTMLElement): number[] {
  const tops: number[] = [];
  el.scrollTo = ((opts: ScrollToOptions) => void tops.push(opts.top ?? -1)) as typeof el.scrollTo;
  return tops;
}

async function mount(node: React.ReactNode, intents: FileOpenIntent[] = []): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<FileLinksContext.Provider value={{ open: (i) => void intents.push(i) }}>{node}</FileLinksContext.Provider>));
  await tick();
}

describe('FileDocView · 目录与锚点', () => {
  test('≥3 个 h1–h4 才有目录；窄容器是按钮 + 弹层，点目录项在容器内滚动', async () => {
    setup({ '/w/repo/a.md': DOC, '/w/repo/short.md': '# 一\n\n## 二\n\n##### 五' });
    await mount(<Doc path="/w/repo/a.md" />);
    const scroll = $('file-scroll')!;
    const tops = spyScroll(scroll);
    expect($('file-toc-rail')).toBeNull();
    act(() => $('file-toc-button')!.click());
    await tick();
    const items = $$('toc-item');
    expect(items.map((i) => i.dataset['slug'])).toEqual(['总览', '安装步骤', '用法', '用法-1']);
    act(() => items[1]!.click());
    expect(tops).toHaveLength(1);
    // 点完弹层关闭
    await tick();
    expect($$('toc-item')).toHaveLength(0);

    act(() => root!.render(<FileLinksContext.Provider value={{ open: () => {} }}><Doc path="/w/repo/short.md" /></FileLinksContext.Provider>));
    await tick();
    expect($('file-toc-button')).toBeNull();
  });

  test('宽容器：右侧 sticky 栏，没有浮动按钮', async () => {
    setup({ '/w/repo/a.md': DOC });
    const proto = window.HTMLElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 1200 });
    try {
      await mount(<Doc path="/w/repo/a.md" />);
      expect($('file-toc-rail')).not.toBeNull();
      expect($('file-toc-button')).toBeNull();
      expect($$('toc-item', $('file-toc-rail')!)).toHaveLength(4);
    } finally {
      if (original === undefined) delete (proto as { clientWidth?: number }).clientWidth;
      else Object.defineProperty(proto, 'clientWidth', original);
    }
  });

  test('同文件锚点（百分号编码）在容器内定位，不走打开 intent；找不到给提示', async () => {
    setup({ '/w/repo/a.md': DOC });
    const intents: FileOpenIntent[] = [];
    await mount(<Doc path="/w/repo/a.md" />, intents);
    const tops = spyScroll($('file-scroll')!);
    const links = $$('file-anchor-link');
    expect(links.map((l) => l.dataset['fragment'])).toEqual(['用法', 'nope']);
    act(() => links[0]!.click());
    expect(tops).toHaveLength(1);
    expect($('file-anchor-missing')).toBeNull();
    act(() => links[1]!.click());
    expect($('file-anchor-missing')?.textContent).toContain('nope');
    expect(intents).toEqual([]);
    expect(location.hash).toBe('');
  });

  test('intent 带来的锚点：加载并渲染后定位一次；对不上给提示', async () => {
    setup({ '/w/repo/a.md': DOC });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const tops: number[] = [];
    // 先拿到滚动容器再让内容加载：首帧同步渲染后立刻装上记录
    act(() => root!.render(<FileLinksContext.Provider value={{ open: () => {} }}><Doc path="/w/repo/a.md" fragment="%E5%AE%89%E8%A3%85%E6%AD%A5%E9%AA%A4" /></FileLinksContext.Provider>));
    $('file-scroll')!.scrollTo = ((o: ScrollToOptions) => void tops.push(o.top ?? -1)) as never;
    await tick();
    expect(tops).toHaveLength(1);
    expect($('file-anchor-missing')).toBeNull();
    // 再渲染不会重复定位
    await tick();
    expect(tops).toHaveLength(1);

    act(() => root!.render(<FileLinksContext.Provider value={{ open: () => {} }}><Doc key="x" path="/w/repo/a.md" fragment="已删除的一节" /></FileLinksContext.Provider>));
    await tick();
    expect($('file-anchor-missing')?.textContent).toContain('已删除的一节');
  });

  test('源码模式下锚点挂起，切回渲染再定位；源码模式没有目录', async () => {
    setup({ '/w/repo/a.md': DOC });
    await mount(<Doc path="/w/repo/a.md" fragment="用法" initial={{ mode: 'source' }} />);
    expect($('file-text')).not.toBeNull();
    expect($('file-toc-button')).toBeNull();
    const tops = spyScroll($('file-scroll')!);
    act(() => $('file-toggle-source')!.click());
    await tick();
    expect($('file-toc-button')).not.toBeNull();
    expect(tops).toHaveLength(1);
    expect($('file-anchor-missing')).toBeNull();
  });

  test('刷新后标题变了：目录跟着变，旧锚点提示找不到', async () => {
    const contents = { '/w/repo/a.md': DOC };
    setup(contents);
    await mount(<Doc path="/w/repo/a.md" />);
    contents['/w/repo/a.md'] = '# 新标题\n\n## 甲\n\n## 乙\n\n[旧](#安装步骤)';
    act(() => $('file-refresh')!.click());
    await tick();
    act(() => $('file-toc-button')!.click());
    await tick();
    expect($$('toc-item').map((i) => i.dataset['slug'])).toEqual(['新标题', '甲', '乙']);
    spyScroll($('file-scroll')!);
    act(() => $('file-anchor-link')!.click());
    expect($('file-anchor-missing')?.textContent).toContain('安装步骤');
  });

  test('两个预览实例：标题 id 各带前缀，不冲突', async () => {
    setup({ '/w/repo/a.md': DOC });
    await mount(
      <>
        <Doc path="/w/repo/a.md" />
        <Doc path="/w/repo/a.md" />
      </>,
    );
    const ids = [...document.querySelectorAll('h2[data-heading-slug="安装步骤"]')].map((h) => h.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids.every((id) => id.endsWith('-安装步骤'))).toBe(true);
  });
});

describe('FilePanel（抽屉外壳）', () => {
  test('文件视图有 Dialog 标题；带锚点打开时定位', async () => {
    setup({ '/w/repo/a.md': DOC });
    await mount(
      <MemoryRouter>
        <FilePanel machineId="m" sessionId="s1" view={{ kind: 'file', path: '/w/repo/a.md', fragment: '用法' }} onNavigate={() => {}} onClose={() => {}} />
      </MemoryRouter>,
    );
    const panel = $('file-panel')!;
    const labelled = panel.getAttribute('aria-labelledby');
    expect(labelled).not.toBeNull();
    expect(document.getElementById(labelled!)?.textContent).toBe('a.md');
    expect($('file-anchor-missing')).toBeNull();
  });
});

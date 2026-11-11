/**
 * 文件视图的滚动 / 目录 / 锚点**行为**（评审 C1 的 7 条）：在一个假布局上断言实际位置、
 * 当前节高亮、焦点、恢复取消与清理，而不是数 scrollTo 调用。
 *
 * 假布局：预览里每个可定位元素（标题、带 id 的元素）按文档顺序每隔 STEP 像素排一个，
 * 位置 = 文档位置 - 容器 scrollTop；容器高 VIEW_H；scrollTo 直接改 scrollTop 并派发 scroll 事件。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { FsFile } from '@trine/core';
import type { OpenedFile } from '@/lib/client.ts';
import type { FileOpenIntent } from './file-links.ts';
import type { FileDocModel } from './view-model.ts';

await import('@/lib/dom-test-env.ts');
const { act, useRef, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router');
const { runtimeState } = await import('@/app/runtime.ts');
const { FileLinksContext } = await import('./file-links.ts');
const { FileDocView } = await import('./FileDocView.tsx');
const { FilePanel } = await import('./FilePanel.tsx');
const { DEFAULT_DOC_MODEL, useScrollMemory } = await import('./view-model.ts');

const STEP = 300;
let VIEW_H = 400;

type Root = ReturnType<typeof createRoot>;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let restoreLayout: (() => void) | null = null;
/** 每个测试可调：容器内容高度（滚动恢复用） */
let contentHeight = 10_000;
/** 每个测试可调：容器宽度（宽 = 目录侧栏） */
let viewWidth = 1200;

function anchorTop(el: HTMLElement): number | undefined {
  const preview = el.closest('[data-file-preview]');
  if (preview === null || !el.matches('[data-heading-slug], [id]')) return undefined;
  const all = [...preview.querySelectorAll('[data-heading-slug], [id]')];
  return all.indexOf(el) * STEP;
}

function installLayout(): () => void {
  const proto = window.HTMLElement.prototype;
  const saved = (['getBoundingClientRect', 'scrollTo', 'clientHeight', 'clientWidth', 'scrollHeight'] as const).map(
    (k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const,
  );
  const scroller = (el: HTMLElement): HTMLElement | null => el.closest<HTMLElement>('[data-testid="file-scroll"], [data-testid="harness"]');
  Object.defineProperty(proto, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      const doc = anchorTop(this);
      const top = doc === undefined ? 0 : doc - (scroller(this)?.scrollTop ?? 0);
      return { top, bottom: top + 20, left: 0, right: 0, width: 0, height: 20, x: 0, y: top, toJSON: () => ({}) };
    },
  });
  Object.defineProperty(proto, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, opts: ScrollToOptions) {
      this.scrollTop = opts.top ?? 0;
      this.dispatchEvent(new window.Event('scroll'));
    },
  });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => VIEW_H });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => viewWidth });
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => contentHeight });
  return () => {
    for (const [k, d] of saved) {
      if (d === undefined) delete (proto as unknown as Record<string, unknown>)[k];
      else Object.defineProperty(proto, k, d);
    }
  };
}

beforeEach(() => {
  VIEW_H = 400;
  contentHeight = 10_000;
  viewWidth = 1200;
  restoreLayout = installLayout();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  restoreLayout?.();
  act(() => runtimeState.setState({ client: null }));
});

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

function setup(contents: Record<string, string>): void {
  const client = {
    on: () => () => {},
    openFile: async (_m: string, _s: string, path: string) => {
      const c = contents[path];
      if (c === undefined) throw new Error('不存在');
      return opened(path, c);
    },
    listFiles: async (_m: string, _s: string, path?: string) => ({
      path: path ?? '/w/repo',
      root: '/w/repo',
      truncated: false,
      entries: [
        { name: 'docs', type: 'dir', mtime: 1 },
        { name: 'a.md', type: 'file', size: 1, mtime: 1 },
      ],
    }),
  };
  act(() => runtimeState.setState({ client: client as never }));
}

const wait = (ms: number): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await wait(0);
  await wait(30);
};
const $ = (id: string, el: ParentNode = document): HTMLElement | null => el.querySelector(`[data-testid="${id}"]`);
const $$ = (id: string, el: ParentNode = document): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const heading = (slug: string): HTMLElement => document.querySelector<HTMLElement>(`[data-file-preview] [data-heading-slug="${slug}"]`)!;
const activeSlug = (): string | undefined => document.querySelector<HTMLElement>('[data-testid="toc-item"][aria-current="location"]')?.dataset['slug'];
const scroller = (): HTMLElement => $('file-scroll')!;

/** 用户滚到某处：改 scrollTop + scroll 事件 */
function userScroll(el: HTMLElement, top: number): void {
  act(() => {
    el.scrollTop = top;
    el.dispatchEvent(new window.Event('scroll'));
  });
}

// 标题顺序与假布局位置：总览 0、安装步骤 300、用法 600、用法-1 900
const DOC = ['# 总览', '', '## 安装步骤', '', '见 [用法](#%E7%94%A8%E6%B3%95)', '', '## 用法', '', '### 用法', ''].join('\n');

function Doc({ path, fragment, initial }: { path: string; fragment?: string; initial?: Partial<FileDocModel> }): React.JSX.Element {
  const [model, setModel] = useState<FileDocModel>({ ...DEFAULT_DOC_MODEL, ...initial });
  return (
    <FileDocView
      machineId="m"
      sessionId="s1"
      path={path}
      {...(fragment === undefined ? {} : { fragment })}
      model={model}
      onModelChange={(p) => setModel((m) => ({ ...m, ...p }))}
      onBrowse={() => {}}
    />
  );
}

async function mount(node: React.ReactNode, intents: FileOpenIntent[] = []): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<FileLinksContext.Provider value={{ open: (i) => void intents.push(i) }}>{node}</FileLinksContext.Provider>));
  await settle();
}

describe('1 · 当前节高亮以阅读线为准', () => {
  test('只滚动（不触发 IO）也会更新；容器尺寸变化重算', async () => {
    setup({ '/w/a.md': DOC });
    await mount(<Doc path="/w/a.md" />);
    expect($('file-toc-rail')).not.toBeNull();
    expect(activeSlug()).toBe('总览');
    // 用法（600）越过阅读线（96），用法-1（900 → 250）还没有
    userScroll(scroller(), 650);
    await settle();
    expect(activeSlug()).toBe('用法');
    // 安装步骤（300 → 120）还在阅读线下
    userScroll(scroller(), 180);
    await settle();
    expect(activeSlug()).toBe('总览');
    userScroll(scroller(), 220);
    await settle();
    expect(activeSlug()).toBe('安装步骤');
  });

  test('容器尺寸变化（ResizeObserver）重算：变矮后阅读线上移', async () => {
    const callbacks: (() => void)[] = [];
    const Original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      constructor(cb: () => void) {
        callbacks.push(cb);
      }
      observe(): void {}
      disconnect(): void {}
    };
    try {
      setup({ '/w/a.md': DOC });
      await mount(<Doc path="/w/a.md" />);
      // 安装步骤在 80：高 400 时阅读线 96 → 已读到
      userScroll(scroller(), 220);
      await settle();
      expect(activeSlug()).toBe('安装步骤');
      // 变矮到 200：阅读线 = 200 × 0.3 = 60，80 没越过
      VIEW_H = 200;
      act(() => callbacks.forEach((cb) => cb()));
      await settle();
      expect(activeSlug()).toBe('总览');
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = Original;
    }
  });

  test('一帧内的多次 scroll 只算一次（rAF 合并）', async () => {
    setup({ '/w/a.md': DOC });
    await mount(<Doc path="/w/a.md" />);
    const el = scroller();
    let reads = 0;
    const orig = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'getBoundingClientRect')!;
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) {
        reads += 1;
        return (orig.value as () => DOMRect).call(this);
      },
    });
    act(() => {
      for (const top of [100, 200, 300, 610]) {
        el.scrollTop = top;
        el.dispatchEvent(new window.Event('scroll'));
      }
    });
    expect(reads).toBe(0);
    await settle();
    expect(reads).toBe(1);
    expect(activeSlug()).toBe('用法');
  });
});

describe('7 · 目录跳转：位置、高亮、焦点', () => {
  test('侧栏：滚到目标（相对容器，留 8px），高亮目标，焦点移到标题', async () => {
    setup({ '/w/a.md': DOC });
    await mount(<Doc path="/w/a.md" />);
    const item = $$('toc-item').find((i) => i.dataset['slug'] === '用法-1')!;
    act(() => item.focus());
    act(() => item.click());
    await settle();
    expect(scroller().scrollTop).toBe(900 - 8);
    expect(activeSlug()).toBe('用法-1');
    expect(document.activeElement).toBe(heading('用法-1'));
    expect(heading('用法-1').tabIndex).toBe(-1);
  });

  test('弹层：选项后弹层关闭，焦点留在目标标题，不回到按钮', async () => {
    viewWidth = 400;
    setup({ '/w/a.md': DOC });
    await mount(<Doc path="/w/a.md" />);
    const button = $('file-toc-button')!;
    act(() => button.focus());
    act(() => button.click());
    await settle();
    act(() => $$('toc-item').find((i) => i.dataset['slug'] === '安装步骤')!.click());
    await settle();
    expect($$('toc-item')).toHaveLength(0);
    expect(scroller().scrollTop).toBe(300 - 8);
    expect(document.activeElement).toBe(heading('安装步骤'));
  });
});

describe('4 / 6 · 锚点匹配顺序与 raw HTML 显式 id', () => {
  test('精确 id 先于标题的大小写兼容：#FAQ 落到 <p id="FAQ">', async () => {
    // 位置：FAQ 标题 0，p#FAQ 300，标题 二 600，标题 三 900
    const md = ['## faq', '', '<p id="FAQ">原始锚点</p>', '', '## 二', '', '## 三', '', '[去](#FAQ) [小写](#faq)'].join('\n');
    setup({ '/w/a.md': md });
    await mount(<Doc path="/w/a.md" />);
    const [upper, lower] = $$('file-anchor-link');
    act(() => upper!.click());
    expect(scroller().scrollTop).toBe(300 - 8);
    expect(document.activeElement?.id).toBe('FAQ');
    act(() => lower!.click());
    expect(scroller().scrollTop).toBe(0);
    expect(document.activeElement).toBe(heading('faq'));
  });

  test('<h2 id="custom">：#custom 能定位到它，DOM id 仍是实例前缀 + slug', async () => {
    const md = ['## 一', '', '## 二', '', '<h2 id="custom">Actual title</h2>', '', '[c](#custom)'].join('\n');
    setup({ '/w/a.md': md });
    await mount(<Doc path="/w/a.md" />);
    const h = heading('actual-title');
    expect(h.dataset['anchorId']).toBe('custom');
    expect(h.id).not.toBe('custom');
    expect(h.id.endsWith('-actual-title')).toBe(true);
    expect(document.getElementById('custom')).toBeNull();
    act(() => $('file-anchor-link')!.click());
    expect(scroller().scrollTop).toBe(600 - 8);
    expect($('file-anchor-missing')).toBeNull();
  });
});

describe('3 · 刷新后复核锚点', () => {
  test('目标还在：刷新后重新定位；之后无关的重渲染不再抢滚动；目标没了：提示刷新后失效', async () => {
    const contents = { '/w/a.md': DOC };
    setup(contents);
    await mount(<Doc path="/w/a.md" fragment="用法" />);
    expect(scroller().scrollTop).toBe(600 - 8);
    userScroll(scroller(), 40);

    // 内容变了，但「用法」还在（前面多了一节，位置往后挪）
    contents['/w/a.md'] = `## 新增\n\n${DOC}`;
    act(() => $('file-refresh')!.click());
    await settle();
    expect(scroller().scrollTop).toBe(900 - 8);
    userScroll(scroller(), 10);
    act(() => root!.render(<FileLinksContext.Provider value={{ open: () => {} }}><Doc path="/w/a.md" fragment="用法" /></FileLinksContext.Provider>));
    await settle();
    expect(scroller().scrollTop).toBe(10);

    contents['/w/a.md'] = '# 甲\n\n## 乙\n\n## 丙';
    act(() => $('file-refresh')!.click());
    await settle();
    const notice = $('file-anchor-missing');
    expect(notice?.dataset['reason']).toBe('refresh');
    expect(notice?.textContent).toContain('用法');
    expect(scroller().scrollTop).toBe(10);
  });

  test('刷新前的旧内容不算数：点刷新的那一刻不会对旧 DOM 复核', async () => {
    const contents = { '/w/a.md': DOC };
    setup(contents);
    await mount(<Doc path="/w/a.md" fragment="用法" />);
    userScroll(scroller(), 40);
    contents['/w/a.md'] = '# 甲\n\n## 乙\n\n## 丙';
    act(() => $('file-refresh')!.click());
    // 还没加载完：既没重新定位，也没提示
    expect(scroller().scrollTop).toBe(40);
    expect($('file-anchor-missing')).toBeNull();
    await settle();
    expect($('file-anchor-missing')?.dataset['reason']).toBe('refresh');
  });
});

describe('5 · 修饰键走完整 intent；显式 side 优先于同文件跳转', () => {
  const MD = ['# 一', '', '## 二', '', '## 三', '', '[本节](#三) [本文](./a.md#二) [别处](./b.md#x)'].join('\n');
  const alt = (el: HTMLElement): void => act(() => void el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true })));

  test('同文件锚点、a.md#x、目录项：Alt = side intent（不滚动）；普通点击就地定位', async () => {
    setup({ '/w/a.md': MD });
    const intents: FileOpenIntent[] = [];
    await mount(<Doc path="/w/a.md" />, intents);
    const hash = $('file-anchor-link')!;
    const self = $$('file-link').find((l) => l.dataset['path'] === '/w/a.md')!;
    const other = $$('file-link').find((l) => l.dataset['path'] === '/w/b.md')!;
    const tocItem = $$('toc-item').find((i) => i.dataset['slug'] === '三')!;
    alt(hash);
    alt(self);
    alt(tocItem);
    alt(other);
    expect(scroller().scrollTop).toBe(0);
    expect(intents).toEqual([
      { path: '/w/a.md', fragment: '三', target: 'side' },
      { path: '/w/a.md', fragment: '二', target: 'side' },
      { path: '/w/a.md', fragment: '三', target: 'side' },
      { path: '/w/b.md', fragment: 'x', target: 'side' },
    ]);
    act(() => self.click());
    expect(scroller().scrollTop).toBe(300 - 8);
    act(() => other.click());
    expect(intents.at(-1)).toEqual({ path: '/w/b.md', fragment: 'x', target: 'auto' });
  });

  test('抽屉目录条目：Alt 走 side intent，普通点击就地导航', async () => {
    setup({});
    const intents: FileOpenIntent[] = [];
    const nav: unknown[] = [];
    await mount(
      <MemoryRouter>
        <FilePanel machineId="m" sessionId="s1" view={{ kind: 'dir' }} onNavigate={(v) => void nav.push(v)} onClose={() => {}} />
      </MemoryRouter>,
      intents,
    );
    const [dir, file] = $$('file-entry');
    alt(file!);
    alt(dir!);
    expect(intents).toEqual([
      { path: '/w/repo/a.md', target: 'side' },
      { dir: true, path: '/w/repo/docs', target: 'side' },
    ]);
    expect(nav).toEqual([]);
    act(() => file!.click());
    act(() => dir!.click());
    expect(nav).toEqual([
      { kind: 'file', path: '/w/repo/a.md' },
      { kind: 'dir', path: '/w/repo/docs' },
    ]);
  });
});

describe('2 · 滚动恢复：用户输入立即取消，只过滤程序滚动', () => {
  function Harness({ initial, ready, reports, timeoutMs, extra }: { initial: number; ready: boolean; reports: number[]; timeoutMs?: number; extra: number }): React.JSX.Element {
    const ref = useRef<HTMLDivElement | null>(null);
    const onScroll = useScrollMemory(ref, initial, ready, (t) => void reports.push(t), timeoutMs === undefined ? {} : { restoreTimeoutMs: timeoutMs });
    return (
      <div ref={ref} data-testid="harness" onScroll={onScroll}>
        {Array.from({ length: extra }, (_, i) => (
          <p key={i}>行 {i}</p>
        ))}
      </div>
    );
  }

  async function mountHarness(props: Parameters<typeof Harness>[0]): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Harness {...props} />));
    await settle();
    return $('harness')!;
  }

  test('内容不够高时挂起；程序滚动不记录；wheel 取消并保存实际位置；之后不再拉回；卸载保存用户位置', async () => {
    contentHeight = 300; // 300 - 400 < 200：一直够不到
    const reports: number[] = [];
    const el = await mountHarness({ initial: 200, ready: true, reports, extra: 1 });
    expect(el.scrollTop).toBe(200);
    // 自己设的位置引起的 scroll：不记录
    act(() => void el.dispatchEvent(new window.Event('scroll')));
    await wait(200);
    expect(reports).toEqual([]);
    // 用户滚轮：立即取消，记下当时的实际位置
    act(() => void el.dispatchEvent(new window.Event('wheel')));
    await wait(200);
    expect(reports).toEqual([200]);
    userScroll(el, 20);
    // 子树变化（内容继续加载）不再把位置拉回 200
    act(() => root!.render(<Harness initial={200} ready reports={reports} extra={5} />));
    await settle();
    expect(el.scrollTop).toBe(20);
    act(() => root!.unmount());
    root = null;
    expect(reports.at(-1)).toBe(20);
  });

  test('别的位置的滚动（查找、辅助技术）也取消恢复；拖滚动条（pointerdown 落在容器上）取消', async () => {
    contentHeight = 300;
    const reports: number[] = [];
    const el = await mountHarness({ initial: 200, ready: true, reports, extra: 1 });
    userScroll(el, 120);
    act(() => root!.render(<Harness initial={200} ready reports={reports} extra={4} />));
    await settle();
    expect(el.scrollTop).toBe(120);
    await wait(200);
    expect(reports).toEqual([120]);

    act(() => root!.unmount());
    root = null;
    const reports2: number[] = [];
    const el2 = await mountHarness({ initial: 200, ready: true, reports: reports2, extra: 1 });
    // 落在子元素上的 pointerdown（点正文）不算拖滚动条
    act(() => void el2.querySelector('p')!.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
    await wait(200);
    expect(reports2).toEqual([]);
    act(() => void el2.dispatchEvent(new window.Event('pointerdown')));
    await wait(200);
    expect(reports2).toEqual([200]);
  });

  test('超时放弃：保存实际位置，并移除输入监听', async () => {
    contentHeight = 300;
    const reports: number[] = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Harness initial={200} ready={false} reports={reports} timeoutMs={30} extra={1} />));
    const el = $('harness')!;
    const added: string[] = [];
    const removed: string[] = [];
    const add = el.addEventListener.bind(el);
    const remove = el.removeEventListener.bind(el);
    el.addEventListener = ((t: string, l: EventListener, o?: AddEventListenerOptions) => (added.push(t), add(t, l, o))) as typeof el.addEventListener;
    el.removeEventListener = ((t: string, l: EventListener, o?: EventListenerOptions) => (removed.push(t), remove(t, l, o))) as typeof el.removeEventListener;
    act(() => root!.render(<Harness initial={200} ready reports={reports} timeoutMs={30} extra={1} />));
    await wait(250);
    expect(reports).toEqual([200]);
    for (const t of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
      expect(added).toContain(t);
      expect(removed).toContain(t);
    }
  });
});

describe('清理', () => {
  test('卸载后移除 scroll 监听，之后的滚动不再触发计算', async () => {
    setup({ '/w/a.md': DOC });
    await mount(<Doc path="/w/a.md" />);
    const el = scroller();
    const removed: string[] = [];
    const remove = el.removeEventListener.bind(el);
    el.removeEventListener = ((t: string, l: EventListener, o?: EventListenerOptions) => (removed.push(t), remove(t, l, o))) as typeof el.removeEventListener;
    act(() => root!.unmount());
    root = null;
    expect(removed).toContain('scroll');
  });
});

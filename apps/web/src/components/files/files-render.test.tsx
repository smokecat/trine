/**
 * 文件查看的渲染：工具卡的「预览」按钮（有无 provider）、目录列表（锁住的条目不能点）、
 * 文件正文按 kind 渲染（html 只显示源码、二进制只给下载）。DOM 测试同款：先注册 happy-dom。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { FsFile } from '@trine/core';
import type { ToolEntry } from '@/lib/reducer.ts';
import type { OpenedFile } from '@/lib/client.ts';

await import('@/lib/dom-test-env.ts');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
type Root = ReturnType<typeof createRoot>;
const { ToolCard } = await import('@/components/chat/ToolCard.tsx');
const { FileLinksContext } = await import('./file-links.ts');
const { FileList } = await import('./FileBrowser.tsx');
const { FileBody } = await import('./FileViewer.tsx');

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}
const $ = (el: ParentNode, id: string): HTMLElement | null => el.querySelector(`[data-testid="${id}"]`);
const tick = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 0)));

const tool = (extra: Partial<ToolEntry> = {}): ToolEntry => ({
  kind: 'tool',
  id: 't1',
  toolName: 'Read',
  argSummary: '…/docs/plan.md',
  status: 'ok',
  seq: 1,
  ts: 1,
  ...extra,
});

describe('ToolCard 文件预览入口', () => {
  test('有 filePath 且有 provider：按钮打开完整路径；没有 provider 或没有路径：不出现', () => {
    const opened: string[] = [];
    const links = { open: (p: string) => opened.push(p), browse: () => {} };
    const el = mount(
      <FileLinksContext.Provider value={links}>
        <ToolCard entry={tool({ filePath: '/w/repo/docs/plan.md' })} runningElapsedMs={null} />
      </FileLinksContext.Provider>,
    );
    act(() => $(el, 'tool-open-file')!.click());
    expect(opened).toEqual(['/w/repo/docs/plan.md']);
    act(() => root?.render(<ToolCard entry={tool({ filePath: '/w/repo/docs/plan.md' })} runningElapsedMs={null} />));
    expect($(el, 'tool-open-file')).toBeNull();
    act(() =>
      root?.render(
        <FileLinksContext.Provider value={links}>
          <ToolCard entry={tool({ toolName: 'Bash', argSummary: 'ls' })} runningElapsedMs={null} />
        </FileLinksContext.Provider>,
      ),
    );
    expect($(el, 'tool-open-file')).toBeNull();
  });
});

describe('FileList', () => {
  test('目录在前；锁住的条目禁用；点目录浏览、点文件打开；隐藏文件开关', () => {
    const browsed: string[] = [];
    const opened: string[] = [];
    const listing = {
      path: '/w/repo',
      root: '/w/repo',
      truncated: false,
      entries: [
        { name: 'docs', type: 'dir' as const, mtime: 1 },
        { name: '.env', type: 'file' as const, size: 3, denied: true },
        { name: 'README.md', type: 'file' as const, size: 12 },
        { name: 'keys', type: 'dir' as const, denied: true },
      ],
    };
    const el = mount(<FileList listing={listing} showHidden={false} onBrowse={(d) => browsed.push(d)} onOpen={(p) => opened.push(p)} now={10} />);
    const rows = Array.from(el.querySelectorAll<HTMLButtonElement>('[data-testid="file-entry"]'));
    expect(rows.map((r) => r.dataset['name'])).toEqual(['docs', 'README.md', 'keys']);
    expect(rows[2]!.disabled).toBe(true);
    act(() => rows[0]!.click());
    act(() => rows[1]!.click());
    act(() => rows[2]!.click());
    expect(browsed).toEqual(['/w/repo/docs']);
    expect(opened).toEqual(['/w/repo/README.md']);
    act(() => root?.render(<FileList listing={listing} showHidden onBrowse={() => {}} onOpen={() => {}} />));
    expect(el.querySelectorAll('[data-testid="file-entry"]')).toHaveLength(4);
  });
});

function opened(file: Partial<FsFile>, content: string | Uint8Array): OpenedFile {
  const f: FsFile = {
    path: '/w/repo/a.md',
    root: '/w/repo',
    name: 'a.md',
    size: typeof content === 'string' ? new TextEncoder().encode(content).length : content.length,
    mtime: 1,
    mime: 'text/markdown',
    kind: 'markdown',
    blobId: 'b'.repeat(22),
    key: 'k'.repeat(43),
    ...file,
  };
  return { file: f, blob: new Blob([content as BlobPart]), url: 'blob:test/1' };
}

describe('FileBody', () => {
  test('markdown：渲染；源码模式显示原文', async () => {
    const o = opened({}, '# 标题\n\n正文 **粗**');
    const el = mount(<FileBody opened={o} mode="rendered" wrap={false} />);
    await tick();
    expect($(el, 'file-markdown')?.querySelector('h1')?.textContent).toBe('标题');
    act(() => root?.render(<FileBody opened={o} mode="source" wrap />));
    await tick();
    expect($(el, 'file-text')?.textContent).toBe('# 标题\n\n正文 **粗**');
  });

  test('html 是文本：只显示源码，不渲染成 DOM', async () => {
    const html = '<script>window.__pwned = 1</script><h1>x</h1>';
    const el = mount(<FileBody opened={opened({ name: 'a.html', kind: 'text', mime: 'text/html' }, html)} mode="rendered" wrap />);
    await tick();
    expect($(el, 'file-text')?.textContent).toBe(html);
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('h1')).toBeNull();
  });

  test('二进制：只给下载', () => {
    const el = mount(<FileBody opened={opened({ name: 'a.bin', kind: 'binary', mime: 'application/octet-stream' }, new Uint8Array([0, 1]))} mode="rendered" wrap={false} />);
    const a = $(el, 'file-binary')?.querySelector('a');
    expect(a?.getAttribute('download')).toBe('a.bin');
    expect(a?.getAttribute('href')).toBe('blob:test/1');
  });

  test('图片：img 指向对象 URL', () => {
    const el = mount(<FileBody opened={opened({ name: 'x.svg', kind: 'image', mime: 'image/svg+xml' }, '<svg/>')} mode="rendered" wrap={false} />);
    expect($(el, 'file-image')?.getAttribute('src')).toBe('blob:test/1');
    expect(el.querySelector('svg')).toBeNull();
  });
});

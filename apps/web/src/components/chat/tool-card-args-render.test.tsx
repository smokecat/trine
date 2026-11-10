/**
 * 工具卡的完整参数：长 / 多行命令在折叠态只显示单行摘要，展开后能看全、能复制。
 * 与其他 DOM 测试同款：先注册 happy-dom，再动态 import react-dom。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ToolEntry } from '@/lib/reducer.ts';

await import('@/lib/dom-test-env.ts');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
type Root = ReturnType<typeof createRoot>;
const { ToolCard, fullArgText, ARG_EXPAND_MIN } = await import('./ToolCard.tsx');

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(entry: ToolEntry): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<ToolCard entry={entry} runningElapsedMs={null} />));
  return host;
}
const $ = (el: ParentNode, id: string): HTMLElement | null => el.querySelector(`[data-testid="${id}"]`);

const bash = (over: Partial<ToolEntry> = {}): ToolEntry => ({
  kind: 'tool',
  id: 't1',
  toolName: 'Bash',
  argSummary: 'ls',
  status: 'ok',
  seq: 1,
  ts: 0,
  ...over,
});

describe('ToolCard · 完整参数', () => {
  test('短命令、没有原文也没有输出：不可展开', () => {
    const el = mount(bash());
    expect(($(el, 'tool-header') as HTMLButtonElement).disabled).toBe(true);
  });

  test('有 argDetail：可展开，展开后保留换行显示原文，标题写「命令」', () => {
    const detail = 'cd /tmp/work\nbun run build && bun test --filter something-long';
    const el = mount(bash({ argSummary: 'cd /tmp/work bun run build && bun test --filter some…', argDetail: detail }));
    const header = $(el, 'tool-header') as HTMLButtonElement;
    expect(header.disabled).toBe(false);
    expect($(el, 'tool-args')).toBeNull();
    act(() => header.click());
    expect($(el, 'tool-args-text')!.textContent).toBe(detail);
    expect($(el, 'tool-args')!.textContent).toContain('命令');
    expect($(el, 'tool-args-copy')).not.toBeNull();
  });

  test('旧 agent 没有 argDetail：摘要较长时也能展开看全摘要', () => {
    const summary = `grep -rn ${'x'.repeat(ARG_EXPAND_MIN)}`;
    const el = mount(bash({ toolName: 'Grep', argSummary: summary }));
    act(() => ($(el, 'tool-header') as HTMLButtonElement).click());
    expect($(el, 'tool-args-text')!.textContent).toBe(summary);
    expect($(el, 'tool-args')!.textContent).toContain('参数');
  });

  test('fullArgText 口径', () => {
    expect(fullArgText({ argSummary: 'ls' })).toBeUndefined();
    expect(fullArgText({ argSummary: 'ls', argDetail: 'ls\n-la' })).toBe('ls\n-la');
    expect(fullArgText({ argSummary: 'y'.repeat(ARG_EXPAND_MIN + 1) })).toBe('y'.repeat(ARG_EXPAND_MIN + 1));
  });
});

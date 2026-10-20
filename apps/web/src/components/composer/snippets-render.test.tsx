/**
 * prompt 片段与输入区布局：PC 卡片工具栏 / 移动端「+」托盘、片段插入与复制。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';

// radix 在模块初始化时探测 DOM，静态 import 会先于 dom-test-env（同 attachments-render.test.tsx）
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Composer } = await import('./Composer.tsx');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

type Viewport = { setViewport: (v: { width: number; height: number }) => void };
const setWidth = (width: number) => (window as unknown as { happyDOM: Viewport }).happyDOM.setViewport({ width, height: 800 });

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setWidth(1024);
});

const $ = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const $$ = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)];
const click = (id: string, index = 0) => act(() => ($$(id)[index] as HTMLElement).click());

const SNIPPETS = ['跑测试，修掉失败的用例', '先读代码再动手'];

function renderComposer(initial: string) {
  let value = initial;
  const onChange = mock((text: string) => {
    value = text;
    rerender();
  });
  const onManage = mock(() => {});
  const node = () => (
    <Composer
      value={value}
      onChange={onChange}
      onSend={() => {}}
      onStop={() => {}}
      onSlashPick={() => {}}
      running={false}
      offlineHint={null}
      sources={{ slashCommands: [] }}
      snippets={SNIPPETS}
      onManageSnippets={onManage}
      sendKey="enter"
      attachments={{ drafts: [], ready: true, onAdd: () => {}, onRemove: () => {}, onRetry: () => {} }}
    />
  );
  const rerender = () => act(() => root!.render(node()));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  rerender();
  return { onChange, onManage, value: () => value };
}

describe('PC 布局', () => {
  test('卡片里一行工具栏：附件与 prompt 在左，发送在右；没有「+」', () => {
    renderComposer('');
    const toolbar = $('composer-toolbar')!;
    expect($('composer-card')?.contains($('composer'))).toBe(true);
    expect(toolbar.contains($('attach'))).toBe(true);
    expect(toolbar.contains($('snippet-toggle'))).toBe(true);
    expect(toolbar.contains($('send'))).toBe(true);
    expect($('composer-more')).toBeNull();
  });

  test('点片段插入光标处并收起面板；输入框末尾非空白先换行', () => {
    const r = renderComposer('先看看');
    click('snippet-toggle');
    expect($$('snippet-item').map((e) => e.textContent)).toEqual(SNIPPETS);
    click('snippet-item', 1);
    expect(r.value()).toBe('先看看\n先读代码再动手');
    expect($('snippet-picker')).toBeNull();
  });

  test('插在失焦前的光标位置', () => {
    const r = renderComposer('ab');
    const textarea = $('composer') as HTMLTextAreaElement;
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(1, 1);
      textarea.blur();
    });
    click('snippet-toggle');
    click('snippet-item', 0);
    expect(r.value()).toBe('a跑测试，修掉失败的用例b');
  });

  test('复制不改输入框；「管理」交给外面', async () => {
    const writeText = mock(async (_: string) => {});
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    const prevClipboard = Object.getOwnPropertyDescriptor(nav, 'clipboard');
    const prevSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
    Object.defineProperty(nav, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    try {
      const r = renderComposer('');
      click('snippet-toggle');
      await act(async () => ($$('snippet-copy')[0] as HTMLElement).click());
      expect(writeText).toHaveBeenCalledWith(SNIPPETS[0]!);
      expect(r.onChange).not.toHaveBeenCalled();
      click('snippet-manage');
      expect(r.onManage).toHaveBeenCalled();
      expect($('snippet-picker')).toBeNull();
    } finally {
      if (prevClipboard === undefined) delete nav.clipboard;
      else Object.defineProperty(nav, 'clipboard', prevClipboard);
      if (prevSecure === undefined) delete (window as unknown as Record<string, unknown>).isSecureContext;
      else Object.defineProperty(window, 'isSecureContext', prevSecure);
    }
  });

  test('点输入区外面收起面板', () => {
    renderComposer('');
    click('snippet-toggle');
    expect($('snippet-picker')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect($('snippet-picker')).toBeNull();
  });
});

describe('移动端布局', () => {
  beforeEach(() => setWidth(400));

  test('附件与 prompt 收在「+」里：点开展开托盘，再点收起', () => {
    renderComposer('');
    const tray = $('composer-tray')!;
    expect(tray.getAttribute('data-open')).toBe('false');
    expect(tray.contains($('attach'))).toBe(true);
    expect(tray.contains($('attach-image'))).toBe(true);
    click('composer-more');
    expect(tray.getAttribute('data-open')).toBe('true');
    expect($('composer-more')?.getAttribute('aria-expanded')).toBe('true');
    click('composer-more');
    expect(tray.getAttribute('data-open')).toBe('false');
  });

  test('托盘里点 Prompt：托盘收起、面板打开，选中后插入', () => {
    const r = renderComposer('');
    click('composer-more');
    click('snippet-toggle');
    expect($('composer-tray')?.getAttribute('data-open')).toBe('false');
    click('snippet-item', 0);
    expect(r.value()).toBe(SNIPPETS[0]!);
  });
});

/**
 * 输入框的扩展入口（U9）：有 extraPicker 才出现按钮；点开在片段面板的位置渲染内容，与片段面板互斥；
 * 内容里调 close 收起。插入走 insertRequest（同扩展面板）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';

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

function renderComposer(options: { picker: boolean; insertRequest?: { id: number; text: string } }) {
  let value = '已有文字';
  let insert = options.insertRequest;
  const node = () => (
    <Composer
      value={value}
      onChange={(text) => {
        value = text;
        rerender();
      }}
      onSend={() => {}}
      onStop={() => {}}
      onSlashPick={() => {}}
      running={false}
      offlineHint={null}
      sources={{ slashCommands: [] }}
      snippets={[]}
      sendKey="enter"
      insertRequest={insert}
      extraPicker={
        options.picker
          ? {
              label: '任务',
              render: (close) => (
                <button type="button" data-testid="fake-item" onClick={close}>
                  任务 A
                </button>
              ),
            }
          : undefined
      }
    />
  );
  const rerender = () => act(() => root!.render(node()));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  rerender();
  return {
    value: () => value,
    setInsert: (req: { id: number; text: string }) => {
      insert = req;
      rerender();
    },
  };
}

describe('Composer · 扩展入口（U9）', () => {
  test('没有 extraPicker 时没有按钮', () => {
    renderComposer({ picker: false });
    expect($('composer-ext-toggle')).toBeNull();
  });

  test('点开渲染扩展内容，与片段面板互斥；内容里 close 收起', () => {
    renderComposer({ picker: true });
    act(() => ($('snippet-toggle') as HTMLElement).click());
    expect($('snippet-picker')).not.toBeNull();
    act(() => ($('composer-ext-toggle') as HTMLElement).click());
    expect($('snippet-picker')).toBeNull();
    expect($('composer-ext-picker')?.getAttribute('aria-label')).toBe('任务');
    act(() => ($('fake-item') as HTMLElement).click());
    expect($('composer-ext-picker')).toBeNull();
  });

  test('手机：按钮在「+」托盘里', () => {
    setWidth(390);
    renderComposer({ picker: true });
    const tray = $('composer-tray');
    expect(tray?.querySelector('[data-testid="composer-ext-toggle"]')).not.toBeNull();
  });

  test('insertRequest：按片段规则插到末尾（另起一行），同一个 id 只插一次', () => {
    const h = renderComposer({ picker: true });
    h.setInsert({ id: 1, text: '.local/tasks/a/README.md' });
    expect(h.value()).toBe('已有文字\n.local/tasks/a/README.md');
    h.setInsert({ id: 1, text: '.local/tasks/a/README.md' });
    expect(h.value()).toBe('已有文字\n.local/tasks/a/README.md');
  });
});

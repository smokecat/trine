/**
 * 排队托盘渲染：行 / 状态 / 动作按钮，以及它在输入框里的位置与 ↑ 编辑。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import type { UserEntry } from '@/lib/reducer.ts';
import '@/lib/dom-test-env.ts';

// radix 在模块初始化时探测 DOM，静态 import 会先于 dom-test-env（同 snippets-render.test.tsx）
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PendingTray } = await import('./PendingTray.tsx');
const { Composer } = await import('../composer/Composer.tsx');

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

const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const $$ = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

const entry = (id: string, over: Partial<UserEntry> = {}): UserEntry => ({
  kind: 'user',
  id,
  text: `消息 ${id}`,
  local: true,
  status: 'queued',
  seq: 0,
  ts: 0,
  ...over,
});

function mount(node: React.ReactNode): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

describe('PendingTray', () => {
  test('按发送顺序编号；排队中的有编辑 + 撤回，点了回调带上条目', () => {
    const onAction = mock((_kind: string, _entry: UserEntry) => {});
    mount(<PendingTray entries={[entry('a'), entry('b', { status: 'cancelled', failReason: '已停止，未发送' })]} onAction={onAction} />);
    const items = $$('pending-item');
    expect(items.map((li) => li.dataset.status)).toEqual(['queued', 'cancelled']);
    expect($('pending-headline')?.textContent).toBe('1 条排队中 · 当前任务结束后依次发送 · 1 条未发送');
    expect(items[0]!.textContent).toContain('消息 a');
    expect(items[1]!.textContent).toContain('已停止，未发送');

    const actions = (li: HTMLElement) => [...li.querySelectorAll<HTMLElement>('button[data-testid^="pending-"]')].map((b) => b.dataset.testid);
    expect(actions(items[0]!)).toEqual(['pending-text', 'pending-edit', 'pending-recall']);
    expect(actions(items[1]!)).toEqual(['pending-text', 'pending-resend', 'pending-edit', 'pending-discard']);

    act(() => items[0]!.querySelector<HTMLElement>('[data-testid="pending-recall"]')!.click());
    expect(onAction.mock.calls[0]?.[0]).toBe('recall');
    expect(onAction.mock.calls[0]?.[1]).toMatchObject({ id: 'a' });
  });

  test('撤回中：转圈、没有动作按钮', () => {
    mount(<PendingTray entries={[entry('a', { recallingAt: Date.now() })]} onAction={() => {}} />);
    const li = $('pending-item')!;
    expect(li.dataset.busy).toBe('true');
    expect($('pending-status')?.textContent).toBe('撤回中…');
    expect($('pending-recall')).toBeNull();
  });

  test('点正文展开全文，再点收起', () => {
    mount(<PendingTray entries={[entry('a', { text: '很长的一段\n第二行' })]} onAction={() => {}} />);
    const text = $('pending-text')!;
    expect(text.getAttribute('aria-expanded')).toBe('false');
    act(() => text.click());
    expect(text.getAttribute('aria-expanded')).toBe('true');
    act(() => text.click());
    expect(text.getAttribute('aria-expanded')).toBe('false');
  });

  test('没有条目不渲染', () => {
    mount(<PendingTray entries={[]} onAction={() => {}} />);
    expect($('pending-tray')).toBeNull();
  });
});

describe('Composer · 排队托盘', () => {
  function renderComposer(value: string, onEditLast: () => boolean, width = 1024) {
    setWidth(width);
    mount(
      <Composer
        value={value}
        onChange={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        onSlashPick={() => {}}
        running
        offlineHint={null}
        sources={{ slashCommands: [] }}
        snippets={[]}
        sendKey="enter"
        pending={<PendingTray entries={[entry('a')]} onAction={() => {}} />}
        onEditLast={onEditLast}
      />,
    );
  }
  const keyDown = (key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => void $('composer')!.dispatchEvent(event));
    return event;
  };

  test('PC：托盘在输入卡片正上方', () => {
    renderComposer('', () => false);
    const tray = $('pending-tray')!;
    const card = $('composer-card')!;
    expect(tray.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.contains(tray)).toBe(false);
  });

  test('移动端也在输入行上方', () => {
    renderComposer('', () => false, 390);
    const tray = $('pending-tray')!;
    expect(tray.compareDocumentPosition($('composer')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('空输入框按 ↑ 交给 onEditLast；接手了就不再当成光标移动', () => {
    const onEditLast = mock(() => true);
    renderComposer('', onEditLast);
    expect(keyDown('ArrowUp').defaultPrevented).toBe(true);
    expect(onEditLast).toHaveBeenCalledTimes(1);
  });

  test('有字时 ↑ 照常移动光标，不碰排队消息', () => {
    const onEditLast = mock(() => true);
    renderComposer('写了一半', onEditLast);
    expect(keyDown('ArrowUp').defaultPrevented).toBe(false);
    expect(onEditLast).not.toHaveBeenCalled();
  });
});

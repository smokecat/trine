/**
 * 聊天页头部「⋯」会话菜单（session-list-v2 §4.4 末句）：缺回调隐藏、归档态切换、
 * 运行中灰显仍可点（评审 M3）。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';
import type { SessionMeta } from '@trine/core';

// react-dom 必须在 DOM 环境装好之后再加载（learnings 2026-09-25）
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SessionHeadMenu } = await import('./SessionHeadMenu.tsx');
type Actions = import('@/components/list/SessionRowMenu.tsx').SessionRowActions;

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  sessionId: 's',
  title: 't',
  state: 'idle',
  lastActivityAt: 1,
  cwd: '/',
  model: '',
  permissionMode: 'default',
  costUsd: 0,
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(actions: Actions, m: SessionMeta | undefined, onRequestRename = () => {}): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(<SessionHeadMenu machineId="m" sessionId="s" meta={m} actions={actions} onRequestRename={onRequestRename} />),
  );
}
const $ = (id: string): HTMLElement | null => document.body.querySelector(`[data-testid="${id}"]`);
/** Radix 触发器在 pointerdown 时开合；popper 的定位是异步的，一并在 act 里冲掉 */
async function open(): Promise<void> {
  await act(async () => {
    $('session-head-menu')!.dispatchEvent(
      new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }),
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('SessionHeadMenu', () => {
  test('一个回调都没有（旧 agent / 从标签页）→ 不渲染按钮', () => {
    render({}, meta());
    expect($('session-head-menu')).toBeNull();
  });

  test('未归档给「归档」，运行中灰显仍可点', async () => {
    const onRequestRename = mock(() => {});
    const onArchive = mock((_m: string, _s: string, _a: boolean) => {});
    render({ onRename: () => {}, onArchive }, meta({ state: 'running' }), onRequestRename);
    await open();
    expect($('head-menu-unarchive')).toBeNull();
    const archive = $('head-menu-archive')!;
    expect(archive.dataset['likelyBusy']).toBe('true');
    act(() => archive.click());
    expect(onArchive).toHaveBeenCalledWith('m', 's', true);
    expect(onRequestRename).not.toHaveBeenCalled();
  });

  test('重命名 → 交给页面开对话框（对话框由聊天页持有，与 /rename 共用）', async () => {
    const onRequestRename = mock(() => {});
    render({ onRename: () => {} }, meta(), onRequestRename);
    await open();
    expect($('head-menu-archive')).toBeNull();
    act(() => $('head-menu-rename')!.click());
    expect(onRequestRename).toHaveBeenCalledTimes(1);
  });

  test('已归档 → 「取消归档」；meta 未到时只给重命名', async () => {
    const onArchive = mock((_m: string, _s: string, _a: boolean) => {});
    render({ onRename: () => {}, onArchive }, meta({ archived: true }));
    await open();
    expect($('head-menu-archive')).toBeNull();
    act(() => $('head-menu-unarchive')!.click());
    expect(onArchive).toHaveBeenCalledWith('m', 's', false);
    act(() => root?.unmount());
    host?.remove();

    render({ onRename: () => {}, onArchive }, undefined);
    await open();
    expect($('head-menu-rename')).not.toBeNull();
    expect($('head-menu-archive')).toBeNull();
    expect($('head-menu-unarchive')).toBeNull();
  });

  test('复制工作目录：只有 onCopyCwd 也出按钮；cwd 为空不给', async () => {
    const onCopyCwd = mock((_cwd: string) => {});
    render({ onCopyCwd }, meta({ cwd: '/home/me/repo' }));
    await open();
    expect($('head-menu-rename')).toBeNull();
    act(() => $('head-menu-copy-cwd')!.click());
    expect(onCopyCwd).toHaveBeenCalledWith('/home/me/repo');
    act(() => root?.unmount());
    render({ onCopyCwd }, meta({ cwd: '' }));
    expect($('session-head-menu')).toBeNull();
  });
});

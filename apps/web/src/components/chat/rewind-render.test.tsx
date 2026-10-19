/**
 * 回退的界面：用户消息上的入口（只给能回退的条目）与 RewindDialog（预览 → 选模式 → 确认）。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';
import type { RewindMode } from '@trine/core';
import type { RewindPreviewResult } from '@/lib/client.ts';
import type { TimelineEntry, UserEntry } from '@/lib/reducer.ts';

// radix 在模块初始化时探测 DOM，静态 import 会先于 dom-test-env（同 session-list.test.tsx）
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { RewindDialog } = await import('./RewindDialog.tsx');
const { Timeline } = await import('./Timeline.tsx');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactNode): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

const $ = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const flush = () => act(async () => await Promise.resolve());

const preview = (over: Partial<RewindPreviewResult> = {}): RewindPreviewResult =>
  ({
    type: 'session.rewind.preview.response',
    ts: 1,
    seq: 1,
    dir: 'a2c',
    sessionId: 's1',
    reqId: 'r',
    ok: true,
    text: '把 README 改短',
    conversation: { available: true },
    files: { available: true, filesChanged: ['README.md', 'src/a.ts'], insertions: 4, deletions: 2 },
    ...over,
  }) as RewindPreviewResult;

describe('用户消息上的回退入口', () => {
  const handlers = { onUserAction: () => {}, onRespondPermission: () => {}, onResumeAt: () => {}, onStop: () => {} };
  const entries: TimelineEntry[] = [
    { kind: 'user', id: 'h1', text: '历史消息', local: false, messageId: 'h1', uuid: 'h1', seq: 0, ts: 1 },
    { kind: 'user', id: 'c2', text: '发送中', local: true, status: 'sending', seq: 0, ts: 2 },
  ];

  test('给了 onRewind：只有能回退的条目出按钮，点了回调该条目', () => {
    const onRewind = mock((_e: UserEntry) => {});
    mount(
      <Timeline entries={entries} syncing={undefined} deviceId={null} now={0} runningToolId={null} runningElapsedMs={0} handlers={handlers} onRewind={onRewind} />,
    );
    const buttons = document.querySelectorAll('[data-testid="user-rewind"]');
    expect(buttons).toHaveLength(1);
    act(() => (buttons[0] as HTMLButtonElement).click());
    expect(onRewind).toHaveBeenCalledTimes(1);
    expect(onRewind.mock.calls[0]![0]).toMatchObject({ id: 'h1' });
  });

  test('不给 onRewind（会话忙 / 版本过旧）：一个按钮都没有', () => {
    mount(<Timeline entries={entries} syncing={undefined} deviceId={null} now={0} runningToolId={null} runningElapsedMs={0} handlers={handlers} />);
    expect(document.querySelectorAll('[data-testid="user-rewind"]')).toHaveLength(0);
  });
});

describe('RewindDialog', () => {
  test('预览中 → 列出三种模式与文件，默认「代码和对话」，确认带上所选模式', async () => {
    let resolve: (p: RewindPreviewResult) => void = () => {};
    const loadPreview = mock(() => new Promise<RewindPreviewResult>((r) => (resolve = r)));
    const onConfirm = mock((_mode: RewindMode) => Promise.resolve());
    mount(<RewindDialog open onOpenChange={() => {}} messageText="把 README 改短" loadPreview={loadPreview} onConfirm={onConfirm} />);
    expect($('rewind-dialog-loading')).not.toBeNull();
    expect(($('rewind-dialog-confirm') as HTMLButtonElement).disabled).toBe(true);

    resolve(preview());
    await flush();
    expect(loadPreview).toHaveBeenCalledTimes(1);
    expect($('rewind-dialog-loading')).toBeNull();
    expect($('rewind-dialog-files')?.textContent).toContain('将还原 2 个文件（+4 −2）');
    expect($('rewind-dialog-files')?.textContent).toContain('src/a.ts');
    expect(($('rewind-mode-both')!.querySelector('input') as HTMLInputElement).checked).toBe(true);

    act(() => ($('rewind-mode-conversation')!.querySelector('input') as HTMLInputElement).click());
    act(() => ($('rewind-dialog-confirm') as HTMLButtonElement).click());
    await flush();
    expect(onConfirm).toHaveBeenCalledWith('conversation');
  });

  test('第一条消息：对话相关选项不可选，默认只还原代码', async () => {
    mount(
      <RewindDialog
        open
        onOpenChange={() => {}}
        messageText="x"
        loadPreview={() => Promise.resolve(preview({ conversation: { available: false, reason: '这是对话的第一条消息' } }))}
        onConfirm={() => Promise.resolve()}
      />,
    );
    await flush();
    expect($('rewind-mode-both')!.getAttribute('data-available')).toBe('false');
    expect($('rewind-mode-conversation')!.textContent).toContain('这是对话的第一条消息');
    expect(($('rewind-mode-code')!.querySelector('input') as HTMLInputElement).checked).toBe(true);
  });

  test('预览失败：展示原因，不能确认；执行失败：展示原因、保持打开', async () => {
    mount(
      <RewindDialog open onOpenChange={() => {}} messageText="x" loadPreview={() => Promise.reject(new Error('会话正在运行'))} onConfirm={() => Promise.resolve()} />,
    );
    await flush();
    expect($('rewind-dialog-error')?.textContent).toContain('会话正在运行');
    expect(($('rewind-dialog-confirm') as HTMLButtonElement).disabled).toBe(true);
    act(() => root?.unmount());
    host?.remove();

    mount(
      <RewindDialog
        open
        onOpenChange={() => {}}
        messageText="x"
        loadPreview={() => Promise.resolve(preview())}
        onConfirm={() => Promise.reject(new Error('没有这条消息之前的文件快照'))}
      />,
    );
    await flush();
    act(() => ($('rewind-dialog-confirm') as HTMLButtonElement).click());
    await flush();
    expect($('rewind-dialog-failure')?.textContent).toContain('没有这条消息之前的文件快照');
    expect($('rewind-dialog')).not.toBeNull();
  });
});

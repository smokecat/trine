/**
 * 附件界面：输入框（回形针 / 粘贴 / 附件条 / 发送条件）与时间线里的附件卡片（点击加载）。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';
import type { DraftAttachment } from '@/lib/attachment-model.ts';
import type { TimelineEntry } from '@/lib/reducer.ts';
import type { ComposerAttachments } from './Composer.tsx';

// radix 在模块初始化时探测 DOM，静态 import 会先于 dom-test-env（同 rewind-render.test.tsx）
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Composer } = await import('./Composer.tsx');
const { Timeline } = await import('../chat/Timeline.tsx');

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
const $$ = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)];
const flush = () => act(async () => await Promise.resolve());

function draft(status: DraftAttachment['status'], over: Partial<DraftAttachment> = {}): DraftAttachment {
  return { id: status, file: new File(['x'], 'notes.txt'), name: 'notes.txt', size: 1, kind: 'file', status, progress: 0.5, ...over };
}

function renderComposer(value: string, attachments: Partial<ComposerAttachments>) {
  const onSend = mock((_text: string) => {});
  const props: ComposerAttachments = {
    drafts: [],
    ready: true,
    onAdd: mock(() => {}),
    onRemove: mock(() => {}),
    onRetry: mock(() => {}),
    ...attachments,
  };
  mount(
    <Composer
      value={value}
      onChange={() => {}}
      onSend={onSend}
      onStop={() => {}}
      onSlashPick={() => {}}
      running={false}
      offlineHint={null}
      sources={{ slashCommands: [] }}
      snippets={[]}
      sendKey="enter"
      attachments={props}
    />,
  );
  return { onSend, props };
}

describe('输入框 · 附件', () => {
  test('只有附件也能发；还在上传时不能发', () => {
    const done = renderComposer('', { drafts: [draft('done')], ready: true });
    const send = $('send') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    act(() => send.click());
    expect(done.onSend).toHaveBeenCalledWith('');
    act(() => root?.unmount());

    renderComposer('hi', { drafts: [draft('uploading')], ready: false });
    expect(($('send') as HTMLButtonElement).disabled).toBe(true);
    expect($$('attachment-draft')[0]?.getAttribute('data-status')).toBe('uploading');
  });

  test('附件条：移除、失败重试', () => {
    const { props } = renderComposer('', { drafts: [draft('error', { error: 'HTTP 500' })], ready: false });
    act(() => ($('attachment-retry') as HTMLButtonElement).click());
    expect(props.onRetry).toHaveBeenCalledWith('error');
    act(() => ($('attachment-remove') as HTMLButtonElement).click());
    expect(props.onRemove).toHaveBeenCalledWith('error');
  });

  test('粘贴文件交给 onAdd，纯文本粘贴不拦', () => {
    const { props } = renderComposer('', {});
    const textarea = $('composer') as HTMLTextAreaElement;
    const file = new File(['png'], 'image.png', { type: 'image/png' });
    const paste = (files: File[]) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { files, getData: () => '' } });
      act(() => {
        textarea.dispatchEvent(event);
      });
      return event;
    };
    expect(paste([file]).defaultPrevented).toBe(true);
    expect(props.onAdd).toHaveBeenCalledWith([file]);
    expect(paste([]).defaultPrevented).toBe(false);
  });

  test('agent 不支持附件：回形针禁用，粘贴的文件不收', () => {
    const { props } = renderComposer('', { disabledReason: '版本过旧' });
    expect(($('attach') as HTMLButtonElement).disabled).toBe(true);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [new File(['x'], 'a.txt')] } });
    act(() => {
      ($('composer') as HTMLTextAreaElement).dispatchEvent(event);
    });
    expect(props.onAdd).not.toHaveBeenCalled();
  });
});

describe('时间线 · 附件卡片', () => {
  const entries: TimelineEntry[] = [
    {
      kind: 'user',
      id: 'h1',
      text: '',
      local: false,
      uuid: 'h1',
      attachments: [
        { name: 'shot.png', mime: 'image/png', size: 2048, kind: 'image' },
        { name: 'cached.png', mime: 'image/png', size: 10, kind: 'image', blobId: 'c'.repeat(22), key: 'k'.repeat(43) },
      ],
      seq: 0,
      ts: 1,
    },
  ];
  const base = { onUserAction: () => {}, onRespondPermission: () => {}, onResumeAt: () => {}, onStop: () => {} };

  test('只有附件的消息不画空气泡；本机已有的直接显示，其余点击加载', async () => {
    const open = mock(async (_entry: unknown, index: number) => `blob:loaded-${index}`);
    mount(
      <Timeline
        entries={entries}
        syncing={undefined}
        deviceId="d"
        now={0}
        runningToolId={null}
        runningElapsedMs={-1}
        handlers={{ ...base, onOpenAttachment: open, attachmentUrl: (id) => (id === 'c'.repeat(22) ? 'blob:cached' : undefined) }}
      />,
    );
    expect(document.querySelector('[data-testid="entry-user"] .bg-user-bubble')).toBeNull();
    const images = () => $$('attachment-image').map((a) => a.querySelector('img')?.getAttribute('src'));
    expect(images()).toEqual(['blob:cached']);

    act(() => ($('attachment-image-placeholder') as HTMLButtonElement).click());
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[1]).toBe(0);
    expect(images()).toEqual(['blob:loaded-0', 'blob:cached']);
  });

  test('加载失败显示原因，可以再点', async () => {
    const open = mock(async () => {
      throw new Error('找不到这个附件');
    });
    mount(
      <Timeline
        entries={entries.map((e) => (e.kind === 'user' ? { ...e, attachments: [e.attachments![0]!] } : e))}
        syncing={undefined}
        deviceId="d"
        now={0}
        runningToolId={null}
        runningElapsedMs={-1}
        handlers={{ ...base, onOpenAttachment: open }}
      />,
    );
    act(() => ($('attachment-image-placeholder') as HTMLButtonElement).click());
    await flush();
    const card = $('attachment-image-placeholder') as HTMLButtonElement;
    expect(card.textContent).toContain('找不到这个附件');
    expect(card.disabled).toBe(false);
  });
});

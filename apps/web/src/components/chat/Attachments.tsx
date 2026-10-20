/**
 * 用户消息上的附件：图片 / 文件卡片。
 *
 * 字节不在时间线里（见 reducer 的 UserEntry.attachments）。本机刚上传的有现成的
 * 预览 URL，直接显示；其余先给占位卡片，**点击才加载**——从 relay 下载解密，过期了
 * 由 agent 重新上传（client.openAttachment）。图片加载后就地显示，点开看原图；
 * 文件加载后触发下载。
 */
import { useState } from 'react';
import { FileIcon, ImageIcon, LoaderCircleIcon } from 'lucide-react';
import type { HistoryAttachment } from '@trine/core';
import { formatBytes } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';

export interface AttachmentActions {
  /** 取第 index 个附件的明文 URL（必要时下载 / 请 agent 重新上传） */
  open: (index: number) => Promise<string>;
  /** 已在本机的明文 URL（刚上传 / 加载过）；没有返回 undefined */
  cached: (blobId: string | undefined) => string | undefined;
}

export function MessageAttachments({
  attachments,
  actions,
}: {
  attachments: readonly HistoryAttachment[];
  actions: AttachmentActions | undefined;
}): React.JSX.Element {
  return (
    <div data-testid="message-attachments" className="flex flex-wrap justify-end gap-1.5">
      {attachments.map((att, i) =>
        att.kind === 'image' ? (
          <ImageAttachment key={i} att={att} index={i} actions={actions} />
        ) : (
          <FileAttachment key={i} att={att} index={i} actions={actions} />
        ),
      )}
    </div>
  );
}

type LoadState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; message: string };

function useLoader(actions: AttachmentActions | undefined, index: number) {
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const load = async (): Promise<string | undefined> => {
    if (actions === undefined || state.kind === 'loading') return undefined;
    setState({ kind: 'loading' });
    try {
      const url = await actions.open(index);
      setState({ kind: 'idle' });
      return url;
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  };
  return { state, load };
}

function ImageAttachment({
  att,
  index,
  actions,
}: {
  att: HistoryAttachment;
  index: number;
  actions: AttachmentActions | undefined;
}): React.JSX.Element {
  const [url, setUrl] = useState(() => actions?.cached(att.blobId));
  const { state, load } = useLoader(actions, index);
  if (url !== undefined) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        data-testid="attachment-image"
        title={`${att.name}（${formatBytes(att.size)}）`}
        className="border-border block overflow-hidden rounded-lg border"
      >
        <img src={url} alt={att.name} className="max-h-48 max-w-[240px] object-contain" />
      </a>
    );
  }
  return (
    <AttachmentCard
      testId="attachment-image-placeholder"
      icon={<ImageIcon className="size-4" />}
      att={att}
      state={state}
      hint="点击加载图片"
      disabled={actions === undefined}
      onClick={() => {
        void load().then((loaded) => {
          if (loaded !== undefined) setUrl(loaded);
        });
      }}
    />
  );
}

function FileAttachment({
  att,
  index,
  actions,
}: {
  att: HistoryAttachment;
  index: number;
  actions: AttachmentActions | undefined;
}): React.JSX.Element {
  const { state, load } = useLoader(actions, index);
  return (
    <AttachmentCard
      testId="attachment-file"
      icon={<FileIcon className="size-4" />}
      att={att}
      state={state}
      hint="点击下载"
      disabled={actions === undefined}
      onClick={() => {
        const cached = actions?.cached(att.blobId);
        const ready = cached === undefined ? load() : Promise.resolve(cached);
        void ready.then((url) => {
          if (url !== undefined) download(url, att.name);
        });
      }}
    />
  );
}

function AttachmentCard({
  testId,
  icon,
  att,
  state,
  hint,
  disabled,
  onClick,
}: {
  testId: string;
  icon: React.ReactNode;
  att: HistoryAttachment;
  state: LoadState;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const error = state.kind === 'error' ? state.message : undefined;
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled || state.kind === 'loading'}
      title={error ?? hint}
      onClick={onClick}
      className={cn(
        'border-border bg-surface flex max-w-[240px] items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left',
        'hover:bg-surface-2 transition-colors disabled:cursor-default disabled:hover:bg-surface',
        error !== undefined && 'border-red/50',
      )}
    >
      <span className="text-text-3 shrink-0">
        {state.kind === 'loading' ? <LoaderCircleIcon className="size-4 animate-spin" /> : icon}
      </span>
      <span className="min-w-0">
        <span className="text-text block truncate text-[12.5px]">{att.name}</span>
        <span className={cn('block truncate text-[11px]', error !== undefined ? 'text-red' : 'text-text-3')}>
          {error ?? `${formatBytes(att.size)} · ${state.kind === 'loading' ? '加载中…' : hint}`}
        </span>
      </span>
    </button>
  );
}

function download(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

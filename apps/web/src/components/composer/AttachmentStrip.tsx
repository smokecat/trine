/**
 * 输入框上方的待发附件条：图片缩略图 / 文件卡片，带上传进度、失败重试、移除。
 */
import { FileIcon, LoaderCircleIcon, RotateCwIcon, XIcon } from 'lucide-react';
import type { DraftAttachment } from '@/lib/attachment-model.ts';
import { formatBytes } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';

export function AttachmentStrip({
  drafts,
  onRemove,
  onRetry,
  className,
}: {
  drafts: readonly DraftAttachment[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  /** PC 输入卡片里去掉顶边框与底色 */
  className?: string;
}): React.JSX.Element | null {
  if (drafts.length === 0) return null;
  return (
    <div
      data-testid="attachment-strip"
      className={cn('border-border bg-background flex gap-2 overflow-x-auto border-t px-3 pt-2', className)}
    >
      {drafts.map((d) => (
        <div
          key={d.id}
          data-testid="attachment-draft"
          data-status={d.status}
          title={d.status === 'error' ? `${d.name}：${d.error ?? '上传失败'}` : `${d.name}（${formatBytes(d.size)}）`}
          className={cn(
            'border-border bg-surface relative flex h-14 shrink-0 items-center overflow-hidden rounded-lg border',
            d.previewUrl === undefined ? 'max-w-[200px] gap-2 pr-7 pl-2.5' : 'w-14',
            d.status === 'error' && 'border-red/60',
          )}
        >
          {d.previewUrl !== undefined ? (
            <img src={d.previewUrl} alt={d.name} className="size-full object-cover" />
          ) : (
            <>
              <FileIcon className="text-text-3 size-4 shrink-0" />
              <span className="min-w-0">
                <span className="text-text block truncate text-[12px]">{d.name}</span>
                <span className={cn('block truncate text-[11px]', d.status === 'error' ? 'text-red' : 'text-text-3')}>
                  {d.status === 'error' ? '上传失败' : formatBytes(d.size)}
                </span>
              </span>
            </>
          )}

          {d.status === 'uploading' && (
            <>
              <span className="absolute inset-0 flex items-center justify-center bg-black/25">
                <LoaderCircleIcon className="size-4 animate-spin text-white" />
              </span>
              <span
                className="bg-brand absolute bottom-0 left-0 h-0.5 transition-[width]"
                style={{ width: `${Math.round(d.progress * 100)}%` }}
              />
            </>
          )}
          {d.status === 'error' && (
            <button
              type="button"
              data-testid="attachment-retry"
              aria-label={`重试上传 ${d.name}`}
              className={cn(
                'absolute flex items-center justify-center',
                d.previewUrl === undefined ? 'right-7 bottom-1 size-5' : 'inset-0 bg-black/40 text-white',
              )}
              onClick={() => onRetry(d.id)}
            >
              <RotateCwIcon className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            data-testid="attachment-remove"
            aria-label={`移除 ${d.name}`}
            className="bg-background/80 text-text-2 hover:text-text absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full"
            onClick={() => onRemove(d.id)}
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

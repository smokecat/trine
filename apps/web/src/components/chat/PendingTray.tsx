/**
 * 排队托盘：还没进入对话的本设备消息（reducer `isPendingEntry`），贴在输入框上方。
 *
 * 为什么不留在时间线里：运行中发出的消息要等当前任务结束才执行，画在时间线末尾的话，
 * 当前这轮的回复会接着长在它下面，看着像在回答它。托盘里按发送顺序编号，出队开始
 * 执行（`user.message` 回显）时条目移进时间线末尾，正好是它真正进入对话的位置。
 *
 * 每行：序号（等回执时转圈）、正文（单行截断，点开看全文）、状态、动作（见
 * entry-status.ts `pendingItemView`）。PC 上输入框为空时按 ↑ 编辑最后一条（Composer）。
 */
import { useState } from 'react';
import { Loader2Icon, PaperclipIcon, PencilIcon, RotateCwIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useIsDesktop } from '@/components/shell/use-media-query.ts';
import type { UserEntry } from '@/lib/reducer.ts';
import { cn } from '@/lib/utils.ts';
import { canEditPending, pendingItemView, type PendingActionKind } from './entry-status.ts';

const TONE_CLASS = {
  muted: 'text-text-3',
  amber: 'text-amber',
  red: 'text-red',
} as const;

const ACTION_ICON: Record<PendingActionKind, React.ReactNode> = {
  edit: <PencilIcon />,
  recall: <XIcon />,
  resend: <RotateCwIcon />,
  discard: <Trash2Icon />,
};

const ACTION_TITLE: Record<PendingActionKind, string> = {
  edit: '撤回并放回输入框',
  recall: '撤回，不再发送',
  resend: '重新发送',
  discard: '丢弃这条消息',
};

function formatExpiry(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 托盘标题：排着的有几条、要等什么；没送进去的另计 */
export function pendingHeadline(entries: readonly UserEntry[]): string {
  let waiting = 0;
  let parked = 0;
  for (const e of entries) {
    if (e.status === 'queued' || e.status === 'sending') waiting += 1;
    if (e.status === 'parked') parked += 1;
  }
  const leftOver = entries.length - waiting - parked;
  const parts: string[] = [];
  if (waiting > 0) parts.push(`${waiting} 条排队中 · 当前任务结束后依次发送`);
  if (parked > 0) parts.push(`${parked} 条等机器上线后发送`);
  if (leftOver > 0) parts.push(`${leftOver} 条未发送`);
  return parts.join(' · ');
}

/** 最后一条能编辑的（PC 上 ↑ 的目标）；撤回中 / 发送中的跳过 */
export function lastEditable(entries: readonly UserEntry[], now: number = Date.now()): UserEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i]!;
    if (canEditPending(e) && pendingItemView(e, formatExpiry, now).actions.some((a) => a.kind === 'edit')) return e;
  }
  return undefined;
}

export function PendingTray({
  entries,
  onAction,
}: {
  entries: readonly UserEntry[];
  onAction: (action: PendingActionKind, entry: UserEntry) => void;
}): React.JSX.Element | null {
  const desktop = useIsDesktop();
  const [expanded, setExpanded] = useState<string | null>(null);
  if (entries.length === 0) return null;
  const now = Date.now();
  const editHint = desktop && lastEditable(entries, now) !== undefined;

  return (
    <section data-testid="pending-tray" aria-label="未发送的消息" className="flex flex-col gap-1.5">
      <div className="text-text-3 flex items-center gap-2 px-1 text-[11.5px]">
        <span data-testid="pending-headline" className="min-w-0 flex-1 truncate">
          {pendingHeadline(entries)}
        </span>
        {editHint && (
          <span className="shrink-0 select-none" title="输入框为空时按 ↑ 编辑最后一条">
            <kbd className="border-border bg-surface-2 rounded border px-1 font-sans">↑</kbd> 编辑
          </span>
        )}
      </div>
      <ol className="flex max-h-[min(30vh,200px)] flex-col gap-1 overflow-y-auto">
        {entries.map((entry, i) => {
          const view = pendingItemView(entry, formatExpiry, now);
          const open = expanded === entry.id;
          const count = entry.attachments?.length ?? 0;
          return (
            <li
              key={entry.id}
              data-testid="pending-item"
              data-status={entry.status}
              data-busy={view.busy || undefined}
              className={cn(
                'border-border-strong bg-surface flex min-h-9 items-center gap-2 rounded-xl border border-dashed py-1 pr-1 pl-2',
                'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 duration-200',
                view.tone === 'amber' && 'border-amber-border bg-amber-soft',
                view.tone === 'red' && 'border-red/40 bg-red-soft',
              )}
            >
              <span
                aria-hidden
                className="bg-surface-2 text-text-3 tabular grid size-5 shrink-0 place-items-center rounded-full text-[11px]"
              >
                {view.busy ? <Loader2Icon className="size-3 motion-safe:animate-spin" /> : i + 1}
              </span>
              <button
                type="button"
                data-testid="pending-text"
                aria-expanded={open}
                title={open ? undefined : entry.text}
                className={cn(
                  'flex min-w-0 flex-1 items-start gap-2 py-0.5 text-left text-[13px] leading-[19px]',
                  view.busy ? 'text-text-3' : 'text-text-2',
                )}
                onClick={() => setExpanded(open ? null : entry.id)}
              >
                <span className={cn('min-w-0 flex-1', open ? 'max-h-40 overflow-y-auto break-words whitespace-pre-wrap' : 'truncate')}>
                  {count > 0 && (
                    <span className="text-text-3 mr-1.5 inline-flex items-center gap-0.5 align-[-2px]">
                      <PaperclipIcon className="size-3" />
                      {count}
                    </span>
                  )}
                  {entry.text === '' && count > 0 ? '仅附件' : entry.text}
                </span>
                {/* 普通的「排队中」标题已经说了，行内只标特殊状态 */}
                {entry.status !== 'queued' || view.busy ? (
                  <span
                    data-testid="pending-status"
                    className={cn('max-w-[45%] shrink-0 truncate text-[11.5px]', TONE_CLASS[view.tone])}
                    title={view.label}
                  >
                    {view.label}
                  </span>
                ) : null}
              </button>
              {view.actions.length > 0 && (
                <span className="flex shrink-0 items-center">
                  {view.actions.map((action) => (
                    <button
                      key={action.kind}
                      type="button"
                      data-testid={`pending-${action.kind}`}
                      title={ACTION_TITLE[action.kind]}
                      aria-label={`${action.label}：${entry.text.slice(0, 20)}`}
                      className={cn(
                        'text-text-3 hover:bg-surface-2 hover:text-text grid place-items-center rounded-full transition-colors',
                        'focus-visible:ring-ring outline-none focus-visible:ring-2 [&_svg]:size-3.5',
                        desktop ? 'size-7' : 'size-8',
                        action.kind === 'discard' && 'hover:text-red',
                      )}
                      onClick={() => onAction(action.kind, entry)}
                    >
                      {ACTION_ICON[action.kind]}
                    </button>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

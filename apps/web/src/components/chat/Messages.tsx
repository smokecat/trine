/**
 * 时间线里的「消息」类条目：用户气泡、assistant 流式文本、思考行。
 *
 * 判别式渲染的第一原则（原型 NOTES.chat 第 1 条）：**不是所有东西都走
 * markdown 管道**。用户消息是纯文本（用户打的就是字面值，把 `*` 渲染成
 * 斜体是错的），只有 assistant 文本过 streamdown。
 */
import { memo, useState } from 'react';
import { Undo2Icon } from 'lucide-react';
import type { AssistantEntry, UserEntry } from '@/lib/reducer.ts';
import { formatClock, formatDateTime } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { MessageAttachments } from './Attachments.tsx';
import { CommandOutputCard } from './CommandOutputCard.tsx';
import { Markdown } from './Markdown.tsx';
import { userEntryBadge, type UserEntryAction } from './entry-status.ts';

const TONE_CLASS = {
  muted: 'text-text-3',
  amber: 'text-amber',
  red: 'text-red',
} as const;

function formatExpiry(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function UserMessage({
  entry,
  now,
  onAction,
  onRewind,
  onOpenAttachment,
  attachmentUrl,
}: {
  entry: UserEntry;
  /** 撤回乐观态的超时判据（Timeline 的统一 tick） */
  now: number;
  onAction: (action: UserEntryAction, entry: UserEntry) => void;
  /** 回退到这条消息之前；不给 = 这条不能回退（未确认 / agent 不支持 / 会话忙） */
  onRewind?: ((entry: UserEntry) => void) | undefined;
  /** 加载附件（见 Attachments.tsx）；不给 = 附件只显示、点不开 */
  onOpenAttachment?: ((entry: UserEntry, index: number) => Promise<string>) | undefined;
  attachmentUrl?: ((blobId: string | undefined) => string | undefined) | undefined;
}): React.JSX.Element {
  const badge = userEntryBadge(entry, formatExpiry, now);
  const action = badge.action;
  // 触屏没有 hover：点气泡把「回退」亮出来；有指针的设备悬停即可见
  const [revealed, setRevealed] = useState(false);
  return (
    <li
      data-testid="entry-user"
      data-status={entry.status ?? 'remote'}
      className="group flex max-w-[85%] flex-col items-end gap-1 self-end"
    >
      {entry.attachments !== undefined && entry.attachments.length > 0 && (
        <MessageAttachments
          attachments={entry.attachments}
          actions={
            onOpenAttachment === undefined
              ? undefined
              : { open: (i) => onOpenAttachment(entry, i), cached: (id) => attachmentUrl?.(id) }
          }
        />
      )}
      {entry.text !== '' && (
        <div
          className="bg-user-bubble rounded-[14px] rounded-br-[4px] px-3 py-2 text-[14px] wrap-anywhere whitespace-pre-wrap"
          onClick={onRewind === undefined ? undefined : () => setRevealed((v) => !v)}
        >
          {entry.text}
        </div>
      )}
      {/* 时间、回退入口、状态同一行：回退平时透明但本来就占着这行，时间放进来不加高度 */}
      {(entry.ts > 0 || onRewind !== undefined || badge.label !== undefined) && (
        <div className="flex items-center gap-2 text-[11.5px]">
          {onRewind !== undefined && (
            <button
              type="button"
              data-testid="user-rewind"
              title="回退到这条消息之前（可选还原代码 / 对话）"
              className={cn(
                'text-text-3 hover:text-text-2 flex items-center gap-1 transition-opacity focus-visible:opacity-100',
                revealed ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              )}
              onClick={() => {
                setRevealed(false);
                onRewind(entry);
              }}
            >
              <Undo2Icon className="size-3" />
              回退到这里
            </button>
          )}
          {badge.label !== undefined && (
            <span className={cn('flex items-center gap-2', TONE_CLASS[badge.tone])}>
              <span>{badge.label}</span>
              {action !== undefined && (
                <button
                  type="button"
                  data-testid={`user-action-${action.kind}`}
                  className="text-brand-ink underline disabled:no-underline disabled:opacity-60"
                  disabled={action.disabled === true}
                  onClick={() => onAction(action.kind, entry)}
                >
                  {action.label}
                </button>
              )}
            </span>
          )}
          {entry.ts > 0 && <EntryTime at={entry.ts} testId="user-time" className="text-text-3" />}
        </div>
      )}
    </li>
  );
}

/**
 * assistant 文本。`thinking && text === ''` 是「思考中…」占位——首个 delta
 * 一到（text 非空）就自然消失，不需要单独的隐藏逻辑。
 */
export function AssistantMessage({ entry }: { entry: AssistantEntry }): React.JSX.Element {
  const streaming = !entry.done;
  const [revealed, setRevealed] = useState(false);
  if (entry.thinking && entry.text === '') {
    return (
      <li data-testid="entry-thinking" className="text-text-3 text-[13px] italic">
        思考中…
      </li>
    );
  }
  return (
    <li
      data-testid="entry-assistant"
      data-done={String(entry.done)}
      className="group relative max-w-full"
      // 触屏没有 hover：点一下正文亮出时间（点链接 / 按钮、选文字时不算）
      onClick={(e) => {
        if ((e.target as Element).closest('a,button') !== null) return;
        if ((window.getSelection()?.toString() ?? '') !== '') return;
        setRevealed((v) => !v);
      }}
    >
      {entry.command === undefined ? (
        <Markdown text={entry.text} streaming={streaming} />
      ) : (
        <CommandOutputCard command={entry.command} text={entry.text} />
      )}
      {streaming && (
        <span aria-hidden className="text-brand ml-0.5 motion-safe:animate-pulse">
          ▍
        </span>
      )}
      {/* 悬停才显示，绝对定位落在与下一条之间的 gap 里，不占高度 */}
      {entry.ts > 0 && (
        <EntryTime
          at={entry.ts}
          testId="assistant-time"
          className={cn(
            'text-text-3 pointer-events-none absolute top-full right-0 mt-px text-[10.5px] leading-none transition-opacity',
            revealed ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        />
      )}
    </li>
  );
}

/** 时间线里的消息时刻：`14:05`，悬停给完整日期时间 */
function EntryTime({ at, testId, className }: { at: number; testId: string; className?: string }): React.JSX.Element {
  return (
    <time
      data-testid={testId}
      dateTime={new Date(at).toISOString()}
      title={formatDateTime(at)}
      className={cn('tabular', className)}
    >
      {formatClock(at)}
    </time>
  );
}

/**
 * 时间标记（像聊天工具）：跨天给「今天 14:05」这类带日期的分隔线，同一天里
 * 长间隔只给一个淡淡的时刻。密集的工具调用不会触发（规则见 lib/time-markers）。
 */
export const TimeDivider = memo(function TimeDivider({
  at,
  day,
}: {
  at: number;
  /** 日期标签（「今天」「10月18日 周六」）；不给 = 同一天里的间隔标记 */
  day: string | undefined;
}): React.JSX.Element {
  return (
    <li
      role="separator"
      data-testid="time-divider"
      data-kind={day === undefined ? 'gap' : 'day'}
      className="text-text-3 flex items-center gap-3 text-[11px] leading-none"
    >
      {day !== undefined && <span aria-hidden className="bg-border h-px flex-1" />}
      <time dateTime={new Date(at).toISOString()} title={formatDateTime(at)} className="tabular mx-auto">
        {day === undefined ? formatClock(at) : `${day} ${formatClock(at)}`}
      </time>
      {day !== undefined && <span aria-hidden className="bg-border h-px flex-1" />}
    </li>
  );
});

/**
 * 系统提示（原型 `.sysnote`）：run.state 迁移、会话恢复、瞬时错误的一行痕迹。
 * 居中胶囊，刻意做得比消息弱——它是背景信息，不是内容。
 */
export function SystemNote({
  children,
  tone = 'muted',
  testId = 'entry-sysnote',
}: {
  children: React.ReactNode;
  tone?: 'muted' | 'amber';
  testId?: string;
}): React.JSX.Element {
  return (
    <li
      data-testid={testId}
      className={cn(
        'border-border bg-surface-2 self-center rounded-full border px-3 py-1 text-center text-[12px]',
        tone === 'amber' ? 'text-amber border-amber-border' : 'text-text-3',
      )}
    >
      {children}
    </li>
  );
}

/** 同步中的顶部占位（方案 §4.2/§4.3 的 normal / backfill 两种模式） */
export function SyncingRow({ mode }: { mode: 'normal' | 'backfill' }): React.JSX.Element {
  return (
    <li data-testid="syncing" className="text-text-3 self-center py-1 text-xs">
      <span className="motion-safe:animate-pulse">
        {mode === 'backfill' ? '正在回填历史…' : '正在同步历史…'}
      </span>
    </li>
  );
}

/**
 * 时间线顶部的历史回看行：本机转录历史的加载中 / 失败重试 / 「加载更早」。
 * 什么都不用显示时返回 null（已到最早、或 agent 不支持历史回看）。
 */
export type HistoryHeadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'more' }
  | { kind: 'none' };

export function HistoryHead({
  state,
  onLoadMore,
  onRetry,
}: {
  state: HistoryHeadState;
  onLoadMore: () => void;
  onRetry: () => void;
}): React.JSX.Element | null {
  switch (state.kind) {
    case 'none':
      return null;
    case 'loading':
      return (
        <li data-testid="history-loading" className="text-text-3 shrink-0 self-center py-1 text-xs">
          <span className="motion-safe:animate-pulse">正在加载本机历史…</span>
        </li>
      );
    case 'error':
      return (
        <li data-testid="history-error" className="text-amber shrink-0 self-center py-1 text-center text-xs">
          历史加载失败：{state.message}
          <button type="button" className="hover:text-text-1 ml-2 underline underline-offset-2" onClick={onRetry}>
            重试
          </button>
        </li>
      );
    case 'more':
      return (
        <li className="shrink-0 self-center">
          <button
            type="button"
            data-testid="history-more"
            className="border-border bg-surface-2 text-text-2 hover:text-text-1 rounded-full border px-3 py-1 text-[12px] transition-colors"
            onClick={onLoadMore}
          >
            加载更早
          </button>
        </li>
      );
  }
}

/**
 * 本地信息卡（`/status` `/mcp` 的渲染目标，原型 `.info-card`）。
 *
 * 它不是时间线条目——数据来自 agent 的状态上报、不往返 Claude、不产生成本，
 * 所以只活在本地 state 里，刷新即消失（重新 `/status` 即可）。
 */
export function InfoCard({
  title,
  rows,
  foot,
  onDismiss,
}: {
  title: string;
  rows: { label: string; value: React.ReactNode }[];
  foot?: string;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <li
      data-testid="info-card"
      className="border-border bg-surface self-stretch rounded-xl border px-3.5 py-2.5 text-[12.5px]"
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[13px] font-semibold">{title}</span>
        <button
          type="button"
          aria-label="关闭"
          className="text-text-3 hover:text-text ml-auto text-xs"
          onClick={onDismiss}
        >
          ✕
        </button>
      </div>
      <table className="w-full border-collapse">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="text-text-3 w-[92px] py-[2.5px] pr-2 align-baseline">{r.label}</td>
              <td className="text-text-2 py-[2.5px] align-baseline font-mono text-[11.5px] break-all">
                {r.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {foot !== undefined && <div className="text-text-3 mt-1.5 text-[11.5px]">{foot}</div>}
    </li>
  );
}

/** 折叠块：权限卡的完整 JSON、工具卡的输出预览都用它 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="text-text-3 hover:text-text-2 flex items-center gap-1 text-[11.5px]"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden className={cn('transition-transform', open && 'rotate-90')}>
          ›
        </span>
        {summary}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

/**
 * 状态点与状态 pill——原型 `.dot` / `.state-pill` 的等价物。
 *
 * 阶段 2a 定稿的共享件（侧栏、会话列表、聊天头、机器页都用），2b 只加不改。
 */
import type { SessionState, WaitingFor } from '@trine/core';
import { cn } from '@/lib/utils.ts';
import { waitingLabel } from '@/lib/waiting.ts';

/** 原型 .dot 的五种语义 */
export type DotTone = 'on' | 'off' | 'run' | 'wait' | 'err' | 'done';

const DOT_TONE: Record<DotTone, string> = {
  on: 'bg-green',
  off: 'bg-text-3',
  run: 'bg-brand motion-safe:animate-pulse',
  wait: 'bg-amber motion-safe:animate-pulse',
  err: 'bg-red',
  done: 'bg-blue',
};

export function StatusDot({ tone, className }: { tone: DotTone; className?: string }): React.JSX.Element {
  return <span aria-hidden className={cn('size-[7px] shrink-0 rounded-full', DOT_TONE[tone], className)} />;
}

/**
 * 会话状态 → pill 的外观与文案。
 *
 * `SessionState` 的 error / stopped 在原型里没有独立 pill 样式：
 * error 走红、stopped 归到 idle 的灰——远程场景里「停了」和「闲着」
 * 对用户的下一步动作是同一件事（可以继续发消息）。
 */
const STATE_PILL: Record<SessionState, { tone: DotTone; label: string; className: string }> = {
  waiting_permission: { tone: 'wait', label: '等待批准', className: 'bg-amber-soft text-amber' },
  running: { tone: 'run', label: '运行中', className: 'bg-brand-soft text-brand-ink' },
  idle: { tone: 'off', label: '空闲', className: 'bg-surface-2 text-text-2' },
  stopped: { tone: 'off', label: '已停止', className: 'bg-surface-2 text-text-2' },
  error: { tone: 'err', label: '出错', className: 'bg-red-soft text-red' },
};

export function StatePill({
  state,
  waitingFor,
  className,
}: {
  state: SessionState;
  /** 等待态细分（提问 / 计划 / 普通权限）；缺省按普通权限，见 lib/waiting.ts */
  waitingFor?: WaitingFor | undefined;
  className?: string;
}): React.JSX.Element {
  const pill = STATE_PILL[state];
  const label = state === 'waiting_permission' ? waitingLabel(waitingFor) : pill.label;
  return (
    <span
      data-testid="state-pill"
      data-state={state}
      className={cn(
        'inline-flex shrink-0 items-center gap-[5px] rounded-full px-2 py-0.5 text-[11px] font-medium',
        pill.className,
        className,
      )}
    >
      <StatusDot tone={pill.tone} />
      {label}
    </span>
  );
}

/**
 * 原型 `.chip`：机器过滤、机器名标签、连接状态都用它。
 * `selected` 对应原型的 `.chip.sel`（accent 描边 + 软底）。
 */
export function Chip({
  children,
  selected = false,
  className,
  ...props
}: React.ComponentProps<'button'> & { selected?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      data-selected={selected}
      className={cn(
        'inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full border px-[9px] py-[3px] text-[11.5px] transition-colors',
        selected
          ? 'border-brand-border bg-brand-soft text-brand-ink font-medium'
          : 'border-border bg-surface-2 text-text-2 hover:border-border-strong',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** 不可点的 chip（纯标签，如聊天头右上角的机器名） */
export function ChipLabel({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}): React.JSX.Element {
  return (
    <span
      {...(title === undefined ? {} : { title })}
      className={cn(
        'border-border bg-surface-2 text-text-2 inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full border px-[9px] py-[3px] text-[11.5px]',
        className,
      )}
    >
      {children}
    </span>
  );
}

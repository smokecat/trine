/**
 * 用量展示组件（usage-display）：
 * - `PlanUsageLine`：一台机器的 5h / 1w 用量 + 重置时间（机器卡、列表顶部共用）；
 * - `PlanUsageStrip`：会话列表顶部，每台机器一行，带手动刷新；
 * - `SessionUsage`：会话头部的 ctx / 5h / 1w 百分比。
 *
 * 文案与色调见 usage-model.ts。限额是账号级数据，挂在 machine.info 上；会话头部的
 * 5h / 1w 就是会话所在机器的值。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { RefreshCwIcon } from 'lucide-react';
import type { ContextUsage, RateLimits, RateLimitWindow } from '@trine/core';
import { Button } from '@/components/ui/button.tsx';
import { useClient, useTrine } from '@/app/runtime.ts';
import type { MachineState } from '@/store/types.ts';
import { formatRelativeTime } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { contextView, remainingShort, supportsUsageRefresh, windowTitle, windowView, type UsageTone } from './usage-model.ts';

const TONE_CLASS: Record<UsageTone, string> = {
  normal: '',
  warn: 'text-amber',
  danger: 'text-red font-semibold',
};

/**
 * 一个限额窗口：「5h 62%」。悬停看详情（windowTitle）；`toggleable` 时是按钮，点一下在
 * 百分比和距重置的倒计时（「1h20m」）之间切换——手机没有悬停，靠它看重置时间。
 */
function WindowValue({
  label,
  window,
  updatedAt,
  now,
  showReset,
  toggleable,
}: {
  label: string;
  window: RateLimitWindow;
  updatedAt: number | undefined;
  now: number;
  showReset: boolean;
  toggleable: boolean;
}): React.JSX.Element {
  const [countdown, setCountdown] = useState(false);
  const view = windowView(window, now);
  const title = windowTitle(label, window, updatedAt, now);
  const remaining = window.resetsAt === undefined ? undefined : remainingShort(window.resetsAt, now);
  // 没有重置时间就没得切：倒计时态下也照常显示百分比
  const showCountdown = countdown && toggleable && (remaining !== undefined || view.expired);
  const body = (
    <>
      <span className="text-text-3">{label}</span>
      {showCountdown ? (
        <span data-testid="window-countdown">{view.expired ? '已重置' : remaining}</span>
      ) : (
        <span className={cn(TONE_CLASS[view.tone])}>{view.percent}</span>
      )}
      {showReset && view.reset !== '' && <span className="text-text-3 text-[11px]">{view.reset}</span>}
    </>
  );
  const className = 'tabular inline-flex items-baseline gap-1 whitespace-nowrap';
  if (!toggleable) {
    return (
      <span className={className} title={title} data-testid="usage-window-value">
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cn(className, 'hover:text-text cursor-pointer')}
      title={`${title} · 点击切换百分比 / 剩余时间`}
      data-testid="usage-window-value"
      onClick={() => setCountdown((v) => !v)}
    >
      {body}
    </button>
  );
}

/**
 * 一台机器的 5h / 1w；没有任何窗口时渲染 null。`interactive` 为 false 时不可点（放在
 * 整块是链接的机器卡里，按钮嵌在链接里既不合法、点了也会跳页）。
 */
export function PlanUsageLine({
  rateLimits,
  now,
  className,
  interactive = true,
}: {
  rateLimits: RateLimits | undefined;
  now: number;
  className?: string;
  interactive?: boolean;
}): React.JSX.Element | null {
  if (rateLimits === undefined || (rateLimits.fiveHour === undefined && rateLimits.sevenDay === undefined)) return null;
  return (
    <span data-testid="plan-usage" className={cn('inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs', className)}>
      {rateLimits.fiveHour !== undefined && (
        <WindowValue label="5h" window={rateLimits.fiveHour} updatedAt={rateLimits.updatedAt} now={now} showReset toggleable={interactive} />
      )}
      {rateLimits.sevenDay !== undefined && (
        <WindowValue label="1w" window={rateLimits.sevenDay} updatedAt={rateLimits.updatedAt} now={now} showReset toggleable={interactive} />
      )}
    </span>
  );
}

/** 手动刷新按钮（单台机器）；成败 toast */
export function PlanUsageRefreshButton({ machine }: { machine: MachineState }): React.JSX.Element | null {
  const client = useClient();
  const [refreshing, setRefreshing] = useState(false);
  if (client === null || !supportsUsageRefresh(machine.info)) return null;
  const refresh = (): void => {
    setRefreshing(true);
    void client
      .refreshUsage(machine.machineId)
      .then(
        (res) => {
          if (!res.ok) toast.error(`${machine.name}：${res.error?.message ?? '刷新用量失败'}`);
        },
        (err: unknown) => toast.error(`${machine.name}：刷新用量失败（${err instanceof Error ? err.message : String(err)}）`),
      )
      .finally(() => setRefreshing(false));
  };
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      data-testid="plan-usage-refresh"
      title="刷新用量（没有活跃会话时会临时启动一次 claude）"
      aria-label="刷新用量"
      disabled={refreshing || machine.online === false}
      onClick={refresh}
    >
      <RefreshCwIcon className={cn(refreshing && 'motion-safe:animate-spin')} />
    </Button>
  );
}

/**
 * 会话列表顶部：每台机器一行 5h / 1w。只列有数据或支持刷新的机器；选了机器过滤就只列
 * 那一台；只有一行时不写机器名。一行都没有时渲染 null。
 */
export function PlanUsageStrip({
  filter,
  now,
  className,
}: {
  filter: string | null;
  now: number;
  className?: string;
}): React.JSX.Element | null {
  const machines = useTrine((s) => s.machines);
  const rows = Object.values(machines)
    .filter((m) => filter === null || m.machineId === filter)
    .filter((m) => m.info?.rateLimits !== undefined || supportsUsageRefresh(m.info))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (rows.length === 0) return null;
  return (
    <div data-testid="plan-usage-strip" className={cn('flex flex-col gap-0.5', className)}>
      {rows.map((m) => (
        <div key={m.machineId} data-machine-id={m.machineId} className="text-text-2 flex min-h-6 items-center gap-2 text-xs">
          {rows.length > 1 && <span className="text-text-3 max-w-[30%] shrink-0 truncate font-mono">{m.name}</span>}
          {m.info?.rateLimits === undefined ? (
            <span className="text-text-3 min-w-0 flex-1 truncate">用量：暂无数据，会话活动后更新</span>
          ) : (
            <PlanUsageLine rateLimits={m.info.rateLimits} now={now} className="min-w-0 flex-1" />
          )}
          <PlanUsageRefreshButton machine={m} />
        </div>
      ))}
    </div>
  );
}

/**
 * 会话头部：ctx / 5h / 1w 百分比（不带重置时间，省地方；悬停看详情）。给了
 * `onRefreshContext` 时 ctx 是按钮，点一下让 agent 重新取（还没有值时显示「ctx —」）。
 * 什么都没有、也不能刷新时渲染 null。
 */
export function SessionUsage({
  context,
  rateLimits,
  now,
  onRefreshContext,
}: {
  context: ContextUsage | undefined;
  rateLimits: RateLimits | undefined;
  now: number;
  /** 手动刷新 context；resolve 后结束转圈（成败提示由调用方负责） */
  onRefreshContext?: (() => Promise<void>) | undefined;
}): React.JSX.Element | null {
  const [refreshing, setRefreshing] = useState(false);
  const ctx = context === undefined ? undefined : contextView(context);
  const five = rateLimits?.fiveHour;
  const seven = rateLimits?.sevenDay;
  const canRefresh = onRefreshContext !== undefined;
  if (ctx === undefined && !canRefresh && five === undefined && seven === undefined) return null;
  const ctxBody = (
    <>
      <span className="text-text-3">ctx </span>
      {refreshing ? (
        <span className="text-text-3 motion-safe:animate-pulse">…</span>
      ) : (
        <span className={cn(ctx !== undefined && TONE_CLASS[ctx.tone])}>{ctx?.percent ?? '—'}</span>
      )}
    </>
  );
  const ctxTitle = [
    ctx?.title ?? '上下文用量：还没有数据',
    ...(context === undefined ? [] : [`取于 ${formatRelativeTime(context.at, now)}`]),
    ...(canRefresh ? ['点击刷新'] : []),
  ].join(' · ');
  return (
    <span data-testid="session-usage" className="inline-flex shrink-0 items-baseline gap-2">
      {canRefresh ? (
        <button
          type="button"
          data-testid="session-context"
          className="tabular hover:text-text-2 cursor-pointer whitespace-nowrap underline decoration-dotted underline-offset-2 disabled:cursor-default"
          title={ctxTitle}
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void onRefreshContext().finally(() => setRefreshing(false));
          }}
        >
          {ctxBody}
        </button>
      ) : (
        ctx !== undefined && (
          <span className="tabular whitespace-nowrap" title={ctxTitle} data-testid="session-context">
            {ctxBody}
          </span>
        )
      )}
      {five !== undefined && (
        <WindowValue label="5h" window={five} updatedAt={rateLimits?.updatedAt} now={now} showReset={false} toggleable />
      )}
      {seven !== undefined && (
        <WindowValue label="1w" window={seven} updatedAt={rateLimits?.updatedAt} now={now} showReset={false} toggleable />
      )}
    </span>
  );
}

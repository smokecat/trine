/**
 * 用量展示组件（usage-display）：
 * - `PlanUsageLine`：一台机器 Claude 的 5h / 1w / 按模型的周限额（如 Fable）+ 重置时间
 *   （机器卡、列表顶部共用）；
 * - `EngineUsageLines`：其他引擎（Codex）的限额；
 * - `MachineUsageRows`：机器详情页，每个引擎一行，行首图标 + 名字；
 * - `PlanUsageStrip`：会话列表顶部，每台机器一行，带手动刷新；行尾带资源数据摘要（machine-stats）；
 * - `SessionUsage`：会话头部的 ctx / 5h / 1w 百分比。
 *
 * 文案与色调见 usage-model.ts。限额是账号级数据，挂在 machine.info 上；会话头部的
 * 5h / 1w 就是会话所在机器的值。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { RefreshCwIcon } from 'lucide-react';
import {
  CLAUDE_ENGINE_ID,
  type ContextUsage,
  type EngineSummary,
  type MachineInfo,
  type ModelRateLimitWindow,
  type RateLimits,
  type RateLimitWindow,
} from '@trine/core';
import { enginesOf, enginesWithLimits, engineTag, hasMultipleEngines, windowLabel } from '@/lib/engine-model.ts';
import { EngineIcon, EngineName } from '@/components/shell/EngineIcon.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useClient, useTrine } from '@/app/runtime.ts';
import type { MachineState } from '@/store/types.ts';
import { formatRelativeTime } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { MachineStatsBrief } from '@/components/machines/MachineStats.tsx';
import { supportsMachineStats } from '@/components/machines/stats-model.ts';
import { useListStatsInterval, useMachineStatsWatch } from '@/components/machines/use-machine-stats.ts';
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
  titleLabel = label,
  window,
  updatedAt,
  now,
  showReset,
  toggleable,
}: {
  label: string;
  /** 悬停提示里的名字（默认同 label），如「Fable 周限额」 */
  titleLabel?: string;
  window: RateLimitWindow;
  updatedAt: number | undefined;
  now: number;
  showReset: boolean;
  toggleable: boolean;
}): React.JSX.Element {
  const [countdown, setCountdown] = useState(false);
  const view = windowView(window, now);
  const title = windowTitle(titleLabel, window, updatedAt, now);
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
 * 引擎标签的显示方式：`none` 不标（只有 Claude 的机器，界面不变）；`icon` 只给图标
 * （列表顶部，地方小，名字给读屏和悬停）；`full` 图标 + 名字（机器详情）。
 */
export type EngineLabelMode = 'none' | 'icon' | 'full';

function EngineLabel({ engineId, name, mode }: { engineId: string; name: string; mode: EngineLabelMode }): React.JSX.Element | null {
  if (mode === 'none') return null;
  if (mode === 'icon') {
    return (
      <span data-testid="usage-engine-label" data-engine={engineId} title={name} className="inline-flex self-center">
        <EngineIcon engineId={engineId} />
        <span className="sr-only">{name}</span>
      </span>
    );
  }
  return (
    <span data-testid="usage-engine-label" data-engine={engineId} className="text-text-2 inline-flex self-start font-medium">
      <EngineName engineId={engineId} name={name} />
    </span>
  );
}

/** Claude 的窗口数（5h、1w、按模型的） */
export function claudeWindowCount(rateLimits: RateLimits | undefined): number {
  if (rateLimits === undefined) return 0;
  return (rateLimits.fiveHour === undefined ? 0 : 1) + (rateLimits.sevenDay === undefined ? 0 : 1) + (rateLimits.models?.length ?? 0);
}

/** Claude 的限额有没有可显示的窗口 */
export function hasClaudeWindows(rateLimits: RateLimits | undefined): rateLimits is RateLimits {
  return (
    rateLimits !== undefined &&
    (rateLimits.fiveHour !== undefined || rateLimits.sevenDay !== undefined || (rateLimits.models?.length ?? 0) > 0)
  );
}

/** Claude 的各个窗口：5h、1w、按模型的周限额（显示「Fable」，悬停写明是周限额） */
function ClaudeWindows({
  rateLimits,
  now,
  showReset,
  toggleable,
  models = rateLimits.models,
}: {
  rateLimits: RateLimits;
  now: number;
  showReset: boolean;
  toggleable: boolean;
  /** 只显示其中一部分按模型的窗口（会话头部按会话模型筛） */
  models?: readonly ModelRateLimitWindow[] | undefined;
}): React.JSX.Element {
  return (
    <>
      {rateLimits.fiveHour !== undefined && (
        <WindowValue label="5h" window={rateLimits.fiveHour} updatedAt={rateLimits.updatedAt} now={now} showReset={showReset} toggleable={toggleable} />
      )}
      {rateLimits.sevenDay !== undefined && (
        <WindowValue label="1w" window={rateLimits.sevenDay} updatedAt={rateLimits.updatedAt} now={now} showReset={showReset} toggleable={toggleable} />
      )}
      {models?.map((m) => (
        <WindowValue
          key={`model:${m.name}`}
          label={m.name}
          titleLabel={`${m.name} 周限额`}
          window={m}
          updatedAt={rateLimits.updatedAt}
          now={now}
          showReset={showReset}
          toggleable={toggleable}
        />
      ))}
    </>
  );
}

/**
 * 一台机器 Claude 的 5h / 1w / 按模型的周限额；没有任何窗口时渲染 null。`interactive` 为
 * false 时不可点（放在整块是链接的机器卡里，按钮嵌在链接里既不合法、点了也会跳页）。
 */
export function PlanUsageLine({
  rateLimits,
  now,
  className,
  interactive = true,
  label = 'none',
  showReset = true,
}: {
  rateLimits: RateLimits | undefined;
  now: number;
  className?: string;
  interactive?: boolean;
  label?: EngineLabelMode;
  /** false = 只给百分比（列表顶部窗口多时省地方；重置时间看悬停或点一下切倒计时） */
  showReset?: boolean;
}): React.JSX.Element | null {
  if (!hasClaudeWindows(rateLimits)) return null;
  return (
    <span
      data-testid="plan-usage"
      data-engine={CLAUDE_ENGINE_ID}
      className={cn('inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs', className)}
    >
      <EngineLabel engineId={CLAUDE_ENGINE_ID} name="Claude" mode={label} />
      <ClaudeWindows rateLimits={rateLimits} now={now} showReset={showReset} toggleable={interactive} />
    </span>
  );
}

/** 一个非 Claude 引擎的各个窗口 */
function EngineWindows({
  engine,
  now,
  toggleable,
  showReset = true,
}: {
  engine: EngineSummary;
  now: number;
  toggleable: boolean;
  showReset?: boolean;
}): React.JSX.Element {
  return (
    <>
      {engine.rateLimits?.windows.map((w) => (
        <WindowValue key={w.id} label={windowLabel(w)} window={w} updatedAt={engine.rateLimits?.updatedAt} now={now} showReset={showReset} toggleable={toggleable} />
      ))}
    </>
  );
}

/** 其他引擎的限额（Claude 的在 PlanUsageLine）：「[图标] 1w 5%」；没有就渲染 null */
export function EngineUsageLines({
  info,
  now,
  className,
  interactive = true,
  label = 'icon',
  showReset = true,
}: {
  info: Pick<MachineInfo, 'engines'> | null | undefined;
  now: number;
  className?: string;
  interactive?: boolean;
  label?: EngineLabelMode;
  showReset?: boolean;
}): React.JSX.Element | null {
  const engines = enginesWithLimits(info);
  if (engines.length === 0) return null;
  return (
    <span data-testid="engine-usage" className={cn('inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs', className)}>
      {engines.map((engine) => (
        <span key={engine.id} className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5" data-engine={engine.id}>
          <EngineLabel engineId={engine.id} name={engineTag(engine)} mode={label} />
          <EngineWindows engine={engine} now={now} toggleable={interactive} showReset={showReset} />
        </span>
      ))}
    </span>
  );
}

/**
 * 机器详情的用量：每个引擎一行，行首「图标 + 名字」对齐成一列，后面是各窗口（放不下
 * 时在本行内换行）。Claude 还没有数据时给一句提示（支持刷新的 agent 才有，刷新按钮由
 * 调用方放）。什么都没有时渲染 null。
 */
export function MachineUsageRows({
  info,
  now,
  className,
}: {
  info: Pick<MachineInfo, 'engines' | 'rateLimits' | 'agentVersion'> | null | undefined;
  now: number;
  className?: string;
}): React.JSX.Element | null {
  const claude = enginesOf(info).find((e) => e.id === CLAUDE_ENGINE_ID);
  const others = enginesWithLimits(info).filter((e) => e.id !== CLAUDE_ENGINE_ID);
  const rateLimits = info?.rateLimits;
  const showClaude = claude !== undefined && (hasClaudeWindows(rateLimits) || supportsUsageRefresh(info));
  if (!showClaude && others.length === 0) return null;
  return (
    <div
      data-testid="machine-usage-rows"
      className={cn('grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-xs', className)}
    >
      {showClaude && (
        <div className="contents" data-testid="usage-row" data-engine={CLAUDE_ENGINE_ID}>
          <EngineLabel engineId={CLAUDE_ENGINE_ID} name={engineTag(claude)} mode="full" />
          {hasClaudeWindows(rateLimits) ? (
            <span data-testid="plan-usage" className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <ClaudeWindows rateLimits={rateLimits} now={now} showReset toggleable />
            </span>
          ) : (
            <span className="text-text-3">暂无数据，会话活动后更新</span>
          )}
        </div>
      )}
      {others.map((engine) => (
        <div key={engine.id} className="contents" data-testid="usage-row" data-engine={engine.id}>
          <EngineLabel engineId={engine.id} name={engineTag(engine)} mode="full" />
          <span data-testid="engine-usage" className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <EngineWindows engine={engine} now={now} toggleable />
          </span>
        </div>
      ))}
    </div>
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
      title="刷新用量（Claude 没有活跃会话时会临时启动一次）"
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
    .filter((m) => m.info?.rateLimits !== undefined || supportsUsageRefresh(m.info) || supportsMachineStats(m.info))
    .sort((a, b) => a.name.localeCompare(b.name));
  const statsInterval = useListStatsInterval();
  useMachineStatsWatch(
    rows.filter((m) => supportsMachineStats(m.info)).map((m) => m.machineId),
    statsInterval,
  );
  if (rows.length === 0) return null;
  return (
    <div data-testid="plan-usage-strip" className={cn('flex flex-col gap-0.5', className)}>
      {rows.map((m) => {
        const multi = hasMultipleEngines(m.info);
        // 多引擎或窗口超过两个（如带 Fable）时只给百分比，侧栏 300px 才排得下
        const compact = multi || claudeWindowCount(m.info?.rateLimits) > 2;
        return (
          <div key={m.machineId} data-machine-id={m.machineId} className="text-text-2 flex min-h-6 items-center gap-2 text-xs">
            {rows.length > 1 && <span className="text-text-3 max-w-[30%] shrink-0 truncate font-mono">{m.name}</span>}
            {/* 用量与资源摘要同一列：放不下时摘要换到下一行靠右（PC 侧栏只有 300px）。
                flex-auto 而不是 flex-1：按内容宽度参与换行判断 */}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
              {hasClaudeWindows(m.info?.rateLimits) ? (
                <PlanUsageLine
                  rateLimits={m.info?.rateLimits}
                  now={now}
                  // 有其他引擎时 Claude 也标上图标，两个引擎的数字才分得开
                  label={multi ? 'icon' : 'none'}
                  showReset={!compact}
                  className="min-w-0 flex-auto"
                />
              ) : supportsUsageRefresh(m.info) && enginesWithLimits(m.info).length === 0 ? (
                <span className="text-text-3 min-w-0 flex-1 truncate">用量：暂无数据，会话活动后更新</span>
              ) : null}
              <EngineUsageLines info={m.info} now={now} showReset={!compact} className="min-w-0 flex-auto" />
              <MachineStatsBrief machine={m} now={now} intervalMs={statsInterval} className="ml-auto" />
            </div>
            <PlanUsageRefreshButton machine={m} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * 会话用到的按模型限额：会话模型名里含桶名（不分大小写，如 `claude-fable-5` 对「Fable」）
 * 的那些。模型未知（默认模型）时不显示——不知道会话在不在用这个桶。
 */
export function sessionModelWindows(
  models: readonly ModelRateLimitWindow[] | undefined,
  sessionModel: string | undefined,
): ModelRateLimitWindow[] {
  if (models === undefined || sessionModel === undefined || sessionModel === '') return [];
  const model = sessionModel.toLowerCase();
  return models.filter((m) => model.includes(m.name.toLowerCase()));
}

/**
 * 会话头部：ctx / 5h / 1w 百分比（不带重置时间，省地方；悬停看详情）。给了
 * `onRefreshContext` 时 ctx 是按钮，点一下让 agent 重新取（还没有值时显示「ctx —」）。
 * 什么都没有、也不能刷新时渲染 null。
 */
export function SessionUsage({
  context,
  rateLimits,
  windows,
  model,
  now,
  onRefreshContext,
}: {
  context: ContextUsage | undefined;
  rateLimits: RateLimits | undefined;
  /** 非 Claude 引擎的限额窗口（时长和数量因账号而异） */
  windows?: EngineSummary['rateLimits'];
  /** 会话模型：Claude 按模型的周限额（Fable）只在会话用这个模型时显示 */
  model?: string | undefined;
  now: number;
  /** 手动刷新 context；resolve 后结束转圈（成败提示由调用方负责） */
  onRefreshContext?: (() => Promise<void>) | undefined;
}): React.JSX.Element | null {
  const [refreshing, setRefreshing] = useState(false);
  const ctx = context === undefined ? undefined : contextView(context);
  const canRefresh = onRefreshContext !== undefined;
  const hasWindows = (windows?.windows.length ?? 0) > 0;
  const modelWindows = sessionModelWindows(rateLimits?.models, model);
  const hasClaude = rateLimits !== undefined && (rateLimits.fiveHour !== undefined || rateLimits.sevenDay !== undefined || modelWindows.length > 0);
  if (ctx === undefined && !canRefresh && !hasClaude && !hasWindows) return null;
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
      {rateLimits !== undefined && (
        <ClaudeWindows rateLimits={rateLimits} now={now} showReset={false} toggleable models={modelWindows} />
      )}
      {windows?.windows.map((w) => (
        <WindowValue key={w.id} label={windowLabel(w)} window={w} updatedAt={windows.updatedAt} now={now} showReset={false} toggleable />
      ))}
    </span>
  );
}

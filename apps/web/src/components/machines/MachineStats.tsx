/**
 * 机器资源数据的展示（machine-stats）：
 * - `MachineStatsBrief`：列表顶部每台机器一行里的「CPU 23% 内存 53%」，盘 ≥ 90% 才出现；
 * - `MachineStatsLine`：机器卡上的一行「CPU 23% · 内存 4.1/7.7 GB · 磁盘 72%」；
 * - `MachineStatsSection`：机器详情页的「资源」区块（条形 + 本次打开以来的趋势 + 刷新）。
 *
 * 数值一律用正文色，颜色只在超过阈值时出现（≥ 80% 琥珀、≥ 90% 红），并且总是和数字
 * 一起出现，不单靠颜色表达。过时的快照（机器离线 / 太久没更新）照常显示，调暗并注明时间。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { RefreshCwIcon } from 'lucide-react';
import type { MachineStats } from '@trine/core';
import { Button } from '@/components/ui/button.tsx';
import type { MachineState } from '@/store/types.ts';
import { formatBytes, formatRelativeTime } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { useClient } from '@/app/runtime.ts';
import {
  formatMemoryPair,
  formatPercent,
  formatRate,
  formatUptime,
  fullestDisk,
  isStatsStale,
  percentTone,
  ratio,
  sparklinePoints,
  supportsMachineStats,
  type StatsTone,
} from './stats-model.ts';

const TONE_TEXT: Record<StatsTone, string> = {
  normal: '',
  warn: 'text-amber',
  danger: 'text-red font-semibold',
};

const TONE_FILL: Record<StatsTone, string> = {
  normal: 'bg-brand',
  warn: 'bg-amber',
  danger: 'bg-red',
};

function memoryPercent(stats: MachineStats): number | undefined {
  return stats.memory === undefined ? undefined : ratio(stats.memory.usedBytes, stats.memory.totalBytes);
}

function staleTitle(stats: MachineStats, now: number, online: boolean | null): string {
  return `${online === false ? '机器离线，' : ''}资源数据更新于 ${formatRelativeTime(stats.at, now)}`;
}

function Value({ label, percent, children }: { label: string; percent: number; children?: React.ReactNode }): React.JSX.Element {
  return (
    <span className="tabular inline-flex items-baseline gap-1 whitespace-nowrap">
      <span className="text-text-3">{label}</span>
      <span className={TONE_TEXT[percentTone(percent)]}>{children ?? formatPercent(percent)}</span>
    </span>
  );
}

/** 列表顶部：CPU / 内存百分比，最满的盘 ≥ 90% 时追加 */
export function MachineStatsBrief({
  machine,
  now,
  intervalMs,
  className,
}: {
  machine: MachineState;
  now: number;
  intervalMs: number | null;
  className?: string;
}): React.JSX.Element | null {
  const stats = machine.stats;
  if (stats === null) return null;
  const mem = memoryPercent(stats);
  const disk = fullestDisk(stats);
  const stale = isStatsStale(stats, now, machine.online, intervalMs);
  return (
    <span
      data-testid="machine-stats-brief"
      data-stale={stale || undefined}
      title={staleTitle(stats, now, machine.online)}
      className={cn('inline-flex shrink-0 items-baseline gap-2 text-xs', stale && 'opacity-50', className)}
    >
      {stats.cpu !== undefined && <Value label="CPU" percent={stats.cpu.percent} />}
      {mem !== undefined && <Value label="内存" percent={mem} />}
      {disk !== undefined && disk.percent >= 90 && <Value label="磁盘" percent={disk.percent} />}
    </span>
  );
}

/** 机器卡：一行紧凑信息 */
export function MachineStatsLine({
  machine,
  now,
  intervalMs,
  className,
}: {
  machine: MachineState;
  now: number;
  intervalMs: number | null;
  className?: string;
}): React.JSX.Element | null {
  const stats = machine.stats;
  if (stats === null) return null;
  const mem = memoryPercent(stats);
  const disk = fullestDisk(stats);
  const stale = isStatsStale(stats, now, machine.online, intervalMs);
  return (
    <span
      data-testid="machine-stats-line"
      data-stale={stale || undefined}
      title={staleTitle(stats, now, machine.online)}
      className={cn('inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs', stale && 'opacity-50', className)}
    >
      {stats.cpu !== undefined && <Value label="CPU" percent={stats.cpu.percent} />}
      {mem !== undefined && stats.memory !== undefined && (
        <Value label="内存" percent={mem}>
          {formatMemoryPair(stats.memory.usedBytes, stats.memory.totalBytes)}
        </Value>
      )}
      {disk !== undefined && <Value label="磁盘" percent={disk.percent} />}
    </span>
  );
}

/** 手动刷新按钮；失败 toast */
export function MachineStatsRefreshButton({ machine }: { machine: MachineState }): React.JSX.Element | null {
  const client = useClient();
  const [refreshing, setRefreshing] = useState(false);
  if (client === null || !supportsMachineStats(machine.info)) return null;
  const refresh = (): void => {
    setRefreshing(true);
    void client
      .requestMachineStats(machine.machineId)
      .catch((err: unknown) =>
        toast.error(`${machine.name}：刷新资源数据失败（${err instanceof Error ? err.message : String(err)}）`),
      )
      .finally(() => setRefreshing(false));
  };
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      data-testid="machine-stats-refresh"
      title="刷新资源数据"
      aria-label="刷新资源数据"
      disabled={refreshing || machine.online === false}
      onClick={refresh}
    >
      <RefreshCwIcon className={cn(refreshing && 'motion-safe:animate-spin')} />
    </Button>
  );
}

/** 一条用量：标签 · 条形 · 数字 · 趋势（可选），明细在下一行 */
function Meter({
  label,
  percent,
  detail,
  testId,
  trend,
}: {
  label: string;
  percent: number;
  detail: string;
  testId: string;
  trend?: React.ReactNode;
}): React.JSX.Element {
  const tone = percentTone(percent);
  return (
    <div className="grid grid-cols-[3.5rem_1fr] items-center gap-x-3 gap-y-0.5" data-testid={testId}>
      <span className="text-text-3 text-xs">{label}</span>
      <div className="flex min-w-0 items-center gap-2.5">
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          className="bg-surface-3 h-1.5 min-w-16 flex-1 overflow-hidden rounded-full sm:max-w-56"
        >
          <div className={cn('h-full rounded-full', TONE_FILL[tone])} style={{ width: `${percent}%` }} />
        </div>
        <span className={cn('tabular w-9 shrink-0 text-right text-xs', TONE_TEXT[tone])}>{formatPercent(percent)}</span>
        {/* 没有趋势线的行也留出同宽，百分比列上下对齐 */}
        {trend ?? <span aria-hidden className="w-24 shrink-0" />}
      </div>
      <span className="text-text-3 tabular col-start-2 min-w-0 truncate text-[11.5px]">{detail}</span>
    </div>
  );
}

/** 本次打开页面以来的趋势（0–100%）；不足 2 个点时只占位 */
function Sparkline({ label, values }: { label: string; values: number[] }): React.JSX.Element {
  if (values.length < 2) return <span aria-hidden className="w-24 shrink-0" />;
  const width = 96;
  const height = 20;
  const last = values[values.length - 1]!;
  const max = Math.max(...values);
  const min = Math.min(...values);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={`${label}趋势：最近 ${formatPercent(last)}，最高 ${formatPercent(max)}，最低 ${formatPercent(min)}`}
      className="text-brand shrink-0 overflow-visible"
      data-testid="machine-stats-sparkline"
    >
      <title>{`${label}（本页打开以来 ${values.length} 次采样）：最近 ${formatPercent(last)} · 最高 ${formatPercent(max)} · 最低 ${formatPercent(min)}`}</title>
      <line x1={0} x2={width} y1={height} y2={height} className="stroke-border" strokeWidth={1} />
      <polyline
        points={sparklinePoints(values, width, height)}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** 机器详情页「资源」区块 */
export function MachineStatsSection({
  machine,
  now,
  intervalMs,
}: {
  machine: MachineState;
  now: number;
  intervalMs: number | null;
}): React.JSX.Element | null {
  if (!supportsMachineStats(machine.info)) return null;
  const stats = machine.stats;
  const stale = stats !== null && isStatsStale(stats, now, machine.online, intervalMs);
  const history = machine.statsHistory;
  const cpuSeries = history.flatMap((s) => (s.cpu === undefined ? [] : [s.cpu.percent]));
  const memSeries = history.flatMap((s) => {
    const p = memoryPercent(s);
    return p === undefined ? [] : [p];
  });

  return (
    <section className="flex flex-col gap-2.5" data-testid="machine-stats-section">
      <div className="flex items-center gap-2">
        <h2 className="font-medium">资源</h2>
        {stats !== null && (
          <span className={cn('text-text-3 text-xs', stale && 'text-amber')} data-testid="machine-stats-updated">
            {machine.online === false ? '机器离线 · ' : ''}更新于 {formatRelativeTime(stats.at, now)}
          </span>
        )}
        <span className="ml-auto">
          <MachineStatsRefreshButton machine={machine} />
        </span>
      </div>
      {stats === null ? (
        <p className="text-text-3 text-xs">
          {machine.online === false ? '机器离线，暂无资源数据。' : intervalMs === null ? '点刷新获取资源数据。' : '正在获取资源数据…'}
        </p>
      ) : (
        <div className={cn('flex flex-col gap-2.5', stale && 'opacity-60')}>
          {stats.cpu !== undefined && (
            <Meter
              label="CPU"
              percent={stats.cpu.percent}
              testId="stats-cpu"
              detail={`${stats.cpu.cores} 核${stats.cpu.load === undefined ? '' : ` · 负载 ${stats.cpu.load.map((l) => l.toFixed(2)).join(' ')}`}`}
              trend={<Sparkline label="CPU" values={cpuSeries} />}
            />
          )}
          {stats.memory !== undefined && (
            <Meter
              label="内存"
              percent={ratio(stats.memory.usedBytes, stats.memory.totalBytes)}
              testId="stats-memory"
              detail={formatMemoryPair(stats.memory.usedBytes, stats.memory.totalBytes)}
              trend={<Sparkline label="内存" values={memSeries} />}
            />
          )}
          {stats.memory?.swapTotalBytes !== undefined && stats.memory.swapTotalBytes > 0 && (
            <Meter
              label="交换"
              percent={ratio(stats.memory.swapUsedBytes ?? 0, stats.memory.swapTotalBytes)}
              testId="stats-swap"
              detail={formatMemoryPair(stats.memory.swapUsedBytes ?? 0, stats.memory.swapTotalBytes)}
            />
          )}
          {(stats.disks ?? []).map((d) => (
            <Meter
              key={d.label}
              label={`磁盘 ${d.label}`}
              percent={ratio(d.usedBytes, d.usedBytes + d.availBytes)}
              testId="stats-disk"
              detail={`剩余 ${formatBytes(d.availBytes)} / ${formatBytes(d.totalBytes)}`}
            />
          ))}
          <dl className="text-text-2 grid grid-cols-[3.5rem_1fr] gap-x-3 gap-y-1 text-xs">
            {stats.network !== undefined && (
              <>
                <dt className="text-text-3">网络</dt>
                <dd className="tabular" data-testid="stats-network">
                  ↓ {formatRate(stats.network.rxBytesPerSec)} · ↑ {formatRate(stats.network.txBytesPerSec)}
                </dd>
              </>
            )}
            {stats.claude !== undefined && (
              <>
                <dt className="text-text-3">claude</dt>
                <dd className="tabular" data-testid="stats-claude" title="agent 拉起的全部子进程（claude CLI 及其 MCP server 等）">
                  {stats.claude.processes} 个进程 · {formatBytes(stats.claude.rssBytes)}
                </dd>
              </>
            )}
            {stats.uptimeSec !== undefined && (
              <>
                <dt className="text-text-3">已运行</dt>
                <dd className="tabular">{formatUptime(stats.uptimeSec)}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </section>
  );
}

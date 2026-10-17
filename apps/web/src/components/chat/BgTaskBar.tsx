/**
 * 后台任务条：会话里有后台 Bash / 后台子 agent 时，常驻在时间线底部、心跳 footer
 * 上方（两者都是「还有事在跑」的仪表，挨着放）。
 *
 * 一行一个任务：图标区分 bash / agent，描述，右侧状态——运行中给本地走秒的
 * 已运行时长（按 `startedAt` 与 ChatView 统一的 1s tick 算，与权限卡「已等待」
 * 同款口径，两端时钟差夹到 ≥0）；结束了给 ✓ / ✗ / ⊘ 与完成摘要。运行中的任务
 * 有「停止」（`bgtask.stop`，agent < 0.7.0 不显示——旧 agent 不认识这帧，按了只会
 * 等到超时）。
 *
 * 全部结束后折成一行「后台任务 N 个已完成」，点开可看摘要，不永久占屏。
 *
 * `stale`（评审 M2）：agent 重启 / 崩溃后落盘快照里的 running 已经不可信（判据见
 * reducer `bgTasksStale`）——这些行显示成「状态未知」、不走秒、没有停止按钮、
 * 不算在跑，条按「全部结束」折叠。
 */
import { useState } from 'react';
import type { BgTask } from '@trine/core';
import { formatDuration } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';

const KIND_ICON: Record<BgTask['kind'], string> = { bash: '🔧', agent: '🤖', other: '⚙️' };

/** 折叠行的文案：`后台任务 3 个已完成` / `… 2 个已完成 · 1 个失败 · 1 个已停止 · 1 个状态未知` */
export function collapsedLabel(tasks: readonly BgTask[], stale = false): string {
  const counts = { completed: 0, failed: 0, stopped: 0, unknown: 0 };
  for (const t of tasks) {
    if (t.status === 'running') {
      if (stale) counts.unknown += 1;
    } else counts[t.status] += 1;
  }
  const parts: string[] = [];
  if (counts.completed > 0) parts.push(`${counts.completed} 个已完成`);
  if (counts.failed > 0) parts.push(`${counts.failed} 个失败`);
  if (counts.stopped > 0) parts.push(`${counts.stopped} 个已停止`);
  if (counts.unknown > 0) parts.push(`${counts.unknown} 个状态未知`);
  return `后台任务 ${parts.join(' · ')}`;
}

/** 一个任务右侧的状态文案（运行中的时长由调用方按 now 算；stale 时运行中 = 状态未知） */
export function statusText(task: BgTask, now: number, stale = false): { text: string; tone: 'run' | 'ok' | 'error' | 'muted' } {
  switch (task.status) {
    case 'running': {
      if (stale) return { text: '? 状态未知（agent 已重启）', tone: 'muted' };
      const elapsed = formatDuration(Math.max(0, now - task.startedAt));
      const progress =
        task.kind === 'agent' && task.lastToolName !== undefined
          ? ` · ${task.lastToolName}${task.toolUses === undefined ? '' : ` ×${task.toolUses}`}`
          : '';
      return { text: `运行中 ${elapsed}${progress}`, tone: 'run' };
    }
    case 'completed':
      return { text: task.summary === undefined || task.summary === '' ? '✓ 完成' : `✓ ${task.summary}`, tone: 'ok' };
    case 'failed':
      return { text: task.summary === undefined || task.summary === '' ? '✗ 失败' : `✗ ${task.summary}`, tone: 'error' };
    case 'stopped':
      return { text: '⊘ 已停止', tone: 'muted' };
  }
}

const TONE_CLASS = {
  run: 'text-brand',
  ok: 'text-green',
  error: 'text-red',
  muted: 'text-text-3',
} as const;

export function BgTaskBar({
  tasks,
  now,
  canStop,
  onStop,
  stale = false,
}: {
  tasks: readonly BgTask[];
  /** ChatView 的 1s tick（有任务在跑时才走） */
  now: number;
  /** agent 是否支持 bgtask.stop（≥ 0.7.0） */
  canStop: boolean;
  onStop: (taskId: string) => void;
  /** 快照里的 running 已陈旧（见文件头） */
  stale?: boolean;
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (tasks.length === 0) return null;
  const running = stale ? 0 : tasks.filter((t) => t.status === 'running').length;
  const collapsed = running === 0 && !expanded;

  return (
    <div
      data-testid="bgtask-bar"
      data-running={running}
      data-stale={stale || undefined}
      className="border-border bg-surface-2 text-text-2 shrink-0 border-t px-3.5 py-1.5 text-[12px]"
    >
      {collapsed ? (
        <button
          type="button"
          data-testid="bgtask-collapsed"
          className="hover:text-text-1 flex w-full items-center gap-1.5 text-left"
          onClick={() => setExpanded(true)}
        >
          <span aria-hidden>▸</span>
          <span className="truncate">{collapsedLabel(tasks, stale)}</span>
        </button>
      ) : (
        <ul className="flex flex-col gap-1">
          {running === 0 && (
            <li>
              <button
                type="button"
                data-testid="bgtask-collapse"
                className="hover:text-text-1 flex items-center gap-1.5 text-left"
                onClick={() => setExpanded(false)}
              >
                <span aria-hidden>▾</span>
                <span className="truncate">{collapsedLabel(tasks, stale)}</span>
              </button>
            </li>
          )}
          {tasks.map((task) => {
            const status = statusText(task, now, stale);
            return (
              <li
                key={task.taskId}
                data-testid="bgtask-row"
                data-task-id={task.taskId}
                data-status={task.status}
                className="flex min-w-0 items-center gap-2"
              >
                <span aria-hidden className="w-[18px] shrink-0 text-center">
                  {KIND_ICON[task.kind]}
                </span>
                <span className="min-w-0 flex-1 truncate" title={task.description}>
                  {task.description === '' ? task.taskId : task.description}
                </span>
                <span
                  data-testid="bgtask-status"
                  className={cn('tabular min-w-0 shrink-0 truncate font-mono text-[11.5px]', TONE_CLASS[status.tone])}
                  title={status.text}
                  // 手机宽度：摘要再长也不挤掉描述，右侧最多占一半
                  style={{ maxWidth: '50%' }}
                >
                  {status.text}
                </span>
                {task.status === 'running' && !stale && canStop && (
                  <button
                    type="button"
                    data-testid="bgtask-stop"
                    className="border-border bg-surface hover:border-border-strong text-text-2 shrink-0 rounded-full border px-2 py-0.5 text-[11px]"
                    onClick={() => onStop(task.taskId)}
                  >
                    停止
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

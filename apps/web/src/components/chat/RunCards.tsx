/**
 * 一轮任务的收尾条目：完成卡与致命错误卡。
 *
 * **完成卡带成本**（NOTES.chat 第 6 条）：远程场景里看不见终端、也看不见
 * 账单，一轮花了多少是安心感的来源，不是可选装饰。
 *
 * **致命错误才出卡**（NOTES.states 第 4 条）：瞬时错误（流中断、5xx）agent
 * 自己 resume，时间线上只留一行痕迹（SystemNote）；只有额度/认证/配置这种
 * 必须人工决策的才占一整张卡。额度墙带 `retryAt` 时给「到点自动续跑」——
 * 远程场景下这比「回来手动点」有价值得多。
 */
import type { ErrorEntry, RunDoneEntry } from './entry-kinds.ts';
import { formatCost, formatDuration } from '@/lib/format.ts';
import { Button } from '@/components/ui/button.tsx';

export function DoneCard({ entry }: { entry: RunDoneEntry }): React.JSX.Element {
  return (
    <li
      data-testid="entry-run-done"
      className="border-border border-l-green bg-surface rounded-xl border border-l-[3px] px-3.5 py-2.5 text-[13px]"
    >
      <div className="mb-1 font-semibold">✓ 任务完成</div>
      <div className="text-text-2 tabular flex flex-wrap gap-x-3.5 gap-y-1 font-mono text-[12.5px]">
        <span>⏱ {formatDuration(entry.durationMs)}</span>
        <span>{formatCost(entry.costUsd)}</span>
        <span>{entry.toolCount} 次工具</span>
        <span>{entry.permissionCount} 次权限</span>
        {entry.turns !== undefined && <span>{entry.turns} 轮</span>}
      </div>
    </li>
  );
}

const FATAL_TITLE: Record<NonNullable<ErrorEntry['errorKind']>, string> = {
  quota: '🛑 额度已用尽',
  auth: '🛑 认证失败',
  config: '🛑 配置有误',
  other: '🛑 任务出错',
};

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function FatalCard({
  entry,
  onResumeAt,
  onStop,
}: {
  entry: ErrorEntry;
  onResumeAt: (at: number) => void;
  onStop: () => void;
}): React.JSX.Element {
  const kind = entry.errorKind ?? 'other';
  return (
    <li
      data-testid="entry-fatal"
      data-kind={kind}
      className="border-red bg-surface rounded-xl border border-l-[3px] px-3.5 py-2.5 text-[13px]"
    >
      <div className="text-red mb-0.5 font-semibold">{FATAL_TITLE[kind]}</div>
      <div className="text-text-2 text-[12.5px] break-words">{entry.message}</div>
      {kind === 'quota' && entry.retryAt !== undefined && (
        <>
          <div className="text-text-3 mt-1 text-[12.5px]">
            额度重置于 {formatClock(entry.retryAt)}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button
              size="sm"
              data-testid="resume-at"
              onClick={() => onResumeAt(entry.retryAt as number)}
            >
              {formatClock(entry.retryAt)} 后自动续跑
            </Button>
            <Button size="sm" variant="outline" data-testid="fatal-stop" onClick={onStop}>
              停止任务
            </Button>
          </div>
        </>
      )}
    </li>
  );
}

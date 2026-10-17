/**
 * 心跳 footer（原型 `.heartbeat`）：运行中常驻在 composer 上方。
 *
 * 「长任务不焦虑」是借鉴清单里用户感知最强的功能（NOTES.chat 第 3 条）。
 * 它回答的是远程场景下唯一要紧的问题——**它还活着吗、在干什么、卡了多久**。
 *
 *     ⏱ 2:31   🔧 Bash 12s   无输出 8s   ✋ 等待批准 45s
 *
 * 等待文案按最早一条 pending 的工具区分：等待批准 / 等待回答 / 等待批准计划。
 *
 * 静默 <60s 用中性色（方案 §0 行 j：工具结束后 agent 静默 ~40s 属常态），
 * ≥60s 才转 amber。数值平滑见 heartbeat-model.ts。
 */
import { formatDuration, formatSeconds } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import type { HeartbeatView } from './heartbeat-model.ts';

export function HeartbeatFooter({ view }: { view: HeartbeatView }): React.JSX.Element {
  return (
    <div
      data-testid="heartbeat"
      data-phase={view.phase}
      className="border-border bg-surface-2 text-text-2 tabular flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3.5 py-1.5 font-mono text-[11.5px]"
    >
      <span className="flex items-center gap-[5px]">
        <span aria-hidden>⏱</span>
        {formatDuration(view.runElapsedMs)}
      </span>
      {view.currentTool !== null && (
        <span data-testid="hb-tool" className="flex min-w-0 items-center gap-[5px]">
          <span aria-hidden>🔧</span>
          <span className="truncate">{view.currentTool.name}</span>
          {formatSeconds(view.currentTool.elapsedMs)}
        </span>
      )}
      <span
        data-testid="hb-silent"
        data-warn={String(view.silentWarn)}
        className={cn('flex items-center gap-[5px]', view.silentWarn && 'text-amber')}
      >
        {view.silentWarn && <span aria-hidden>⚠</span>}
        无输出 {formatSeconds(view.silentMs)}
      </span>
      {view.waitingMs !== null && (
        <span data-testid="hb-wait" className="text-amber flex items-center gap-[5px]">
          <span aria-hidden>✋</span>
          {view.waitingLabel} {formatSeconds(view.waitingMs)}
        </span>
      )}
    </div>
  );
}

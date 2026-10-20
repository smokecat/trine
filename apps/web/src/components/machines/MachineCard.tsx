/**
 * 机器卡（原型 `.mach`：r1 状态点 + 名字 + 平台；`.meta` 版本/活跃/心跳；
 * `.warnline` 排队告警）。
 *
 * 「版本可见很重要——远程排查『为什么这台不支持某功能』的第一线索」
 * （原型 `NOTES.machines`），所以版本行常驻而不是折进详情页。
 */
import { NavLink } from 'react-router';
import { StatusDot } from '@/components/shell/StatusDot.tsx';
import type { MachineState } from '@/store/types.ts';
import { cn } from '@/lib/utils.ts';
import { liveSessionsLine } from '@/components/list/sorting.ts';
import {
  machineHeartbeatLine,
  machinePlatformLine,
  machineTone,
  machineVersionLine,
  parkedWarnLine,
} from './machine-text.ts';

export function MachineCard({
  machine,
  activeCount,
  liveCount,
  now,
}: {
  machine: MachineState;
  activeCount: number;
  /** 有子进程的会话数（`meta.live`） */
  liveCount: number;
  now?: number;
}): React.JSX.Element {
  const platform = machinePlatformLine(machine.info);
  const live = liveSessionsLine(liveCount, machine.info?.maxSessions);
  const warn = parkedWarnLine(machine.parkedCount);

  return (
    <NavLink
      to={`/machines/${machine.machineId}`}
      data-testid="machine-card"
      data-machine-id={machine.machineId}
      data-online={String(machine.online)}
      className={cn(
        'border-border bg-surface hover:border-border-strong block rounded-[14px] border px-3.5 py-3 transition-colors',
      )}
    >
      <div className="mb-1.5 flex items-center gap-2.5">
        <StatusDot tone={machineTone(machine.online)} />
        <span className="min-w-0 flex-1 truncate font-mono text-[15px] font-semibold">
          {machine.name}
        </span>
        {platform !== '' && <span className="text-text-3 shrink-0 text-[11.5px]">{platform}</span>}
      </div>

      <div className="text-text-2 flex flex-wrap gap-x-3.5 gap-y-1 text-xs">
        <span className="tabular" data-testid="machine-heartbeat">
          {machineHeartbeatLine(machine.online, machine.lastSeenAt, now)}
        </span>
        <span className="font-mono text-[11.5px]" data-testid="machine-versions">
          {machineVersionLine(machine.info)}
        </span>
        {activeCount > 0 && <span className="text-brand-ink">{activeCount} 个活跃会话</span>}
        {live !== '' && (
          <span className="tabular" data-testid="machine-live">
            {live}
          </span>
        )}
      </div>

      {warn !== '' && (
        <div className="text-amber mt-2 flex items-baseline gap-1.5 text-xs" data-testid="machine-parked">
          <span aria-hidden>📮</span>
          {warn}
        </div>
      )}

      {machine.lastError && (
        <div className="text-red mt-1.5 flex items-baseline gap-1.5 text-xs">
          <span aria-hidden>⚠</span>
          <span className="min-w-0 flex-1">{machine.lastError.message}</span>
        </div>
      )}
    </NavLink>
  );
}

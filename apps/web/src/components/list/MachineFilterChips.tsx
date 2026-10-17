/**
 * 机器过滤 chip 行（原型 `.filter-row`）：全部 + 每台机器。
 * 列表页与 PC 侧栏共用；`machineFilter` 的值提在 Layout，两边同步。
 *
 * chip 内容：在线点 + 名称 + 活跃数；离线机器灰点 + 排队数角标
 * （原型 `.chip` 里的 `.dot on/off` 与 machines 屏的「📮 N 条排队」）。
 */
import { Chip, StatusDot } from '@/components/shell/StatusDot.tsx';
import { cn } from '@/lib/utils.ts';
import type { MachineFilterItem } from './sorting.ts';

export function MachineFilterChips({
  items,
  selected,
  onSelect,
  className,
}: {
  items: MachineFilterItem[];
  selected: string | null;
  onSelect: (machineId: string | null) => void;
  className?: string;
}): React.JSX.Element | null {
  // 只有一台机器时过滤没有意义——「全部」和「那一台」永远同一个结果
  if (items.length <= 1) return null;

  return (
    <div
      data-testid="machine-filter"
      className={cn('flex shrink-0 gap-1.5 overflow-x-auto', className)}
    >
      <Chip selected={selected === null} onClick={() => onSelect(null)} data-testid="filter-all">
        全部
      </Chip>
      {items.map((m) => (
        <Chip
          key={m.machineId}
          data-testid="filter-machine"
          data-machine-id={m.machineId}
          selected={selected === m.machineId}
          onClick={() => onSelect(m.machineId)}
          title={m.online === true ? '在线' : m.online === false ? '离线' : '状态未知'}
        >
          <StatusDot tone={m.online === true ? 'on' : 'off'} />
          {m.name}
          {m.activeCount > 0 && <span className="tabular">· {m.activeCount}</span>}
          {m.parkedCount > 0 && (
            <span className="text-amber tabular" title={`${m.parkedCount} 条消息排队中`}>
              📮{m.parkedCount}
            </span>
          )}
        </Chip>
      ))}
    </div>
  );
}

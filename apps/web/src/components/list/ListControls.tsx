/**
 * 会话列表控制行（session-list-v2 §4.2 / §4.5）：搜索框、状态 chips、
 * 「按工作空间」开关、「临时会话」开关、「已归档 (n)」入口。
 *
 * 两种排布，同一组零件：
 * - **列表页 / 归档视图**（`ListControls`）：搜索框一行 + chips 一行，直接铺开；
 * - **PC 侧栏**（`SidebarListControls`）：300px 放不下两行 chips，只留搜索框，
 *   其余收进「筛选」弹出层（评审 M4：PC 上没有列表页，这是归档视图与分组
 *   开关唯一的入口）。有非默认筛选时按钮高亮，免得用户忘了自己筛过。
 *
 * 值都不在这里持有：搜索词 / 状态在 Layout，分组与临时会话开关在 prefs，由调用方传入。
 */
import { useState } from 'react';
import { NavLink } from 'react-router';
import { ArchiveIcon, ListFilterIcon, SearchIcon, XIcon } from 'lucide-react';
import { Chip } from '@/components/shell/StatusDot.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { cn } from '@/lib/utils.ts';
import { STATUS_FILTER_LABEL, STATUS_FILTERS, type ListGroupBy, type StatusFilter } from './filtering.ts';

export const ARCHIVED_PATH = '/archived';

export function SearchBox({
  value,
  onChange,
  compact = false,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('relative flex min-w-0 items-center', className)}>
      <SearchIcon className="text-text-3 pointer-events-none absolute left-2.5 size-3.5" aria-hidden />
      <Input
        type="search"
        data-testid="list-search"
        aria-label="搜索会话"
        placeholder="搜索标题、目录、分支…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value !== '') {
            e.preventDefault();
            onChange('');
          }
        }}
        className={cn('pr-7 pl-8 [&::-webkit-search-cancel-button]:hidden', compact && 'h-7 text-[13px]')}
      />
      {value !== '' && (
        <button
          type="button"
          aria-label="清除搜索"
          data-testid="list-search-clear"
          className="text-text-3 hover:text-text-2 absolute right-1.5 p-1"
          onClick={() => onChange('')}
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function StatusChips({
  value,
  onChange,
  className,
}: {
  value: StatusFilter;
  onChange: (value: StatusFilter) => void;
  className?: string;
}): React.JSX.Element {
  return (
    <div role="group" aria-label="按状态筛选" data-testid="status-chips" className={cn('flex gap-1.5', className)}>
      {STATUS_FILTERS.map((f) => (
        <Chip
          key={f}
          data-testid="status-chip"
          data-status={f}
          aria-pressed={value === f}
          selected={value === f}
          onClick={() => onChange(f)}
        >
          {STATUS_FILTER_LABEL[f]}
        </Chip>
      ))}
    </div>
  );
}

export function GroupToggle({
  value,
  onChange,
}: {
  value: ListGroupBy;
  onChange: (value: ListGroupBy) => void;
}): React.JSX.Element {
  const on = value === 'workspace';
  return (
    <Chip
      data-testid="group-toggle"
      aria-pressed={on}
      selected={on}
      onClick={() => onChange(on ? 'none' : 'workspace')}
      title={on ? '当前按工作空间分组，点击改为平铺' : '当前平铺，点击按工作空间分组'}
    >
      按工作空间
    </Chip>
  );
}

export function TempToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}): React.JSX.Element {
  return (
    <Chip
      data-testid="temp-toggle"
      aria-pressed={value}
      selected={value}
      onClick={() => onChange(!value)}
      title={
        value
          ? '正在显示临时会话（临时目录下的、claude -p 等脚本跑出来的），点击隐藏'
          : '临时会话（临时目录下的、claude -p 等脚本跑出来的）已隐藏，点击显示'
      }
    >
      临时会话
    </Chip>
  );
}

export function ArchivedEntry({
  count,
  className,
  onNavigate,
}: {
  count: number;
  className?: string;
  onNavigate?: () => void;
}): React.JSX.Element {
  return (
    <NavLink
      to={ARCHIVED_PATH}
      data-testid="archived-entry"
      onClick={onNavigate}
      className={cn(
        'text-text-2 hover:text-text inline-flex shrink-0 items-center gap-1 text-[11.5px] whitespace-nowrap',
        className,
      )}
    >
      <ArchiveIcon className="size-3.5" aria-hidden />
      已归档 ({count})
    </NavLink>
  );
}

export interface ListControlsProps {
  search: string;
  onSearch: (value: string) => void;
  status: StatusFilter;
  onStatus: (value: StatusFilter) => void;
  groupBy: ListGroupBy;
  onGroupBy: (value: ListGroupBy) => void;
  showTemp: boolean;
  onShowTemp: (value: boolean) => void;
  /** 不传 = 不显示「已归档」入口（归档视图自己） */
  archivedCount?: number;
  className?: string;
}

/** 列表页 / 归档视图：铺开 */
export function ListControls({
  search,
  onSearch,
  status,
  onStatus,
  groupBy,
  onGroupBy,
  showTemp,
  onShowTemp,
  archivedCount,
  className,
}: ListControlsProps): React.JSX.Element {
  return (
    <div data-testid="list-controls" className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center gap-2.5">
        <SearchBox value={search} onChange={onSearch} className="flex-1" />
        {archivedCount !== undefined && <ArchivedEntry count={archivedCount} />}
      </div>
      {/* 窄屏放不下一行时整体换行，而不是横向滚动把开关藏到屏外 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChips value={status} onChange={onStatus} className="flex-wrap" />
        <span className="bg-border mx-0.5 h-4 w-px shrink-0" aria-hidden />
        <GroupToggle value={groupBy} onChange={onGroupBy} />
        <TempToggle value={showTemp} onChange={onShowTemp} />
      </div>
    </div>
  );
}

/** PC 侧栏：搜索框 + 「筛选」弹出层 */
export function SidebarListControls({
  search,
  onSearch,
  status,
  onStatus,
  groupBy,
  onGroupBy,
  showTemp,
  onShowTemp,
  archivedCount,
  className,
}: ListControlsProps): React.JSX.Element {
  // 非默认筛选：状态不是「全部」，或打开了临时会话
  const filtered = status !== 'all' || showTemp;
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="sidebar-list-controls" className={cn('flex items-center gap-1.5', className)}>
      <SearchBox value={search} onChange={onSearch} compact className="flex-1" />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            size="icon-sm"
            variant={filtered ? 'secondary' : 'ghost'}
            data-testid="list-filter-trigger"
            data-active={filtered}
            aria-label="筛选"
            title="筛选"
            className={cn(filtered && 'text-brand-ink')}
          >
            <ListFilterIcon />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" data-testid="list-filter-popover" className="flex flex-col gap-3">
          <section className="flex flex-col gap-1.5">
            <h3 className="text-text-3 text-xs">状态</h3>
            <StatusChips value={status} onChange={onStatus} className="flex-wrap" />
          </section>
          <section className="flex flex-col gap-1.5">
            <h3 className="text-text-3 text-xs">显示</h3>
            <div className="flex flex-wrap gap-1.5">
              <GroupToggle value={groupBy} onChange={onGroupBy} />
              <TempToggle value={showTemp} onChange={onShowTemp} />
            </div>
          </section>
          {archivedCount !== undefined && (
            <section className="border-border border-t pt-2.5">
              <ArchivedEntry count={archivedCount} className="text-[13px]" onNavigate={() => setOpen(false)} />
            </section>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

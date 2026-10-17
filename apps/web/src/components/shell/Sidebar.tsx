/**
 * PC（≥900px）常驻左侧栏，300px 固定宽——原型 `.desk-side`。
 *
 * 结构（自上而下，照原型）：
 *   brand「◈ trine」+ 连接状态 chip
 *   机器过滤 chip 行          ← components/list/MachineFilterChips
 *   搜索框 + 「筛选」弹出层    ← components/list/ListControls（SidebarListControls）
 *   会话列表                   ← components/list/SessionList（compact 变体）
 *   底部「+ 新建 / 机器 / 设置」
 *
 * ## 中间两块与列表页共用同一套组件（2b 已接上）
 *
 * 方案要求侧栏与列表页复用同一套组件，所以这里的两个 Slot 只是薄封装：
 * 从 store 取数据、传给 `components/list/**`，紧凑变体对应原型的
 * `.desk-side .sess{padding:9px 11px}`。过滤选中态由 Layout 持有
 * （`useMachineFilter()`），列表页选了机器侧栏跟着变。
 * 本文件的骨架、300px 宽度、底部入口保持 2a 定稿不动。
 */
import { useMemo } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { MonitorIcon, PlusIcon, RefreshCwIcon, SettingsIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { ScrollArea } from '@/components/ui/scroll-area.tsx';
import { MachineFilterChips } from '@/components/list/MachineFilterChips.tsx';
import { SessionList } from '@/components/list/SessionList.tsx';
import { SidebarListControls } from '@/components/list/ListControls.tsx';
import { countArchived } from '@/components/list/filtering.ts';
import { selectMachineFilterItems } from '@/components/list/sorting.ts';
import { useListGroupBy, useListQuery } from '@/components/list/use-list-query.ts';
import { useSessionActions } from '@/components/list/use-session-actions.ts';
import { useListFilters } from '@/app/Layout.tsx';
import { useNow, useSessionRefresh } from '@/components/list/use-session-refresh.ts';
import { NewSessionSheetRoute } from '@/components/sheets/new-session-route.tsx';
import { useTrine } from '@/app/runtime.ts';
import { cn } from '@/lib/utils.ts';
import { ChipLabel, StatusDot } from './StatusDot.tsx';

/** 连接状态 → 状态点 + 文案。侧栏顶部与设置页共用这套口径 */
export function useConnectionChip(): { tone: 'on' | 'off' | 'wait' | 'err'; label: string } {
  const connection = useTrine((s) => s.connection);
  const paired = useTrine((s) => s.paired);
  if (!paired) return { tone: 'off', label: '未配对' };
  switch (connection.status) {
    case 'open':
      return { tone: 'on', label: '已连接' };
    case 'authenticating':
    case 'connecting':
      return { tone: 'wait', label: '连接中' };
    case 'backoff':
      return { tone: 'wait', label: '重连中' };
    case 'needs_upgrade':
      return { tone: 'err', label: '需升级' };
    case 'stopped':
    case 'idle':
      return { tone: 'off', label: '未连接' };
  }
}

export function Brand(): React.JSX.Element {
  const chip = useConnectionChip();
  return (
    <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5 text-[15px] font-semibold">
      <span className="text-brand font-mono" aria-hidden>
        ◈
      </span>
      trine
      <ChipLabel className="ml-auto" data-testid="connection-chip">
        <StatusDot tone={chip.tone} />
        {chip.label}
      </ChipLabel>
    </div>
  );
}

/**
 * 机器过滤 chip 行 —— 2b：`components/list/MachineFilterChips` 的薄封装。
 * 选中态由 Layout 持有，列表页与侧栏同一个值。
 */
function MachineFilterSlot({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (machineId: string | null) => void;
}): React.JSX.Element | null {
  const machines = useTrine((s) => s.machines);
  const sessions = useTrine((s) => s.sessions);
  const items = useMemo(() => selectMachineFilterItems(machines, sessions), [machines, sessions]);
  return (
    <MachineFilterChips items={items} selected={selected} onSelect={onSelect} className="px-3 pb-2" />
  );
}

/**
 * 搜索框 + 「筛选」弹出层（session-list-v2 §4.5，评审 M4）。PC 上列表页
 * 从不挂载，状态 chips、分组开关、已归档入口只能从这里进。
 */
function ListControlsSlot({ filter }: { filter: string | null }): React.JSX.Element {
  const sessions = useTrine((s) => s.sessions);
  const { search, setSearch, status, setStatus } = useListFilters();
  const [groupBy, setGroupBy] = useListGroupBy();
  return (
    <SidebarListControls
      search={search}
      onSearch={setSearch}
      status={status}
      onStatus={setStatus}
      groupBy={groupBy}
      onGroupBy={setGroupBy}
      archivedCount={countArchived(sessions, filter)}
      className="px-3 pb-2"
    />
  );
}

/**
 * 会话列表 —— 2b：`components/list/SessionList` 的紧凑变体
 * （原型 `.desk-side .sess{padding:9px 11px}`），与列表页同一套过滤管线与卡片。
 * 侧栏恒显示未归档视图；归档视图走 `/archived` 渲染在主区。
 */
function SessionListSlot(): React.JSX.Element {
  const sessions = useTrine((s) => s.sessions);
  const machines = useTrine((s) => s.machines);
  const query = useListQuery({ archived: false });
  const actions = useSessionActions();
  const now = useNow();
  return (
    <>
      <SessionList
        sessions={sessions}
        machines={machines}
        query={query}
        actions={actions}
        variant="compact"
        now={now}
        className="px-2.5 pb-3"
      />
      {/*
        新建会话 sheet 的挂载点（PC）。它是 portal，对侧栏布局零影响；挂在这里
        是因为 PC 上唤起它的「+ 新建」在侧栏底部，而列表页此刻并没有挂载
        （PC 的 `/` 主区是空态）。移动端反过来——不渲染侧栏，由列表页挂载。
      */}
      <NewSessionSheetRoute />
    </>
  );
}

export function Sidebar({
  filter,
  onFilterChange,
}: {
  filter: string | null;
  onFilterChange: (machineId: string | null) => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  // PC 上列表页从不挂载（`/` 渲染 EmptyMain），刷新入口只能在侧栏（评审 M1）
  const { refresh, refreshing, canRefresh } = useSessionRefresh();
  return (
    <aside
      data-testid="sidebar"
      className="border-border bg-surface flex w-[300px] shrink-0 flex-col border-r"
    >
      <Brand />
      <MachineFilterSlot selected={filter} onSelect={onFilterChange} />
      <ListControlsSlot filter={filter} />
      <ScrollArea className="min-h-0 flex-1">
        <SessionListSlot />
      </ScrollArea>
      <div className="border-border flex items-center gap-1 border-t px-2.5 py-2">
        <Button
          size="sm"
          className="flex-1"
          data-testid="sidebar-new"
          onClick={() => navigate('/?new=1')}
        >
          <PlusIcon />
          新建
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          data-testid="sidebar-refresh"
          title="刷新会话列表"
          aria-label="刷新会话列表"
          disabled={!canRefresh || refreshing}
          onClick={refresh}
        >
          <RefreshCwIcon className={cn(refreshing && 'motion-safe:animate-spin')} />
        </Button>
        <Button size="icon-sm" variant="ghost" asChild title="机器">
          <NavLink to="/machines" aria-label="机器">
            <MonitorIcon />
          </NavLink>
        </Button>
        <Button size="icon-sm" variant="ghost" asChild title="设置">
          <NavLink to="/settings" aria-label="设置">
            <SettingsIcon />
          </NavLink>
        </Button>
      </div>
    </aside>
  );
}

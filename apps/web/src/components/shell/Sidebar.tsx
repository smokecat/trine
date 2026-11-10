/**
 * Desktop workspace navigation (900px+).
 * Brand / create / workspace filters / sessions / maintenance actions.
 * The right edge can be dragged to resize (dragging far left collapses it); collapsed it
 * becomes an icon rail. ⌘B / Ctrl+B toggles. Width and collapsed state live in prefs.
 * Session data and filtering are shared with the mobile list view.
 * See docs/DESIGN.md for layout and component conventions.
 */
import { useMemo, useRef } from 'react';
import { NavLink } from 'react-router';
import { MonitorIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, RefreshCwIcon, SettingsIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { ScrollArea } from '@/components/ui/scroll-area.tsx';
import { MachineFilterChips } from '@/components/list/MachineFilterChips.tsx';
import { SessionList } from '@/components/list/SessionList.tsx';
import { SidebarListControls } from '@/components/list/ListControls.tsx';
import { countArchived } from '@/components/list/filtering.ts';
import { selectMachineFilterItems } from '@/components/list/sorting.ts';
import { useEngineFilter, useListGroupBy, useListQuery, useListShowTemp } from '@/components/list/use-list-query.ts';
import { useSessionActions } from '@/components/list/use-session-actions.ts';
import { useListFilters } from '@/app/Layout.tsx';
import { useNow, useSessionRefresh } from '@/components/list/use-session-refresh.ts';
import { NewSessionSheetRoute, useNewSessionSheet } from '@/components/sheets/new-session-route.tsx';
import { PlanUsageStrip } from '@/components/usage/PlanUsage.tsx';
import { useClient, useTrine } from '@/app/runtime.ts';
import { IS_MAC } from '@/components/composer/composer-keys.ts';
import { SIDEBAR_MIN_WIDTH } from '@/lib/layout-prefs.ts';
import { cn } from '@/lib/utils.ts';
import { ChipLabel, StatusDot } from './StatusDot.tsx';
import { useSidebarResize, useSidebarShortcut } from './sidebar-resize.ts';

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

export function Brand({ trailing }: { trailing?: React.ReactNode }): React.JSX.Element {
  const chip = useConnectionChip();
  return (
    <div className="flex items-center gap-2.5 px-4 pt-5 pb-4 text-[17px] font-semibold">
      <span className="text-brand font-mono" aria-hidden>
        ◈
      </span>
      trine
      <ChipLabel className="ml-auto" data-testid="connection-chip">
        <StatusDot tone={chip.tone} />
        {chip.label}
      </ChipLabel>
      {trailing}
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

/** 订阅限额用量（每台机器一行，跟随机器过滤）；PC 上列表页不挂载，只能放侧栏 */
function PlanUsageSlot({ filter }: { filter: string | null }): React.JSX.Element | null {
  const now = useNow();
  return <PlanUsageStrip filter={filter} now={now} className="px-3.5 pb-2" />;
}

/**
 * 搜索框 + 「筛选」弹出层（session-list-v2 §4.5，评审 M4）。PC 上列表页
 * 从不挂载，状态 chips、分组开关、已归档入口只能从这里进。
 */
function ListControlsSlot({ filter }: { filter: string | null }): React.JSX.Element {
  const sessions = useTrine((s) => s.sessions);
  const { search, setSearch, status, setStatus } = useListFilters();
  const [groupBy, setGroupBy] = useListGroupBy();
  const [showTemp, setShowTemp] = useListShowTemp();
  const { engine, setEngine, options: engineOptions } = useEngineFilter();
  return (
    <SidebarListControls
      search={search}
      onSearch={setSearch}
      status={status}
      onStatus={setStatus}
      groupBy={groupBy}
      onGroupBy={setGroupBy}
      showTemp={showTemp}
      onShowTemp={setShowTemp}
      engine={engine}
      onEngine={setEngine}
      engineOptions={engineOptions}
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
  const [, setShowTemp] = useListShowTemp();
  const actions = useSessionActions();
  const now = useNow();
  return (
    <>
      <SessionList
        sessions={sessions}
        machines={machines}
        query={query}
        actions={actions}
        onShowTemp={setShowTemp}
        variant="compact"
        now={now}
        className="px-2.5 pb-3"
      />
    </>
  );
}

/** 侧栏底部的刷新 / 机器 / 设置；展开时横排，折叠成图标栏时竖排 */
function SidebarFooterActions({ vertical = false }: { vertical?: boolean }): React.JSX.Element {
  // PC 上列表页从不挂载（`/` 渲染 EmptyMain），刷新入口只能在侧栏（评审 M1）
  const { refresh, refreshing, canRefresh } = useSessionRefresh();
  return (
    <div className={cn('flex items-center gap-2', vertical && 'flex-col gap-1')}>
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
  );
}

const SHORTCUT = IS_MAC ? '⌘B' : 'Ctrl+B';

/** 折叠后的图标栏：展开、新建，底部仍是刷新 / 机器 / 设置 */
function SidebarRail({ onExpand }: { onExpand: () => void }): React.JSX.Element {
  const [, setNewOpen] = useNewSessionSheet();
  const chip = useConnectionChip();
  return (
    <aside
      data-testid="sidebar"
      data-collapsed=""
      className="border-border bg-background flex w-14 shrink-0 flex-col items-center gap-1 border-r pt-4 pb-3 min-[1100px]:border-r-0"
    >
      <span className="relative mb-2 flex size-8 items-center justify-center" title={chip.label} data-testid="connection-chip">
        <span className="text-brand font-mono text-[17px]" aria-hidden>
          ◈
        </span>
        <StatusDot tone={chip.tone} className="absolute right-0.5 bottom-0.5" />
        <span className="sr-only">{chip.label}</span>
      </span>
      <Button size="icon-sm" variant="ghost" data-testid="sidebar-expand" title={`展开侧栏（${SHORTCUT}）`} aria-label="展开侧栏" onClick={onExpand}>
        <PanelLeftOpenIcon />
      </Button>
      <Button size="icon-sm" data-testid="sidebar-new" title="新建会话" aria-label="新建会话" onClick={() => setNewOpen(true)}>
        <PlusIcon />
      </Button>
      <div className="flex-1" />
      <SidebarFooterActions vertical />
    </aside>
  );
}

export function Sidebar({
  filter,
  onFilterChange,
}: {
  filter: string | null;
  onFilterChange: (machineId: string | null) => void;
}): React.JSX.Element {
  const client = useClient();
  const collapsed = useTrine((s) => s.prefs.sidebarCollapsed);
  const setCollapsed = (value: boolean): void => client?.updatePrefs({ sidebarCollapsed: value });
  useSidebarShortcut(() => setCollapsed(!collapsed));
  return (
    <>
      {collapsed ? (
        <SidebarRail onExpand={() => setCollapsed(false)} />
      ) : (
        <ExpandedSidebar filter={filter} onFilterChange={onFilterChange} onCollapse={() => setCollapsed(true)} />
      )}
      {/*
        新建会话 sheet 的挂载点（PC）。它是 portal，对侧栏布局零影响；挂在这里
        是因为 PC 上唤起它的「+ 新建」在侧栏里，而列表页此刻并没有挂载
        （PC 的 `/` 主区是空态）。移动端反过来——不渲染侧栏，由列表页挂载。
      */}
      <NewSessionSheetRoute />
    </>
  );
}

function ExpandedSidebar({
  filter,
  onFilterChange,
  onCollapse,
}: {
  filter: string | null;
  onFilterChange: (machineId: string | null) => void;
  onCollapse: () => void;
}): React.JSX.Element {
  const client = useClient();
  const [, setNewOpen] = useNewSessionSheet();
  const storedWidth = useTrine((s) => s.prefs.sidebarWidth);
  const asideRef = useRef<HTMLElement | null>(null);
  const resize = useSidebarResize(asideRef, {
    onCommit: (width) => client?.updatePrefs({ sidebarWidth: width }),
    onCollapse,
    onReset: () => client?.updatePrefs({ sidebarWidth: null }),
  });
  const width = resize.dragWidth ?? storedWidth;
  return (
    <aside
      ref={asideRef}
      data-testid="sidebar"
      className={cn(
        'border-border bg-background relative flex shrink-0 flex-col border-r min-[1100px]:border-r-0',
        width === null && 'w-[300px] min-[1100px]:w-[320px]',
        resize.willCollapse && 'opacity-60',
      )}
      // 窗口变窄时给主区至少留 480px（与 layout-prefs 的拖动上限同一口径）
      style={width === null ? undefined : { width: `clamp(${SIDEBAR_MIN_WIDTH}px, ${width}px, 100vw - 480px)` }}
    >
      <Brand
        trailing={
          <Button
            size="icon-xs"
            variant="ghost"
            data-testid="sidebar-collapse"
            className="text-text-3 hover:text-text -mr-1"
            title={`收起侧栏（${SHORTCUT}）`}
            aria-label="收起侧栏"
            onClick={onCollapse}
          >
            <PanelLeftCloseIcon />
          </Button>
        }
      />
      <div className="px-3 pb-4">
        <Button className="w-full justify-start" data-testid="sidebar-new" onClick={() => setNewOpen(true)}>
          <PlusIcon />新建会话
        </Button>
      </div>
      <div className="text-text-3 px-4 pb-2 text-[11px] font-medium tracking-wider">工作空间</div>
      <MachineFilterSlot selected={filter} onSelect={onFilterChange} />
      <PlanUsageSlot filter={filter} />
      <ListControlsSlot filter={filter} />
      <div className="text-text-3 px-4 pt-2 pb-2 text-[11px] font-medium tracking-wider">会话</div>
      <ScrollArea className="min-h-0 flex-1">
        <SessionListSlot />
      </ScrollArea>
      <div className="border-border border-t px-3 py-3">
        <SidebarFooterActions />
      </div>
      <div
        aria-hidden
        data-testid="sidebar-resize-handle"
        title="拖动调整宽度，双击恢复默认；往左拖到底收起"
        className="group/resize absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none"
        {...resize.handleProps}
      >
        <span
          className={cn(
            'absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors group-hover/resize:bg-brand/50',
            resize.dragWidth !== null && 'bg-brand/60',
          )}
        />
      </div>
    </aside>
  );
}

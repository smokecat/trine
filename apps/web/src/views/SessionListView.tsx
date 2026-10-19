/**
 * 会话列表（原型「列表」屏 `#scr-list`）。
 *
 * 本视图只做「壳」：页头（刷新 + 机器/设置入口）、机器过滤 chip 行、
 * 控制行（搜索 / 状态 / 分组 / 已归档入口）、列表体、右下 FAB。卡片与 chip 的实现在 `components/list/**`，PC 侧栏复用同一套
 * （紧凑变体），过滤值由 Layout 持有，两边同步——所以本视图不再自己存
 * filter state（方案 §5「PC 布局：同一套组件」）。
 *
 * 新建会话 sheet 的开关挂在 URL（`/?new=1`）上，因为侧栏底部的「新建」按钮
 * 在 PC 上跳的就是这个地址：一个开关两个入口，不需要跨组件传 state。
 */
import { useEffect, useMemo } from 'react';
import { NavLink } from 'react-router';
import { MonitorIcon, PlusIcon, RefreshCwIcon, SettingsIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { AppHead } from '@/components/shell/AppHead.tsx';
import { MachineFilterChips } from '@/components/list/MachineFilterChips.tsx';
import { SessionList } from '@/components/list/SessionList.tsx';
import { ListControls } from '@/components/list/ListControls.tsx';
import { countArchived } from '@/components/list/filtering.ts';
import { selectMachineFilterItems } from '@/components/list/sorting.ts';
import { useListGroupBy, useListQuery, useListShowTemp } from '@/components/list/use-list-query.ts';
import { useSessionActions } from '@/components/list/use-session-actions.ts';
import { useNow, useSessionRefresh } from '@/components/list/use-session-refresh.ts';
import { NewSessionSheet } from '@/components/sheets/NewSessionSheet.tsx';
import { useNewSessionSheet } from '@/components/sheets/new-session-route.tsx';
import { useTrine } from '@/app/runtime.ts';
import { useListFilters, useMachineFilter } from '@/app/Layout.tsx';
import { cn } from '@/lib/utils.ts';

export function SessionListView(): React.JSX.Element {
  const paired = useTrine((s) => s.paired);
  const machines = useTrine((s) => s.machines);
  const sessions = useTrine((s) => s.sessions);
  const [filter, setFilter] = useMachineFilter();
  const { search, setSearch, status, setStatus } = useListFilters();
  const [groupBy, setGroupBy] = useListGroupBy();
  const [showTemp, setShowTemp] = useListShowTemp();
  const query = useListQuery({ archived: false });
  const actions = useSessionActions();
  const [sheetOpen, setSheetOpen] = useNewSessionSheet();
  const { refresh, refreshing, error, canRefresh } = useSessionRefresh();
  const now = useNow();

  const filterItems = useMemo(
    () => selectMachineFilterItems(machines, sessions),
    [machines, sessions],
  );

  // 过滤指向的机器被移除后回到「全部」，免得列表永远空着
  useEffect(() => {
    if (filter !== null && machines[filter] === undefined) setFilter(null);
  }, [filter, machines, setFilter]);

  if (!paired) {
    return (
      <main className="mx-auto flex min-h-0 max-w-sm flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <span className="text-brand font-mono text-4xl" aria-hidden>
          ◈
        </span>
        <h1 className="text-xl font-semibold">trine</h1>
        <p className="text-text-2 text-sm">还没有配对任何机器。</p>
        <Button asChild>
          <NavLink to="/pair">配对机器</NavLink>
        </Button>
      </main>
    );
  }

  return (
    // relative：右下角 FAB 的定位参照（原型 .fab 相对 .phone 定位）
    <div className="relative flex min-h-0 flex-1 flex-col">
      <AppHead
        title="会话"
        right={
          <div className="flex items-center gap-0.5">
            <Button
              size="icon-sm"
              variant="ghost"
              data-testid="list-refresh"
              title={canRefresh ? '刷新会话列表' : '没有在线的机器'}
              aria-label="刷新"
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
        }
      />

      <MachineFilterChips
        items={filterItems}
        selected={filter}
        onSelect={setFilter}
        className="px-3.5 pt-2.5 pb-1"
      />

      <ListControls
        search={search}
        onSearch={setSearch}
        status={status}
        onStatus={setStatus}
        groupBy={groupBy}
        onGroupBy={setGroupBy}
        showTemp={showTemp}
        onShowTemp={setShowTemp}
        archivedCount={countArchived(sessions, filter)}
        className="px-3.5 pt-1.5 pb-1"
      />

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2.5 pb-24">
        {error !== null && (
          <div
            data-testid="list-error"
            className="border-red bg-red-soft text-red rounded-lg border px-3 py-2 text-xs"
          >
            拉取会话列表失败：{error}
          </div>
        )}
        <SessionList
          sessions={sessions}
          machines={machines}
          query={query}
          now={now}
          actions={actions}
          onShowTemp={() => setShowTemp(true)}
        />
      </div>

      <Button
        size="icon-lg"
        data-testid="new-session-fab"
        aria-label="新建会话"
        className="absolute right-4 bottom-5 z-20 size-13 rounded-2xl shadow-[var(--shadow-card)]"
        onClick={() => setSheetOpen(true)}
      >
        <PlusIcon className="size-6" />
      </Button>

      <NewSessionSheet open={sheetOpen} onOpenChange={setSheetOpen} />
    </div>
  );
}

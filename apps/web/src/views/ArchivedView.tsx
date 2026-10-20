/**
 * 归档视图（session-list-v2 §4.2 / §4.5，评审 M4）：`/archived`。
 *
 * 两套布局同一条路由：手机上是从列表页「已归档 (n)」进来的整页（返回回列表），
 * PC 上渲染在主区 Outlet（侧栏继续显示未归档列表；PC 没有列表页，这是
 * 取消归档 / 永久删除的唯一入口）。PC 上机器 chips / 搜索 / 筛选只在侧栏
 * 画一份（值共享），主区不重复。
 *
 * 机器过滤、搜索词、状态 chip 与列表页共用 Layout 的同一份值；只是归档维度
 * 翻过来。行菜单的「取消归档 / 永久删除」来自 `useSessionActions()`
 * （回调缺省即隐藏：从标签页或 agent < 0.2.0 时不给）。
 */
import { useMemo } from 'react';
import { AppHead } from '@/components/shell/AppHead.tsx';
import { useIsDesktop } from '@/components/shell/use-media-query.ts';
import { MachineFilterChips } from '@/components/list/MachineFilterChips.tsx';
import { ListControls } from '@/components/list/ListControls.tsx';
import { SessionList } from '@/components/list/SessionList.tsx';
import { countArchived } from '@/components/list/filtering.ts';
import { selectMachineFilterItems } from '@/components/list/sorting.ts';
import { useListGroupBy, useListQuery, useListShowTemp } from '@/components/list/use-list-query.ts';
import { useNow } from '@/components/list/use-session-refresh.ts';
import { useSessionActions } from '@/components/list/use-session-actions.ts';
import { useListFilters, useMachineFilter } from '@/app/Layout.tsx';
import { useTrine } from '@/app/runtime.ts';

export function ArchivedView(): React.JSX.Element {
  const machines = useTrine((s) => s.machines);
  const sessions = useTrine((s) => s.sessions);
  const [filter, setFilter] = useMachineFilter();
  const { search, setSearch, status, setStatus } = useListFilters();
  const [groupBy, setGroupBy] = useListGroupBy();
  const [showTemp, setShowTemp] = useListShowTemp();
  const query = useListQuery({ archived: true });
  const actions = useSessionActions();
  const now = useNow();
  const filterItems = useMemo(() => selectMachineFilterItems(machines, sessions), [machines, sessions]);
  const count = countArchived(sessions, filter);
  // PC 上侧栏常驻且已有机器 chips / 搜索框 / 筛选弹层（同一份值），主区再画一套只是重复
  const isDesktop = useIsDesktop();

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="archived-view">
      <AppHead back="/" backLabel="返回会话列表" title="已归档" meta={`${count} 个会话`} />

      {!isDesktop && (
        <>
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
            className="px-3.5 pt-1.5 pb-1"
          />
        </>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2.5 pb-10">
        <p className="text-text-3 px-1 text-xs">
          归档只是从列表里收起，随时可以取消归档；会话一旦再次运行会自动取消归档。
        </p>
        <SessionList
          sessions={sessions}
          machines={machines}
          query={query}
          now={now}
          actions={actions}
          onShowTemp={setShowTemp}
        />
      </div>
    </div>
  );
}

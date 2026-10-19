/**
 * 把分散在三处的列表查询条件拼成一个 `ListQuery`：
 * - 机器过滤、搜索词、状态 chip → Layout context（返回列表不丢，评审 S4）；
 * - 分组开关 → prefs `listGroupBy`（跨会话记住，评审 M7）；
 * - 是否显示临时会话 → prefs `listShowTemp`（同上）；
 * - 归档视图 → 由调用方（路由）决定。
 */
import { useCallback, useMemo } from 'react';
import { useClient, useTrine } from '@/app/runtime.ts';
import { useListFilters, useMachineFilter } from '@/app/Layout.tsx';
import type { ListGroupBy, ListQuery } from './filtering.ts';

export function useListGroupBy(): readonly [ListGroupBy, (groupBy: ListGroupBy) => void] {
  const groupBy = useTrine((s) => s.prefs.listGroupBy);
  const client = useClient();
  const set = useCallback((next: ListGroupBy) => client?.updatePrefs({ listGroupBy: next }), [client]);
  return [groupBy, set] as const;
}

export function useListShowTemp(): readonly [boolean, (showTemp: boolean) => void] {
  const showTemp = useTrine((s) => s.prefs.listShowTemp);
  const client = useClient();
  const set = useCallback((next: boolean) => client?.updatePrefs({ listShowTemp: next }), [client]);
  return [showTemp, set] as const;
}

export function useListQuery({ archived }: { archived: boolean }): ListQuery {
  const [machine] = useMachineFilter();
  const { search, status } = useListFilters();
  const [groupBy] = useListGroupBy();
  const [showTemp] = useListShowTemp();
  return useMemo(
    () => ({ machine, archived, showTemp, status, search, groupBy }),
    [machine, archived, showTemp, status, search, groupBy],
  );
}

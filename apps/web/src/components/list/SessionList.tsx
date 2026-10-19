/**
 * 会话列表体（列表页 / PC 侧栏 / 归档视图 / 机器详情共用）。
 *
 * 只负责「过滤管线 → 渲染 SessionRow（平铺或按工作空间分组）+ 空态」；
 * 查询条件、页头、FAB 由调用方给。过滤与分组的全部规则在 `filtering.ts`。
 *
 * 空态按「在管线哪一步被筛空」区分（评审 S4）：没有会话 / 该机器没有会话 /
 * 全部已归档 / 归档视图为空 / 被状态筛空 / 被搜索筛空——用户下一步该做的
 * 事不同，别让人以为列表坏了。「没配对机器」由调用方处理。
 *
 * 临时会话（filtering.ts isTempSession）默认隐藏，列表底部注明藏了几个，给了
 * `onShowTemp` 就带一个「显示」按钮。
 *
 * ## 右键菜单与多选
 *
 * 每行包一层 SessionRowContextMenu（菜单项同「⋯」）。`actions.onArchiveMany`
 * 给了就开放多选（规则见 selection.ts）：选中后顶部出现吸顶操作条
 * 「已选 N 个 · 归档 / 取消」，Esc 清空。只有能归档（或在归档视图里能取消归档）
 * 的行可选。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router';
import { ChevronRightIcon } from 'lucide-react';
import type { SessionMeta } from '@trine/core';
import type { MachineState } from '@/store/types.ts';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { SessionRow } from './SessionRow.tsx';
import {
  emptyText,
  filterSessions,
  groupLabel,
  isFiltering,
  isGroupExpanded,
  type ListQuery,
  type SessionGroup,
} from './filtering.ts';
import { useCollapsedGroups } from './collapsed-groups.ts';
import {
  hasRowMenu,
  rowMenuItems,
  SessionRowContextMenu,
  SessionRowMenu,
  useRowActionDialogs,
  type RowSelection,
  type SessionRowActions,
} from './SessionRowMenu.tsx';
import {
  applyClick,
  EMPTY_SELECTION,
  isSelectionClick,
  selectionKey,
  toggleKey,
  type SelectionState,
} from './selection.ts';
import { shortCwd, type SessionRowData } from './sorting.ts';

export function SessionList({
  sessions,
  machines,
  query,
  variant = 'full',
  now,
  className,
  actions,
  onShowTemp,
}: {
  sessions: Record<string, Record<string, SessionMeta>>;
  machines: Record<string, MachineState>;
  query: ListQuery;
  variant?: 'full' | 'compact';
  now?: number;
  className?: string;
  /** 行「⋯」菜单的动作；缺省的回调对应的菜单项隐藏（见 SessionRowMenu） */
  actions?: SessionRowActions;
  /** 「已隐藏 N 个临时会话」旁的「显示」按钮；不给就只有文字 */
  onShowTemp?: () => void;
}): React.JSX.Element {
  const location = useLocation();
  const compact = variant === 'compact';
  const [collapsed, setCollapsed] = useCollapsedGroups();
  const machineNames = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [id, m] of Object.entries(machines)) out[id] = m.name;
    return out;
  }, [machines]);
  const result = useMemo(
    () => filterSessions(sessions, query, machineNames),
    [sessions, query, machineNames],
  );
  const { requestRename, requestDelete, dialogs } = useRowActionDialogs(actions);

  // ---- 多选 ----
  const onArchiveMany = actions?.onArchiveMany;
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [bulkBusy, setBulkBusy] = useState(false);
  const canSelect = useCallback(
    ({ machineId, meta }: SessionRowData): boolean => {
      if (onArchiveMany === undefined) return false;
      const items = rowMenuItems(actions, meta, machineId);
      return query.archived ? items.unarchive : items.archive;
    },
    [actions, onArchiveMany, query.archived],
  );
  // 当前可见（展开的组里）、可选的行，自上而下——Shift 范围选与「已选 N 个」都按它算
  const selectableRows = useMemo(() => {
    const visible =
      result.groups === null
        ? result.rows
        : result.groups.flatMap((g) => (isGroupExpanded(g, collapsed, query) ? g.rows : []));
    return visible.filter(canSelect);
  }, [result, collapsed, query, canSelect]);
  const order = useMemo(
    () => selectableRows.map((r) => selectionKey(r.machineId, r.meta.sessionId)),
    [selectableRows],
  );
  // 选中但已不可见（被归档走 / 被筛掉）的不算数
  const selectedRows = useMemo(
    () => selectableRows.filter((r) => selection.keys.has(selectionKey(r.machineId, r.meta.sessionId))),
    [selectableRows, selection],
  );
  const selectedCount = selectedRows.length;
  const clearSelection = useCallback(() => setSelection(EMPTY_SELECTION), []);
  const applyToSelected = useCallback(() => {
    if (onArchiveMany === undefined || selectedRows.length === 0) return;
    const result = onArchiveMany(
      selectedRows.map((r) => ({ machineId: r.machineId, sessionId: r.meta.sessionId })),
      !query.archived,
    );
    if (!(result instanceof Promise)) {
      clearSelection();
      return;
    }
    setBulkBusy(true);
    // 成功清空选择；失败保留（错误提示由回调自己 toast），方便看清哪些没动
    result.then(clearSelection, () => {}).finally(() => setBulkBusy(false));
  }, [onArchiveMany, selectedRows, query.archived, clearSelection]);

  useEffect(() => {
    if (selectedCount === 0) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clearSelection();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedCount, clearSelection]);

  const tempNote =
    result.tempHidden > 0 ? (
      <p
        data-testid="temp-hidden-note"
        className={cn('text-text-3 flex items-center justify-center gap-1.5 px-2 text-center', compact ? 'text-[11.5px]' : 'text-xs')}
      >
        已隐藏 {result.tempHidden} 个临时会话
        {onShowTemp !== undefined && (
          <button
            type="button"
            data-testid="temp-show"
            className="text-brand-ink hover:underline"
            onClick={onShowTemp}
          >
            显示
          </button>
        )}
      </p>
    ) : null;

  if (result.empty !== null) {
    return (
      <>
        <p
          data-testid="session-list-empty"
          data-reason={result.empty}
          className={cn('text-text-3 px-4 text-center', compact ? 'py-6 text-xs' : 'py-10 text-sm')}
        >
          {emptyText(result.empty, {
            compact,
            archivedCount: result.archivedCount,
            tempHidden: result.tempHidden,
            search: query.search,
          })}
        </p>
        {tempNote}
        {dialogs}
      </>
    );
  }

  const showMachine = query.machine === null;
  // 从归档视图点进会话：带上来源，手机上「返回」回到 /archived 而不是列表（评审 minor 9）
  const linkState = location.pathname === '/archived' ? { from: '/archived' } : undefined;
  const renderRow = (row: SessionRowData): React.JSX.Element => {
    const { machineId, meta } = row;
    const key = selectionKey(machineId, meta.sessionId);
    const selectable = canSelect(row);
    const selected = selectable && selection.keys.has(key);
    const rowSelection: RowSelection | undefined = selectable
      ? {
          selected,
          count: selectedCount,
          toggle: () => setSelection((s) => toggleKey(s, key)),
          applyToSelected,
          clear: clearSelection,
        }
      : undefined;
    const menuProps = {
      target: { machineId, meta },
      actions: actions ?? {},
      onRequestRename: requestRename,
      onRequestDelete: requestDelete,
      selection: rowSelection,
    };
    const onLinkClick = (e: React.MouseEvent<HTMLAnchorElement>): void => {
      const mods = { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey };
      if (!isSelectionClick(mods, selectedCount)) return;
      // 不可选的行（旧 agent 等）不参与多选：照常走浏览器默认（导航 / 新标签页）
      if (!selectable) {
        if (selectedCount > 0) clearSelection();
        return;
      }
      e.preventDefault();
      setSelection((s) => applyClick(s, key, mods, order));
    };
    const card = (
      <SessionRow
        key={`${machineId}/${meta.sessionId}`}
        machineId={machineId}
        machineName={machineNames[machineId] ?? machineId}
        meta={meta}
        variant={variant}
        showMachine={showMachine}
        active={location.pathname === `/s/${machineId}/${meta.sessionId}`}
        {...(linkState === undefined ? {} : { linkState })}
        {...(now === undefined ? {} : { now })}
        selected={selected}
        onLinkClick={onLinkClick}
        {...(actions !== undefined && hasRowMenu(actions, meta, machineId)
          ? { menu: <SessionRowMenu {...menuProps} /> }
          : {})}
      />
    );
    if (actions === undefined || !hasRowMenu(actions, meta, machineId)) return card;
    return (
      <SessionRowContextMenu key={`${machineId}/${meta.sessionId}`} {...menuProps}>
        {card}
      </SessionRowContextMenu>
    );
  };

  /*
   * `w-0 min-w-full`：侧栏用的是 Radix ScrollArea，它 viewport 内层是
   * `display:table; min-width:100%`——table 按**内容**定宽，卡片里
   * `truncate`（white-space:nowrap）的长标题会把它撑到 700+px，溢出 300px
   * 侧栏。`w-0` 把首选宽度压成 0 让 table 不再按内容算，`min-w-full` 再把
   * 它顶回容器宽度。列表页没有 table 这一层，这组值等价于 `w-full`。
   */
  return (
    <>
      <div
        data-testid="session-list"
        className={cn('flex w-0 min-w-full flex-col', result.groups ? 'gap-3' : 'gap-2', className)}
      >
        {selectedCount > 0 && (
          <div
            data-testid="bulk-bar"
            role="toolbar"
            aria-label="批量操作"
            className="border-brand-border bg-surface sticky top-0 z-20 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs shadow-sm"
          >
            <span className="text-text-2 tabular min-w-0 flex-1 truncate" data-testid="bulk-count">
              已选 {selectedCount} 个
            </span>
            <Button size="xs" data-testid="bulk-apply" disabled={bulkBusy} onClick={applyToSelected}>
              {bulkBusy ? '处理中…' : query.archived ? '取消归档' : '归档'}
            </Button>
            <Button size="xs" variant="ghost" data-testid="bulk-clear" disabled={bulkBusy} onClick={clearSelection}>
              取消
            </Button>
          </div>
        )}
        {result.groups === null
          ? result.rows.map(renderRow)
          : result.groups.map((group) => (
              <GroupSection
                key={group.key}
                group={group}
                expanded={isGroupExpanded(group, collapsed, query)}
                filtering={isFiltering(query)}
                machineName={showMachine ? (machineNames[group.machineId] ?? group.machineId) : null}
                compact={compact}
                onToggle={(next) => setCollapsed(group.key, !next)}
              >
                {group.rows.map(renderRow)}
              </GroupSection>
            ))}
        {tempNote}
      </div>
      {dialogs}
    </>
  );
}

function GroupSection({
  group,
  expanded,
  filtering,
  machineName,
  compact,
  onToggle,
  children,
}: {
  group: SessionGroup;
  expanded: boolean;
  /** 搜索 / 筛选中：强制展开，组头点了也不收（同待批准的处理） */
  filtering: boolean;
  /** 「全部机器」视图下组头带上机器名（同一路径可能在两台机器上各有一组） */
  machineName: string | null;
  compact: boolean;
  onToggle: (expanded: boolean) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  // 有待批准 / 搜索筛选中强制展开：点了也收不起来，别假装能收（评审 M5 / minor 3）
  const forced = group.waitingCount > 0 || filtering;
  const label = group.cwd === '' ? groupLabel('') : shortCwd(group.cwd, compact ? 2 : 3);
  return (
    <section data-testid="session-group" data-group-key={group.key} data-expanded={expanded} className="flex flex-col gap-2">
      <button
        type="button"
        data-testid="session-group-header"
        aria-expanded={expanded}
        aria-disabled={forced || undefined}
        title={
          forced
            ? `${groupLabel(group.cwd)}（${filtering ? '搜索 / 筛选中' : '有待批准的会话'}，保持展开）`
            : groupLabel(group.cwd)
        }
        onClick={() => {
          if (!forced) onToggle(!expanded);
        }}
        className={cn(
          'text-text-2 hover:text-text flex min-w-0 items-center gap-1.5 px-1 text-left text-xs',
          forced && 'cursor-default',
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn('size-3.5 shrink-0 transition-transform', expanded && 'rotate-90', forced && 'opacity-40')}
        />
        <span className={cn('min-w-0 truncate font-mono', group.cwd === '' && 'font-sans italic')}>{label}</span>
        {machineName !== null && <span className="text-text-3 shrink-0 truncate">· {machineName}</span>}
        <span className="text-text-3 tabular shrink-0">{group.rows.length}</span>
        {!expanded && (group.waitingCount > 0 || group.runningCount > 0) && (
          <span className="ml-auto flex shrink-0 gap-1.5" data-testid="session-group-badges">
            {group.waitingCount > 0 && (
              <span className="text-amber tabular" title={`${group.waitingCount} 个待批准`}>
                ✋{group.waitingCount}
              </span>
            )}
            {group.runningCount > 0 && (
              <span className="text-brand-ink tabular" title={`${group.runningCount} 个运行中`}>
                🔧{group.runningCount}
              </span>
            )}
          </span>
        )}
      </button>
      {expanded && children}
    </section>
  );
}

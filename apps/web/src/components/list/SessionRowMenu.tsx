/**
 * 会话行「⋯」菜单、右键菜单与它们唤起的对话框（session-list-v2 §4.4，评审 M3 / M6）。
 *
 * 「⋯」（DropdownMenu）与右键（ContextMenu，`SessionRowContextMenu`）是同一组
 * 菜单项（`RowMenuItems`），只是换了外壳。
 *
 * ## 回调壳
 *
 * 菜单项的动作全部由调用方以 `SessionRowActions` 注入；**缺哪个回调就隐藏
 * 哪个菜单项**，一个都没有时连「⋯」都不渲染。协议接线（`client.request`、
 * 失败 toast、agent 版本能力探测）在调用方做——本组件只管交互：
 *
 * - 复制工作目录 → `onCopyCwd(cwd)`（不经 agent，旧 agent 的行上也有；cwd 未知时隐藏）
 * - 重命名 → 列表级共享的 RenameDialog → `onRename(machineId, sessionId, title)`
 * - 归档 → 直接 `onArchive(…, true)`（可撤回，不确认）。运行中 / 待批准时
 *   菜单项**灰显但仍可点**：web 的 state 可能是过期的，以 agent 应答为准（M3）
 * - 归档视图里：取消归档 `onArchive(…, false)`；永久删除 → 两击确认 →
 *   `onDelete(machineId, sessionId)`
 * - 多选（SessionList 给 `selection` 时）：单行菜单里多一项「选择」；右键一个
 *   已选中的行且选了不止一个时，菜单换成对整批的「归档已选 N 个」/「取消选择」
 *
 * 回调可以返回 Promise：对话框在 pending 期间显示「处理中…」，resolve 后关闭，
 * reject 时保持打开（错误提示由回调自己 toast）。这里吞掉 reject，不会
 * 冒成未处理异常。
 *
 * ## 为什么对话框在列表级
 *
 * 行组件只放菜单触发器与菜单项（且作为 NavLink 的**兄弟**，见 SessionRow
 * 文件头）；对话框由 `useRowActionDialogs` 在 SessionList 挂一份，行只报
 * 「要对谁开」。几百行不必各挂一个 Dialog，也不会有对话框落进 NavLink 的
 * 组件子树里冒泡触发导航。
 */
import { useCallback, useState } from 'react';
import { MoreHorizontalIcon } from 'lucide-react';
import type { SessionMeta } from '@trine/core';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu.tsx';
import { ConfirmDialog } from '@/components/machines/ConfirmDialog.tsx';
import { cn } from '@/lib/utils.ts';
import { RenameDialog } from './RenameDialog.tsx';
import { sessionTitle } from './sorting.ts';

type MaybePromise = void | Promise<unknown>;

export interface SessionRowActions {
  /**
   * 逐机器的能力探测（「全部机器」视图里新旧 agent 混排）：给了且对某台返回
   * false，那台的行不出任何菜单项。不给 = 所有机器同等对待。
   */
  supports?: (machineId: string) => boolean;
  onRename?: (machineId: string, sessionId: string, title: string) => MaybePromise;
  onArchive?: (machineId: string, sessionId: string, archived: boolean) => MaybePromise;
  /** 多选批量归档 / 取消归档；不给则列表不开放多选 */
  onArchiveMany?: (targets: readonly { machineId: string; sessionId: string }[], archived: boolean) => MaybePromise;
  onDelete?: (machineId: string, sessionId: string) => MaybePromise;
  /** 复制工作目录。不经 agent，不受 `supports` 约束 */
  onCopyCwd?: (cwd: string) => MaybePromise;
}

export interface RowTarget {
  machineId: string;
  meta: SessionMeta;
}

/** 这行会出现哪些菜单项 */
export function rowMenuItems(
  actions: SessionRowActions | undefined,
  meta: SessionMeta,
  machineId?: string,
): { copyCwd: boolean; rename: boolean; archive: boolean; unarchive: boolean; delete: boolean } {
  const copyCwd = actions?.onCopyCwd !== undefined && meta.cwd !== '';
  if (machineId !== undefined && actions?.supports !== undefined && !actions.supports(machineId)) {
    return { copyCwd, rename: false, archive: false, unarchive: false, delete: false };
  }
  const archived = meta.archived === true;
  return {
    copyCwd,
    rename: actions?.onRename !== undefined,
    archive: !archived && actions?.onArchive !== undefined,
    unarchive: archived && actions?.onArchive !== undefined,
    // 永久删除只在归档视图里给（agent 侧同样要求 archived===true，方案 §3.4）
    delete: archived && actions?.onDelete !== undefined,
  };
}

export function hasRowMenu(actions: SessionRowActions | undefined, meta: SessionMeta, machineId?: string): boolean {
  const items = rowMenuItems(actions, meta, machineId);
  return items.copyCwd || items.rename || items.archive || items.unarchive || items.delete;
}

/** 运行中 / 待批准：归档大概率会被 agent 以 busy 拒绝 */
export function archiveLikelyBusy(meta: SessionMeta): boolean {
  return meta.state === 'running' || meta.state === 'waiting_permission';
}

function swallow(result: MaybePromise): void {
  if (result instanceof Promise) result.catch(() => {});
}

/** 行在多选里的状态与操作（SessionList 给；不给 = 这个列表不开放多选） */
export interface RowSelection {
  selected: boolean;
  /** 当前一共选了几个 */
  count: number;
  /** 把这一行加入 / 移出选择 */
  toggle: () => void;
  /** 对整批执行归档（归档视图里是取消归档） */
  applyToSelected: () => void;
  clear: () => void;
}

/** 两种菜单外壳共用的菜单项接口 */
interface MenuKit {
  Item: (props: {
    testId: string;
    onSelect: () => void;
    destructive?: boolean;
    className?: string | undefined;
    title?: string | undefined;
    likelyBusy?: boolean;
    children: React.ReactNode;
  }) => React.JSX.Element;
  Separator: () => React.JSX.Element;
}

const DROPDOWN_KIT: MenuKit = {
  Item: ({ testId, onSelect, destructive, className, title, likelyBusy, children }) => (
    <DropdownMenuItem
      data-testid={testId}
      data-likely-busy={likelyBusy || undefined}
      variant={destructive === true ? 'destructive' : 'default'}
      className={className}
      title={title}
      onSelect={onSelect}
    >
      {children}
    </DropdownMenuItem>
  ),
  Separator: () => <DropdownMenuSeparator />,
};

const CONTEXT_KIT: MenuKit = {
  Item: ({ testId, onSelect, destructive, className, title, likelyBusy, children }) => (
    <ContextMenuItem
      data-testid={testId}
      data-likely-busy={likelyBusy || undefined}
      variant={destructive === true ? 'destructive' : 'default'}
      className={className}
      title={title}
      onSelect={onSelect}
    >
      {children}
    </ContextMenuItem>
  ),
  Separator: () => <ContextMenuSeparator />,
};

interface RowMenuProps {
  target: RowTarget;
  actions: SessionRowActions;
  onRequestRename: (target: RowTarget) => void;
  onRequestDelete: (target: RowTarget) => void;
  selection?: RowSelection | undefined;
}

function RowMenuItems({
  kit,
  target,
  actions,
  onRequestRename,
  onRequestDelete,
  selection,
}: RowMenuProps & { kit: MenuKit }): React.JSX.Element {
  const { Item, Separator } = kit;
  const { machineId, meta } = target;

  // 右键一个已选中的行、且选了不止一个：菜单作用于整批
  if (selection !== undefined && selection.selected && selection.count > 1) {
    return (
      <>
        <Item testId="menu-bulk-apply" onSelect={selection.applyToSelected}>
          {meta.archived === true ? '取消归档' : '归档'}已选 {selection.count} 个
        </Item>
        <Item testId="menu-bulk-clear" onSelect={selection.clear}>
          取消选择
        </Item>
      </>
    );
  }

  const items = rowMenuItems(actions, meta, machineId);
  const busy = archiveLikelyBusy(meta);
  const mutations = items.rename || items.archive || items.unarchive;
  return (
    <>
      {items.copyCwd && (
        <Item testId="menu-copy-cwd" title={meta.cwd} onSelect={() => swallow(actions.onCopyCwd?.(meta.cwd))}>
          复制工作目录
        </Item>
      )}
      {items.copyCwd && mutations && <Separator />}
      {items.rename && (
        <Item testId="menu-rename" onSelect={() => onRequestRename(target)}>
          重命名
        </Item>
      )}
      {items.archive && (
        <Item
          testId="menu-archive"
          likelyBusy={busy}
          className={cn(busy && 'text-text-3')}
          title={busy ? '会话正在运行，agent 可能会拒绝；以 agent 应答为准' : undefined}
          onSelect={() => swallow(actions.onArchive?.(machineId, meta.sessionId, true))}
        >
          归档{busy && <span className="text-[11px]">（运行中）</span>}
        </Item>
      )}
      {items.unarchive && (
        <Item testId="menu-unarchive" onSelect={() => swallow(actions.onArchive?.(machineId, meta.sessionId, false))}>
          取消归档
        </Item>
      )}
      {selection !== undefined && (items.archive || items.unarchive) && (
        <Item testId="menu-select" onSelect={selection.toggle}>
          {selection.selected ? '取消选择' : '选择'}
        </Item>
      )}
      {items.delete && (
        <>
          <Separator />
          <Item testId="menu-delete" destructive onSelect={() => onRequestDelete(target)}>
            永久删除…
          </Item>
        </>
      )}
    </>
  );
}

export function SessionRowMenu(props: RowMenuProps): React.JSX.Element {
  return (
    // modal={false}：菜单项打开 Dialog 时，modal 菜单的 pointer-events 锁与
    // Dialog 的焦点陷阱会互相踩（关掉对话框后页面点不动）
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          data-testid="session-row-menu"
          aria-label={`「${sessionTitle(props.target.meta)}」的操作`}
          className="text-text-3 hover:text-text"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-36" data-testid="session-row-menu-content">
        <RowMenuItems kit={DROPDOWN_KIT} {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 右键菜单：包在整张卡片外面（Trigger asChild → 卡片容器 div）。菜单内容在
 * portal 里，事件沿组件树冒泡到的是容器 div 而不是 NavLink，同「⋯」菜单的
 * 兄弟结构（SessionRow 文件头）。触屏上 Radix 用长按触发。
 */
export function SessionRowContextMenu({
  children,
  ...props
}: RowMenuProps & { children: React.ReactElement }): React.JSX.Element {
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-auto min-w-36" data-testid="session-row-context-content">
        <RowMenuItems kit={CONTEXT_KIT} {...props} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** SessionList 级共享的重命名 / 删除确认对话框 */
export function useRowActionDialogs(actions: SessionRowActions | undefined): {
  requestRename: (target: RowTarget) => void;
  requestDelete: (target: RowTarget) => void;
  dialogs: React.ReactNode;
} {
  const [renameTarget, setRenameTarget] = useState<RowTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RowTarget | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback((result: MaybePromise, close: () => void) => {
    if (!(result instanceof Promise)) {
      close();
      return;
    }
    setBusy(true);
    result.then(
      () => {
        setBusy(false);
        close();
      },
      () => setBusy(false),
    );
  }, []);

  const dialogs =
    actions === undefined ? null : (
      <>
        {actions.onRename !== undefined && (
          <RenameDialog
            open={renameTarget !== null}
            onOpenChange={(open) => {
              if (!open && !busy) setRenameTarget(null);
            }}
            initialTitle={renameTarget?.meta.title ?? ''}
            busy={busy}
            onSubmit={(title) => {
              if (renameTarget === null) return;
              const { machineId, meta } = renameTarget;
              run(actions.onRename?.(machineId, meta.sessionId, title), () => setRenameTarget(null));
            }}
          />
        )}
        {actions.onDelete !== undefined && (
          <ConfirmDialog
            open={deleteTarget !== null}
            onOpenChange={(open) => {
              if (!open && !busy) setDeleteTarget(null);
            }}
            testId="confirm-delete-session"
            busy={busy}
            title={`永久删除「${deleteTarget === null ? '' : sessionTitle(deleteTarget.meta)}」？`}
            description={
              <>
                <p>
                  会删除 agent 那台机器上的会话记录（claude 的 jsonl 文件），<strong>不可恢复</strong>
                  ，本机终端里也无法再 resume 它。
                </p>
                <p>所有设备上的这条会话与本地时间线都会一并清除。</p>
              </>
            }
            confirmLabel="永久删除"
            onConfirm={() => {
              if (deleteTarget === null) return;
              const { machineId, meta } = deleteTarget;
              run(actions.onDelete?.(machineId, meta.sessionId), () => setDeleteTarget(null));
            }}
          />
        )}
      </>
    );

  return { requestRename: setRenameTarget, requestDelete: setDeleteTarget, dialogs };
}

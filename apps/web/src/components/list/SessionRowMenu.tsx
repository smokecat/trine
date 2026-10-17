/**
 * 会话行「⋯」菜单与它唤起的对话框（session-list-v2 §4.4，评审 M3 / M6）。
 *
 * ## 回调壳
 *
 * 菜单项的动作全部由调用方以 `SessionRowActions` 注入；**缺哪个回调就隐藏
 * 哪个菜单项**，一个都没有时连「⋯」都不渲染。协议接线（`client.request`、
 * 失败 toast、agent 版本能力探测）在调用方做——本组件只管交互：
 *
 * - 重命名 → 列表级共享的 RenameDialog → `onRename(machineId, sessionId, title)`
 * - 归档 → 直接 `onArchive(…, true)`（可撤回，不确认）。运行中 / 待批准时
 *   菜单项**灰显但仍可点**：web 的 state 可能是过期的，以 agent 应答为准（M3）
 * - 归档视图里：取消归档 `onArchive(…, false)`；永久删除 → 两击确认 →
 *   `onDelete(machineId, sessionId)`
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
  onDelete?: (machineId: string, sessionId: string) => MaybePromise;
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
): { rename: boolean; archive: boolean; unarchive: boolean; delete: boolean } {
  if (machineId !== undefined && actions?.supports !== undefined && !actions.supports(machineId)) {
    return { rename: false, archive: false, unarchive: false, delete: false };
  }
  const archived = meta.archived === true;
  return {
    rename: actions?.onRename !== undefined,
    archive: !archived && actions?.onArchive !== undefined,
    unarchive: archived && actions?.onArchive !== undefined,
    // 永久删除只在归档视图里给（agent 侧同样要求 archived===true，方案 §3.4）
    delete: archived && actions?.onDelete !== undefined,
  };
}

export function hasRowMenu(actions: SessionRowActions | undefined, meta: SessionMeta, machineId?: string): boolean {
  const items = rowMenuItems(actions, meta, machineId);
  return items.rename || items.archive || items.unarchive || items.delete;
}

/** 运行中 / 待批准：归档大概率会被 agent 以 busy 拒绝 */
export function archiveLikelyBusy(meta: SessionMeta): boolean {
  return meta.state === 'running' || meta.state === 'waiting_permission';
}

function swallow(result: MaybePromise): void {
  if (result instanceof Promise) result.catch(() => {});
}

export function SessionRowMenu({
  target,
  actions,
  onRequestRename,
  onRequestDelete,
}: {
  target: RowTarget;
  actions: SessionRowActions;
  onRequestRename: (target: RowTarget) => void;
  onRequestDelete: (target: RowTarget) => void;
}): React.JSX.Element {
  const { machineId, meta } = target;
  const items = rowMenuItems(actions, meta, machineId);
  const busy = archiveLikelyBusy(meta);
  return (
    // modal={false}：菜单项打开 Dialog 时，modal 菜单的 pointer-events 锁与
    // Dialog 的焦点陷阱会互相踩（关掉对话框后页面点不动）
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          data-testid="session-row-menu"
          aria-label={`「${sessionTitle(meta)}」的操作`}
          className="text-text-3 hover:text-text"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-36" data-testid="session-row-menu-content">
        {items.rename && (
          <DropdownMenuItem data-testid="menu-rename" onSelect={() => onRequestRename(target)}>
            重命名
          </DropdownMenuItem>
        )}
        {items.archive && (
          <DropdownMenuItem
            data-testid="menu-archive"
            data-likely-busy={busy || undefined}
            className={cn(busy && 'text-text-3')}
            title={busy ? '会话正在运行，agent 可能会拒绝；以 agent 应答为准' : undefined}
            onSelect={() => swallow(actions.onArchive?.(machineId, meta.sessionId, true))}
          >
            归档{busy && <span className="text-[11px]">（运行中）</span>}
          </DropdownMenuItem>
        )}
        {items.unarchive && (
          <DropdownMenuItem
            data-testid="menu-unarchive"
            onSelect={() => swallow(actions.onArchive?.(machineId, meta.sessionId, false))}
          >
            取消归档
          </DropdownMenuItem>
        )}
        {items.delete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="menu-delete"
              variant="destructive"
              onSelect={() => onRequestDelete(target)}
            >
              永久删除…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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

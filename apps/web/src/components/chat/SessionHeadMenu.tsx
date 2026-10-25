/**
 * 聊天页头部的「⋯」会话菜单（session-list-v2 §4.4 末句）：浏览文件、复制工作目录、重命名、
 * 归档 / 取消归档。
 *
 * 动作与列表行菜单同源（`useSessionActions(machineId)`），缺哪个回调隐藏哪项，
 * 一项都没有时整个按钮不渲染。永久删除刻意不放这里：它只在归档视图里给，
 * 两击确认、说明不可逆（§4.4）。
 *
 * 归档与列表一致：运行中 / 待批准时**灰显但仍可点**，以 agent 应答为准（评审 M3）。
 */
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
import { archiveLikelyBusy, type SessionRowActions } from '@/components/list/SessionRowMenu.tsx';
import { cn } from '@/lib/utils.ts';

export function SessionHeadMenu({
  machineId,
  sessionId,
  meta,
  actions,
  onRequestRename,
  onBrowseFiles,
}: {
  machineId: string;
  sessionId: string;
  /** 还没拉到 meta 时不知道归档状态：只给重命名 */
  meta: SessionMeta | undefined;
  actions: SessionRowActions;
  onRequestRename: () => void;
  /** 打开文件浏览器；agent 不支持文件查看时不给 */
  onBrowseFiles?: (() => void) | undefined;
}): React.JSX.Element | null {
  const canRename = actions.onRename !== undefined;
  const canArchive = actions.onArchive !== undefined && meta !== undefined;
  const cwd = meta?.cwd ?? '';
  const canCopyCwd = actions.onCopyCwd !== undefined && cwd !== '';
  const canLink = actions.onLink !== undefined && (actions.supportsLinks === undefined || actions.supportsLinks(machineId));
  const canBrowse = onBrowseFiles !== undefined;
  if (!canRename && !canArchive && !canCopyCwd && !canLink && !canBrowse) return null;
  const archived = meta?.archived === true;
  const busy = meta !== undefined && archiveLikelyBusy(meta);
  const swallow = (r: void | Promise<unknown>): void => {
    if (r instanceof Promise) r.catch(() => {});
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          data-testid="session-head-menu"
          aria-label="会话操作"
          className="text-text-3 hover:text-text"
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-36" data-testid="session-head-menu-content">
        {canBrowse && (
          <DropdownMenuItem data-testid="head-menu-browse-files" onSelect={onBrowseFiles}>
            浏览文件
          </DropdownMenuItem>
        )}
        {canBrowse && !canCopyCwd && (canRename || canArchive || canLink) && <DropdownMenuSeparator />}
        {canCopyCwd && (
          <DropdownMenuItem data-testid="head-menu-copy-cwd" title={cwd} onSelect={() => swallow(actions.onCopyCwd?.(cwd))}>
            复制工作目录
          </DropdownMenuItem>
        )}
        {canCopyCwd && (canRename || canArchive || canLink) && <DropdownMenuSeparator />}
        {canLink && (
          <DropdownMenuItem data-testid="head-menu-link" onSelect={() => actions.onLink?.(machineId, [sessionId])}>
            关联…
          </DropdownMenuItem>
        )}
        {canRename && (
          <DropdownMenuItem data-testid="head-menu-rename" onSelect={onRequestRename}>
            重命名
          </DropdownMenuItem>
        )}
        {canArchive && !archived && (
          <DropdownMenuItem
            data-testid="head-menu-archive"
            data-likely-busy={busy || undefined}
            className={cn(busy && 'text-text-3')}
            title={busy ? '会话正在运行，agent 可能会拒绝；以 agent 应答为准' : undefined}
            onSelect={() => swallow(actions.onArchive?.(machineId, sessionId, true))}
          >
            归档{busy && <span className="text-[11px]">（运行中）</span>}
          </DropdownMenuItem>
        )}
        {canArchive && archived && (
          <DropdownMenuItem
            data-testid="head-menu-unarchive"
            onSelect={() => swallow(actions.onArchive?.(machineId, sessionId, false))}
          >
            取消归档
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

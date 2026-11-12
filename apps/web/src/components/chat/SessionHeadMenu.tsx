/**
 * 聊天页头部的「⋯」会话菜单（session-list-v2 §4.4 末句）：会话设置、浏览文件、复制工作目录、
 * 重命名、归档 / 取消归档。
 *
 * 「会话设置」与页头元信息行（`cwd · model · mode ▾`）打开的是同一个 sheet。手机上
 * 元信息行会被用量徽标挤得只剩几个字，这里给一个总点得到的入口。
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { archiveLikelyBusy, type SessionRowActions } from '@/components/list/SessionRowMenu.tsx';
import { CONTENT_WIDTH_LABEL, CONTENT_WIDTHS, type ContentWidth } from '@/lib/layout-prefs.ts';
import { cn } from '@/lib/utils.ts';

/** 本会话的内容宽度：value 为 null = 跟随全局（global） */
export interface SessionContentWidthControl {
  value: ContentWidth | null;
  global: ContentWidth;
  onChange: (width: ContentWidth | null) => void;
}

const FOLLOW_GLOBAL = 'global';

function ContentWidthSub({ control }: { control: SessionContentWidthControl }): React.JSX.Element {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="head-menu-content-width">
        内容宽度
        <span className="text-text-3 ml-auto pl-3 text-[11px]">{CONTENT_WIDTH_LABEL[control.value ?? control.global]}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={control.value ?? FOLLOW_GLOBAL}
          onValueChange={(v) => control.onChange(v === FOLLOW_GLOBAL ? null : (v as ContentWidth))}
        >
          <DropdownMenuRadioItem value={FOLLOW_GLOBAL} data-testid="content-width-global">
            跟随全局（{CONTENT_WIDTH_LABEL[control.global]}）
          </DropdownMenuRadioItem>
          {CONTENT_WIDTHS.map((w) => (
            <DropdownMenuRadioItem key={w} value={w} data-testid={`content-width-${w}`}>
              {CONTENT_WIDTH_LABEL[w]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function SessionHeadMenu({
  machineId,
  sessionId,
  meta,
  actions,
  onRequestRename,
  onBrowseFiles,
  onOpenSettings,
  contentWidth,
}: {
  machineId: string;
  sessionId: string;
  /** 还没拉到 meta 时不知道归档状态：只给重命名 */
  meta: SessionMeta | undefined;
  actions: SessionRowActions;
  onRequestRename: () => void;
  /** 打开文件浏览器；agent 不支持文件查看时不给 */
  onBrowseFiles?: (() => void) | undefined;
  /** 打开会话设置 sheet（模型 / 权限 / 工作目录）；会话不可交互时不给 */
  onOpenSettings?: (() => void) | undefined;
  /** 本会话内容宽度（PC 才给；手机上内容本来就铺满） */
  contentWidth?: SessionContentWidthControl | undefined;
}): React.JSX.Element | null {
  const canRename = actions.onRename !== undefined;
  const canArchive = actions.onArchive !== undefined && meta !== undefined;
  const cwd = meta?.cwd ?? '';
  const canCopyCwd = actions.onCopyCwd !== undefined && cwd !== '';
  const canLink = actions.onLink !== undefined && (actions.supportsLinks === undefined || actions.supportsLinks(machineId));
  const canBrowse = onBrowseFiles !== undefined;
  const canSettings = onOpenSettings !== undefined;
  if (!canSettings && !canRename && !canArchive && !canCopyCwd && !canLink && !canBrowse && contentWidth === undefined) {
    return null;
  }
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
        {canSettings && (
          <>
            <DropdownMenuItem data-testid="head-menu-settings" onSelect={onOpenSettings}>
              会话设置…
            </DropdownMenuItem>
            {(canBrowse || canCopyCwd || canLink || canRename || canArchive || contentWidth !== undefined) && (
              <DropdownMenuSeparator />
            )}
          </>
        )}
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
        {contentWidth !== undefined && (
          <>
            {(canBrowse || canCopyCwd || canLink || canRename || canArchive) && <DropdownMenuSeparator />}
            <ContentWidthSub control={contentWidth} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

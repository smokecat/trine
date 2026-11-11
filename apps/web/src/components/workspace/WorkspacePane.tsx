/**
 * 会话页右栏：分隔条 + 工作区（工具条 + 懒加载的 dockview）+ 收起时右侧边缘的「文件（N）」。
 *
 * - 收起 / 窄屏自动收起都用 <Activity mode="hidden"> 包住工作区：dockview 实例保留，隐藏期间
 *   React 清掉 effect → 重内容卸载（Blob URL 释放），恢复后重挂并回填滚动。
 * - 最大化只改外层布局（盖住聊天栏，聊天不卸载），不涉及 dockview。
 * - 分隔条参照侧栏拖边（sidebar-resize），但可聚焦、有 separator 语义与键盘调宽。
 */
import { Activity, useEffect, useRef, useState } from 'react';
import { EllipsisIcon, FilesIcon, Maximize2Icon, Minimize2Icon, PanelRightCloseIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { clampWorkspaceWidth, CHAT_MIN_WIDTH, WORKSPACE_SPLITTER_WIDTH } from '@/lib/layout-prefs.ts';
import { cn } from '@/lib/utils.ts';
import { LazyWorkspace } from './LazyWorkspace.tsx';
import type { WorkspaceController } from './use-workspace.ts';

const KEY_STEP = 24;
const KEY_STEP_LARGE = 96;

/** 拖动 / 键盘调宽：拖动中只改本地状态，松手才写 prefs */
function useSplitter({
  width,
  mainWidth,
  minWidth,
  onCommit,
  onReset,
}: {
  width: number;
  mainWidth: number;
  /** 工作区最小宽度（含分栏布局的聚合最小宽度） */
  minWidth: number;
  onCommit: (width: number) => void;
  onReset: () => void;
}): { dragWidth: number | null; props: React.HTMLAttributes<HTMLDivElement> & { 'aria-valuenow': number; 'aria-valuemin': number; 'aria-valuemax': number } } {
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const dragging = dragWidth !== null;
  const max = Math.max(minWidth, mainWidth - CHAT_MIN_WIDTH - WORKSPACE_SPLITTER_WIDTH);

  useEffect(() => {
    if (!dragging) return;
    const style = document.documentElement.style;
    const prev = { cursor: style.cursor, userSelect: style.userSelect };
    style.cursor = 'col-resize';
    style.userSelect = 'none';
    return () => {
      style.cursor = prev.cursor;
      style.userSelect = prev.userSelect;
    };
  }, [dragging]);

  const clamp = (w: number): number => clampWorkspaceWidth(w, mainWidth, minWidth);
  return {
    dragWidth,
    props: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': '调整文件工作区宽度',
      'aria-valuenow': width,
      'aria-valuemin': minWidth,
      'aria-valuemax': max,
      tabIndex: 0,
      title: '拖动调整宽度，双击恢复默认（键盘：←/→）',
      onPointerDown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startWidth: width, width };
        setDragWidth(width);
      },
      onPointerMove: (e) => {
        const d = drag.current;
        if (d === null) return;
        // 分隔条在工作区左边：往左拖 = 变宽
        d.width = clamp(d.startWidth - (e.clientX - d.startX));
        setDragWidth(d.width);
      },
      onPointerUp: (e) => {
        const d = drag.current;
        if (d === null) return;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        drag.current = null;
        setDragWidth(null);
        if (Math.abs(d.width - d.startWidth) >= 1) onCommit(d.width);
      },
      onPointerCancel: () => {
        drag.current = null;
        setDragWidth(null);
      },
      onDoubleClick: onReset,
      onKeyDown: (e) => {
        const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
        let next: number | null = null;
        if (e.key === 'ArrowLeft') next = width + step;
        else if (e.key === 'ArrowRight') next = width - step;
        else if (e.key === 'Home') next = max;
        else if (e.key === 'End') next = minWidth;
        else if (e.key === 'Enter') {
          e.preventDefault();
          onReset();
          return;
        }
        if (next === null) return;
        e.preventDefault();
        onCommit(clamp(next));
      },
    },
  };
}

export function WorkspacePane({
  ws,
  mainWidth,
  storedWidth,
  onWidthCommit,
  onWidthReset,
  onPeek,
}: {
  ws: WorkspaceController;
  mainWidth: number;
  storedWidth: number | null;
  onWidthCommit: (width: number) => void;
  onWidthReset: () => void;
  /** 窄屏时点「文件（N）」：以抽屉形式看当前活动 tab */
  onPeek: () => void;
}): React.JSX.Element | null {
  const width = clampWorkspaceWidth(storedWidth, mainWidth, ws.minWidth);
  const splitter = useSplitter({ width, mainWidth, minWidth: ws.minWidth, onCommit: onWidthCommit, onReset: onWidthReset });
  if (!ws.enabled || ws.status === 'absent') return null;
  const hidden = ws.status === 'collapsed' || ws.narrow;
  const effective = splitter.dragWidth ?? width;
  return (
    <>
      {hidden && (
        <button
          type="button"
          data-testid="ws-restore"
          onClick={() => (ws.narrow ? onPeek() : ws.expand())}
          title={ws.narrow ? '窗口较窄：以抽屉形式查看已打开的文件' : '展开文件工作区'}
          aria-label={`文件（${ws.count}）`}
          className="border-border bg-surface-2 text-text-2 hover:text-text hover:bg-brand-soft flex w-8 shrink-0 flex-col items-center gap-1.5 border-l pt-3 text-[12px] [writing-mode:vertical-rl]"
        >
          <FilesIcon className="size-3.5 rotate-90" aria-hidden />
          文件（{ws.count}）
        </button>
      )}
      {!hidden && !ws.maximized && (
        <div
          data-testid="ws-splitter"
          className="group/split focus-visible:bg-brand/40 relative w-2 shrink-0 cursor-col-resize touch-none outline-none"
          {...splitter.props}
        >
          <span
            className={cn(
              'bg-border absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover/split:bg-brand/60 group-focus-visible/split:bg-brand',
              splitter.dragWidth !== null && 'bg-brand/70',
            )}
          />
        </div>
      )}
      <Activity mode={hidden ? 'hidden' : 'visible'}>
        <section
          data-testid="ws-pane"
          aria-label="文件工作区"
          data-maximized={ws.maximized ? 'true' : undefined}
          className={cn('bg-surface flex min-h-0 shrink-0 flex-col', ws.maximized && 'absolute inset-0 z-20')}
          style={ws.maximized ? undefined : { width: effective }}
        >
          <div className="border-border text-text-2 flex h-8 shrink-0 items-center gap-1 border-b pr-1 pl-3 text-[12px]">
            <FilesIcon className="size-3.5" aria-hidden />
            <span className="min-w-0 flex-1 truncate">文件 · {ws.count}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              data-testid="ws-maximize"
              aria-pressed={ws.maximized}
              aria-label={ws.maximized ? '还原工作区' : '最大化工作区'}
              title={ws.maximized ? '还原（回到聊天 | 工作区）' : '最大化（暂时盖住聊天）'}
              onClick={() => ws.setMaximized(!ws.maximized)}
            >
              {ws.maximized ? <Minimize2Icon /> : <Maximize2Icon />}
            </Button>
            <Button size="icon-xs" variant="ghost" data-testid="ws-collapse" aria-label="收起工作区" title="收起（保留已打开的 tab）" onClick={ws.collapse}>
              <PanelRightCloseIcon />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-xs" variant="ghost" data-testid="ws-menu" aria-label="工作区菜单" title="更多">
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem data-testid="ws-menu-reset" onSelect={ws.resetLayout}>
                  重置布局（合并为一组）
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="ws-menu-close-all" onSelect={ws.closeAll}>
                  关闭全部 tab
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="min-h-0 flex-1">
            {ws.mounted && ws.dock !== null && <LazyWorkspace key={`${ws.key ?? ''}#${ws.generation}`} {...ws.dock} visible={!hidden} />}
          </div>
        </section>
      </Activity>
    </>
  );
}

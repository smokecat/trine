/**
 * PC 侧栏的拖边调宽与折叠快捷键。规则见 lib/layout-prefs.ts。
 *
 * 拖动中只改本地状态，松手才写 prefs（prefs 每次写都落 localStorage 并通知全局 store）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { dragSidebar } from '@/lib/layout-prefs.ts';

export interface SidebarResize {
  /** 拖动中的宽度；null = 没在拖 */
  dragWidth: number | null;
  /** 拖到会折叠的位置了（松手即折叠），用于给出视觉提示 */
  willCollapse: boolean;
  handleProps: React.HTMLAttributes<HTMLDivElement>;
}

export function useSidebarResize(
  asideRef: React.RefObject<HTMLElement | null>,
  {
    onCommit,
    onCollapse,
    onReset,
  }: { onCommit: (width: number) => void; onCollapse: () => void; onReset: () => void },
): SidebarResize {
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [willCollapse, setWillCollapse] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number; width: number; collapse: boolean } | null>(null);
  const dragging = dragWidth !== null;

  // 指针滑出拖柄时整页保持调宽光标，不选中文字
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

  const end = useCallback((): void => {
    drag.current = null;
    setDragWidth(null);
    setWillCollapse(false);
  }, []);

  return {
    dragWidth,
    willCollapse,
    handleProps: {
      onPointerDown: (e) => {
        if (e.button !== 0 || asideRef.current === null) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const startWidth = asideRef.current.getBoundingClientRect().width;
        drag.current = { startX: e.clientX, startWidth, width: startWidth, collapse: false };
        setDragWidth(startWidth);
      },
      onPointerMove: (e) => {
        const d = drag.current;
        if (d === null) return;
        const next = dragSidebar(d.startWidth, e.clientX - d.startX, window.innerWidth);
        d.width = next.width;
        d.collapse = next.collapse;
        setDragWidth(next.width);
        setWillCollapse(next.collapse);
      },
      onPointerUp: (e) => {
        const d = drag.current;
        if (d === null) return;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        end();
        if (d.collapse) onCollapse();
        // 只是点了一下：不把默认宽度固化成自定义宽度
        else if (Math.abs(d.width - d.startWidth) >= 1) onCommit(d.width);
      },
      onPointerCancel: end,
      onDoubleClick: onReset,
    },
  };
}

/** ⌘B / Ctrl+B 切换侧栏（与常见编辑器一致） */
export function useSidebarShortcut(toggle: () => void): void {
  const ref = useRef(toggle);
  useEffect(() => {
    ref.current = toggle;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() !== 'b' || e.isComposing) return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

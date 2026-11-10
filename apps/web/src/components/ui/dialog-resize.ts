/**
 * 弹窗拖边调宽（DialogContent 的 `resizable`）。
 *
 * 弹窗居中，拖一侧边时两侧对称伸缩：宽度变化是指针位移的两倍，手底下那条边始终跟着指针。
 * 只在桌面（精确指针、sm 以上）出现拖柄；触屏仍按弹窗自己的默认宽度。
 * 调过的宽度按 key 记在本设备 localStorage，双击拖柄恢复默认。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const KEY_PREFIX = 'trine.dialog-width:';
/** 最窄 20rem；最宽留出与默认相同的 1rem 边距 */
export const DIALOG_MIN_WIDTH = 320;
const VIEWPORT_MARGIN = 32;

export function clampDialogWidth(width: number, viewport: number): number {
  const max = Math.max(DIALOG_MIN_WIDTH, viewport - VIEWPORT_MARGIN);
  return Math.round(Math.min(max, Math.max(DIALOG_MIN_WIDTH, width)));
}

/** 拖 side 侧的边：起始宽 + 两倍位移（左边往左拖为加宽） */
export function dragDialogWidth(startWidth: number, dx: number, side: 'left' | 'right', viewport: number): number {
  return clampDialogWidth(startWidth + (side === 'right' ? dx : -dx) * 2, viewport);
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readWidth(key: string | undefined): number | null {
  if (key === undefined) return null;
  const n = Number(storage()?.getItem(KEY_PREFIX + key));
  return Number.isFinite(n) && n >= DIALOG_MIN_WIDTH ? n : null;
}

function writeWidth(key: string | undefined, width: number | null): void {
  if (key === undefined) return;
  try {
    if (width === null) storage()?.removeItem(KEY_PREFIX + key);
    else storage()?.setItem(KEY_PREFIX + key, String(width));
  } catch {
    // 存不了（隐私模式、配额满）就只在本次生效
  }
}

export interface DialogResize {
  /** null = 用弹窗默认宽度 */
  width: number | null;
  dragging: boolean;
  handleProps: (side: 'left' | 'right') => React.HTMLAttributes<HTMLDivElement>;
}

export function useDialogResize(contentRef: React.RefObject<HTMLElement | null>, storageKey: string | undefined): DialogResize {
  const [width, setWidth] = useState<number | null>(() => readWidth(storageKey));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ side: 'left' | 'right'; startX: number; startWidth: number; width: number } | null>(null);
  // 拖动时指针可能滑出拖柄：整页保持调宽光标，并禁止选中文字
  useEffect(() => {
    if (!dragging) return;
    const style = document.documentElement.style;
    const prev = { cursor: style.cursor, userSelect: style.userSelect };
    style.cursor = 'ew-resize';
    style.userSelect = 'none';
    return () => {
      style.cursor = prev.cursor;
      style.userSelect = prev.userSelect;
    };
  }, [dragging]);

  const handleProps = useCallback(
    (side: 'left' | 'right'): React.HTMLAttributes<HTMLDivElement> => ({
      onPointerDown: (e) => {
        if (e.button !== 0 || contentRef.current === null) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const startWidth = contentRef.current.getBoundingClientRect().width;
        drag.current = { side, startX: e.clientX, startWidth, width: startWidth };
        setDragging(true);
      },
      onPointerMove: (e) => {
        const d = drag.current;
        if (d === null) return;
        d.width = dragDialogWidth(d.startWidth, e.clientX - d.startX, d.side, window.innerWidth);
        setWidth(d.width);
      },
      onPointerUp: (e) => {
        const d = drag.current;
        if (d === null) return;
        drag.current = null;
        setDragging(false);
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        // 只是点了一下没拖动：不记成自定义宽度
        if (Math.abs(d.width - d.startWidth) >= 1) writeWidth(storageKey, d.width);
      },
      onPointerCancel: () => {
        drag.current = null;
        setDragging(false);
      },
      onDoubleClick: () => {
        setWidth(null);
        writeWidth(storageKey, null);
      },
    }),
    [contentRef, storageKey],
  );

  return { width, dragging, handleProps };
}

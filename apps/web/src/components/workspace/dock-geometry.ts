/** 组的几何关系（纯函数，测试与 WorkspaceDock 共用） */

export type Direction = 'left' | 'right' | 'up' | 'down';

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** b 是否在 a 的 d 方向上（整体落在那一侧，且在另一条轴上有重叠；1px 容差） */
export function isInDirection(a: Rect, b: Rect, d: Direction): boolean {
  const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1;
  const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  switch (d) {
    case 'left':
      return b.right <= a.left + 1 && overlapY;
    case 'right':
      return b.left >= a.right - 1 && overlapY;
    case 'up':
      return b.bottom <= a.top + 1 && overlapX;
    case 'down':
      return b.top >= a.bottom - 1 && overlapX;
  }
}

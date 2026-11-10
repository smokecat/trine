/**
 * PC 布局偏好：侧栏宽度 / 折叠，会话内容宽度。都只存本设备（prefs）。
 *
 * - 侧栏：拖右边调宽，往左拖过最窄宽度一段距离就折叠成图标栏；未调过时用响应式默认宽度
 *   （<1100px 300，≥1100px 320）。
 * - 内容宽度：会话页时间线与输入框的最大宽度，全局一个默认，单个会话可以覆盖。
 *   宽度只是上限：侧栏折叠后主区变宽，「全宽」会跟着铺满，标准 / 宽仍居中。
 */
import { z } from 'zod';

export const CONTENT_WIDTHS = ['standard', 'wide', 'full'] as const;
export type ContentWidth = (typeof CONTENT_WIDTHS)[number];
export const ContentWidthSchema = z.enum(CONTENT_WIDTHS);

export const CONTENT_WIDTH_LABEL: Record<ContentWidth, string> = {
  standard: '标准',
  wide: '宽',
  full: '全宽',
};

/** 内容区最大宽度（CSS 长度），给 `--chat-max` 用；全宽 = 100%，两侧只留默认内边距 */
export function contentMaxWidth(width: ContentWidth): string {
  switch (width) {
    case 'standard':
      return '960px';
    case 'wide':
      return '1200px';
    case 'full':
      return '100%';
  }
}

/** 会话的生效宽度：单独设过就用它，否则跟随全局 */
export function effectiveContentWidth(
  global: ContentWidth,
  overrides: Readonly<Record<string, ContentWidth>>,
  key: string,
): ContentWidth {
  return overrides[key] ?? global;
}

/** 设单个会话的宽度；null = 跟随全局（删掉覆盖，不让记录无限增长） */
export function setContentWidthOverride(
  overrides: Readonly<Record<string, ContentWidth>>,
  key: string,
  width: ContentWidth | null,
): Record<string, ContentWidth> {
  const next = { ...overrides };
  if (width === null) delete next[key];
  else next[key] = width;
  return next;
}

export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 480;
/** 拖到比最窄还窄这么多就折叠 */
export const SIDEBAR_COLLAPSE_SLOP = 80;
/** 主区至少留这么宽，窄窗口上侧栏不能把它挤没 */
const MAIN_MIN_WIDTH = 480;

export function clampSidebarWidth(width: number, viewport: number): number {
  const max = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewport - MAIN_MIN_WIDTH));
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/** 拖动结果：宽度（已夹住）与松手时是否应折叠 */
export function dragSidebar(startWidth: number, dx: number, viewport: number): { width: number; collapse: boolean } {
  const raw = startWidth + dx;
  return { width: clampSidebarWidth(raw, viewport), collapse: raw < SIDEBAR_MIN_WIDTH - SIDEBAR_COLLAPSE_SLOP };
}

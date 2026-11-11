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
/**
 * 聊天栏至少这么宽：窄窗口上侧栏不能把它挤没（Sidebar 的 CSS clamp 用同一个值），
 * 工作区也不能把它挤没（见下）。
 */
export const CHAT_MIN_WIDTH = 480;

/**
 * 会话页的文件工作区（聊天 | 工作区，见 components/workspace）：
 * - 工作区至少 WORKSPACE_MIN_WIDTH，其中每个组（dockview）至少 WORKSPACE_GROUP_MIN_WIDTH；
 * - 主区放不下「聊天最小宽 + 分隔条 + 工作区最小宽」时，工作区自动收起成「文件（N）」，
 *   宽度恢复后还原（不改用户设的宽度）；
 * - 侧栏照旧只保证聊天最小宽：侧栏拖宽 → 主区变窄 → 先压工作区，再自动收起它。
 */
export const WORKSPACE_MIN_WIDTH = 360;
export const WORKSPACE_GROUP_MIN_WIDTH = 220;
export const WORKSPACE_SPLITTER_WIDTH = 8;
/** 工作区宽度的存储上限（防坏数据；实际以主区宽度夹住） */
export const WORKSPACE_MAX_STORED_WIDTH = 8000;

export function clampSidebarWidth(width: number, viewport: number): number {
  const max = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewport - CHAT_MIN_WIDTH));
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/** 主区（聊天 + 工作区）够不够同时放下两栏 */
export function workspaceFits(mainWidth: number): boolean {
  return mainWidth >= CHAT_MIN_WIDTH + WORKSPACE_SPLITTER_WIDTH + WORKSPACE_MIN_WIDTH;
}

/**
 * 工作区的实际宽度：`stored` 为 null 时取主区一半；再夹到 [最小宽, 主区 − 聊天最小宽 − 分隔条]。
 * 主区放不下两栏时（应已自动收起）返回最小宽。
 */
export function clampWorkspaceWidth(stored: number | null, mainWidth: number): number {
  const max = mainWidth - CHAT_MIN_WIDTH - WORKSPACE_SPLITTER_WIDTH;
  const want = stored ?? Math.round((mainWidth - WORKSPACE_SPLITTER_WIDTH) / 2);
  if (max < WORKSPACE_MIN_WIDTH) return WORKSPACE_MIN_WIDTH;
  return Math.round(Math.min(max, Math.max(WORKSPACE_MIN_WIDTH, want)));
}

/** 拖动结果：宽度（已夹住）与松手时是否应折叠 */
export function dragSidebar(startWidth: number, dx: number, viewport: number): { width: number; collapse: boolean } {
  const raw = startWidth + dx;
  return { width: clampSidebarWidth(raw, viewport), collapse: raw < SIDEBAR_MIN_WIDTH - SIDEBAR_COLLAPSE_SLOP };
}

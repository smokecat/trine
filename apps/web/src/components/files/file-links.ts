/**
 * 「点路径打开文件」的入口：聊天页在 agent 支持文件查看（machine.info.files）时提供，
 * ToolCard 与 Markdown 读它。没有 provider（别的页面、旧 agent）= 路径不可点。
 */
import { createContext, useContext } from 'react';

export interface FileLinks {
  /** 打开文件预览；路径可以是绝对、`~` 或相对会话 cwd */
  open: (path: string) => void;
  /** 打开文件浏览器；省略 = 会话 cwd */
  browse: (dir?: string) => void;
}

export const FileLinksContext = createContext<FileLinks | null>(null);

export function useFileLinks(): FileLinks | null {
  return useContext(FileLinksContext);
}

/**
 * 正在预览的 markdown 文件路径：文档里的相对链接 / 图片相对它解析（不是相对 cwd）。
 * 只由文件预览器里的 Markdown 提供。
 */
export const FileBaseContext = createContext<string | undefined>(undefined);

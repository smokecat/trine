/**
 * 「点路径打开文件」的入口：聊天页在 agent 支持文件查看（machine.info.files）时提供，
 * ToolCard 与 Markdown 读它。没有 provider（别的页面、旧 agent）= 路径不可点。
 *
 * 所有打开动作都是同一个 intent（方案 §5「打开规则」）：
 * - `auto`：工作区展开时进工作区，否则抽屉临时查看；
 * - `side`：直接进工作区（Alt+点击、「在侧边打开」）；
 * - `drawer`：总是抽屉。
 * 路由由 `createFileLinks` 决定：只给了抽屉时三种都落到抽屉；工作区（C2）通过
 * `workspace` 处理器接进来，调用点不用改。
 */
import { createContext, useContext } from 'react';

export type FileOpenTarget = 'auto' | 'side' | 'drawer';

interface FileOpenCommon {
  target: FileOpenTarget;
  /** 打开后直接是「保留」tab（不被下一次 auto 打开替换）；抽屉忽略 */
  keep?: boolean;
}

/** 打开文件：路径可以是绝对、`~` 或相对会话 cwd */
export interface FileOpenFileIntent extends FileOpenCommon {
  dir?: false;
  path: string;
  /** 加载后定位到的锚点（已解码的原文，如 `安装步骤`）；与路径分开传，路径里的 `#` 是文件名的一部分 */
  fragment?: string;
}

/** 浏览目录：省略 path = 会话 cwd */
export interface FileOpenDirIntent extends FileOpenCommon {
  dir: true;
  path?: string;
}

export type FileOpenIntent = FileOpenFileIntent | FileOpenDirIntent;

export interface FileLinks {
  open: (intent: FileOpenIntent) => void;
}

/** 工作区（C2）接入点：展开状态由它自己报，打开由它自己做 */
export interface FileWorkspaceRoute {
  /** 工作区存在且展开（auto 据此决定去向） */
  expanded: () => boolean;
  open: (intent: FileOpenIntent) => void;
}

export interface FileOpenHandlers {
  /** 抽屉（手机唯一形态，也是没有工作区时的去处） */
  drawer: (intent: FileOpenIntent) => void;
  /** 工作区；不给 = 还没有工作区（C1）或当前不可用（手机宽度） */
  workspace?: FileWorkspaceRoute | null | undefined;
}

/** intent 落到哪里：纯函数，便于测 */
export function resolveFileOpenTarget(target: FileOpenTarget, workspace: FileWorkspaceRoute | null | undefined): 'drawer' | 'workspace' {
  if (target === 'drawer' || workspace == null) return 'drawer';
  if (target === 'side') return 'workspace';
  return workspace.expanded() ? 'workspace' : 'drawer';
}

export function createFileLinks(handlers: FileOpenHandlers): FileLinks {
  return {
    open: (intent) => {
      if (resolveFileOpenTarget(intent.target, handlers.workspace) === 'workspace') handlers.workspace!.open(intent);
      else handlers.drawer(intent);
    },
  };
}

/**
 * 点击时按修饰键选目标：Alt+点击 = 在侧边打开（VS Code 惯例）。Ctrl/Cmd 不劫持。
 * 只看 altKey：不依赖具体事件类型。
 */
export function targetForClick(event: { altKey: boolean }): FileOpenTarget {
  return event.altKey ? 'side' : 'auto';
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

/**
 * 文件预览实例的锚点能力（只在文件预览里提供，聊天消息没有）：
 * - `ns`：本预览实例的 id 前缀，标题 id = `${ns}-${slug}`，多个预览同屏不冲突；
 * - `jump`：在本预览的滚动容器内定位锚点（原文或百分号编码都行），找不到返回 false。
 */
export interface FileDocAnchors {
  ns: string;
  jump: (fragment: string) => boolean;
}

export const FileDocAnchorContext = createContext<FileDocAnchors | null>(null);

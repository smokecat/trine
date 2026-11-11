/**
 * 文件面板的打开状态放在 URL 查询参数里（`?file=<路径>` / `?dir=<路径>`，`dir` 为空 = 会话 cwd）：
 * 手机上系统返回键能逐级退回（文件 → 目录 → 关闭），刷新页面也停在原处。
 *
 * 每次面板内跳转都 push 一条历史，并在 location.state 里记深度与「是不是从关着的状态打开的」；
 * 关闭时，从关着打开的按深度一次退回打开前；深链进来的（历史起点就带着面板）退回去面板还在，
 * 所以就地 replace 掉参数。location.state 原有的字段（来源页 `from`）保留。
 *
 * 打开文件时要定位的锚点（`a.md#安装`）放在 location.state 的 `fileFragment`，不进查询参数：
 * 路径里的 `#` 是文件名的一部分，锚点要单独传；返回到这一条历史时、刷新页面后照样定位。
 * 限制：location.state 只属于本标签页的这条历史，**复制 URL、新标签 / 深链打开不携带锚点**，
 * 只会打开文件本身（从顶部开始）。
 */
import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { FileView } from './FilePanel.tsx';
import type { FileOpenIntent } from './file-links.ts';

export function viewFromSearch(search: string): FileView | null {
  const params = new URLSearchParams(search);
  const file = params.get('file');
  if (file !== null && file !== '') return { kind: 'file', path: file };
  const dir = params.get('dir');
  if (dir !== null) return dir === '' ? { kind: 'dir' } : { kind: 'dir', path: dir };
  return null;
}

/** 打开 intent → 抽屉视图（`keep` / `target` 对抽屉没有意义） */
export function viewForIntent(intent: FileOpenIntent): FileView {
  if (intent.dir === true) return intent.path === undefined ? { kind: 'dir' } : { kind: 'dir', path: intent.path };
  return intent.fragment === undefined || intent.fragment === ''
    ? { kind: 'file', path: intent.path }
    : { kind: 'file', path: intent.path, fragment: intent.fragment };
}

export function searchForView(search: string, view: FileView | null): string {
  const params = new URLSearchParams(search);
  params.delete('file');
  params.delete('dir');
  if (view?.kind === 'file') params.set('file', view.path);
  if (view?.kind === 'dir') params.set('dir', view.path ?? '');
  const out = params.toString();
  return out === '' ? '' : `?${out}`;
}

export function useFilePanelRoute(): {
  view: FileView | null;
  open: (view: FileView) => void;
  close: () => void;
} {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as { fileDepth?: unknown; fileFromClosed?: unknown; fileFragment?: unknown } | null;
  const fragment = typeof state?.fileFragment === 'string' && state.fileFragment !== '' ? state.fileFragment : undefined;
  const view = useMemo(() => {
    const v = viewFromSearch(location.search);
    return v?.kind === 'file' && fragment !== undefined ? { ...v, fragment } : v;
  }, [location.search, fragment]);
  const depth = typeof state?.fileDepth === 'number' ? state.fileDepth : 0;
  const fromClosed = state?.fileFromClosed === true;

  const open = useCallback(
    (next: FileView) => {
      const opening = view === null;
      const { fileFragment: _fragment, ...prev } = (location.state as Record<string, unknown> | null) ?? {};
      navigate(
        { pathname: location.pathname, search: searchForView(location.search, next) },
        {
          state: {
            ...prev,
            fileDepth: opening ? 1 : depth + 1,
            fileFromClosed: opening ? true : fromClosed,
            ...(next.kind === 'file' && next.fragment !== undefined && next.fragment !== '' ? { fileFragment: next.fragment } : {}),
          },
        },
      );
    },
    [navigate, location.pathname, location.search, location.state, depth, fromClosed, view],
  );

  const close = useCallback(() => {
    if (fromClosed && depth > 0) {
      navigate(-depth);
      return;
    }
    const { fileDepth: _depth, fileFromClosed: _from, fileFragment: _fragment, ...rest } = (location.state as Record<string, unknown> | null) ?? {};
    navigate({ pathname: location.pathname, search: searchForView(location.search, null) }, { replace: true, state: rest });
  }, [navigate, depth, fromClosed, location.pathname, location.search, location.state]);

  return { view, open, close };
}

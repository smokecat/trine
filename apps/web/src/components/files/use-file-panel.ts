/**
 * 文件面板的打开状态放在 URL 查询参数里（`?file=<路径>` / `?dir=<路径>`，`dir` 为空 = 会话 cwd）：
 * 手机上系统返回键能逐级退回（文件 → 目录 → 关闭），刷新页面也停在原处。
 *
 * 每次面板内跳转都 push 一条历史，并在 location.state 里记深度；关闭时按深度一次退回打开前，
 * 深链进来的（深度未知）就地 replace 掉参数。location.state 原有的字段（来源页 `from`）保留。
 */
import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { FileView } from './FilePanel.tsx';

export function viewFromSearch(search: string): FileView | null {
  const params = new URLSearchParams(search);
  const file = params.get('file');
  if (file !== null && file !== '') return { kind: 'file', path: file };
  const dir = params.get('dir');
  if (dir !== null) return dir === '' ? { kind: 'dir' } : { kind: 'dir', path: dir };
  return null;
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
  const view = useMemo(() => viewFromSearch(location.search), [location.search]);
  const state = location.state as { fileDepth?: unknown } | null;
  const depth = typeof state?.fileDepth === 'number' ? state.fileDepth : 0;

  const open = useCallback(
    (next: FileView) => {
      navigate(
        { pathname: location.pathname, search: searchForView(location.search, next) },
        { state: { ...(location.state as object | null), fileDepth: depth + 1 } },
      );
    },
    [navigate, location.pathname, location.search, location.state, depth],
  );

  const close = useCallback(() => {
    if (depth > 0) {
      navigate(-depth);
      return;
    }
    const { fileDepth: _drop, ...rest } = (location.state as Record<string, unknown> | null) ?? {};
    navigate({ pathname: location.pathname, search: searchForView(location.search, null) }, { replace: true, state: rest });
  }, [navigate, depth, location.pathname, location.search, location.state]);

  return { view, open, close };
}

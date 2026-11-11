/**
 * 抽屉 → 工作区（「在工作区打开」，以及工作区展开时的 `?file=` 深链）。顺序：
 *   1. 调用方先抓好抽屉当前内容状态（路径、模式、换行、滚动），此时抽屉还在；
 *   2. 消费抽屉历史：从关着打开的 → navigate(-depth) 一次退回；深链进来的 → 就地 replace 去掉 ?file/?dir；
 *   3. 等 location 真回到「无抽屉」后再建 tab（浏览器里 navigate(-n) 是异步 popstate）。
 *
 * 不在第 2 步后立刻建 tab：history.go 异步，期间聊天页仍以旧 location 渲染；用「挂起的 intent +
 * 等抽屉参数消失」解耦，也不会留下多余历史条目。
 */
import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { searchForView, viewFromSearch } from '@/components/files/use-file-panel.ts';
import type { FileView } from '@/components/files/FilePanel.tsx';
import type { FileOpenIntent } from '@/components/files/file-links.ts';
import type { TabViewState } from './workspace-model.ts';

/** 抽屉视图 → 工作区打开 intent */
export function intentForView(view: FileView): FileOpenIntent {
  if (view.kind === 'dir') return view.path === undefined ? { dir: true, target: 'side' } : { dir: true, path: view.path, target: 'side' };
  return view.fragment === undefined ? { path: view.path, target: 'side' } : { path: view.path, fragment: view.fragment, target: 'side' };
}

export interface HandoffIntent {
  intent: FileOpenIntent;
  state: TabViewState;
}

/**
 * 工作区**确实显示着**时的 `?file=` / `?dir=` 深链（不是本页从关着打开的抽屉）：转成 tab，参数就地 replace 掉。
 * `shown` 必须在主区宽度测量之后才为 true（见 use-workspace 的 measured）：窄窗口首次进入时，
 * 未测量的 0 宽不能当成「够宽」，否则深链会交给一个随即自动收起的工作区，目标文件看不到。
 */
export function useWorkspaceDeepLink(shown: boolean, view: FileView | null, fromClosed: boolean, handoff: (h: HandoffIntent) => void): void {
  const deepLink = view !== null && !fromClosed ? view : null;
  useEffect(() => {
    if (!shown || deepLink === null) return;
    handoff({ intent: intentForView(deepLink), state: {} });
  }, [shown, deepLink, handoff]);
}

export function useDrawerHandoff(createTab: (h: HandoffIntent) => void): (h: HandoffIntent) => void {
  const location = useLocation();
  const navigate = useNavigate();
  const pending = useRef<HandoffIntent | null>(null);
  const createRef = useRef(createTab);
  createRef.current = createTab;

  const drawerOpen = viewFromSearch(location.search) !== null;

  useEffect(() => {
    if (drawerOpen || pending.current === null) return;
    const h = pending.current;
    pending.current = null;
    createRef.current(h);
  }, [drawerOpen]);

  return useCallback(
    (h: HandoffIntent) => {
      pending.current = h;
      const state = location.state as { fileDepth?: unknown; fileFromClosed?: unknown } | null;
      const depth = typeof state?.fileDepth === 'number' ? state.fileDepth : 0;
      if (state?.fileFromClosed === true && depth > 0) {
        navigate(-depth);
        return;
      }
      const { fileDepth: _d, fileFromClosed: _f, fileFragment: _g, ...rest } = (location.state as Record<string, unknown> | null) ?? {};
      navigate({ pathname: location.pathname, search: searchForView(location.search, null) }, { replace: true, state: rest });
    },
    [location, navigate],
  );
}

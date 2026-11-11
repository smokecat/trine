/**
 * 视图实例的代次（见 WorkspaceViewStore）：挂载（layout effect）时取得新代次。旧实例的卸载补报
 * 发生在 passive 清理里，晚于新实例的 layout effect，所以会因代次不符被拒绝。
 * 工作区 tab 正文与窄屏抽屉共用（本文件在主包，不依赖 dockview）。
 */
import { useLayoutEffect, useRef } from 'react';
import type { WorkspaceViewStore } from './workspace-store.ts';

export function useViewGeneration(view: WorkspaceViewStore, id: string | undefined): React.RefObject<number> {
  const gen = useRef(-1);
  useLayoutEffect(() => {
    if (id !== undefined) gen.current = view.attach(id);
  }, [view, id]);
  return gen;
}

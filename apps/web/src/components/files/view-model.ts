/**
 * 文件视图的「内容状态」：模式、换行、滚动位置。视图本身不持有它，由外壳传入并接收变更——
 * 抽屉放在组件 state 里（关掉就丢），工作区 tab（C2）存进 tab 元数据并持久化。
 * 只放可序列化的小字段，不放内容与 Blob URL。
 */
import { useEffect, useLayoutEffect, useRef } from 'react';

export interface FileDocModel {
  /** markdown 的显示方式 */
  mode: 'rendered' | 'source';
  /** 文本自动换行 */
  wrap: boolean;
  /** 预览滚动容器的 scrollTop（打开时恢复一次） */
  scrollTop: number;
}

export interface FileDirModel {
  scrollTop: number;
}

export const DEFAULT_DOC_MODEL: FileDocModel = { mode: 'rendered', wrap: false, scrollTop: 0 };
export const DEFAULT_DIR_MODEL: FileDirModel = { scrollTop: 0 };

/** 滚动停下多久后上报一次 */
const SCROLL_REPORT_MS = 150;

/**
 * 滚动位置：内容就绪（`ready` 首次为 true）时恢复一次 `initialTop`；之后在 onScroll 里记录
 * （卸载时 DOM 上读到的已经是 0），停下后上报，卸载时把没报的补上。
 * 返回要挂到滚动容器上的 onScroll。
 */
export function useScrollMemory(
  ref: React.RefObject<HTMLElement | null>,
  initialTop: number,
  ready: boolean,
  report: (top: number) => void,
): (event: React.UIEvent<HTMLElement>) => void {
  const restored = useRef(false);
  /** 正在恢复：这期间的滚动事件是自己设 scrollTop 引起的，不记录 */
  const restoring = useRef(false);
  const last = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reportRef = useRef(report);
  reportRef.current = report;
  const initialRef = useRef(initialTop);
  initialRef.current = initialTop;

  // 内容可能晚一拍才有高度（文本异步解码、代码高亮）：高度不够时盯着子树变化再试，超时放弃
  useLayoutEffect(() => {
    const el = ref.current;
    if (!ready || restored.current || el === null) return;
    restored.current = true;
    const top = initialRef.current;
    if (top <= 0) return;
    const apply = (): boolean => {
      el.scrollTop = top;
      return el.scrollHeight - el.clientHeight >= top;
    };
    if (apply() || typeof MutationObserver === 'undefined') return;
    restoring.current = true;
    const observer = new MutationObserver(() => {
      if (apply()) stop();
    });
    const timeout = setTimeout(() => stop(), 3000);
    function stop(): void {
      restoring.current = false;
      observer.disconnect();
      clearTimeout(timeout);
    }
    observer.observe(el, { childList: true, subtree: true });
    return stop;
  }, [ready, ref]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (last.current !== null) reportRef.current(last.current);
    },
    [],
  );

  return (event) => {
    if (restoring.current) return;
    last.current = event.currentTarget.scrollTop;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (last.current === null) return;
      reportRef.current(last.current);
      last.current = null;
    }, SCROLL_REPORT_MS);
  };
}

/**
 * 文件视图的「内容状态」：模式、换行、滚动位置。视图本身不持有它，由外壳传入并接收变更——
 * 抽屉放在组件 state 里（关掉就丢），工作区 tab（C2）存进 tab 元数据并持久化。
 * 只放可序列化的小字段，不放内容与 Blob URL。
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ScrollAnchor } from './scroll-anchor.ts';

export interface FileDocModel {
  /** markdown 的显示方式 */
  mode: 'rendered' | 'source';
  /** 文本自动换行 */
  wrap: boolean;
  /** 预览滚动容器的 scrollTop（打开时恢复一次；有 anchor 时以 anchor 为准） */
  scrollTop: number;
  /** 滚动锚点（源码行号 + 偏移，见 scroll-anchor.ts）：宽度 / 模式不同也能回到同一块 */
  anchor?: ScrollAnchor | undefined;
}

export interface FileDirModel {
  scrollTop: number;
}

export const DEFAULT_DOC_MODEL: FileDocModel = { mode: 'rendered', wrap: false, scrollTop: 0 };
export const DEFAULT_DIR_MODEL: FileDirModel = { scrollTop: 0 };

/** 滚动停下多久后上报一次 */
const SCROLL_REPORT_MS = 150;
/** 内容一直不够高时，最多等这么久再放弃恢复 */
const RESTORE_TIMEOUT_MS = 3000;
/** 这些输入说明用户在自己滚动：立即取消恢复（pointerdown 只认落在容器本身上的，即拖滚动条） */
const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

/**
 * 滚动位置：内容就绪（`ready` 首次为 true）时恢复一次 `initialTop`；之后在 onScroll 里记录
 * （卸载时 DOM 上读到的已经是 0），停下后上报，卸载时把没报的补上。
 *
 * 内容可能晚一拍才有高度（文本异步解码、代码高亮）：高度不够时盯着子树变化再试。恢复期间：
 * - 只过滤**自己设 scrollTop** 引起的滚动事件（位置等于刚设下的值）；
 * - 用户 wheel / touch / 键盘 / 拖滚动条，或出现别的位置的滚动，立即取消恢复，不再拉回；
 * - 取消或超时后把**实际位置**记下来上报（文档变短时就是夹到底的位置）。
 * 返回要挂到滚动容器上的 onScroll。
 */
export function useScrollMemory(
  ref: React.RefObject<HTMLElement | null>,
  initialTop: number,
  ready: boolean,
  report: (top: number) => void,
  options: {
    restoreTimeoutMs?: number;
    /** 正在恢复时为 true（别的定位逻辑据此让路） */
    restoring?: { current: boolean };
  } = {},
): (event: React.UIEvent<HTMLElement>) => void {
  const restoringOut = options.restoring;
  const restored = useRef(false);
  /** 正在恢复时的收尾函数（save=true 记下实际位置）；不在恢复中为 null */
  const finishRef = useRef<((save: boolean) => void) | null>(null);
  /** 程序刚设下的 scrollTop（浏览器夹过之后的值），用来认出自己引起的滚动事件 */
  const expected = useRef<number | null>(null);
  const last = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reportRef = useRef(report);
  reportRef.current = report;
  const initialRef = useRef(initialTop);
  initialRef.current = initialTop;
  const timeoutMs = options.restoreTimeoutMs ?? RESTORE_TIMEOUT_MS;

  const record = useRef((top: number): void => {
    last.current = top;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (last.current === null) return;
      reportRef.current(last.current);
      last.current = null;
    }, SCROLL_REPORT_MS);
  }).current;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!ready || restored.current || el === null) return;
    restored.current = true;
    const top = initialRef.current;
    if (top <= 0) return;
    const apply = (): boolean => {
      el.scrollTop = top;
      expected.current = el.scrollTop;
      return el.scrollHeight - el.clientHeight >= top;
    };
    if (apply() || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
      if (apply()) finish(false);
    });
    const onUserInput = (event: Event): void => {
      if (event.type === 'pointerdown' && event.target !== el) return;
      finish(true);
    };
    const timeout = setTimeout(() => finish(true), timeoutMs);
    function finish(save: boolean): void {
      if (finishRef.current === null) return;
      finishRef.current = null;
      if (restoringOut !== undefined) restoringOut.current = false;
      expected.current = null;
      observer.disconnect();
      clearTimeout(timeout);
      for (const type of USER_SCROLL_EVENTS) el!.removeEventListener(type, onUserInput);
      if (save) record(el!.scrollTop);
    }
    finishRef.current = finish;
    if (restoringOut !== undefined) restoringOut.current = true;
    for (const type of USER_SCROLL_EVENTS) el.addEventListener(type, onUserInput, { passive: true });
    observer.observe(el, { childList: true, subtree: true });
    return () => finish(false);
  }, [ready, ref, record, timeoutMs, restoringOut]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (last.current !== null) reportRef.current(last.current);
    },
    [],
  );

  return (event) => {
    const top = event.currentTarget.scrollTop;
    if (finishRef.current !== null) {
      // 自己设的位置引起的：不记录；别的位置 = 用户用别的方式滚了（查找、辅助技术），取消恢复
      if (expected.current !== null && Math.abs(top - expected.current) < 1) return;
      finishRef.current(false);
    }
    record(top);
  };
}

/**
 * 滚动锚点的生命周期（规则见 scroll-anchor.ts）：
 * - 滚动时（rAF 合并）记下锚点；
 * - 尺寸变化（ResizeObserver 观察滚动容器与正文元素，回调在布局完成之后）时按锚点恢复——
 *   宽度变化重排、代码高亮 / 图片撑高都不丢位置；
 * - 换了正文元素（源码 ↔ 渲染、刷新）时重新观察，初次回调同样按锚点恢复；
 * - 带初始锚点（重挂回来）时，恢复成功或用户自己动之前不记录，免得加载过程中的位置把它冲掉。
 * 浏览器自带的 scroll anchoring 由调用方用 `overflow-anchor: none` 关掉，避免两套逻辑互相拉扯。
 */
import { useCallback, useEffect, useRef } from 'react';
import { anchorContent, captureAnchor, renderedBlockStarts, restoreAnchor, type ScrollAnchor } from './scroll-anchor.ts';

const USER_INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

export function useScrollAnchor(
  container: HTMLElement | null,
  options: { initial?: ScrollAnchor | undefined; busy?: () => boolean },
): { anchor: React.RefObject<ScrollAnchor | null>; capture: () => void; restore: () => void } {
  const anchor = useRef<ScrollAnchor | null>(options.initial ?? null);
  const pending = useRef(options.initial !== undefined);
  const blockStarts = useRef<number[] | null>(null);
  const busyRef = useRef(options.busy);
  busyRef.current = options.busy;

  /** 上次记录 / 恢复时的布局尺寸：变了说明是重排（不是用户滚动），要恢复而不是重新记录 */
  const layoutKey = useRef('');
  const currentLayout = useCallback((): string => {
    if (container === null) return '';
    const content = anchorContent(container);
    const r = content?.getBoundingClientRect();
    return `${content === null ? '-' : content.tagName}|${container.clientWidth}x${container.clientHeight}|${Math.round(r?.width ?? 0)}x${Math.round(r?.height ?? 0)}`;
  }, [container]);

  /** 记录当前锚点；`explicit` = 调用方主动定位过（跳转、切模式），覆盖还没恢复的初始锚点 */
  const record = useCallback((explicit: boolean): void => {
    if (container === null) return;
    if (explicit) pending.current = false;
    if (pending.current) return;
    const starts = renderedBlockStarts(container);
    if (starts !== null) blockStarts.current = starts;
    const next = captureAnchor(container, blockStarts.current);
    if (next !== null) anchor.current = next;
    layoutKey.current = currentLayout();
  }, [container, currentLayout]);
  const capture = useCallback((): void => record(true), [record]);

  const restore = useCallback((): void => {
    if (container === null || anchor.current === null || busyRef.current?.() === true) return;
    if (restoreAnchor(container, anchor.current)) pending.current = false;
    layoutKey.current = currentLayout();
  }, [container, currentLayout]);

  /**
   * 滚动后的记录：如果布局在这之间变了（异步代码高亮、图片撑高、宽度变化），这次滚动事件
   * 多半是我们自己恢复引起的，此刻顶部的块已经不是原来那个——先按旧锚点恢复，不记录。
   * （rAF 在布局与 ResizeObserver 回调之前跑，不能指望 RO 先把位置纠正过来。）
   */
  const settle = useCallback((): void => {
    if (container === null) return;
    if (anchor.current !== null && layoutKey.current !== '' && currentLayout() !== layoutKey.current) restore();
    else record(false);
  }, [container, currentLayout, restore, record]);

  useEffect(() => {
    if (container === null) return;
    let frame: number | null = null;
    const onScroll = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        settle();
      });
    };
    const onInput = (): void => {
      pending.current = false;
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    for (const t of USER_INPUT) container.addEventListener(t, onInput, { passive: true });

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => restore()) : null;
    let content: HTMLElement | null = null;
    const retarget = (): void => {
      const next = anchorContent(container);
      if (next === content) return;
      if (content !== null) ro?.unobserve(content);
      content = next;
      if (content !== null) {
        ro?.observe(content);
        // 新正文出现就先按锚点放一次（RO 的首次回调随后再校正）
        restore();
      }
    };
    ro?.observe(container);
    retarget();
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(retarget);
    mo?.observe(container, { childList: true, subtree: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      for (const t of USER_INPUT) container.removeEventListener(t, onInput);
      ro?.disconnect();
      mo?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [container, settle, restore]);

  return { anchor, capture, restore };
}

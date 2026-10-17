/**
 * 断点订阅。
 *
 * 900px 是原型定的 PC/移动分界（prototype.html 的 `@media (max-width:900px)`
 * 隐藏 `.desk`）：≥900px 左侧栏常驻，<900px 走列表 ⇄ 聊天的双栈导航。
 *
 * 为什么不用纯 CSS 把两套布局都渲染出来再各自 `display:none`：侧栏与列表页
 * 用的是同一批组件，双份挂载意味着双份订阅、双份 effect（列表页有
 * `session.list.request` 这种带副作用的 effect），得不偿失。这里用 JS 断点
 * 只挂一套。
 */
import { useSyncExternalStore } from 'react';

/** PC 布局起点，与 styles.css / 原型保持一致 */
export const DESKTOP_QUERY = '(min-width: 900px)';

function subscribe(query: string): (onChange: () => void) => () => void {
  return (onChange) => {
    if (typeof matchMedia !== 'function') return () => {};
    const mql = matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  };
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    subscribe(query),
    () => (typeof matchMedia === 'function' ? matchMedia(query).matches : false),
    // SSR/无 matchMedia 时按移动端——窄布局在宽屏上能看，反过来不行
    () => false,
  );
}

/** ≥900px？ */
export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}

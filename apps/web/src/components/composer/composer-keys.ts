/**
 * 输入框里 Enter 是「换行」还是「发送」。
 *
 * ## 触屏设备：回车永远换行
 *
 * iOS / Android 软键盘没有 Shift+Enter，Enter 一旦被拿去发送就再也打不出
 * 换行。所以触屏设备（`pointer: coarse`）上键盘回车只换行，发送走界面上的
 * 发送按钮；接了外接键盘的平板仍可用 Cmd/Ctrl+Enter 发送。
 *
 * ## PC：用户在设置页二选一（prefs.sendKey）
 *
 * - `enter`（默认）：Enter 发送，Shift+Enter 换行；
 * - `mod-enter`：Cmd/Ctrl+Enter 发送，Enter 换行。
 *
 * 两种模式下 Cmd/Ctrl+Enter 都是发送，换了模式肌肉记忆也不会误伤。
 *
 * 输入法组合中的 Enter 是「选词」，一律不算发送（Safari 在组合结束那一下
 * 报 `isComposing: false` 但 keyCode 仍是 229，一并排除）。
 */

export type SendKey = 'enter' | 'mod-enter';

/** 触屏判定：主指针是手指（配 useMediaQuery 订阅） */
export const TOUCH_QUERY = '(pointer: coarse)';

/** 提示里写 ⌘ 还是 Ctrl（iPad 外接键盘同样是 ⌘） */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export interface EnterKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

/**
 * 这次按键是否应当发送。返回 false 时调用方什么都不做，让 textarea 按
 * 默认行为插入换行。
 */
export function isSendKey(e: EnterKeyEvent, mode: SendKey, touch: boolean): boolean {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return false;
  if (e.shiftKey || e.altKey) return false;
  if (e.metaKey || e.ctrlKey) return true;
  return !touch && mode === 'enter';
}

/** 发送键的人话描述（placeholder / 按钮 title 用） */
export function sendKeyLabel(mode: SendKey, touch: boolean, mac: boolean): string | null {
  if (touch) return null;
  const mod = mac ? '⌘' : 'Ctrl';
  return mode === 'enter' ? 'Enter 发送，Shift+Enter 换行' : `${mod}+Enter 发送，Enter 换行`;
}

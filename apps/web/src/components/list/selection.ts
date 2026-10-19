/**
 * 会话列表多选的纯逻辑（零 React，selection.test.ts 覆盖）。
 *
 * 交互约定（同常见文件管理器）：
 * - Ctrl/Cmd + 点击：切换这一行，并把它记为锚点；
 * - Shift + 点击：从锚点到这一行（按当前可见顺序）整段加入选择；没有锚点时等同切换；
 * - 已有选择时的普通点击：切换（「选择模式」，触屏上没有修饰键也能多选）；
 * - 没有选择时的普通点击：不归这里管（照常导航）。
 */

export interface SelectionState {
  keys: ReadonlySet<string>;
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { keys: new Set(), anchor: null };

export function selectionKey(machineId: string, sessionId: string): string {
  return `${machineId}\u0000${sessionId}`;
}

export interface ClickMods {
  /** Ctrl / Cmd */
  toggle: boolean;
  /** Shift */
  range: boolean;
}

/** 这次点击是否归多选处理（否则照常导航） */
export function isSelectionClick(mods: ClickMods, selectedCount: number): boolean {
  return mods.toggle || mods.range || selectedCount > 0;
}

export function toggleKey(state: SelectionState, key: string): SelectionState {
  const keys = new Set(state.keys);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return { keys, anchor: key };
}

/**
 * 处理一次归多选的点击。`order` 是当前可见、可选的行 key（自上而下），
 * range 只在锚点与目标都在其中时生效。
 */
export function applyClick(
  state: SelectionState,
  key: string,
  mods: ClickMods,
  order: readonly string[],
): SelectionState {
  if (mods.range && state.anchor !== null) {
    const from = order.indexOf(state.anchor);
    const to = order.indexOf(key);
    if (from >= 0 && to >= 0) {
      const keys = new Set(state.keys);
      for (const k of order.slice(Math.min(from, to), Math.max(from, to) + 1)) keys.add(k);
      return { keys, anchor: state.anchor };
    }
  }
  return toggleKey(state, key);
}

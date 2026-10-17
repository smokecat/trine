/**
 * 两个会话 sheet（新建 / 会话设置）共用的纯逻辑：权限模式选项与
 * **bypass 两击确认**的状态机（决策 9 / 原型 `NOTES.chat` 的「bypass 权限档
 * （已拍板：保留）：UI 强制两击确认」），以及离线机器的口径文案。
 *
 * 为什么单独抽出来：两击确认是安全相关的交互，行为必须可测——「首击只变红
 * 不生效、再击才生效、点别的档位后红色清掉、已选中的 bypass 不再要求确认」
 * 这四条任何一条错了都是安全问题。零 React，`bun test` 直接覆盖。
 */
import type { PermissionMode } from '@trine/core';

/**
 * 离线机器为什么不能新建会话。
 *
 * 口径必须与 `client.request()` 一致：它对 `online === false` **立即 reject**，
 * 不发帧——机器级帧离线本就被服务端静默丢弃，不存在「排队等上线后创建」。
 * 早先 sheet 的提示说的正是后者，与点下去看到的 toast 直接矛盾。
 */
export const OFFLINE_HINT = '这台机器离线，无法新建会话；可以进入已有会话留言排队，等它上线后送达。';

export interface PermissionModeOption {
  value: PermissionMode;
  label: string;
  /** 非空 = 选中前需要两击确认，文案即首击后显示的警告 */
  confirmWarning: string;
}

/**
 * 警告文案的统一前缀（评审 M3 残留 / N12）。
 *
 * 早先两个 sheet 一个渲染 `⚠ {warning}`、一个直接 `{warning}`，同一句话
 * 两副样子。M8 收敛了状态机与文案常量，前缀却还留在 JSX 里各写各的——
 * 所以把它并进 `pendingWarning()` 的返回值，调用方原样渲染即可，没有
 * 「忘了加前缀」这个可能。
 */
export const WARNING_PREFIX = '⚠ ';

/** bypass 的警告文案：只陈述事实（等同哪条 CLI 参数、后果是什么），不做安全承诺 */
export const BYPASS_WARNING =
  '等同 claude --permission-mode bypassPermissions，所有工具不再询问。再点一次确认。';

export const PERMISSION_MODE_OPTIONS: readonly PermissionModeOption[] = [
  { value: 'default', label: 'default', confirmWarning: '' },
  { value: 'acceptEdits', label: 'acceptEdits', confirmWarning: '' },
  { value: 'plan', label: 'plan', confirmWarning: '' },
  { value: 'bypassPermissions', label: 'bypass', confirmWarning: BYPASS_WARNING },
];

export interface ModePickerState {
  /** 当前已生效的选择 */
  value: PermissionMode;
  /** 已首击、等待第二击确认的选项；null = 没有待确认项 */
  pending: PermissionMode | null;
}

export function initialModeState(value: PermissionMode = 'default'): ModePickerState {
  return { value, pending: null };
}

function needsConfirm(mode: PermissionMode): boolean {
  return (PERMISSION_MODE_OPTIONS.find((o) => o.value === mode)?.confirmWarning ?? '') !== '';
}

/**
 * 点一下某档位后的新状态。
 *
 * - 普通档位：立即生效，并清掉别处的待确认（用户改主意了）。
 * - 需确认的档位且尚未处于「待确认」：只置 pending，**不改 value**。
 * - 需确认的档位且正是当前 pending：生效。
 * - 已经是当前 value 的需确认档位：视为无操作（不要求用户为「保持现状」再确认一次）。
 */
export function clickMode(state: ModePickerState, clicked: PermissionMode): ModePickerState {
  if (!needsConfirm(clicked)) return { value: clicked, pending: null };
  if (state.value === clicked) return { value: clicked, pending: null };
  if (state.pending === clicked) return { value: clicked, pending: null };
  return { value: state.value, pending: clicked };
}

/** 当前该显示的警告文案（无待确认项时为空串） */
export function pendingWarning(state: ModePickerState): string {
  if (state.pending === null) return '';
  const text = PERMISSION_MODE_OPTIONS.find((o) => o.value === state.pending)?.confirmWarning ?? '';
  // 前缀在这里加，调用方原样渲染——两个 sheet 不可能再写出两副样子
  return text === '' ? '' : `${WARNING_PREFIX}${text}`;
}

/** `/permission <arg>` 的入参校验：唯一一份合法档位清单 */
export function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODE_OPTIONS.some((o) => o.value === value);
}

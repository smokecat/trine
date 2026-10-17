/**
 * 权限 remember 规则：模式串匹配、安全校验、建议生成。
 *
 * 三端共用：agent 用 `matchesPattern`/`isSafeRememberPattern` 决定放不放行，
 * client 用 `suggestRememberPattern` 生成 UI 里填的那个 pattern。
 */
export {
  isSafeRememberPattern,
  matchesPattern,
  suggestRememberPattern,
} from './pattern.ts';
export { waitingForTool } from './waiting.ts';

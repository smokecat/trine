/**
 * 「在等什么」的唯一映射：挂起权限请求的 toolName → WaitingFor。
 *
 * agent 用它推 `SessionMeta.waitingFor` 与推送提示，web 用它给会话内的
 * 等待文案分流——两端同一份真相，不各写一个 switch。
 */
import type { WaitingFor } from '../types/index.ts';

export function waitingForTool(toolName: string): WaitingFor {
  switch (toolName) {
    case 'AskUserQuestion':
      return 'question';
    case 'ExitPlanMode':
      return 'plan';
    default:
      return 'permission';
  }
}

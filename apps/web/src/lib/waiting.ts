/**
 * 「在等什么」→ 文案：会话内（心跳 footer / 头部 pill）与会话列表共用这一份。
 *
 * 数据来源两条，口径一致（都是「最早一条挂起的权限请求」）：
 * - 会话内：时间线上最早一条 pending 的权限条目的 toolName → `waitingForOfTool`；
 * - 会话列表：`SessionMeta.waitingFor`（agent ≥ 0.6.0 才带）。
 * 没有信息（旧 agent / 时间线里没有 pending 条目）一律按普通权限处理。
 *
 * toolName → 类型的映射本身在 core（`waitingForTool`），agent 推 waitingFor 用的
 * 也是它——这里不另写一份 switch。
 */
import type { WaitingFor } from '@trine/core';
import { waitingForTool } from '@trine/core/permission';

const WAITING_LABEL: Record<WaitingFor, string> = {
  permission: '等待批准',
  question: '等待回答',
  plan: '等待批准计划',
};

/** 等待态文案；缺省（旧 agent 不带 waitingFor）按普通权限 */
export function waitingLabel(waitingFor: WaitingFor | undefined): string {
  return WAITING_LABEL[waitingFor ?? 'permission'];
}

/** 权限条目的 toolName → 等待类型；没有条目（undefined）按普通权限 */
export function waitingForOfTool(toolName: string | undefined): WaitingFor {
  return toolName === undefined ? 'permission' : waitingForTool(toolName);
}

/**
 * 本地用户消息的状态角标：文案 + 可用动作（方案 §4.3 本地条目状态机）。
 *
 * 抽成纯函数是为了能单测——状态机有六个状态、两种可撤回、两种可重发，
 * 塞在 JSX 里既看不清也测不了。UserMessage 只负责把这里的结果画出来。
 */
import { RECALL_PENDING_MS, type UserEntry } from '@/lib/reducer.ts';

// 判据常量在 reducer（client 的结算定时器与这里的角标文案共用同一个值）；
// 这里再导出一次，调用方与测试沿用原来的引入路径。
export { RECALL_PENDING_MS };

/** 角标上能出现的动作；`recall_parked` 撤回服务端队列、`recall_queued` 撤回 agent 队列 */
export type UserEntryAction = 'recall_parked' | 'recall_queued' | 'retry' | 'resend';

export interface UserEntryBadge {
  /** 主文案；undefined = 不显示角标（已确认的本地条目与他人回显） */
  label?: string;
  /** 语气：中性 / 提醒 / 失败 */
  tone: 'muted' | 'amber' | 'red';
  action?: { kind: UserEntryAction; label: string; disabled?: boolean };
}


const NONE: UserEntryBadge = { tone: 'muted' };

/**
 * `now` 用于 parked 的「xx 前有效」与撤回乐观态的超时，给测试注入。
 * `formatExpiry` 由调用方给（UI 层用 toLocaleString，测试用固定串）。
 */
export function userEntryBadge(
  entry: UserEntry,
  formatExpiry: (at: number) => string,
  now: number = Date.now(),
): UserEntryBadge {
  if (!entry.local) return NONE;
  switch (entry.status) {
    case undefined:
    case 'confirmed':
      return NONE;
    case 'sending':
      return { label: '发送中…', tone: 'muted' };
    case 'queued':
      // 撤回已发出但协议没有回执（评审 M6）：显示乐观态并禁用按钮，
      // 超过 RECALL_PENDING_MS 还没动静就当撤成了，恢复成可再点
      if (entry.recallingAt !== undefined && now - entry.recallingAt < RECALL_PENDING_MS) {
        return {
          label: '已排队 · 撤回中…',
          tone: 'muted',
          action: { kind: 'recall_queued', label: '撤回中…', disabled: true },
        };
      }
      // agent 已收下、排在当前任务后面（运行中发消息的正常路径）
      return {
        label: '已排队 · 任务结束后发送',
        tone: 'muted',
        action: { kind: 'recall_queued', label: '撤回' },
      };
    case 'parked':
      return {
        label:
          entry.expiresAt === undefined
            ? '机器离线，已在服务端排队'
            : `机器离线，已在服务端排队 · ${formatExpiry(entry.expiresAt)} 前有效`,
        tone: 'amber',
        action: { kind: 'recall_parked', label: '撤回' },
      };
    case 'expired':
      return {
        label: '排队已过期，未送达',
        tone: 'red',
        action: { kind: 'resend', label: '重发' },
      };
    case 'failed':
      return {
        label: entry.failReason === undefined ? '发送失败' : `发送失败：${entry.failReason}`,
        tone: 'red',
        // failed 条目沿用同一个 clientMsgId 重发（agent 按它去重）
        action: { kind: 'retry', label: '重发' },
      };
    case 'recalled':
      // 撤回成功（评审 C-2）：消息确实没被执行，这是用户要的结果——
      // 所以不给红色的「失败」语气，也不给动作（同一个 clientMsgId 重发
      // 会被 agent 按去重表吃掉，给了也没用）
      return { label: '已撤回', tone: 'muted' };
  }
}

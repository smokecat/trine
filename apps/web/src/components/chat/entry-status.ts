/**
 * 本地用户消息的状态文案 + 可用动作（方案 §4.3 本地条目状态机）。
 *
 * - `userEntryBadge`：时间线里用户气泡下的角标。
 * - `pendingItemView`：输入框上方排队托盘里的一行（还没进入对话的消息，见 reducer
 *   `isPendingEntry`）。
 *
 * 抽成纯函数是为了能单测——状态机的状态多、动作组合多，塞在 JSX 里既看不清也测不了。
 * 组件只负责把这里的结果画出来。
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
      // 撤回已发出、等回执：禁用按钮；RECALL_PENDING_MS 内没等到就恢复成可再点
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
    case 'cancelled':
      return { label: entry.failReason ?? '未发送', tone: 'muted', action: { kind: 'resend', label: '重发' } };
    case 'recalled':
      // 旧版落盘的撤回成功条目（现在撤回成功直接删条目）：消息确实没被执行，
      // 不给红色的「失败」语气，也不给动作（同一个 clientMsgId 重发会被 agent 去重吃掉）
      return { label: '已撤回', tone: 'muted' };
  }
}

/** 托盘行上的动作 */
export type PendingActionKind = 'recall' | 'edit' | 'resend' | 'discard';

export interface PendingItemView {
  /** 状态文案 */
  label: string;
  tone: 'muted' | 'amber' | 'red';
  /** 等回执中（发送中 / 撤回中）：行变淡、显示转圈 */
  busy: boolean;
  actions: { kind: PendingActionKind; label: string }[];
}

/** 能不能「编辑」（放回输入框）：带附件的放不回去——草稿附件要原始文件 */
export function canEditPending(entry: UserEntry): boolean {
  return entry.attachments === undefined || entry.attachments.length === 0;
}

/**
 * 托盘里一行的文案与动作。
 *
 * 排队中：撤回、编辑（撤回成功后放回输入框）；离线暂存：只能撤回。没送进去的（被停止 / 关闭丢弃、
 * 过期、发送失败）：重发、编辑、丢弃。
 */
export function pendingItemView(entry: UserEntry, formatExpiry: (at: number) => string, now: number = Date.now()): PendingItemView {
  const edit = canEditPending(entry) ? [{ kind: 'edit' as const, label: '编辑' }] : [];
  const leftOver = [{ kind: 'resend' as const, label: '重发' }, ...edit, { kind: 'discard' as const, label: '丢弃' }];
  switch (entry.status) {
    case 'queued':
      if (entry.recallingAt !== undefined && now - entry.recallingAt < RECALL_PENDING_MS) {
        return { label: '撤回中…', tone: 'muted', busy: true, actions: [] };
      }
      return { label: '排队中', tone: 'muted', busy: false, actions: [...edit, { kind: 'recall', label: '撤回' }] };
    case 'parked':
      return {
        label: entry.expiresAt === undefined ? '机器离线 · 上线后发送' : `机器离线 · ${formatExpiry(entry.expiresAt)} 前有效`,
        tone: 'amber',
        busy: false,
        // 不给编辑：park.recall 没有回执，与上线投递撞上时旧消息照样执行，
        // 放回输入框再发就成了两条
        actions: [{ kind: 'recall', label: '撤回' }],
      };
    case 'cancelled':
      return { label: entry.failReason ?? '未发送', tone: 'muted', busy: false, actions: leftOver };
    case 'expired':
      return { label: '排队已过期，未送达', tone: 'red', busy: false, actions: leftOver };
    case 'failed':
      return {
        label: entry.failReason === undefined ? '发送失败' : `发送失败：${entry.failReason}`,
        tone: 'red',
        busy: false,
        actions: leftOver,
      };
    default:
      return { label: '发送中…', tone: 'muted', busy: true, actions: [] };
  }
}

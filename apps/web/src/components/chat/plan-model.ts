/**
 * ExitPlanMode 计划卡的纯逻辑：解析 input、三个动作 → decision、已响应态文案。
 *
 * ## 协议上它是什么（已用真 claude 2.1.282 + SDK 0.3.251 实测）
 *
 * plan 模式下 Claude 调 ExitPlanMode，走 canUseTool，input 形如
 * `{ plan: "<markdown 计划全文>", planFilePath: "/…/.claude/plans/x.md" }`。
 * 三个动作对齐本机 CLI：
 * - 「批准并自动接受编辑」= allow + `setMode:'acceptEdits'`：agent 转成
 *   updatedPermissions setMode，CLI 原子地停在 acceptEdits，后续编辑不再询问；
 * - 「批准，逐个确认编辑」= allow，不带 setMode：CLI 自己切回 default，后续
 *   编辑逐个走权限卡；
 * - 「继续规划」= deny + message：message 原样作为 tool_result 送给 Claude，
 *   Claude 修改计划后会再次调 ExitPlanMode，会话仍在 plan 模式。
 *
 * 两个批准都显式带 `updatedInput = 原 input`：实测用的就是这个形状（CLI 对
 * 不带 updatedInput 的 allow 也接受，但计划卡没理由偏离验证过的形状）；
 * 顺带 resolved 帧会回报这份 input，刷新 / 多设备也能从 approvedInput 读到计划。
 *
 * **不要**改成「批准后 client 再发 session.setPermissionMode」：ExitPlanMode
 * 批准后 CLI 会自动切回 default，两者竞态。
 */
import type { PermissionEntry } from '@/lib/reducer.ts';
import type { PermissionDecision } from './PermissionCard.tsx';
import { permissionResultText } from './permission-model.ts';

export interface PlanInput {
  /** markdown 计划全文（非空） */
  plan: string;
  /** 计划文件路径（CLI 写到 ~/.claude/plans/ 下）；缺失时不显示 */
  planFilePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析 ExitPlanMode 的 input；plan 不是非空字符串返回 null（调用方回落普通权限卡） */
export function parsePlanInput(input: unknown): PlanInput | null {
  if (!isRecord(input)) return null;
  const { plan, planFilePath } = input;
  if (typeof plan !== 'string' || plan.trim() === '') return null;
  return {
    plan,
    ...(typeof planFilePath === 'string' && planFilePath !== '' ? { planFilePath } : {}),
  };
}

/** 时间线里这条权限请求要不要画成计划卡（否则画普通权限卡） */
export function isPlanRequest(toolName: string, input: unknown): boolean {
  return toolName === 'ExitPlanMode' && parsePlanInput(input) !== null;
}

/** 「继续规划」没填反馈时送给 Claude 的默认附言 */
export const DEFAULT_KEEP_PLANNING_MESSAGE = '用户选择继续规划，暂不执行。请根据需要继续完善计划，完善后再请求批准。';

export type PlanAction = 'approve_auto' | 'approve_manual' | 'keep_planning';

/**
 * 动作 → 发给 agent 的 decision。
 *
 * @param feedback 「继续规划」旁的反馈输入；trim 后非空才作为 message，否则用默认附言
 * @param options.supportsOptions agent 是否支持 message / setMode（≥ 0.6.0）。不支持
 *   时不带这两个字段——旧 agent 会 strip 掉，带了也只是假装生效
 */
export function planDecision(
  action: PlanAction,
  input: unknown,
  feedback: string,
  options: { supportsOptions: boolean } = { supportsOptions: true },
): PermissionDecision {
  const updatedInput = isRecord(input) ? input : {};
  switch (action) {
    case 'approve_auto':
      return options.supportsOptions
        ? { verdict: 'allow', updatedInput, setMode: 'acceptEdits' }
        : { verdict: 'allow', updatedInput };
    case 'approve_manual':
      return { verdict: 'allow', updatedInput };
    case 'keep_planning': {
      if (!options.supportsOptions) return { verdict: 'deny' };
      const text = feedback.trim();
      return { verdict: 'deny', message: text === '' ? DEFAULT_KEEP_PLANNING_MESSAGE : text };
    }
  }
}

/**
 * 已响应 / 已失效态的文案。
 * - 批准：`✓ 已批准（设备）· 已切到自动接受编辑` / `· 逐个确认编辑`；
 * - 继续规划：`↺ 继续规划（设备）`，`feedback` = 用户填的反馈原文（默认附言不算）；
 * - 失效：复用权限卡文案。
 */
export function planResultText(
  entry: PermissionEntry,
  deviceId: string | null,
): { text: string; tone: 'green' | 'amber' | 'muted'; feedback?: string } {
  if (entry.state !== 'resolved') {
    const base = permissionResultText(entry, deviceId);
    return { text: base.text, tone: 'muted' };
  }
  const by =
    entry.resolvedBy === undefined ? '' : entry.resolvedBy === deviceId ? '（本设备）' : `（${entry.resolvedBy}）`;
  if (entry.verdict === 'allow') {
    return { text: `✓ 已批准${by} · ${approvedModeText(entry.approvedMode)}`, tone: 'green' };
  }
  const feedback = entry.denyMessage;
  return {
    text: `↺ 继续规划${by}`,
    tone: 'amber',
    ...(feedback !== undefined && feedback !== DEFAULT_KEEP_PLANNING_MESSAGE ? { feedback } : {}),
  };
}

/**
 * 批准时随之切到的模式 → 文案。没有 setMode（「逐个确认编辑」，或旧 agent 不回报）
 * 时 CLI 自己切回 default，即逐个确认——两种情况的事实相同。
 */
function approvedModeText(mode: PermissionEntry['approvedMode']): string {
  switch (mode) {
    case undefined:
    case 'default':
      return '逐个确认编辑';
    case 'acceptEdits':
      return '已切到自动接受编辑';
    case 'bypassPermissions':
      return '已切到跳过所有权限确认';
    case 'plan':
      return '仍在规划模式';
  }
}

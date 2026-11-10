/**
 * 子 agent 卡的显示模型（纯函数，无 I/O）。
 *
 * ## 两件事分开说（plan §7）
 *
 * 「启动它的那次工具调用返回了」（tool.end）≠「子 agent 跑完了」。Claude 在 SDK 下 Agent 多为
 * 后台启动（spike S1）：tool.end 在启动时就到了，子 agent 还在跑。所以：
 *
 * - **Claude（Agent / Task）**：前台 / 后台以 `subagent.background` 或后台任务快照里有它为准；
 *   后台的运行状态按优先级取：agent 给的最终状态（结束收尾帧 / 历史回填）→ 后台任务快照
 *   （`toolUseId` 关联；快照陈旧时运行中按「状态未知」）→ 历史的「状态未知」。
 * - **Codex（SubAgent）**：卡片右侧是调用状态（agent 的 resultSummary，已中文化），子 agent
 *   自己的状态另起一行（昵称 / 角色 / 模型 / 状态）。
 */
import type { BgTask, SubagentInfo, SubagentState } from '@trine/core';
import type { ToolEntry } from './reducer.ts';
import { isSubagentTool } from './tool-tree.ts';

/** 子 agent 状态的中文（全部枚举都有，未知值由调用方原样显示） */
export const SUBAGENT_STATE_LABEL: Record<SubagentState, string> = {
  pending: '等待启动',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  interrupted: '已中断',
  shutdown: '已关闭',
  not_found: '找不到',
  ended: '已结束 · 结果未知',
  unknown: '状态未知',
};

/** 最终状态：到了就不再从快照派生「运行中」 */
export const FINAL_STATES: ReadonlySet<SubagentState> = new Set(['completed', 'failed', 'stopped', 'interrupted', 'shutdown', 'not_found', 'ended']);

/** agent 给参数摘要加的后台前缀（agent summarize.ts 的 BACKGROUND_MARK） */
const BACKGROUND_MARK = '后台 · ';
/** agent 给后台启动回执的摘要（summarize.ts） */
const LAUNCH_SUMMARY = '✓ 后台子 agent 已启动';

export interface ClaudeSubagentView {
  /** 前台 / 后台；还不知道（启动中）时 undefined */
  background: boolean | undefined;
  /** 目标子 agent 的状态；前台的跟随工具状态 */
  state: SubagentState;
  /** 后台运行中计时的起点（agent 时钟，与后台任务条同口径） */
  startedAt?: number;
  /** 后台任务快照里的进度（最近的工具、调用次数） */
  progress?: string;
}

/** 后台任务快照按发起它的 toolUseId 建索引（只收 agent 类，Bash 后台任务不归子 agent 卡） */
export function bgTasksByToolUseId(tasks: readonly BgTask[] | undefined): ReadonlyMap<string, BgTask> {
  const out = new Map<string, BgTask>();
  if (tasks === undefined) return out;
  for (const t of tasks) if (t.toolUseId !== undefined && t.kind === 'agent') out.set(t.toolUseId, t);
  return out;
}

function stateOfTask(task: BgTask): SubagentState {
  switch (task.status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
  }
}

/**
 * Claude 子 agent 卡的状态（见文件头）。不是 Agent/Task 返回 undefined。
 *
 * @param stale 后台任务快照已陈旧（reducer `bgTasksStale`：agent 重启后落盘的 running 不可信）
 */
export function claudeSubagentView(entry: ToolEntry, task: BgTask | undefined, stale: boolean): ClaudeSubagentView | undefined {
  if (!isSubagentTool(entry.toolName)) return undefined;
  const info = entry.subagent;
  // 旧 agent / 旧落盘条目没有 subagent 字段：按 agent 给的文案认出后台
  const legacyBackground = info === undefined && (entry.argSummary.startsWith(BACKGROUND_MARK) || entry.resultSummary === LAUNCH_SUMMARY);
  const background =
    info?.background === true || task !== undefined || legacyBackground ? true : entry.status === undefined ? undefined : false;
  if (legacyBackground && task === undefined && entry.status !== undefined && entry.resultSummary !== LAUNCH_SUMMARY) {
    // 旧 agent 的收尾帧已经把结果写进来了
    return { background, state: entry.status === 'error' ? 'failed' : entry.status === 'warn' ? 'stopped' : 'completed' };
  }
  if (background !== true) {
    // 前台（或启动中）：就是这次工具调用本身
    const state: SubagentState =
      entry.status === undefined ? 'running' : entry.status === 'error' ? 'failed' : 'completed';
    return { background, state };
  }
  if (info?.state !== undefined && FINAL_STATES.has(info.state)) return { background, state: info.state };
  if (task !== undefined) {
    const state = stateOfTask(task);
    if (state === 'running') {
      if (stale) return { background, state: 'unknown' };
      const progress =
        task.lastToolName === undefined ? undefined : `${task.lastToolName}${task.toolUses === undefined ? '' : ` ×${task.toolUses}`}`;
      return { background, state, startedAt: task.startedAt, ...(progress === undefined ? {} : { progress }) };
    }
    return { background, state };
  }
  // 启动工具还没返回：仍在启动
  if (entry.status === undefined) return { background, state: 'running' };
  // 没有任务证据、启动调用本身失败：是启动失败，不是「状态未知」（评审 中9）
  if (entry.status === 'error' && (info?.state === undefined || info.state === 'unknown')) return { background, state: 'failed' };
  return { background, state: info?.state ?? 'unknown' };
}

/** 卡头的工具名一栏：「Agent · Explore · 后台」（不知道的部分省略） */
export function subagentTitle(entry: ToolEntry, view: ClaudeSubagentView | undefined): string {
  if (view === undefined) return entry.toolName;
  const parts = [entry.toolName];
  if (entry.subagent?.agentType !== undefined) parts.push(entry.subagent.agentType);
  if (view.background !== undefined) parts.push(view.background ? '后台' : '前台');
  return parts.join(' · ');
}

/** 标题已经写了「后台」：参数摘要去掉 agent 加的同义前缀 */
export function subagentArgSummary(entry: ToolEntry, view: ClaudeSubagentView | undefined): string {
  if (view?.background === undefined || !entry.argSummary.startsWith(BACKGROUND_MARK)) return entry.argSummary;
  return entry.argSummary.slice(BACKGROUND_MARK.length);
}

/** 子 agent 状态文本；不在枚举里的原样给（协议升级后的新值） */
export function subagentStateLabel(state: string): string {
  return (SUBAGENT_STATE_LABEL as Record<string, string>)[state] ?? state;
}

/** Codex 子 agent 的显示名：昵称 → 角色 → thread 短 id */
export function codexAgentName(info: SubagentInfo): string | undefined {
  if (info.nickname !== undefined) return info.agentType === undefined ? info.nickname : `${info.nickname}（${info.agentType}）`;
  if (info.agentType !== undefined) return info.agentType;
  if (info.agentId !== undefined) return info.agentId.length > 8 ? info.agentId.slice(-8) : info.agentId;
  return undefined;
}

/** Codex 子 agent 卡的状态行：「子 agent：Meitner · 运行中 · gpt-x」；没有信息时 null */
export function codexSubagentLine(entry: ToolEntry): string | null {
  if (entry.toolName !== 'SubAgent' || entry.subagent === undefined) return null;
  const info = entry.subagent;
  const parts = [codexAgentName(info), info.state === undefined ? undefined : subagentStateLabel(info.state), info.model].filter(
    (p): p is string => p !== undefined && p !== '',
  );
  return parts.length === 0 ? null : `子 agent：${parts.join(' · ')}`;
}

/** Claude 子 agent 卡是否还在跑（要每秒走字的那种） */
export function subagentTicking(view: ClaudeSubagentView | undefined, entry: ToolEntry): boolean {
  if (view === undefined) return false;
  if (view.background === true) return view.state === 'running' && view.startedAt !== undefined;
  return entry.status === undefined;
}

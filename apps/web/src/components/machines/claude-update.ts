/**
 * 「更新 Claude」的纯逻辑（claude-update）：能力探测 + 把应答整理成给人看的结论。
 * React 胶水在 MachineDetailView，这里零 React 依赖、可直接单测。
 *
 * 能力探测同 session-actions.ts：旧 agent 对不认识的 c2a type 静默丢弃，web
 * 只能等（6 分钟的）超时——所以 `agentVersion >= 0.4.0` 才给入口，版本号解析
 * 不了或还没收到 machine.info 一律当不支持。
 */
import type { MachineInfo } from '@trine/core';
import { compareVersions } from '@/components/list/session-actions.ts';
import type { ClaudeUpdateResult } from '@/lib/client.ts';

/** 首个支持 machine.claude.update.request 的 agent 版本 */
export const CLAUDE_UPDATE_MIN_AGENT = '0.4.0';

export function supportsClaudeUpdate(info: Pick<MachineInfo, 'agentVersion'> | null | undefined): boolean {
  if (info === null || info === undefined) return false;
  const cmp = compareVersions(info.agentVersion, CLAUDE_UPDATE_MIN_AGENT);
  return cmp !== null && cmp >= 0;
}

/** `2.1.282 (Claude Code)` → `2.1.282`；别的形状（含 `(SDK 内置)`）原样 */
export function shortClaudeVersion(version: string): string {
  return version.replace(/\s*\(Claude Code\)\s*$/, '').trim();
}

export interface ClaudeUpdateSummary {
  tone: 'success' | 'info' | 'error';
  /** 一句话结论（toast 与结果区标题共用） */
  title: string;
  /** 补充说明（可无） */
  detail?: string;
  /** agent 回来的输出尾部（可能为空） */
  output: string;
  outputTruncated: boolean;
}

/** 运行中的会话不会被重启——结果里必须讲明，否则用户会以为当前会话已是新版 */
export const RUNNING_SESSIONS_NOTE = '运行中的会话仍是旧版本，新开（或空闲回收后重新打开）的会话才会用上新版。';

export function summarizeClaudeUpdate(res: ClaudeUpdateResult): ClaudeUpdateSummary {
  const from = shortClaudeVersion(res.fromVersion);
  const to = shortClaudeVersion(res.toVersion);
  const output = res.output;
  const outputTruncated = res.outputTruncated === true;
  if (!res.ok) {
    const message = res.error?.message ?? 'agent 未给出原因';
    return { tone: 'error', title: `更新失败：${message}`, output, outputTruncated };
  }
  if (res.fromVersion === res.toVersion) {
    return { tone: 'info', title: `Claude 已是最新（${to}）`, output, outputTruncated };
  }
  return { tone: 'success', title: `Claude 已更新：${from} → ${to}`, detail: RUNNING_SESSIONS_NOTE, output, outputTruncated };
}

/** 请求本身失败（离线 / 未配对 / 等不到应答） */
export function summarizeClaudeUpdateError(err: unknown): ClaudeUpdateSummary {
  const message = err instanceof Error ? err.message : String(err);
  return { tone: 'error', title: `更新失败：${message}`, output: '', outputTruncated: false };
}

/**
 * 「重启 agent」的纯逻辑（agent-restart）：能力探测、版本状态、把应答整理成给人看的结论。
 * React 胶水在 AgentRestartSection，这里零 React 依赖、可直接单测。
 *
 * 能力探测按 `machine.info.restart` 有无（agent ≥ 0.18.0 才带），不按版本号。
 */
import type { MachineInfo, MachineRestartInfo } from '@trine/core';
import type { AgentRestartResult } from '@/lib/client.ts';

export function supportsAgentRestart(info: Pick<MachineInfo, 'restart'> | null | undefined): boolean {
  return info?.restart !== undefined;
}

/** 重启会结束全部会话的 claude 子进程；排空是为了不打断进行中的轮次 */
export const RESTART_NOTE =
  '会等所有会话都空闲（没有进行中的回复、排队消息和后台任务）后再重启，重启后会话的上下文不受影响，发消息即可继续。';

/** 版本一行：运行中 / 工作区；两者不同 = 有更新还没生效 */
export function describeRevision(restart: MachineRestartInfo): { text: string; outdated: boolean } | null {
  const { revision, workspaceRevision } = restart;
  if (revision === undefined && workspaceRevision === undefined) return null;
  if (revision !== undefined && workspaceRevision !== undefined && revision !== workspaceRevision) {
    return { text: `运行中 ${revision}，工作区已是 ${workspaceRevision}：重启后生效`, outdated: true };
  }
  return { text: `运行中 ${revision ?? workspaceRevision}`, outdated: false };
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 进行中的重启 → 一句话；没有 → null */
export function describePending(pending: MachineRestartInfo['pending']): string | null {
  if (pending === undefined) return null;
  if (pending.phase === 'checking') return '正在预检新代码（安装依赖、加载检查）……';
  const deadline = pending.deadline === undefined ? '' : `，${clock(pending.deadline)} 前仍未空闲则取消`;
  return pending.busySessions === 0
    ? '会话已空闲，马上重启……'
    : `已排期：等待 ${pending.busySessions} 个会话空闲后重启${deadline}`;
}

export interface AgentRestartSummary {
  tone: 'success' | 'info' | 'error';
  title: string;
  /** 预检输出尾部（失败时） */
  output: string;
}

export function summarizeAgentRestart(res: AgentRestartResult): AgentRestartSummary {
  if (!res.ok) {
    const message = res.error?.message ?? 'agent 未给出原因';
    const prefix = res.error?.code === 'check_failed' ? '预检未通过，没有重启' : '没有重启';
    return { tone: 'error', title: `${prefix}：${message}`, output: res.error?.output ?? '' };
  }
  const version = res.toVersion === undefined ? '' : `（新版本 ${res.toVersion}）`;
  switch (res.phase) {
    case 'cancelled':
      return { tone: 'info', title: '已取消重启', output: '' };
    case 'restarting':
      return { tone: 'success', title: `预检通过${version}，agent 正在重启`, output: '' };
    default:
      return { tone: 'success', title: `预检通过${version}，会话空闲后重启`, output: '' };
  }
}

/** 请求本身失败（离线 / 未配对 / 等不到应答） */
export function summarizeAgentRestartError(err: unknown): AgentRestartSummary {
  const message = err instanceof Error ? err.message : String(err);
  return { tone: 'error', title: `重启失败：${message}`, output: '' };
}

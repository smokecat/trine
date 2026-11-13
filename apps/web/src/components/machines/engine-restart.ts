/**
 * 「重启引擎进程」的纯逻辑（machine.engine.restart.request）：把应答整理成给人看的结论。
 * React 胶水在 EngineRestartSection，这里零 React 依赖、可直接单测。
 *
 * 能力探测按 EngineSummary.capabilities.restart（agent ≥ 0.28.0 才带），不按版本号。
 */
import type { EngineSummary } from '@trine/core';
import type { EngineRestartResult } from '@/lib/client.ts';

export function supportsEngineRestart(engine: Pick<EngineSummary, 'capabilities'>): boolean {
  return engine.capabilities.restart === true;
}

/** 确认框与说明里共用：重启做了什么、什么时候用 */
export const ENGINE_RESTART_NOTE =
  '换掉 trine 的 Codex 进程并重新读取登录；这台机器上的 Codex 常驻 daemon（本机 Codex 终端用的那个）在运行时一并重启。换账号或重新登录后仍然报未授权时用。';

export interface EngineRestartSummary {
  tone: 'success' | 'info' | 'error';
  title: string;
}

export function summarizeEngineRestart(res: EngineRestartResult, engineName: string): EngineRestartSummary {
  if (!res.ok) {
    const message = res.error?.message ?? 'agent 未给出原因';
    return { tone: res.error?.code === 'busy' ? 'info' : 'error', title: `没有重启：${message}` };
  }
  switch (res.daemon) {
    case 'restarted':
      return { tone: 'success', title: `已重启 ${engineName} 进程和本机 daemon` };
    case 'failed':
      return {
        tone: 'error',
        title: `已重启 trine 的 ${engineName} 进程，本机 daemon 没有重启：${res.daemonMessage ?? '原因未知'}`,
      };
    case 'not_running':
      return { tone: 'success', title: `已重启 ${engineName} 进程（本机 daemon 没在运行）` };
    default:
      return { tone: 'success', title: `已重启 ${engineName} 进程` };
  }
}

/** 请求本身失败（离线 / 未配对 / 等不到应答） */
export function summarizeEngineRestartError(err: unknown): EngineRestartSummary {
  const message = err instanceof Error ? err.message : String(err);
  return { tone: 'error', title: `重启失败：${message}` };
}

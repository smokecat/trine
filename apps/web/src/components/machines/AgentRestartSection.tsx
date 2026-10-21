/**
 * 机器详情里的「重启 agent」（agent-restart）：版本状态 + 确认 → `machine.agent.restart.request`
 * → loading（预检可能几十秒）→ 结论；排空进度来自 machine.info.restart.pending（各设备一致）。
 *
 * 只在 machine.info 带 restart 时由 MachineDetailView 渲染（能力探测见 agent-restart.ts）。
 * 结论同时 toast 一次：用户可能在等待期间离开了这个页面。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import type { MachineRestartInfo } from '@trine/core';
import { Button } from '@/components/ui/button.tsx';
import { ConfirmDialog } from '@/components/machines/ConfirmDialog.tsx';
import {
  describePending,
  describeRevision,
  RESTART_NOTE,
  summarizeAgentRestart,
  summarizeAgentRestartError,
  type AgentRestartSummary,
} from '@/components/machines/agent-restart.ts';
import type { AgentRestartResult } from '@/lib/client.ts';
import { cn } from '@/lib/utils.ts';

const TONE_CLASS: Record<AgentRestartSummary['tone'], string> = {
  success: 'border-green bg-green-soft text-green',
  info: 'border-border bg-surface-2 text-text-2',
  error: 'border-red bg-red-soft text-red',
};

type Action = 'schedule' | 'now' | 'cancel';

export function AgentRestartSection({
  machineName,
  online,
  restart,
  request,
}: {
  machineName: string;
  /** false = 已知离线（按钮禁用）；null = 未知，允许尝试 */
  online: boolean | null;
  restart: MachineRestartInfo;
  request: (action: Action) => Promise<AgentRestartResult>;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState<'schedule' | 'now' | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [result, setResult] = useState<AgentRestartSummary | null>(null);
  const [showOutput, setShowOutput] = useState(false);

  const run = (action: Action): void => {
    setConfirming(null);
    setBusy(action);
    setResult(null);
    setShowOutput(false);
    void request(action)
      .then(summarizeAgentRestart, summarizeAgentRestartError)
      .then((summary) => {
        setResult(summary);
        const notify = summary.tone === 'error' ? toast.error : summary.tone === 'success' ? toast.success : toast.info;
        notify(`${machineName}：${summary.title}`);
      })
      .finally(() => setBusy(null));
  };

  const revision = describeRevision(restart);
  const pendingText = describePending(restart.pending);
  const pending = restart.pending !== undefined;
  const disabled = busy !== null || online === false || !restart.available;

  return (
    <section className="flex flex-col gap-2" data-testid="agent-restart-section">
      <h2 className="font-medium">trine agent</h2>
      {revision !== null && (
        <p
          data-testid="agent-revision"
          data-outdated={revision.outdated}
          className={cn('font-mono text-xs', revision.outdated ? 'text-amber' : 'text-text-3')}
        >
          {revision.text}
        </p>
      )}
      <p className="text-text-3 text-xs">
        预检工作区代码后重启这台机器上的 agent，换上新版本。{RESTART_NOTE}
      </p>
      {!restart.available && (
        <p className="text-text-3 text-xs" data-testid="agent-restart-unavailable">
          不能远程重启：{restart.unavailableReason ?? 'agent 不是由 supervisor 托管的'}
        </p>
      )}
      {pendingText !== null && (
        <p className="text-text-2 text-xs" data-testid="agent-restart-pending">
          {pendingText}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {pending ? (
          <>
            <Button
              variant="outline"
              className="w-fit"
              data-testid="agent-restart-now"
              disabled={disabled || restart.pending?.phase === 'checking'}
              onClick={() => setConfirming('now')}
            >
              立即重启
            </Button>
            <Button
              variant="outline"
              className="w-fit"
              data-testid="agent-restart-cancel"
              // 预检中也能取消：发起方还在等预检应答（busy 为 schedule / now）时同样可以点
              disabled={busy === 'cancel' || online === false}
              onClick={() => run('cancel')}
            >
              取消重启
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            className="w-fit"
            data-testid="agent-restart"
            disabled={disabled}
            onClick={() => setConfirming('schedule')}
          >
            {busy === 'schedule' || busy === 'now' ? (
              <>
                <span aria-hidden className="inline-block motion-safe:animate-spin">
                  ◠
                </span>
                预检中…
              </>
            ) : (
              '重启 agent'
            )}
          </Button>
        )}
      </div>
      {online === false && busy === null && <p className="text-text-3 text-xs">机器离线，上线后才能重启。</p>}
      {result !== null && (
        <div
          data-testid="agent-restart-result"
          data-tone={result.tone}
          className={cn('rounded-[12px] border px-3 py-2 text-xs', TONE_CLASS[result.tone])}
        >
          <p className="font-medium">{result.title}</p>
          {result.output !== '' && (
            <div className="mt-1.5">
              <button
                type="button"
                data-testid="agent-restart-output-toggle"
                aria-expanded={showOutput}
                className="cursor-pointer underline underline-offset-2"
                onClick={() => setShowOutput((v) => !v)}
              >
                {showOutput ? '收起输出' : '查看预检输出'}
              </button>
              {showOutput && (
                <pre
                  data-testid="agent-restart-output"
                  className="bg-code-bg border-border text-text-2 mt-1.5 max-h-64 overflow-auto rounded-lg border px-2.5 py-2 font-mono text-[11.5px] whitespace-pre-wrap"
                >
                  {result.output}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        testId="confirm-agent-restart"
        destructive={confirming === 'now'}
        title={confirming === 'now' ? `立即重启 ${machineName} 上的 agent？` : `重启 ${machineName} 上的 agent？`}
        description={
          confirming === 'now' ? (
            <p>不再等待会话空闲：进行中的回复会被打断，排队的消息会丢失。重启后发消息即可继续。</p>
          ) : (
            <p>先预检工作区代码，通过后{RESTART_NOTE}</p>
          )
        }
        confirmLabel={confirming === 'now' ? '立即重启' : '重启'}
        onConfirm={() => run(confirming ?? 'schedule')}
      />
    </section>
  );
}

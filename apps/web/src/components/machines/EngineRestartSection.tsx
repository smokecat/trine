/**
 * 引擎卡里的「重启进程」（machine.engine.restart.request）：确认 → 请求 → 结论。
 * 只在 capabilities.restart 为真时由 EngineCards 渲染（见 engine-restart.ts）。
 * 结论同时 toast 一次：用户可能在等待期间离开了这个页面。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { ConfirmDialog } from '@/components/machines/ConfirmDialog.tsx';
import {
  ENGINE_RESTART_NOTE,
  summarizeEngineRestart,
  summarizeEngineRestartError,
  type EngineRestartSummary,
} from '@/components/machines/engine-restart.ts';
import type { EngineRestartResult } from '@/lib/client.ts';
import { cn } from '@/lib/utils.ts';

const TONE_CLASS: Record<EngineRestartSummary['tone'], string> = {
  success: 'border-green bg-green-soft text-green',
  info: 'border-border bg-surface-2 text-text-2',
  error: 'border-red bg-red-soft text-red',
};

export function EngineRestartSection({
  engineName,
  idPrefix,
  machineName,
  online,
  restart,
}: {
  engineName: string;
  /** data-testid 前缀 */
  idPrefix: string;
  machineName: string;
  /** false = 已知离线（按钮禁用）；null = 未知，允许尝试 */
  online: boolean | null;
  restart: () => Promise<EngineRestartResult>;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EngineRestartSummary | null>(null);

  const run = (): void => {
    setConfirming(false);
    setBusy(true);
    setResult(null);
    void restart()
      .then((res) => summarizeEngineRestart(res, engineName), summarizeEngineRestartError)
      .then((summary) => {
        setResult(summary);
        const notify = summary.tone === 'error' ? toast.error : summary.tone === 'success' ? toast.success : toast.info;
        notify(`${machineName}：${summary.title}`);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-2" data-testid={`${idPrefix}-restart-section`}>
      <Button
        variant="outline"
        className="w-fit"
        data-testid={`${idPrefix}-restart`}
        disabled={busy || online === false}
        onClick={() => setConfirming(true)}
      >
        {busy ? (
          <>
            <span aria-hidden className="inline-block motion-safe:animate-spin">
              ◠
            </span>
            重启中…
          </>
        ) : (
          `重启 ${engineName} 进程`
        )}
      </Button>
      {result !== null && (
        <p
          data-testid={`${idPrefix}-restart-result`}
          data-tone={result.tone}
          className={cn('rounded-[12px] border px-3 py-2 text-xs', TONE_CLASS[result.tone])}
        >
          {result.title}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        testId={`confirm-${idPrefix}-restart`}
        destructive={false}
        title={`重启 ${machineName} 上的 ${engineName} 进程？`}
        description={
          <>
            <p>{ENGINE_RESTART_NOTE}</p>
            <p>trine 里有会话正在回复时不会重启；空闲会话发下一条消息即可继续。</p>
            <p>daemon 上正在跑的任务（如机器终端里的 {engineName}）会被打断，终端里的 {engineName} 需要退出后重新打开。</p>
          </>
        }
        confirmLabel="重启"
        onConfirm={run}
      />
    </div>
  );
}

/**
 * 机器详情里的「更新 Claude」（claude-update）：确认 → 发 `machine.claude.update.request`
 * → loading（可能几十秒）→ 结论（旧→新 / 已是最新 / 失败原因）+ 可展开的输出尾部。
 *
 * 只在 agent >= 0.4.0 时由 MachineDetailView 渲染（能力探测见 claude-update.ts）。
 * agent >= 0.19.0 另有最新版本行与「检查更新」（`latest` 不为 null 时）：版本由 agent
 * 自动定期检查，按钮只是立即再查一次，结果随 machine.info 回来。
 * 结论同时 toast 一次：用户可能在等待期间离开了这个页面，toast 是全局的。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { ConfirmDialog } from '@/components/machines/ConfirmDialog.tsx';
import {
  RUNNING_SESSIONS_NOTE,
  shortClaudeVersion,
  summarizeClaudeCheck,
  summarizeClaudeUpdate,
  summarizeClaudeUpdateError,
  type ClaudeLatestView,
  type ClaudeUpdateSummary,
} from '@/components/machines/claude-update.ts';
import type { ClaudeCheckResult, ClaudeUpdateResult } from '@/lib/client.ts';
import { formatRelativeTime } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';

const TONE_CLASS: Record<ClaudeUpdateSummary['tone'], string> = {
  success: 'border-green bg-green-soft text-green',
  info: 'border-border bg-surface-2 text-text-2',
  error: 'border-red bg-red-soft text-red',
};

export function ClaudeUpdateSection({
  machineName,
  online,
  claudeVersion,
  update,
  latest = null,
  check,
  now = Date.now(),
}: {
  machineName: string;
  /** false = 已知离线（按钮禁用）；null = 未知，允许尝试 */
  online: boolean | null;
  /** 当前 machine.info 里的版本（确认框里给用户看） */
  claudeVersion: string | undefined;
  update: () => Promise<ClaudeUpdateResult>;
  /** 最新版本（machine.info.claudeLatest 整理后）；null = agent 不支持检查 */
  latest?: ClaudeLatestView | null;
  /** 立即检查最新版本；latest 不为 null 时才有意义 */
  check?: () => Promise<ClaudeCheckResult>;
  now?: number;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ClaudeUpdateSummary | null>(null);
  const [showOutput, setShowOutput] = useState(false);

  const start = (): void => {
    setConfirming(false);
    setUpdating(true);
    setResult(null);
    setShowOutput(false);
    void update()
      .then(summarizeClaudeUpdate, summarizeClaudeUpdateError)
      .then((summary) => {
        setResult(summary);
        const notify = summary.tone === 'error' ? toast.error : summary.tone === 'success' ? toast.success : toast.info;
        notify(`${machineName}：${summary.title}`);
      })
      .finally(() => setUpdating(false));
  };

  const runCheck = (): void => {
    if (check === undefined) return;
    setChecking(true);
    void check()
      .then(summarizeClaudeCheck, (err: unknown) => ({
        tone: 'error' as const,
        title: `检查失败：${err instanceof Error ? err.message : String(err)}`,
      }))
      .then((summary) => {
        const notify = summary.tone === 'error' ? toast.error : summary.tone === 'success' ? toast.success : toast.info;
        notify(`${machineName}：${summary.title}`);
      })
      .finally(() => setChecking(false));
  };

  const updateAvailable = latest?.updateAvailable === true;
  const current = claudeVersion === undefined || claudeVersion.trim() === '' ? '未知' : shortClaudeVersion(claudeVersion);

  return (
    <section className="flex flex-col gap-2" data-testid="claude-update-section">
      <h2 className="font-medium">Claude</h2>
      <p className="text-text-3 text-xs">
        在这台机器上执行 <code className="font-mono">claude update</code>，把远程会话使用的 claude
        更新到最新版。{RUNNING_SESSIONS_NOTE}
      </p>
      {latest !== null && (
        <div className="flex flex-col gap-0.5 text-xs" data-testid="claude-latest">
          <p>
            <span className="text-text-3">当前 </span>
            <span className="font-mono">{latest.current ?? '未知'}</span>
            <span className="text-text-3"> · 最新 </span>
            <span className="font-mono">{latest.latest ?? '未知'}</span>
            {latest.updateAvailable !== null && (
              <span
                data-testid="claude-latest-status"
                data-available={String(latest.updateAvailable)}
                className={cn('ml-2', latest.updateAvailable ? 'text-amber' : 'text-green')}
              >
                {latest.updateAvailable ? '有新版本' : '已是最新'}
              </span>
            )}
          </p>
          <p className="text-text-3">
            {latest.channel} 渠道
            {latest.checkedAt !== null && ` · ${formatRelativeTime(latest.checkedAt, now)}检查`}
            {' · agent 每 6 小时自动检查'}
          </p>
          {latest.error !== null && (
            <p className="text-red" data-testid="claude-latest-error">
              {latest.error}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={updateAvailable ? 'default' : 'outline'}
          className="w-fit"
          data-testid="claude-update"
          disabled={updating || online === false}
          onClick={() => setConfirming(true)}
        >
          {updating ? (
            <>
              <span aria-hidden className="inline-block motion-safe:animate-spin">
                ◠
              </span>
              更新中…
            </>
          ) : updateAvailable && latest?.latest ? (
            `更新到 ${latest.latest}`
          ) : (
            '更新 Claude'
          )}
        </Button>
        {latest !== null && check !== undefined && (
          <Button
            variant="outline"
            className="w-fit"
            data-testid="claude-check"
            disabled={checking || updating || online === false}
            onClick={runCheck}
          >
            {checking ? '检查中…' : '检查更新'}
          </Button>
        )}
      </div>
      {online === false && !updating && <p className="text-text-3 text-xs">机器离线，上线后才能更新。</p>}
      {updating && (
        <p className="text-text-3 text-xs" data-testid="claude-update-progress">
          正在检查并安装更新，可能需要数十秒到几分钟，可以先离开此页面，完成后会有提示。
        </p>
      )}
      {result !== null && (
        <div
          data-testid="claude-update-result"
          data-tone={result.tone}
          className={cn('rounded-[12px] border px-3 py-2 text-xs', TONE_CLASS[result.tone])}
        >
          <p className="font-medium">{result.title}</p>
          {result.detail !== undefined && <p className="mt-1 opacity-90">{result.detail}</p>}
          {result.output !== '' && (
            <div className="mt-1.5">
              <button
                type="button"
                data-testid="claude-update-output-toggle"
                aria-expanded={showOutput}
                className="cursor-pointer underline underline-offset-2"
                onClick={() => setShowOutput((v) => !v)}
              >
                {showOutput ? '收起输出' : '查看输出'}
              </button>
              {showOutput && (
                <pre
                  data-testid="claude-update-output"
                  className="bg-code-bg border-border text-text-2 mt-1.5 max-h-64 overflow-auto rounded-lg border px-2.5 py-2 font-mono text-[11.5px] whitespace-pre-wrap"
                >
                  {result.outputTruncated ? `…（前略）\n${result.output}` : result.output}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        testId="confirm-claude-update"
        destructive={false}
        title={`更新 ${machineName} 上的 Claude？`}
        description={
          <>
            <p>
              当前版本：<span className="font-mono">{current}</span>。agent 会在这台机器上执行{' '}
              <code className="font-mono">claude update</code>，最长 5 分钟。
            </p>
            <p>{RUNNING_SESSIONS_NOTE}</p>
          </>
        }
        confirmLabel="更新"
        onConfirm={start}
      />
    </section>
  );
}

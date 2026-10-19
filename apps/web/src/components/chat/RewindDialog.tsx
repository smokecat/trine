/**
 * 回退确认对话框：对应 Claude Code `/rewind`。打开即向 agent 要一次预览
 * （`session.rewind.preview`，不改任何东西），列出三种模式与各自能不能做、
 * 会还原哪些文件；用户选定后才发 `session.rewind`。
 *
 * 预览 / 执行都经 props 注入（ChatView 接 client），组件本身不碰网络，便于渲染测试。
 */
import { useEffect, useState } from 'react';
import type { RewindMode } from '@trine/core';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import type { RewindPreviewResult } from '@/lib/client.ts';
import { cn } from '@/lib/utils.ts';
import { defaultRewindMode, filesSummary, rewindChoices, rewindTouchesFiles } from './rewind-model.ts';

/** 文件清单最多列这么多行，其余折成「…等 N 个」 */
const MAX_FILES_LISTED = 8;

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; preview: RewindPreviewResult };

export function RewindDialog({
  open,
  onOpenChange,
  messageText,
  loadPreview,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 目标消息的文本（预览回来之前先用时间线里的） */
  messageText: string;
  /** 打开时调一次；reject 的 message 原样展示 */
  loadPreview: () => Promise<RewindPreviewResult>;
  /** 确认回退；resolve 后对话框由调用方关掉，reject 的 message 原样展示 */
  onConfirm: (mode: RewindMode) => Promise<void>;
}): React.JSX.Element {
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });
  const [mode, setMode] = useState<RewindMode | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // 每次打开都重新预览：文件状态随时会变
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    setMode(undefined);
    setFailure(null);
    setBusy(false);
    loadPreview().then(
      (preview) => {
        if (cancelled) return;
        setState({ kind: 'ready', preview });
        setMode(defaultRewindMode(rewindChoices(preview)));
      },
      (err: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, loadPreview]);

  const choices = state.kind === 'ready' ? rewindChoices(state.preview) : [];
  const files = state.kind === 'ready' ? state.preview.files : undefined;
  const summary = filesSummary(files);
  const listed = files?.available === true ? (files.filesChanged ?? []) : [];
  const text = state.kind === 'ready' ? (state.preview.text ?? messageText) : messageText;
  const canConfirm = !busy && state.kind === 'ready' && mode !== undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent data-testid="rewind-dialog" className="max-w-[min(30rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>回退到这条消息之前</DialogTitle>
          <DialogDescription>这条消息和它之后的内容会被撤掉。所有设备同步生效。</DialogDescription>
        </DialogHeader>

        <blockquote
          data-testid="rewind-dialog-text"
          className="bg-user-bubble line-clamp-3 rounded-[10px] px-3 py-2 text-[13px] whitespace-pre-wrap"
        >
          {text}
        </blockquote>

        {state.kind === 'loading' && (
          <p data-testid="rewind-dialog-loading" className="text-text-3 text-sm motion-safe:animate-pulse">
            正在读取文件快照…
          </p>
        )}
        {state.kind === 'error' && (
          <p data-testid="rewind-dialog-error" className="text-red text-sm">
            无法回退：{state.message}
          </p>
        )}

        {state.kind === 'ready' && (
          <div className="flex flex-col gap-3">
            <div role="radiogroup" aria-label="回退方式" className="flex flex-col gap-1.5">
              {choices.map((choice) => (
                <label
                  key={choice.mode}
                  data-testid={`rewind-mode-${choice.mode}`}
                  data-available={String(choice.available)}
                  className={cn(
                    'border-border flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2',
                    mode === choice.mode && 'border-brand bg-muted',
                    !choice.available && 'cursor-not-allowed opacity-55',
                  )}
                >
                  <input
                    type="radio"
                    name="rewind-mode"
                    className="mt-1"
                    checked={mode === choice.mode}
                    disabled={!choice.available || busy}
                    onChange={() => setMode(choice.mode)}
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[14px]">{choice.label}</span>
                    <span className="text-text-3 text-[12px]">{choice.available ? choice.hint : choice.reason}</span>
                  </span>
                </label>
              ))}
            </div>

            {summary !== undefined && (
              <div data-testid="rewind-dialog-files" className="text-text-2 flex flex-col gap-1 text-[12.5px]">
                <span>{summary}</span>
                {listed.length > 0 && (
                  <ul className="text-text-3 font-mono text-[11.5px]">
                    {listed.slice(0, MAX_FILES_LISTED).map((path) => (
                      <li key={path} className="truncate">
                        {path}
                      </li>
                    ))}
                    {listed.length > MAX_FILES_LISTED && <li>…等 {listed.length} 个</li>}
                  </ul>
                )}
              </div>
            )}

            <p className="text-text-3 text-[12px]">
              只能还原 Claude 用编辑工具改过的文件；Bash 命令和手工做的改动不会被还原。
            </p>
          </div>
        )}

        {failure !== null && (
          <p data-testid="rewind-dialog-failure" className="text-red text-sm">
            回退失败：{failure}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            type="button"
            data-testid="rewind-dialog-confirm"
            variant={mode !== undefined && rewindTouchesFiles(mode) ? 'destructive' : 'default'}
            disabled={!canConfirm}
            onClick={() => {
              if (mode === undefined) return;
              setBusy(true);
              setFailure(null);
              onConfirm(mode).then(
                () => setBusy(false),
                (err: unknown) => {
                  setBusy(false);
                  setFailure(err instanceof Error ? err.message : String(err));
                },
              );
            }}
          >
            {busy ? '回退中…' : '确认回退'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

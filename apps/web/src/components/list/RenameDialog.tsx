/**
 * 会话重命名对话框（session-list-v2 §4.4 / §4.6）。列表的「⋯ → 重命名」与
 * 聊天页的 `/rename`（无参数）共用。
 *
 * web 侧只 trim、判空；长度上限与去控制字符等权威规范化全在 agent（方案 §2，
 * 按**码点**截 200），广播回来的 title 以 agent 为准。这里不按 200 设
 * `maxLength`：它按 UTF-16 码元计，含 emoji 的标题会被提前截断（评审 minor 4）。
 *
 * 只设一个宽松的软上限 `RENAME_INPUT_SOFT_MAX`（码元，评审 S3）：防误粘贴一大段
 * 文本整段加密上送；200 个码点的 emoji 标题也才 400 码元，正常标题碰不到。
 * 超过 200 码点时提示「保存时只保留前 200 字」，截断仍由 agent 做。
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Input } from '@/components/ui/input.tsx';

/** 输入框软上限（UTF-16 码元）：只防误粘贴，权威上限是 agent 的 200 码点 */
export const RENAME_INPUT_SOFT_MAX = 400;
/** agent 截断标题的上限（码点，与 agent SESSION_TITLE_MAX 一致）——只用于提示 */
const TITLE_MAX_CODE_POINTS = 200;

export function RenameDialog({
  open,
  onOpenChange,
  initialTitle,
  busy = false,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTitle: string;
  busy?: boolean;
  onSubmit: (title: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(initialTitle);
  // 每次打开都从当前标题起步（对话框在列表级共享，换一行再开要换初值）
  useEffect(() => {
    if (open) setDraft(initialTitle);
  }, [open, initialTitle]);

  const title = draft.trim();
  const canSubmit = !busy && title !== '' && title !== initialTitle.trim();
  const overLong = [...title].length > TITLE_MAX_CODE_POINTS;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="rename-dialog" className="max-w-[min(28rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>重命名会话</DialogTitle>
          <DialogDescription>与本机 claude 的 /rename 同一份标题，所有设备可见。</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) onSubmit(title);
          }}
          className="flex flex-col gap-4"
        >
          <Input
            autoFocus
            data-testid="rename-dialog-input"
            aria-label="会话标题"
            value={draft}
            maxLength={RENAME_INPUT_SOFT_MAX}
            onChange={(e) => setDraft(e.target.value.slice(0, RENAME_INPUT_SOFT_MAX))}
          />
          {overLong && (
            <p data-testid="rename-dialog-too-long" className="text-text-3 -mt-2 text-xs">
              超过 {TITLE_MAX_CODE_POINTS} 字，保存时只保留前 {TITLE_MAX_CODE_POINTS} 字
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              取消
            </Button>
            <Button type="submit" data-testid="rename-dialog-confirm" disabled={!canSubmit}>
              {busy ? '处理中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

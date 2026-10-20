/**
 * prompt 片段面板：输入区工具栏上的 prompt 按钮打开，浮在输入区上方
 * （同 SlashMenu：软键盘从下面顶上来，下拉会被挡住）。
 *
 * 每条片段两个动作：点正文 = 插入输入框（光标处，规则见 snippet-model.ts），
 * 右侧按钮 = 复制到剪贴板。片段在设置页维护，这里只读。
 *
 * `onPointerDown` 里 preventDefault 与 SlashMenu 同理：点面板不让 textarea
 * 失焦，移动端软键盘不收、视口不跳。
 */
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { copyText } from '@/lib/clipboard.ts';
import { cn } from '@/lib/utils.ts';

export function SnippetPicker({
  snippets,
  onInsert,
  onManage,
  className,
}: {
  snippets: readonly string[];
  onInsert: (text: string) => void;
  /** 去设置页管理片段；不给 = 不显示入口 */
  onManage?: (() => void) | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <div
      data-testid="snippet-picker"
      role="dialog"
      aria-label="prompt 片段"
      className={cn(
        'border-border-strong bg-surface absolute inset-x-3 bottom-full z-30 mb-1.5',
        'flex max-h-[46vh] flex-col rounded-[14px] border shadow-[var(--shadow-card)]',
        className,
      )}
      onPointerDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <span className="text-text-3 text-[11px] tracking-[0.05em] uppercase">常用 prompt · 本设备</span>
        {onManage !== undefined && (
          <button
            type="button"
            data-testid="snippet-manage"
            className="text-brand-ink text-[12px] hover:underline"
            onClick={onManage}
          >
            管理
          </button>
        )}
      </div>
      <ul className="min-h-0 overflow-y-auto px-1.5 pb-1.5">
        {snippets.map((text, i) => (
          <SnippetRow key={`${i}:${text}`} text={text} onInsert={onInsert} />
        ))}
        {snippets.length === 0 && (
          <li className="text-text-3 px-2.5 py-3 text-[12.5px]" data-testid="snippet-empty">
            还没有片段。在设置里添加常用的 prompt，之后在这里一点就能插入。
          </li>
        )}
      </ul>
    </div>
  );
}

function SnippetRow({ text, onInsert }: { text: string; onInsert: (text: string) => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    copyText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => toast.error('复制失败：浏览器不允许写剪贴板'),
    );
  };
  return (
    <li className="hover:bg-surface-2 flex items-start gap-1 rounded-[9px]">
      <button
        type="button"
        data-testid="snippet-item"
        title="插入输入框"
        className="min-w-0 flex-1 px-2.5 py-2 text-left text-[13px] leading-[19px] break-words whitespace-pre-wrap line-clamp-3"
        onClick={() => onInsert(text)}
      >
        {text}
      </button>
      <button
        type="button"
        data-testid="snippet-copy"
        title="复制"
        aria-label="复制片段"
        className="text-text-3 hover:text-text mt-1 mr-1 flex size-7 shrink-0 items-center justify-center rounded-md"
        onClick={copy}
      >
        {copied ? <CheckIcon className="text-green size-3.5" /> : <CopyIcon className="size-3.5" />}
      </button>
    </li>
  );
}

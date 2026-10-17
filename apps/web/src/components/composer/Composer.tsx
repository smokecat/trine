/**
 * 输入区（原型 `.composer`）。
 *
 * ## 运行中照样能发（NOTES.chat 第 4 条）
 *
 * 不禁输入、不打断任务：运行中发送就是**排队**，回执可撤回，任务结束按序
 * 出队。所以发送按钮与停止按钮 ■ **并存**——一个是「再说一句」，一个是
 * 「别干了」，是两回事。
 *
 * ## 机器离线也能发
 *
 * 方案 A（排队发送）：消息以密文落服务端队列，agent 上线按序补发。
 * composer 里只给一行提示「将排队到 xx 上线」；离线横幅是外壳的事。
 *
 * ## 自增高
 *
 * textarea 高度跟内容走，最多 6 行——再高就把时间线挤没了，手机上尤其。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpIcon, SquareIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { SlashMenu } from './SlashMenu.tsx';
import {
  buildSlashMenu,
  flattenSlashGroups,
  moveSlashIndex,
  type SlashItem,
  type SlashSources,
} from './slash-model.ts';

/** 最多长到几行 */
const MAX_ROWS = 6;
const LINE_HEIGHT_PX = 21;
const VERTICAL_PADDING_PX = 17;

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  onSlashPick,
  running,
  offlineHint,
  sources,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /** 选中一条 slash 项：由 ChatView 决定它是开 sheet、发请求还是发文本 */
  onSlashPick: (item: SlashItem) => void;
  /** running / waiting_permission：显示停止按钮，发送变「排队」语义 */
  running: boolean;
  /** 机器离线时的提示文案；null = 在线 */
  offlineHint: string | null;
  sources: SlashSources;
}): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);

  const groups = menuDismissed || !value.startsWith('/') ? [] : buildSlashMenu(value, sources);
  const items = flattenSlashGroups(groups);
  const menuOpen = items.length > 0;

  // 文本变了就把选中项归零（过滤后的第一项才是最贴切的候选）
  useEffect(() => {
    setActiveIndex(0);
  }, [value]);

  // 不再以 `/` 开头时解除「已手动关闭」，下次打 `/` 菜单还能出来
  useEffect(() => {
    if (!value.startsWith('/')) setMenuDismissed(false);
  }, [value]);

  // 自增高：先归零再按 scrollHeight 设，否则删字时不会变矮
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    const max = MAX_ROWS * LINE_HEIGHT_PX + VERTICAL_PADDING_PX;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value]);

  const submit = (): void => {
    const text = value.trim();
    if (text === '') return;
    onSend(text);
  };

  // 填入类选中（项目命令 / 片段）后，等新文本渲染出来再把光标挪到末尾——
  // 直接接着打参数，不用先点一下定位
  const caretToEnd = useRef(false);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!caretToEnd.current || el === null) return;
    caretToEnd.current = false;
    el.setSelectionRange(value.length, value.length);
  }, [value]);

  const pick = (item: SlashItem): void => {
    // 关掉菜单：填入的文本仍以 `/` 开头，不关的话下一个回车又会被菜单吃掉
    setMenuDismissed(true);
    if (item.action.kind === 'fill') caretToEnd.current = true;
    onSlashPick(item);
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => moveSlashIndex(i, 1, items.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => moveSlashIndex(i, -1, items.length));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const item = items[activeIndex];
        if (item !== undefined) pick(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    // 输入法组合中的 Enter 是「选词」，不是「发送」
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="relative shrink-0">
      {menuOpen && <SlashMenu groups={groups} activeIndex={activeIndex} onPick={pick} />}
      {offlineHint !== null && (
        <div
          data-testid="composer-offline-hint"
          className="border-border bg-surface-2 text-text-3 border-t px-3.5 py-1 text-[11.5px]"
        >
          📮 {offlineHint}
        </div>
      )}
      <div className="border-border bg-background safe-bottom flex items-end gap-2 border-t px-3 py-2.5">
        <textarea
          ref={textareaRef}
          data-testid="composer"
          rows={1}
          className={cn(
            'border-border-strong bg-surface text-text flex-1 resize-none rounded-xl border',
            'min-h-[38px] px-3 py-2 text-[14px] leading-[21px]',
            'placeholder:text-text-3 focus-visible:border-brand-border outline-none',
          )}
          value={value}
          placeholder={
            running ? '运行中：发送即排队，任务结束后按序发出…' : '发消息，/ 呼出命令…'
          }
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {running && (
          <Button
            size="icon"
            variant="outline"
            data-testid="stop"
            title="停止当前任务"
            aria-label="停止当前任务"
            className="border-red text-red size-[38px]"
            onClick={onStop}
          >
            <SquareIcon className="size-3.5 fill-current" />
          </Button>
        )}
        <Button
          size="icon"
          data-testid="send"
          title={running ? '排队发送' : '发送'}
          aria-label={running ? '排队发送' : '发送'}
          className="size-[38px]"
          disabled={value.trim() === ''}
          onClick={submit}
        >
          <ArrowUpIcon />
        </Button>
      </div>
    </div>
  );
}

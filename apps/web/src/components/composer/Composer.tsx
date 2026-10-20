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
 *
 * ## 回车：换行还是发送
 *
 * 见 composer-keys.ts：触屏设备回车只换行、靠按钮发送；PC 按 prefs.sendKey。
 *
 * ## 附件
 *
 * 回形针选文件、在输入框里粘贴（剪贴板里的图片 / 文件）都交给 `attachments.onAdd`；
 * 拖拽到页面由 ChatView 处理（整页都是落点）。附件一加进来就开始上传，全部传完
 * 才能发送；只有附件没有文字也能发。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpIcon, PaperclipIcon, SquareIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { useMediaQuery } from '@/components/shell/use-media-query.ts';
import { cn } from '@/lib/utils.ts';
import type { DraftAttachment } from '@/lib/attachment-model.ts';
import { AttachmentStrip } from './AttachmentStrip.tsx';
import { IS_MAC, isSendKey, sendKeyLabel, TOUCH_QUERY, type SendKey } from './composer-keys.ts';
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

export interface ComposerAttachments {
  drafts: readonly DraftAttachment[];
  /** 全部传完且没有失败 */
  ready: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  /** 不能加附件的原因（agent 版本过旧等）；undefined = 可以 */
  disabledReason?: string | undefined;
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  onSlashPick,
  running,
  offlineHint,
  sources,
  sendKey,
  attachments,
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
  /** PC 上的发送键（prefs.sendKey）；触屏设备忽略 */
  sendKey: SendKey;
  /** 附件；不给 = 不显示附件入口 */
  attachments?: ComposerAttachments | undefined;
}): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const drafts = attachments?.drafts ?? [];
  const canAttach = attachments !== undefined && attachments.disabledReason === undefined;
  const canSend = (value.trim() !== '' || drafts.length > 0) && (attachments?.ready ?? true);
  const touch = useMediaQuery(TOUCH_QUERY);
  const keyHint = sendKeyLabel(sendKey, touch, IS_MAC);
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
    if (!canSend) return;
    onSend(value.trim());
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0 || attachments === undefined) return;
    // 剪贴板里有文件（截图、复制的图片 / 文件）：当附件收，不往输入框里贴文件名
    e.preventDefault();
    if (attachments.disabledReason !== undefined) {
      toast.error(attachments.disabledReason);
      return;
    }
    attachments.onAdd(files);
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
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
    // 不是发送键就什么都不做，textarea 自己插入换行
    const keyEvent = {
      key: e.key,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      isComposing: e.nativeEvent.isComposing,
      keyCode: e.keyCode,
    };
    if (isSendKey(keyEvent, sendKey, touch)) {
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
      {attachments !== undefined && (
        <AttachmentStrip drafts={drafts} onRemove={attachments.onRemove} onRetry={attachments.onRetry} />
      )}
      <div
        className={cn(
          'border-border bg-background safe-bottom flex items-end gap-2 px-3 py-2.5',
          drafts.length === 0 && 'border-t',
        )}
      >
        {attachments !== undefined && (
          <>
            <Button
              size="icon"
              variant="ghost"
              data-testid="attach"
              title={attachments.disabledReason ?? '添加图片或文件（也可以粘贴或拖到页面上）'}
              aria-label="添加附件"
              className="text-text-2 size-[38px]"
              disabled={!canAttach}
              onClick={() => fileInputRef.current?.click()}
            >
              <PaperclipIcon />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              data-testid="attach-input"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                // 清空：同一个文件删掉后还能再选
                e.target.value = '';
                if (files.length > 0) attachments.onAdd(files);
              }}
            />
          </>
        )}
        <textarea
          ref={textareaRef}
          data-testid="composer"
          rows={1}
          // 软键盘右下角显示「换行」而不是「发送 / 前往」
          enterKeyHint="enter"
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
          onPaste={onPaste}
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
          title={(running ? '排队发送' : '发送') + (keyHint === null ? '' : `（${keyHint}）`)}
          aria-label={running ? '排队发送' : '发送'}
          className="size-[38px]"
          disabled={!canSend}
          onClick={submit}
        >
          <ArrowUpIcon />
        </Button>
      </div>
    </div>
  );
}

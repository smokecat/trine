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
 * ## 两套布局（900px 断点，同 use-media-query.ts）
 *
 * - **PC**：一张圆角输入卡片（ChatGPT / Claude.ai 的做法）——上面 textarea，
 *   下面一行工具栏：左边附件、prompt 片段，右边停止 / 发送。卡片四周留白，
 *   不贴页面底边；整张卡片都是点击区，聚焦时描边变色。
 * - **移动端**：一行 `+ | 输入框 | 发送`。附件、prompt 收进「+」：点开在输入行
 *   上方展开一排按钮，选完或点外面自动收起，不跟输入框抢宽度。
 *
 * ## 附件
 *
 * 回形针（移动端「+」里的图片 / 文件）选文件、在输入框里粘贴（剪贴板里的图片 /
 * 文件）都交给 `attachments.onAdd`；拖拽到页面由 ChatView 处理（整页都是落点）。
 * 附件一加进来就开始上传，全部传完才能发送；只有附件没有文字也能发。
 *
 * ## prompt 片段
 *
 * 工具栏上的 prompt 按钮打开 SnippetPicker：点片段插入光标处，或单独复制。
 * 片段不再出现在「/」菜单里——那里只放命令。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowUpIcon,
  FileIcon,
  ImageIcon,
  MessageSquareQuoteIcon,
  PaperclipIcon,
  PlusIcon,
  SquareIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button.tsx';
import { useIsDesktop, useMediaQuery } from '@/components/shell/use-media-query.ts';
import { cn } from '@/lib/utils.ts';
import type { DraftAttachment } from '@/lib/attachment-model.ts';
import { AttachmentStrip } from './AttachmentStrip.tsx';
import { IS_MAC, isSendKey, sendKeyLabel, TOUCH_QUERY, type SendKey } from './composer-keys.ts';
import { SlashMenu } from './SlashMenu.tsx';
import { SnippetPicker } from './SnippetPicker.tsx';
import { insertSnippet } from './snippet-model.ts';
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
/** textarea 上下 padding + 边框：移动端 py-2 + 1px 边框；PC 卡片里 pt-3 pb-1、无边框 */
const VERTICAL_PADDING_PX = { mobile: 17, desktop: 16 } as const;

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
  snippets,
  onManageSnippets,
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
  /** 常用 prompt 片段（prefs.promptSnippets） */
  snippets: readonly string[];
  /** 片段面板里的「管理」：去设置页；不给 = 不显示 */
  onManageSnippets?: (() => void) | undefined;
  /** PC 上的发送键（prefs.sendKey）；触屏设备忽略 */
  sendKey: SendKey;
  /** 附件；不给 = 不显示附件入口 */
  attachments?: ComposerAttachments | undefined;
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const drafts = attachments?.drafts ?? [];
  const canAttach = attachments !== undefined && attachments.disabledReason === undefined;
  const canSend = (value.trim() !== '' || drafts.length > 0) && (attachments?.ready ?? true);
  const desktop = useIsDesktop();
  const touch = useMediaQuery(TOUCH_QUERY);
  const keyHint = sendKeyLabel(sendKey, touch, IS_MAC);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 移动端「+」托盘 */
  const [trayOpen, setTrayOpen] = useState(false);
  /** 失焦前的光标 / 选区：点工具栏按钮时 textarea 可能已失焦，插入片段要用它 */
  const lastSelection = useRef<{ start: number; end: number } | null>(null);

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

  // 片段面板 / 托盘：点输入区以外的地方收起
  useEffect(() => {
    if (!pickerOpen && !trayOpen) return;
    const onDown = (e: PointerEvent): void => {
      if (rootRef.current?.contains(e.target as Node) === true) return;
      setPickerOpen(false);
      setTrayOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [pickerOpen, trayOpen]);

  // 自增高：先归零再按 scrollHeight 设，否则删字时不会变矮
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    const max = MAX_ROWS * LINE_HEIGHT_PX + VERTICAL_PADDING_PX[desktop ? 'desktop' : 'mobile'];
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value, desktop]);

  const submit = (): void => {
    if (!canSend) return;
    setPickerOpen(false);
    setTrayOpen(false);
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

  // 填入 / 插入后，等新文本渲染出来再摆光标——直接接着打，不用先点一下定位。
  // 'end' = 文本末尾（slash 填入），数字 = 指定位置（片段插在中间时）
  const pendingCaret = useRef<number | 'end' | null>(null);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    const caret = pendingCaret.current;
    if (caret === null || el === null) return;
    pendingCaret.current = null;
    const at = caret === 'end' ? value.length : Math.min(caret, value.length);
    el.setSelectionRange(at, at);
  }, [value]);

  const pick = (item: SlashItem): void => {
    // 关掉菜单：填入的文本仍以 `/` 开头，不关的话下一个回车又会被菜单吃掉
    setMenuDismissed(true);
    if (item.action.kind === 'fill') pendingCaret.current = 'end';
    onSlashPick(item);
    textareaRef.current?.focus();
  };

  const insert = (snippet: string): void => {
    const el = textareaRef.current;
    const selection =
      el !== null && document.activeElement === el
        ? { start: el.selectionStart, end: el.selectionEnd }
        : lastSelection.current;
    const { text, caret } = insertSnippet(value, selection, snippet);
    pendingCaret.current = caret;
    setPickerOpen(false);
    setTrayOpen(false);
    onChange(text);
    el?.focus();
  };

  const togglePicker = (): void => {
    setTrayOpen(false);
    setPickerOpen((open) => !open);
  };

  const chooseFiles = (input: HTMLInputElement | null): void => {
    setTrayOpen(false);
    input?.click();
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
    if (e.key === 'Escape' && (pickerOpen || trayOpen)) {
      e.preventDefault();
      setPickerOpen(false);
      setTrayOpen(false);
      return;
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

  const fileInputs = attachments !== undefined && (
    <>
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
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="attach-image-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length > 0) attachments.onAdd(files);
        }}
      />
    </>
  );

  const textarea = (
    <textarea
      ref={textareaRef}
      data-testid="composer"
      rows={1}
      // 软键盘右下角显示「换行」而不是「发送 / 前往」
      enterKeyHint="enter"
      className={cn(
        'text-text resize-none text-[14px] leading-[21px] outline-none',
        'placeholder:text-text-3',
        desktop
          ? 'block w-full bg-transparent px-3.5 pt-3 pb-1'
          : cn(
              'border-border-strong bg-surface min-h-[38px] flex-1 rounded-xl border px-3 py-2',
              'focus-visible:border-brand-border',
            ),
      )}
      value={value}
      placeholder={running ? '运行中：发送即排队，任务结束后按序发出…' : '发消息，/ 呼出命令…'}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onBlur={(e) => {
        lastSelection.current = { start: e.target.selectionStart, end: e.target.selectionEnd };
      }}
    />
  );

  const stopButton = running && (
    <Button
      size="icon"
      variant="outline"
      data-testid="stop"
      title="停止当前任务"
      aria-label="停止当前任务"
      className={cn('border-red text-red dark:border-red', desktop ? 'size-8 rounded-full' : 'size-[38px]')}
      onClick={onStop}
    >
      <SquareIcon className="size-3.5 fill-current" />
    </Button>
  );

  const sendButton = (
    <Button
      size="icon"
      data-testid="send"
      title={(running ? '排队发送' : '发送') + (keyHint === null ? '' : `（${keyHint}）`)}
      aria-label={running ? '排队发送' : '发送'}
      className={desktop ? 'size-8 rounded-full' : 'size-[38px]'}
      disabled={!canSend}
      onClick={submit}
    >
      <ArrowUpIcon />
    </Button>
  );

  const offline = offlineHint !== null && (
    <div
      data-testid="composer-offline-hint"
      className={cn(
        'text-text-3 text-[11.5px]',
        desktop ? 'px-1 pb-1.5' : 'border-border bg-surface-2 border-t px-3.5 py-1',
      )}
    >
      📮 {offlineHint}
    </div>
  );

  const panels = (
    <>
      {menuOpen && <SlashMenu groups={groups} activeIndex={activeIndex} onPick={pick} />}
      {!menuOpen && pickerOpen && (
        <SnippetPicker
          className={desktop ? 'inset-x-4' : undefined}
          snippets={snippets}
          onInsert={insert}
          onManage={
            onManageSnippets === undefined
              ? undefined
              : () => {
                  setPickerOpen(false);
                  onManageSnippets();
                }
          }
        />
      )}
    </>
  );

  if (desktop) {
    return (
      <div
        ref={rootRef}
        className="bg-background relative shrink-0 px-4 pt-1 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        {panels}
        {offline}
        <div
          data-testid="composer-card"
          className={cn(
            'border-border-strong bg-surface rounded-2xl border shadow-[var(--shadow-card)]',
            'focus-within:border-brand-border cursor-text transition-colors',
          )}
          // 点卡片空白处（工具栏间隙）也聚焦输入框
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) {
              e.preventDefault();
              textareaRef.current?.focus();
            }
          }}
        >
          {attachments !== undefined && (
            <AttachmentStrip
              drafts={drafts}
              onRemove={attachments.onRemove}
              onRetry={attachments.onRetry}
              className="border-t-0 bg-transparent px-3 pt-3"
            />
          )}
          {textarea}
          <div className="flex items-center gap-0.5 px-2 pb-2" data-testid="composer-toolbar">
            {attachments !== undefined && (
              <Button
                size="icon"
                variant="ghost"
                data-testid="attach"
                title={attachments.disabledReason ?? '添加图片或文件（也可以粘贴或拖到页面上）'}
                aria-label="添加附件"
                className="text-text-2 size-8"
                disabled={!canAttach}
                onClick={() => chooseFiles(fileInputRef.current)}
              >
                <PaperclipIcon />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              data-testid="snippet-toggle"
              title="插入常用 prompt"
              aria-label="常用 prompt"
              aria-expanded={pickerOpen}
              className={cn('text-text-2 size-8', pickerOpen && 'bg-surface-2 text-text')}
              onPointerDown={(e) => e.preventDefault()}
              onClick={togglePicker}
            >
              <MessageSquareQuoteIcon />
            </Button>
            {fileInputs}
            <span className="flex-1" />
            {keyHint !== null && (
              <span className="text-text-3 mr-1.5 text-[11px] select-none">{keyHint}</span>
            )}
            <div className="flex items-center gap-1.5">
              {stopButton}
              {sendButton}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      {panels}
      {offline}
      {attachments !== undefined && (
        <AttachmentStrip drafts={drafts} onRemove={attachments.onRemove} onRetry={attachments.onRetry} />
      )}
      <div
        className={cn(
          'border-border bg-background pb-[max(0.625rem,env(safe-area-inset-bottom))]',
          drafts.length === 0 && 'border-t',
        )}
      >
        {/* 「+」托盘：grid 0fr ⇄ 1fr 做高度过渡；收起时 inert，不进 Tab 序列 */}
        <div
          data-testid="composer-tray"
          data-open={String(trayOpen)}
          inert={!trayOpen}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease-out',
            trayOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="flex gap-2 overflow-x-auto px-3 pt-2.5" onPointerDown={(e) => e.preventDefault()}>
              {attachments !== undefined && (
                <>
                  <TrayButton
                    testId="attach-image"
                    icon={<ImageIcon />}
                    label="图片"
                    disabled={!canAttach}
                    onClick={() => chooseFiles(imageInputRef.current)}
                  />
                  <TrayButton
                    testId="attach"
                    icon={<FileIcon />}
                    label="文件"
                    disabled={!canAttach}
                    onClick={() => chooseFiles(fileInputRef.current)}
                  />
                </>
              )}
              <TrayButton
                testId="snippet-toggle"
                icon={<MessageSquareQuoteIcon />}
                label="Prompt"
                onClick={togglePicker}
              />
            </div>
            {attachments?.disabledReason !== undefined && (
              <p className="text-text-3 px-3.5 pt-1.5 text-[11.5px]">{attachments.disabledReason}</p>
            )}
          </div>
        </div>
        <div className="flex items-end gap-2 px-3 pt-2.5">
          <Button
            size="icon"
            variant="ghost"
            data-testid="composer-more"
            aria-label={trayOpen ? '收起' : '更多：图片、文件、prompt'}
            aria-expanded={trayOpen}
            className={cn('text-text-2 size-[38px] shrink-0', (trayOpen || pickerOpen) && 'text-text')}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              setPickerOpen(false);
              setTrayOpen((open) => !open);
            }}
          >
            <PlusIcon className={cn('transition-transform duration-200', trayOpen && 'rotate-45')} />
          </Button>
          {fileInputs}
          {textarea}
          {stopButton}
          {sendButton}
        </div>
      </div>
    </div>
  );
}

function TrayButton({
  testId,
  icon,
  label,
  disabled = false,
  onClick,
}: {
  testId: string;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      className={cn(
        'border-border bg-surface text-text-2 flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5',
        'text-[13px] [&_svg]:size-4',
        'active:bg-surface-2 disabled:opacity-50',
      )}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

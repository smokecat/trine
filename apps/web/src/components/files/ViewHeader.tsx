/**
 * 文件视图的头部（标题、说明、操作按钮）。与容器无关：抽屉把 SheetTitle / SheetDescription
 * 作为 `chrome.Title` / `chrome.Description` 传进来提供 Dialog 语义；工作区 tab 用默认的 h2 / div。
 */
import { ArrowLeftIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';

type Slot = React.ElementType<{ className?: string; children?: React.ReactNode }>;

/** 外壳给视图的「外框」：标题 / 说明用什么元素，有没有关闭按钮 */
export interface FileViewChrome {
  Title?: Slot;
  Description?: Slot;
  /** 给了才显示关闭按钮 */
  onClose?: () => void;
}

export function ViewHeader({
  chrome,
  title,
  description,
  children,
  onBack,
  backTitle,
}: {
  chrome: FileViewChrome | undefined;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  onBack?: (() => void) | undefined;
  backTitle?: string | undefined;
}): React.JSX.Element {
  const Title: Slot = chrome?.Title ?? 'h2';
  const Description: Slot = chrome?.Description ?? 'div';
  const onClose = chrome?.onClose;
  return (
    <div className="border-border flex shrink-0 flex-wrap items-start gap-x-2 gap-y-1 border-b px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
      {onBack !== undefined && (
        <Button size="icon-sm" variant="ghost" aria-label={backTitle} title={backTitle} onClick={onBack} data-testid="file-panel-up">
          <ArrowLeftIcon />
        </Button>
      )}
      <div className="min-w-0 flex-1 pt-0.5">
        <Title className="truncate text-[14px] font-semibold">{title}</Title>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {children}
        {onClose !== undefined && (
          <Button size="icon-sm" variant="ghost" aria-label="关闭" title="关闭" onClick={onClose} data-testid="file-panel-close">
            <XIcon />
          </Button>
        )}
      </div>
      <Description className="text-text-3 min-w-0 basis-full text-[12px]">{description}</Description>
    </div>
  );
}

export function ErrorBox({
  message,
  onRetry,
  onBrowseParent,
}: {
  message: string;
  onRetry: () => void;
  /** 文件在范围外：去所在目录（那里有信任流程，由用户决定要不要信任） */
  onBrowseParent?: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <div data-testid="file-error" className="flex flex-col items-center gap-3 p-10 text-center text-[13px]">
      <div className="text-red">{message}</div>
      <div className="flex flex-wrap justify-center gap-2">
        {onBrowseParent !== undefined && (
          <Button size="sm" data-testid="file-browse-parent" onClick={onBrowseParent}>
            浏览所在目录
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onRetry}>
          重试
        </Button>
      </div>
    </div>
  );
}

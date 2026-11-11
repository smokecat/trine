/**
 * 文件抽屉：桌面右侧宽抽屉、手机全屏。两种视图——目录（FileDirView）与文件（FileDocView）——
 * 由调用方（聊天页，经 URL 查询参数）决定；视图本身与容器无关（工作区 tab 也用），
 * 这里只提供 Dialog 外壳（SheetTitle / SheetDescription）与视图的内容状态。
 *
 * 加载经 client.listFiles / client.openFile（agent 读、加密上传 blob、这里解密）。
 * 同一文件第二次打开用缓存，「刷新」重新向 agent 要。
 */
import { useState } from 'react';
import { cn } from '@/lib/utils.ts';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet.tsx';
import { useIsDesktop } from '@/components/shell/use-media-query.ts';
import { FileDirView } from './FileDirView.tsx';
import { FileDocView } from './FileDocView.tsx';
import { useFileLinks, type FileOpenTarget } from './file-links.ts';
import type { FileViewChrome } from './ViewHeader.tsx';
import { DEFAULT_DIR_MODEL, DEFAULT_DOC_MODEL, type FileDirModel, type FileDocModel } from './view-model.ts';

export { fileErrorText } from './use-file-load.ts';

/** 抽屉当前显示什么；`fragment` 是打开文件后要定位的锚点（不进 URL 查询参数） */
export type FileView = { kind: 'dir'; path?: string } | { kind: 'file'; path: string; fragment?: string };

/** 抽屉的标题 / 说明：用 Sheet 的，提供 Dialog 的可访问名称与描述 */
function DrawerTitle({ className, children }: { className?: string; children?: React.ReactNode }): React.JSX.Element {
  return <SheetTitle className={className}>{children}</SheetTitle>;
}

function DrawerDescription({ className, children }: { className?: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <SheetDescription asChild>
      <div className={className}>{children}</div>
    </SheetDescription>
  );
}

export function FilePanel({
  machineId,
  sessionId,
  view,
  onNavigate,
  onClose,
}: {
  machineId: string;
  sessionId: string;
  /** null = 关闭 */
  view: FileView | null;
  onNavigate: (view: FileView) => void;
  onClose: () => void;
}): React.JSX.Element {
  const desktop = useIsDesktop();
  const chrome: FileViewChrome = { Title: DrawerTitle, Description: DrawerDescription, onClose };
  const links = useFileLinks();
  // 抽屉内普通点击就地导航（push 历史）；显式 side（Alt+点击）走完整打开 intent，由路由决定去处
  const browse = (dir?: string, target?: FileOpenTarget): void => {
    if (target === 'side' && links !== null) links.open(dir === undefined ? { dir: true, target } : { dir: true, path: dir, target });
    else onNavigate(dir === undefined ? { kind: 'dir' } : { kind: 'dir', path: dir });
  };
  const openFile = (path: string, target: FileOpenTarget): void => {
    if (target === 'side' && links !== null) links.open({ path, target });
    else onNavigate({ kind: 'file', path });
  };
  return (
    <Sheet open={view !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        data-testid="file-panel"
        // Sheet 自带 data-[side=right]:w-3/4 / sm:max-w-sm，要用同样的 data 变体才压得住
        className={cn(
          'gap-0',
          desktop
            ? 'data-[side=right]:w-[min(56rem,92vw)] data-[side=right]:sm:max-w-none'
            : 'data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:border-l-0 data-[side=right]:sm:max-w-none',
        )}
      >
        {view?.kind === 'file' && (
          <DrawerDoc
            // 换文件或换锚点都重挂：每次打开从头定位（内容走缓存，不会重新下载）
            key={`${view.path}#${view.fragment ?? ''}`}
            machineId={machineId}
            sessionId={sessionId}
            path={view.path}
            fragment={view.fragment}
            onBrowse={browse}
            chrome={chrome}
          />
        )}
        {view?.kind === 'dir' && (
          <DrawerDir
            key={view.path ?? ''}
            machineId={machineId}
            sessionId={sessionId}
            path={view.path}
            onBrowse={browse}
            onOpenFile={openFile}
            chrome={chrome}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

/** 抽屉里的内容状态只活在组件里：关掉 / 换文件就丢（工作区 tab 才持久化） */
function DrawerDoc({
  fragment,
  ...props
}: Omit<React.ComponentProps<typeof FileDocView>, 'model' | 'onModelChange' | 'fragment'> & { fragment: string | undefined }): React.JSX.Element {
  const [model, setModel] = useState<FileDocModel>(DEFAULT_DOC_MODEL);
  return (
    <FileDocView
      {...props}
      {...(fragment === undefined ? {} : { fragment })}
      model={model}
      onModelChange={(patch) => setModel((m) => ({ ...m, ...patch }))}
    />
  );
}

function DrawerDir(props: Omit<React.ComponentProps<typeof FileDirView>, 'model' | 'onModelChange'>): React.JSX.Element {
  const [model, setModel] = useState<FileDirModel>(DEFAULT_DIR_MODEL);
  return <FileDirView {...props} model={model} onModelChange={(patch) => setModel((m) => ({ ...m, ...patch }))} />;
}

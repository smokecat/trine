/**
 * 文件抽屉：桌面右侧宽抽屉、手机全屏。两种视图——目录（FileDirView）与文件（FileDocView）——
 * 由调用方（聊天页，经 URL 查询参数）决定；视图本身与容器无关（工作区 tab 也用），
 * 这里只提供 Dialog 外壳（SheetTitle / SheetDescription）与视图的内容状态。
 *
 * 加载经 client.listFiles / client.openFile（agent 读、加密上传 blob、这里解密）。
 * 同一文件第二次打开用缓存，「刷新」重新向 agent 要。
 */
import { useState } from 'react';
import { useLocation } from 'react-router';
import { PanelRightOpenIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { lastInputWasPointer } from '@/lib/input-modality.ts';
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

/** 抽屉交给工作区的内容：当前视图 + 内容状态（模式、换行、滚动） */
export interface DrawerHandoff {
  view: FileView;
  state: Partial<FileDocModel> & Partial<FileDirModel>;
}

export function FilePanel({
  machineId,
  sessionId,
  view,
  onNavigate,
  onClose,
  onHandoff,
}: {
  machineId: string;
  sessionId: string;
  /** null = 关闭 */
  view: FileView | null;
  onNavigate: (view: FileView) => void;
  onClose: () => void;
  /** 「在工作区打开」（桌面且工作区可用时给） */
  onHandoff?: ((handoff: DrawerHandoff) => void) | undefined;
}): React.JSX.Element {
  const desktop = useIsDesktop();
  const location = useLocation();
  const stateKey = view === null ? '' : `${machineId}|${sessionId}|${location.key}|${view.kind}|${view.path ?? ''}`;
  const chrome: FileViewChrome = {
    Title: DrawerTitle,
    Description: DrawerDescription,
    onClose,
    ...(onHandoff === undefined || view === null
      ? {}
      : {
          actions: (
            <Button
              size="icon-sm"
              variant="ghost"
              data-testid="file-to-workspace"
              aria-label="在工作区打开"
              title="在工作区打开（保留为 tab，可与聊天并排）"
              // 点的这一刻抓内容状态：滚动停下才上报，这里直接读抽屉的记忆
              onClick={() => onHandoff({ view, state: { ...(drawerState.get(stateKey) ?? {}) } })}
            >
              <PanelRightOpenIcon />
            </Button>
          ),
        }),
  };
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
        // 指针打开：焦点落在抽屉容器上（不给第一个按钮套焦点框）；键盘打开：沿用默认（第一个可聚焦元素）
        onOpenAutoFocus={(e) => {
          if (!lastInputWasPointer()) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        // Sheet 自带 data-[side=right]:w-3/4 / sm:max-w-sm，要用同样的 data 变体才压得住
        className={cn(
          'gap-0 outline-none',
          desktop
            ? 'data-[side=right]:w-[min(56rem,92vw)] data-[side=right]:sm:max-w-none'
            : 'data-[side=right]:w-full data-[side=right]:max-w-none data-[side=right]:border-l-0 data-[side=right]:sm:max-w-none',
        )}
      >
        {view?.kind === 'file' && (
          <DrawerDoc
            // 换文件或换锚点都重挂：每次打开从头定位（内容走缓存，不会重新下载）
            key={`${view.path}#${view.fragment ?? ''}`}
            cacheKey={`${machineId}|${sessionId}|${location.key}|file|${view.path}`}
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
            cacheKey={`${machineId}|${sessionId}|${location.key}|dir|${view.path ?? ''}`}
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

/**
 * 抽屉的内容状态（模式、换行、滚动）按「历史条目 + 视图」记在内存里：
 * 外壳在 900px 断点切换桌面 / 手机布局时整个聊天页（连同抽屉）会重挂，没有这层记忆滚动位置就归零；
 * 返回到某条历史时也回到当时的位置。只存小字段，不存内容；不持久化（刷新页面即清空）。
 */
const DRAWER_STATE_MAX = 40;
const drawerState = new Map<string, FileDocModel | FileDirModel>();

function rememberDrawer(key: string, model: FileDocModel | FileDirModel): void {
  drawerState.delete(key);
  drawerState.set(key, model);
  while (drawerState.size > DRAWER_STATE_MAX) drawerState.delete(drawerState.keys().next().value!);
}

/** 测试用：清空抽屉的内容状态记忆 */
export function resetDrawerState(): void {
  drawerState.clear();
}

function useDrawerModel<T extends FileDocModel | FileDirModel>(cacheKey: string, initial: T): [T, (patch: Partial<T>) => void, boolean] {
  const [restored] = useState(() => drawerState.has(cacheKey));
  const [model, setModel] = useState<T>(() => (drawerState.get(cacheKey) as T | undefined) ?? initial);
  const update = (patch: Partial<T>): void => {
    // 卸载时视图还会补报最后的滚动位置：直接写进记忆，不依赖 setState
    const next = { ...((drawerState.get(cacheKey) as T | undefined) ?? model), ...patch };
    rememberDrawer(cacheKey, next);
    setModel(next);
  };
  return [model, update, restored];
}

function DrawerDoc({
  fragment,
  cacheKey,
  ...props
}: Omit<React.ComponentProps<typeof FileDocView>, 'model' | 'onModelChange' | 'fragment'> & { fragment: string | undefined; cacheKey: string }): React.JSX.Element {
  const [model, update, restored] = useDrawerModel<FileDocModel>(cacheKey, DEFAULT_DOC_MODEL);
  // 重挂回来的（同一条历史）：回到当时的位置，不再按锚点重新跳
  const effectiveFragment = restored ? undefined : fragment;
  return <FileDocView {...props} {...(effectiveFragment === undefined ? {} : { fragment: effectiveFragment })} model={model} onModelChange={update} />;
}

function DrawerDir({ cacheKey, ...props }: Omit<React.ComponentProps<typeof FileDirView>, 'model' | 'onModelChange'> & { cacheKey: string }): React.JSX.Element {
  const [model, update] = useDrawerModel<FileDirModel>(cacheKey, DEFAULT_DIR_MODEL);
  return <FileDirView {...props} model={model} onModelChange={update} />;
}

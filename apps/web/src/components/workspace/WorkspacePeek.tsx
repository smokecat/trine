/**
 * 桌面窄窗口：工作区自动收起成「文件（N）」，点开以抽屉形式显示当前活动 tab，顶部附已打开列表。
 *
 * - 打开时 push 一条历史（location.state.wsPeek），返回键 / 关闭按钮把它退掉；抽屉内切换 tab、
 *   进目录、点文件都只在抽屉里就地切换，不写历史、不改工作区布局。
 * - tab 本身的内容状态（模式、换行、滚动）与工作区共用 view store，宽度恢复后回到工作区照样接上。
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { FileTextIcon, FolderIcon } from 'lucide-react';
import { lastInputWasPointer } from '@/lib/input-modality.ts';
import { cn } from '@/lib/utils.ts';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet.tsx';
import { FileDirView } from '@/components/files/FileDirView.tsx';
import { FileDocView } from '@/components/files/FileDocView.tsx';
import type { FileViewChrome } from '@/components/files/ViewHeader.tsx';
import { FileLinksContext, type FileLinks } from '@/components/files/file-links.ts';
import { DEFAULT_DIR_MODEL, DEFAULT_DOC_MODEL, type FileDirModel, type FileDocModel } from '@/components/files/view-model.ts';
import { tabTitle, type TabMeta } from './workspace-model.ts';
import type { WorkspaceViewStore } from './workspace-store.ts';
import { useViewGeneration } from './use-view-generation.ts';

/** 窄屏抽屉的开关在 location.state 里：push 一条，返回即关 */
export function useWorkspacePeekRoute(): { open: boolean; show: () => void; close: () => void } {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as { wsPeek?: unknown } | null;
  const open = state?.wsPeek === true;
  const show = useCallback(() => {
    if (open) return;
    navigate({ pathname: location.pathname, search: location.search }, { state: { ...((location.state as Record<string, unknown> | null) ?? {}), wsPeek: true } });
  }, [open, navigate, location.pathname, location.search, location.state]);
  const close = useCallback(() => {
    if (!open) return;
    // 历史里上一条就是打开前；刷新后同一条历史也还带着标记，同样退回去
    if (location.key !== 'default') {
      navigate(-1);
      return;
    }
    const { wsPeek: _p, ...rest } = (location.state as Record<string, unknown> | null) ?? {};
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: rest });
  }, [open, navigate, location.key, location.pathname, location.search, location.state]);
  return { open, show, close };
}

/** 同一文件反复带锚点打开时让视图重挂 */
let peekNonce = 0;

type LocalView ={ kind: 'dir'; path: string } | { kind: 'file'; path: string; fragment?: string; nonce?: number };

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

/**
 * 抽屉里的一个视图实例（换 tab / 就地导航即重挂）：显示 tab 时订阅与工作区共用的 view store，
 * 并以自己的实例代次写入（旧实例卸载时的补报写不进来）
 */
function PeekBody({
  shown,
  tabId,
  view,
  localModel,
  setLocalModel,
  goLocal,
  machineId,
  sessionId,
  chrome,
}: {
  shown: LocalView;
  tabId: string | undefined;
  view: WorkspaceViewStore;
  localModel: FileDocModel | FileDirModel;
  setLocalModel: React.Dispatch<React.SetStateAction<FileDocModel | FileDirModel>>;
  goLocal: (v: LocalView) => void;
  machineId: string;
  sessionId: string;
  chrome: FileViewChrome;
}): React.JSX.Element {
  const gen = useViewGeneration(view, tabId);
  const stored = useSyncExternalStore(view.subscribe, () => (tabId === undefined ? undefined : view.get(tabId)));
  const modelOf = <T extends FileDocModel | FileDirModel>(base: T): T => (tabId === undefined ? (localModel as T) : ({ ...base, ...stored } as T));
  const onModelChange = (patch: Partial<FileDocModel & FileDirModel>): void => {
    if (tabId !== undefined) view.patch(tabId, patch, gen.current);
    else setLocalModel((m) => ({ ...m, ...patch }));
  };
  if (shown.kind === 'file') {
    return (
      <FileDocView
        machineId={machineId}
        sessionId={sessionId}
        path={shown.path}
        {...(shown.fragment === undefined ? {} : { fragment: shown.fragment })}
        model={modelOf(DEFAULT_DOC_MODEL)}
        onModelChange={onModelChange}
        onBrowse={(dir) => goLocal({ kind: 'dir', path: dir ?? '' })}
        chrome={chrome}
      />
    );
  }
  return (
    <FileDirView
      machineId={machineId}
      sessionId={sessionId}
      path={shown.path === '' ? undefined : shown.path}
      model={modelOf(DEFAULT_DIR_MODEL)}
      onModelChange={onModelChange}
      onBrowse={(dir) => goLocal({ kind: 'dir', path: dir ?? '' })}
      onOpenFile={(path) => goLocal({ kind: 'file', path })}
      chrome={chrome}
    />
  );
}

export function WorkspacePeek({
  open,
  onClose,
  machineId,
  sessionId,
  tabs,
  active,
  view,
}: {
  open: boolean;
  onClose: () => void;
  machineId: string;
  sessionId: string;
  tabs: readonly TabMeta[];
  active: string | undefined;
  view: WorkspaceViewStore;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  /** 抽屉内就地导航到的目录 / 文件（不是 tab）；null = 显示选中的 tab */
  const [local, setLocal] = useState<LocalView | null>(null);
  const [localModel, setLocalModel] = useState<FileDocModel | FileDirModel>(DEFAULT_DOC_MODEL);
  const tab = tabs.find((t) => t.id === (selected ?? active)) ?? tabs[0];
  const chrome: FileViewChrome = { Title: DrawerTitle, Description: DrawerDescription, onClose };
  const goLocal = useCallback((v: LocalView): void => {
    setLocal(v);
    setLocalModel(v.kind === 'file' ? DEFAULT_DOC_MODEL : DEFAULT_DIR_MODEL);
  }, []);
  const shown: LocalView | undefined = local ?? (tab === undefined ? undefined : { kind: tab.kind, path: tab.path });
  const tabId = local === null ? tab?.id : undefined;
  // 正文里的文件链接 / 图片：在抽屉里就地切换（带锚点），不再叠一层文件抽屉、不写历史
  const links = useMemo<FileLinks>(
    () => ({
      sideAvailable: false,
      open: (intent) => {
        if (intent.dir === true) goLocal({ kind: 'dir', path: intent.path ?? '' });
        else goLocal(intent.fragment === undefined || intent.fragment === '' ? { kind: 'file', path: intent.path } : { kind: 'file', path: intent.path, fragment: intent.fragment, nonce: ++peekNonce });
      },
    }),
    [goLocal],
  );
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        data-testid="ws-peek"
        onOpenAutoFocus={(e) => {
          if (!lastInputWasPointer()) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        className="gap-0 outline-none data-[side=right]:w-[min(56rem,92vw)] data-[side=right]:sm:max-w-none"
      >
        <div role="tablist" aria-label="已打开的文件" className="border-border bg-surface-2 flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1.5">
          {tabs.map((t) => {
            const on = local === null && t.id === tab?.id;
            const Icon = t.kind === 'dir' ? FolderIcon : FileTextIcon;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={on}
                data-testid="ws-peek-tab"
                data-tab={t.id}
                title={t.kind === 'dir' && t.path === '' ? '会话目录' : t.path}
                onClick={() => {
                  setSelected(t.id);
                  setLocal(null);
                }}
                className={cn(
                  'flex max-w-[12rem] shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px]',
                  on ? 'bg-surface text-text shadow-sm' : 'text-text-2 hover:text-text',
                  t.preview && 'italic',
                )}
              >
                <Icon aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">{tabTitle(t)}</span>
              </button>
            );
          })}
        </div>
        <FileLinksContext.Provider value={links}>
          {shown !== undefined && (
            <PeekBody
              key={`${tabId ?? 'local'}|${shown.kind}|${shown.path}|${shown.kind === 'file' ? (shown.nonce ?? 0) : 0}`}
              shown={shown}
              tabId={tabId}
              view={view}
              localModel={localModel}
              setLocalModel={setLocalModel}
              goLocal={goLocal}
              machineId={machineId}
              sessionId={sessionId}
              chrome={chrome}
            />
          )}
        </FileLinksContext.Provider>
      </SheetContent>
    </Sheet>
  );
}

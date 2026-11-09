/**
 * 文件面板：桌面右侧宽抽屉、手机全屏。两种视图——目录（FileList）与文件（FileBody）——
 * 由调用方（聊天页，经 URL 查询参数）决定，面板只负责加载与渲染。
 *
 * 加载经 client.listFiles / client.openFile（agent 读、加密上传 blob、这里解密）。
 * 同一文件第二次打开用缓存，「刷新」重新向 agent 要。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeftIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FolderOpenIcon,
  RefreshCwIcon,
  WrapTextIcon,
  XIcon,
} from 'lucide-react';
import { useClient } from '@/app/runtime.ts';
import { FsRequestError, RequestTimeoutError, type FsListing, type OpenedFile } from '@/lib/client.ts';
import { formatBytes, formatDateTime } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet.tsx';
import { useIsDesktop } from '@/components/shell/use-media-query.ts';
import { Breadcrumbs, FileList } from './FileBrowser.tsx';
import { FileBody } from './FileViewer.tsx';
import { parentDir } from './file-model.ts';
import { LocationMenu, OutOfScopeNotice, TrustDirDialog, useFilesInfo } from './TrustDir.tsx';

/** 范围外（可以去信任）：新 agent 带 reason，旧 agent 的 denied 只能看 message 猜，按范围外处理 */
function isOutOfScope(err: unknown): boolean {
  if (!(err instanceof FsRequestError) || err.code !== 'denied') return false;
  return err.reason === undefined ? err.message.includes('范围') : err.reason === 'out_of_scope';
}

/**
 * 点开头的条目默认显示：`.local`、`.claude` 这类目录正是在 trine 里常看的；
 * 用户关掉后记在本设备（localStorage），下次打开沿用。
 */
const SHOW_HIDDEN_KEY = 'trine.files.showHidden';

function readShowHidden(): boolean {
  try {
    return globalThis.localStorage?.getItem(SHOW_HIDDEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeShowHidden(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(SHOW_HIDDEN_KEY, value ? '1' : '0');
  } catch {
    // 隐私模式等写不了：只影响下次的默认值
  }
}

export type FileView = { kind: 'dir'; path?: string } | { kind: 'file'; path: string };

type Load<T> = { state: 'loading' } | { state: 'ok'; value: T } | { state: 'error'; message: string; error: unknown };

/** 错误给人看的话：agent 的原话已经是中文，补上该怎么办 */
export function fileErrorText(err: unknown): string {
  if (err instanceof FsRequestError) {
    if (err.code === 'unavailable') return `${err.message}（agent 设置了 TRINE_FILES=off，或还没连上 relay）`;
    return err.message;
  }
  if (err instanceof RequestTimeoutError) return 'agent 没有应答（可能离线或版本过旧）';
  return err instanceof Error ? err.message : String(err);
}

/** 按 deps 加载；reload() 强制再跑一次（「刷新」由调用方在 fn 里决定要不要绕过缓存） */
function useLoad<T>(fn: (() => Promise<T>) | null, deps: readonly unknown[]): [Load<T>, () => void] {
  const [load, setLoad] = useState<Load<T>>({ state: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (fn === null) return;
    let alive = true;
    setLoad({ state: 'loading' });
    fn().then(
      (value) => alive && setLoad({ state: 'ok', value }),
      (err: unknown) => alive && setLoad({ state: 'error', message: fileErrorText(err), error: err }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fn 每次渲染都是新的，按 deps 与 tick 触发
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return [load, reload];
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
          <FilePane key={view.path} machineId={machineId} sessionId={sessionId} path={view.path} onNavigate={onNavigate} onClose={onClose} />
        )}
        {view?.kind === 'dir' && (
          <DirPane key={view.path ?? ''} machineId={machineId} sessionId={sessionId} path={view.path} onNavigate={onNavigate} onClose={onClose} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function PanelHeader({
  title,
  description,
  children,
  onBack,
  backTitle,
  onClose,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  onBack?: () => void;
  backTitle?: string;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="border-border flex shrink-0 items-start gap-2 border-b px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
      {onBack !== undefined && (
        <Button size="icon-sm" variant="ghost" aria-label={backTitle} title={backTitle} onClick={onBack} data-testid="file-panel-up">
          <ArrowLeftIcon />
        </Button>
      )}
      <div className="min-w-0 flex-1 pt-0.5">
        <SheetTitle className="truncate text-[14px] font-semibold">{title}</SheetTitle>
        <SheetDescription asChild>
          <div className="text-text-3 mt-0.5 text-[12px]">{description}</div>
        </SheetDescription>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {children}
        <Button size="icon-sm" variant="ghost" aria-label="关闭" title="关闭" onClick={onClose} data-testid="file-panel-close">
          <XIcon />
        </Button>
      </div>
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div data-testid="file-error" className="flex flex-col items-center gap-3 p-10 text-center text-[13px]">
      <div className="text-red">{message}</div>
      <Button size="sm" variant="outline" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

function FilePane({
  machineId,
  sessionId,
  path,
  onNavigate,
  onClose,
}: {
  machineId: string;
  sessionId: string;
  path: string;
  onNavigate: (view: FileView) => void;
  onClose: () => void;
}): React.JSX.Element {
  const client = useClient();
  const [refresh, setRefresh] = useState(false);
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');
  const [wrap, setWrap] = useState(false);
  const [load, reload] = useLoad<OpenedFile>(
    client === null ? null : () => client.openFile(machineId, sessionId, path, { refresh }),
    [client, machineId, sessionId, path],
  );
  const opened = load.state === 'ok' ? load.value : undefined;
  const file = opened?.file;
  const doRefresh = (): void => {
    setRefresh(true);
    reload();
  };
  return (
    <>
      <PanelHeader
        title={file?.name ?? path.slice(path.lastIndexOf('/') + 1)}
        description={
          file === undefined ? (
            <span className="font-mono break-all">{path}</span>
          ) : (
            <span className="flex flex-col gap-0.5">
              <Breadcrumbs path={parentDir(file.path)} root={file.root} onBrowse={(dir) => onNavigate({ kind: 'dir', path: dir })} />
              <span>
                {formatBytes(file.size)} · 修改于 {formatDateTime(file.mtime)}
              </span>
            </span>
          )
        }
        onBack={() => onNavigate({ kind: 'dir', ...(file === undefined ? {} : { path: parentDir(file.path) }) })}
        backTitle="所在目录"
        onClose={onClose}
      >
        {file?.kind === 'markdown' && (
          <Button
            size="icon-sm"
            variant="ghost"
            data-testid="file-toggle-source"
            aria-pressed={mode === 'source'}
            title={mode === 'rendered' ? '查看源码' : '查看渲染效果'}
            onClick={() => setMode((m) => (m === 'rendered' ? 'source' : 'rendered'))}
          >
            {mode === 'rendered' ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        )}
        {(file?.kind === 'text' || (file?.kind === 'markdown' && mode === 'source')) && (
          <Button size="icon-sm" variant="ghost" aria-pressed={wrap} title="自动换行" onClick={() => setWrap((w) => !w)} className={cn(wrap && 'text-brand')}>
            <WrapTextIcon />
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" title="刷新" aria-label="刷新" onClick={doRefresh} disabled={load.state === 'loading'} data-testid="file-refresh">
          <RefreshCwIcon className={cn(load.state === 'loading' && 'motion-safe:animate-spin')} />
        </Button>
        {opened !== undefined && (
          <Button asChild size="icon-sm" variant="ghost" title="下载">
            <a href={opened.url} download={opened.file.name} aria-label="下载" data-testid="file-download">
              <DownloadIcon />
            </a>
          </Button>
        )}
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-auto pb-[env(safe-area-inset-bottom)]">
        {load.state === 'loading' && <div className="text-text-3 p-6 text-[13px]">正在读取…</div>}
        {load.state === 'error' && <ErrorBox message={load.message} onRetry={doRefresh} />}
        {opened !== undefined && <FileBody opened={opened} mode={mode} wrap={wrap} />}
      </div>
    </>
  );
}

function DirPane({
  machineId,
  sessionId,
  path,
  onNavigate,
  onClose,
}: {
  machineId: string;
  sessionId: string;
  path: string | undefined;
  onNavigate: (view: FileView) => void;
  onClose: () => void;
}): React.JSX.Element {
  const client = useClient();
  const roots = useFilesInfo(machineId)?.roots;
  const [showHidden, setShowHidden] = useState(readShowHidden);
  const [trustPath, setTrustPath] = useState<string | null>(null);
  const toggleHidden = (): void =>
    setShowHidden((v) => {
      writeShowHidden(!v);
      return !v;
    });
  const [load, reload] = useLoad<FsListing>(
    client === null ? null : () => client.listFiles(machineId, sessionId, path),
    [client, machineId, sessionId, path],
  );
  const listing = load.state === 'ok' ? load.value : undefined;
  // 范围外：只认绝对路径（相对路径是相对会话 cwd 的，展示和信任都说不清）
  const outOfScope = load.state === 'error' && isOutOfScope(load.error) && path?.startsWith('/') === true ? path : undefined;
  // 当前所在的目录：加载成功取 agent 解析后的路径，范围外取请求路径
  const here = listing?.path ?? outOfScope;
  // 会话目录：root 不是任何信任目录时就是会话 cwd
  const sessionDir = listing !== undefined && !(roots ?? []).some((r) => r.path === listing.root) ? listing.root : undefined;
  const browse = (dir: string | undefined): void => onNavigate({ kind: 'dir', ...(dir === undefined ? {} : { path: dir }) });
  const title =
    listing !== undefined
      ? listing.path === sessionDir
        ? '会话目录'
        : listing.path.slice(listing.path.lastIndexOf('/') + 1) || '/'
      : outOfScope !== undefined
        ? outOfScope.slice(outOfScope.lastIndexOf('/') + 1) || '/'
        : '文件';
  return (
    <>
      <PanelHeader
        title={
          <span className="flex items-center gap-1.5">
            <FolderOpenIcon className="text-brand size-4" />
            {title}
            {listing !== undefined && listing.root !== sessionDir && listing.path === listing.root && (
              <span className="text-text-3 bg-surface-2 rounded px-1.5 py-px text-[11px] font-normal">信任目录</span>
            )}
          </span>
        }
        description={
          here === undefined ? (
            <span className="font-mono break-all">{path ?? '会话目录'}</span>
          ) : (
            <Breadcrumbs path={here} root={listing?.root} onBrowse={browse} />
          )
        }
        {...(here === undefined || here === '/' ? {} : { onBack: () => browse(parentDir(here)), backTitle: '上一级' })}
        onClose={onClose}
      >
        {roots !== undefined && (
          <LocationMenu machineId={machineId} roots={roots} current={here} sessionDir={sessionDir} onBrowse={browse} onTrustCurrent={setTrustPath} />
        )}
        <Button
          size="sm"
          variant="ghost"
          data-testid="file-toggle-hidden"
          aria-pressed={showHidden}
          title={showHidden ? '不显示点开头的文件和目录（.git、.env 等）' : '显示点开头的文件和目录'}
          onClick={toggleHidden}
          className="text-text-2 h-7 gap-1 px-2 text-[12px]"
        >
          {showHidden ? <EyeIcon /> : <EyeOffIcon />}
          <span className="hidden sm:inline">{showHidden ? '隐藏 .文件' : '显示 .文件'}</span>
        </Button>
        <Button size="icon-sm" variant="ghost" title="刷新" aria-label="刷新" onClick={reload} disabled={load.state === 'loading'}>
          <RefreshCwIcon className={cn(load.state === 'loading' && 'motion-safe:animate-spin')} />
        </Button>
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-auto pb-[env(safe-area-inset-bottom)]">
        {load.state === 'loading' && <div className="text-text-3 p-6 text-[13px]">正在读取…</div>}
        {outOfScope !== undefined && (
          <OutOfScopeNotice path={outOfScope} canTrust={roots !== undefined && outOfScope !== '/'} onTrust={() => setTrustPath(outOfScope)} onSessionDir={() => browse(undefined)} />
        )}
        {load.state === 'error' && outOfScope === undefined && <ErrorBox message={load.message} onRetry={reload} />}
        {listing !== undefined && (
          <FileList
            listing={listing}
            showHidden={showHidden}
            onBrowse={(dir) => browse(dir)}
            onOpen={(p) => onNavigate({ kind: 'file', path: p })}
          />
        )}
      </div>
      {trustPath !== null && (
        <TrustDirDialog
          machineId={machineId}
          path={trustPath}
          open
          onOpenChange={(open) => !open && setTrustPath(null)}
          onTrusted={() => reload()}
        />
      )}
    </>
  );
}

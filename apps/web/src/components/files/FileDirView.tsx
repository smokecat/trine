/**
 * 目录视图（与容器无关）：头部（面包屑、位置菜单、点文件开关）+ 列表 + 范围外信任流程。
 * 抽屉与工作区 tab 共用；去别的目录 / 打开文件交给外壳（`onBrowse` / `onOpenFile`）。
 */
import { useRef, useState } from 'react';
import { EyeIcon, EyeOffIcon, FolderOpenIcon, RefreshCwIcon } from 'lucide-react';
import { useClient } from '@/app/runtime.ts';
import type { FsListing } from '@/lib/client.ts';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Breadcrumbs, FileList } from './FileBrowser.tsx';
import type { FileOpenTarget } from './file-links.ts';
import { parentDir } from './file-model.ts';
import { LocationMenu, OutOfScopeNotice, TrustDirDialog, useFilesInfo } from './TrustDir.tsx';
import { isOutOfScope, useLoad } from './use-file-load.ts';
import { ErrorBox, ViewHeader, type FileViewChrome } from './ViewHeader.tsx';
import { useScrollMemory, type FileDirModel } from './view-model.ts';

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

export function FileDirView({
  machineId,
  sessionId,
  path,
  model,
  onModelChange,
  onBrowse,
  onOpenFile,
  chrome,
}: {
  machineId: string;
  sessionId: string;
  /** 省略 = 会话 cwd */
  path: string | undefined;
  model?: FileDirModel | undefined;
  onModelChange?: ((patch: Partial<FileDirModel>) => void) | undefined;
  /** 去别的目录；省略 dir = 会话目录 */
  /** `target`：列表条目按点击修饰键给（Alt = side），其余入口省略（就地导航） */
  onBrowse: (dir?: string, target?: FileOpenTarget) => void;
  onOpenFile: (path: string, target: FileOpenTarget) => void;
  chrome?: FileViewChrome;
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollMemory(scrollRef, model?.scrollTop ?? 0, listing !== undefined, (top) => onModelChange?.({ scrollTop: top }));
  // 范围外：只认绝对路径（相对路径是相对会话 cwd 的，展示和信任都说不清）
  const outOfScope = load.state === 'error' && isOutOfScope(load.error) && path?.startsWith('/') === true ? path : undefined;
  // 当前所在的目录：加载成功取 agent 解析后的路径，范围外取请求路径
  const here = listing?.path ?? outOfScope;
  // 会话目录：root 不是任何信任目录时就是会话 cwd
  const sessionDir = listing !== undefined && !(roots ?? []).some((r) => r.path === listing.root) ? listing.root : undefined;
  const browse = (dir: string | undefined): void => (dir === undefined ? onBrowse() : onBrowse(dir));
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
      <ViewHeader
        chrome={chrome}
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
      >
        {roots !== undefined && (
          <LocationMenu machineId={machineId} roots={roots} current={here} sessionDir={sessionDir} onBrowse={browse} onTrustCurrent={setTrustPath} />
        )}
        <Button
          size="sm"
          variant="ghost"
          data-testid="file-toggle-hidden"
          aria-label={showHidden ? '隐藏点文件' : '显示点文件'}
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
      </ViewHeader>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto pb-[env(safe-area-inset-bottom)]">
        {load.state === 'loading' && <div className="text-text-3 p-6 text-[13px]">正在读取…</div>}
        {outOfScope !== undefined && (
          <OutOfScopeNotice path={outOfScope} canTrust={roots !== undefined && outOfScope !== '/'} onTrust={() => setTrustPath(outOfScope)} onSessionDir={() => browse(undefined)} />
        )}
        {load.state === 'error' && outOfScope === undefined && <ErrorBox message={load.message} onRetry={reload} />}
        {listing !== undefined && <FileList listing={listing} showHidden={showHidden} onBrowse={(dir, target) => onBrowse(dir, target)} onOpen={onOpenFile} />}
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

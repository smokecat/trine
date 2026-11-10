/**
 * 文件视图（与容器无关）：头部 + 加载 + FileBody。抽屉与工作区 tab 共用。
 *
 * 内容状态（模式、换行、滚动）由外壳经 `model` / `onModelChange` 管理；
 * 「去所在目录」等导航交给外壳的 `onBrowse`（抽屉 push 历史，工作区开目录 tab）。
 */
import { useRef, useState } from 'react';
import { DownloadIcon, EyeIcon, EyeOffIcon, RefreshCwIcon, WrapTextIcon } from 'lucide-react';
import { useClient } from '@/app/runtime.ts';
import type { OpenedFile } from '@/lib/client.ts';
import { formatBytes, formatDateTime } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Breadcrumbs } from './FileBrowser.tsx';
import { FileBody } from './FileViewer.tsx';
import { parentDir } from './file-model.ts';
import { useLoad } from './use-file-load.ts';
import { ErrorBox, ViewHeader, type FileViewChrome } from './ViewHeader.tsx';
import { useScrollMemory, type FileDocModel } from './view-model.ts';

export function FileDocView({
  machineId,
  sessionId,
  path,
  model,
  onModelChange,
  onBrowse,
  chrome,
}: {
  machineId: string;
  sessionId: string;
  path: string;
  /** 加载后定位的锚点（打开 intent 带来的） */
  fragment?: string;
  model: FileDocModel;
  onModelChange: (patch: Partial<FileDocModel>) => void;
  /** 去某个目录（面包屑、所在目录）；省略 dir = 会话目录 */
  onBrowse: (dir?: string) => void;
  chrome?: FileViewChrome;
}): React.JSX.Element {
  const client = useClient();
  const [refresh, setRefresh] = useState(false);
  const { mode, wrap } = model;
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollMemory(scrollRef, model.scrollTop, opened !== undefined, (top) => onModelChange({ scrollTop: top }));
  return (
    <>
      <ViewHeader
        chrome={chrome}
        title={file?.name ?? path.slice(path.lastIndexOf('/') + 1)}
        description={
          file === undefined ? (
            <span className="font-mono break-all">{path}</span>
          ) : (
            <span className="flex flex-col gap-0.5">
              <Breadcrumbs path={parentDir(file.path)} root={file.root} onBrowse={(dir) => onBrowse(dir)} />
              <span>
                {formatBytes(file.size)} · 修改于 {formatDateTime(file.mtime)}
              </span>
            </span>
          )
        }
        onBack={() => (file === undefined ? onBrowse() : onBrowse(parentDir(file.path)))}
        backTitle="所在目录"
      >
        {file?.kind === 'markdown' && (
          <Button
            size="icon-sm"
            variant="ghost"
            data-testid="file-toggle-source"
            aria-label={mode === 'rendered' ? '查看源码' : '查看渲染效果'}
            aria-pressed={mode === 'source'}
            title={mode === 'rendered' ? '查看源码' : '查看渲染效果'}
            onClick={() => onModelChange({ mode: mode === 'rendered' ? 'source' : 'rendered' })}
          >
            {mode === 'rendered' ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        )}
        {(file?.kind === 'text' || (file?.kind === 'markdown' && mode === 'source')) && (
          <Button size="icon-sm" variant="ghost" aria-pressed={wrap} title="自动换行" onClick={() => onModelChange({ wrap: !wrap })} className={cn(wrap && 'text-brand')}>
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
      </ViewHeader>
      <div ref={scrollRef} onScroll={onScroll} data-testid="file-scroll" className="min-h-0 flex-1 overflow-auto pb-[env(safe-area-inset-bottom)]">
        {load.state === 'loading' && <div className="text-text-3 p-6 text-[13px]">正在读取…</div>}
        {load.state === 'error' && <ErrorBox message={load.message} onRetry={doRefresh} />}
        {opened !== undefined && <FileBody opened={opened} mode={mode} wrap={wrap} />}
      </div>
    </>
  );
}

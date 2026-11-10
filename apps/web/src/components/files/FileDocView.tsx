/**
 * 文件视图（与容器无关）：头部 + 加载 + FileBody。抽屉与工作区 tab 共用。
 *
 * 内容状态（模式、换行、滚动）由外壳经 `model` / `onModelChange` 管理；
 * 「去所在目录」等导航交给外壳的 `onBrowse`（抽屉 push 历史，工作区开目录 tab）。
 *
 * markdown 预览带目录与锚点（方案 §6）：标题 id 加本实例前缀（useId），锚点只在本视图的
 * 滚动容器里定位；intent 带来的 `fragment` 等预览渲染出来再定位，找不到给提示。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { DownloadIcon, EyeIcon, EyeOffIcon, RefreshCwIcon, WrapTextIcon } from 'lucide-react';
import { useClient } from '@/app/runtime.ts';
import type { OpenedFile } from '@/lib/client.ts';
import { formatBytes, formatDateTime } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Breadcrumbs } from './FileBrowser.tsx';
import { FileBody } from './FileViewer.tsx';
import { FileDocAnchorContext, type FileDocAnchors } from './file-links.ts';
import { HIGHLIGHT_MAX_BYTES, parentDir } from './file-model.ts';
import { TOC_RAIL_MIN_WIDTH, TocPopover, TocRail, useContainerWidth, useDocToc } from './MarkdownToc.tsx';
import { useLoad } from './use-file-load.ts';
import { ErrorBox, ViewHeader, type FileViewChrome } from './ViewHeader.tsx';
import { useScrollMemory, type FileDocModel } from './view-model.ts';

export function FileDocView({
  machineId,
  sessionId,
  path,
  fragment,
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
  // 锚点：intent 带来的先挂起，等渲染好的预览出现再定位；找不到给一条提示（刷新后标题没了也一样）
  const [pending, setPending] = useState<string | undefined>(fragment);
  const [prevFragment, setPrevFragment] = useState(fragment);
  if (fragment !== prevFragment) {
    setPrevFragment(fragment);
    setPending(fragment);
  }
  const [missing, setMissing] = useState<string | null>(null);
  const doRefresh = (): void => {
    setRefresh(true);
    setMissing(null);
    reload();
  };
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const setScrollRefs = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);
  // 带锚点打开时不恢复旧滚动位置，以锚点为准
  const onScroll = useScrollMemory(scrollRef, fragment === undefined ? model.scrollTop : 0, opened !== undefined, (top) => onModelChange({ scrollTop: top }));

  const toc = useDocToc(scrollEl);
  const rawId = useId();
  const ns = `fd${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const { jump } = toc;
  const anchors = useMemo<FileDocAnchors>(
    () => ({
      ns,
      jump: (f) => {
        const ok = jump(f);
        setMissing(ok ? null : f);
        return ok;
      },
    }),
    [ns, jump],
  );

  useEffect(() => {
    if (pending === undefined) return;
    if (load.state === 'error') return setPending(undefined);
    if (file === undefined) return;
    // 不是会渲染成预览的 markdown（其他类型、太大只给纯文本）：锚点无从定位，静默丢弃
    if (file.kind !== 'markdown' || file.size > HIGHLIGHT_MAX_BYTES) return setPending(undefined);
    // 源码模式：切回渲染时再定位
    if (mode !== 'rendered' || !toc.hasPreview) return;
    setPending(undefined);
    setMissing(jump(pending, false) ? null : pending);
  }, [pending, load.state, file, mode, toc.hasPreview, toc.version, jump]);

  const showToc = mode === 'rendered' && toc.items.length > 0;
  const width = useContainerWidth(scrollEl);
  const rail = showToc && width >= TOC_RAIL_MIN_WIDTH;
  const body =
    opened === undefined ? null : (
      <FileDocAnchorContext.Provider value={anchors}>
        <FileBody opened={opened} mode={mode} wrap={wrap} />
      </FileDocAnchorContext.Provider>
    );
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
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={setScrollRefs} onScroll={onScroll} data-testid="file-scroll" className="min-h-0 flex-1 overflow-auto pb-[env(safe-area-inset-bottom)]">
          {missing !== null && (
            <div data-testid="file-anchor-missing" role="status" className="text-text-2 border-border bg-surface-2 flex items-center gap-2 border-b px-4 py-1.5 text-[12px]">
              <span className="min-w-0 flex-1 truncate">文档里没有找到「{missing}」这一节（可能已改名或删除）</span>
              <button type="button" className="text-text-3 hover:text-text shrink-0" onClick={() => setMissing(null)}>
                知道了
              </button>
            </div>
          )}
          {load.state === 'loading' && <div className="text-text-3 p-6 text-[13px]">正在读取…</div>}
          {load.state === 'error' && <ErrorBox message={load.message} onRetry={doRefresh} />}
          {/* 结构不随宽窄变（只换 class），宽窄切换时正文不重挂；窄时 contents 不产生盒子，PDF 的 h-full 照旧 */}
          <div className={rail ? 'flex min-w-0 items-start' : 'contents'}>
            <div className={rail ? 'min-w-0 flex-1' : 'contents'}>{body}</div>
            {rail && <TocRail items={toc.items} active={toc.active} onJump={(slug) => anchors.jump(slug)} maxHeight={scrollEl?.clientHeight ?? 0} />}
          </div>
        </div>
        {showToc && !rail && <TocPopover items={toc.items} active={toc.active} onJump={(slug) => anchors.jump(slug)} />}
      </div>
    </>
  );
}

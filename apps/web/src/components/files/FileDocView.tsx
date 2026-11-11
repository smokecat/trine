/**
 * 文件视图（与容器无关）：头部 + 加载 + FileBody。抽屉与工作区 tab 共用。
 *
 * 内容状态（模式、换行、滚动）由外壳经 `model` / `onModelChange` 管理；
 * 「去所在目录」等导航交给外壳的 `onBrowse`（抽屉 push 历史，工作区开目录 tab）。
 *
 * markdown 预览带目录与锚点（方案 §6）：标题 id 加本实例前缀（useId），锚点只在本视图的
 * 滚动容器里定位；intent 带来的 `fragment` 等预览渲染出来再定位，找不到给提示。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DownloadIcon, EyeIcon, EyeOffIcon, RefreshCwIcon, WrapTextIcon } from 'lucide-react';
import { useClient, useTrine } from '@/app/runtime.ts';
import type { OpenedFile } from '@/lib/client.ts';
import { formatBytes, formatDateTime } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { Button } from '@/components/ui/button.tsx';
import { Breadcrumbs } from './FileBrowser.tsx';
import { FileDocAnchorContext, useFileLinks, type FileDocAnchors, type FileOpenTarget } from './file-links.ts';
import { absoluteFilePath, HIGHLIGHT_MAX_BYTES, parentDir } from './file-model.ts';
import { FileBody } from './FileViewer.tsx';
import { useFilesInfo } from './TrustDir.tsx';
import { TOC_RAIL_MIN_WIDTH, TocPopover, TocRail, useContainerWidth, useDocToc } from './MarkdownToc.tsx';
import { isOutOfScope, useLoad } from './use-file-load.ts';
import { useScrollAnchor } from './use-scroll-anchor.ts';
import { ErrorBox, ViewHeader, type FileViewChrome } from './ViewHeader.tsx';
import { useScrollMemory, type FileDocModel } from './view-model.ts';

type MissingReason = 'open' | 'refresh' | 'jump';

/** 挂起的定位：`open` = intent 带来的，`refresh` = 刷新后复核（`stale` 是刷新前的内容，不能拿它判断） */
interface PendingAnchor {
  fragment: string;
  reason: 'open' | 'refresh';
  stale?: OpenedFile | undefined;
}

const MISSING_TEXT: Record<MissingReason, (f: string) => string> = {
  open: (f) => `文档里没有找到「${f}」这一节（可能已改名或删除）`,
  refresh: (f) => `刷新后文档里已经没有「${f}」这一节了`,
  jump: (f) => `文档里没有找到「${f}」这一节（可能已改名或删除）`,
};

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
  const sessionCwd = useTrine((s) => s.sessions[machineId]?.[sessionId]?.cwd);
  const home = useFilesInfo(machineId)?.home;
  const absPath = absoluteFilePath(path, sessionCwd, home);
  // 锚点：intent 带来的先挂起，等渲染好的预览出现再定位；找不到给一条提示。
  // 视图记着「当前定位目标」（intent 带来的或用户点过的同文件锚点）：刷新后对**新内容**复核一次——
  // 还在就重新定位（刷新会重建正文、滚动归零），没了就提示失效。复核只在刷新后跑一次，
  // 无关的重渲染不会反复抢滚动；用户主动跳转立即执行，不经过挂起。
  const [pending, setPending] = useState<PendingAnchor | undefined>(fragment === undefined ? undefined : { fragment, reason: 'open' });
  const [prevFragment, setPrevFragment] = useState(fragment);
  const landed = useRef<string | undefined>(fragment);
  if (fragment !== prevFragment) {
    setPrevFragment(fragment);
    setPending(fragment === undefined ? undefined : { fragment, reason: 'open' });
  }
  const [missing, setMissing] = useState<{ fragment: string; reason: MissingReason } | null>(null);
  const doRefresh = (): void => {
    setRefresh(true);
    setMissing(null);
    // 复核要等**新的**内容：记下刷新前的 opened，同一个对象不算
    if (landed.current !== undefined) setPending({ fragment: landed.current, reason: 'refresh', stale: opened });
    reload();
  };
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const setScrollRefs = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);
  // 滚动锚点（见 scroll-anchor.ts）：有记下的锚点就按它恢复（宽度、模式变了也准），
  // 只有像素位置（旧数据）才走 useScrollMemory 的像素恢复；带 fragment 打开以 fragment 为准
  const initialAnchor = fragment === undefined ? model.anchor : undefined;
  const memoryRestoring = useRef(false);
  const scrollAnchor = useScrollAnchor(scrollEl, { initial: initialAnchor, busy: () => memoryRestoring.current });
  const captureAnchorNow = scrollAnchor.capture;
  const onScroll = useScrollMemory(
    scrollRef,
    fragment === undefined && initialAnchor === undefined ? model.scrollTop : 0,
    opened !== undefined,
    (top) => onModelChange({ scrollTop: top, anchor: scrollAnchor.anchor.current ?? undefined }),
    { restoring: memoryRestoring },
  );

  const toc = useDocToc(scrollEl);
  const rawId = useId();
  const ns = `fd${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const { jump } = toc;
  const anchors = useMemo<FileDocAnchors>(
    () => ({
      ns,
      jump: (f, options) => {
        const ok = jump(f, { focus: options?.focus === true });
        // 主动定位后以新位置为锚点（否则紧接着的重排校正会按旧锚点拉回去）
        if (ok) captureAnchorNow();
        if (ok) landed.current = f;
        setMissing(ok ? null : { fragment: f, reason: 'jump' });
        return ok;
      },
    }),
    [ns, jump, captureAnchorNow],
  );
  const links = useFileLinks();
  // 目录项：普通点击就地定位并移焦点；Alt（side）交给打开 intent（工作区里另开一份）
  const onTocJump = (slug: string, target: FileOpenTarget): boolean => {
    if (target === 'side' && links !== null) {
      links.open({ path, fragment: slug, target });
      return false;
    }
    return anchors.jump(slug, { focus: true });
  };

  useEffect(() => {
    if (pending === undefined) return;
    if (load.state === 'error') return setPending(undefined);
    if (opened === undefined || opened === pending.stale) return;
    // 不是会渲染成预览的 markdown（其他类型、太大只给纯文本）：锚点无从定位，静默丢弃
    if (opened.file.kind !== 'markdown' || opened.file.size > HIGHLIGHT_MAX_BYTES) return setPending(undefined);
    // 源码模式：切回渲染时再定位
    if (mode !== 'rendered' || !toc.hasPreview) return;
    setPending(undefined);
    // 打开带来的定位与同文件跳转一致：焦点落到目标标题；刷新后的复核不抢焦点
    const ok = jump(pending.fragment, { smooth: false, focus: pending.reason === 'open' });
    if (ok) captureAnchorNow();
    landed.current = ok ? pending.fragment : undefined;
    setMissing(ok ? null : { fragment: pending.fragment, reason: pending.reason });
  }, [pending, load.state, opened, mode, toc.hasPreview, toc.version, jump, captureAnchorNow]);

  // 源码 / 渲染切换：像素位置在两种模式下不可比——切换前按滚动锚点（块的源码行号 + 偏移）记下，
  // 新模式提交后立即按它恢复；之后的重排（代码高亮、宽度变化）由 ResizeObserver 再按锚点校正
  const toggleMode = (): void => {
    scrollAnchor.capture();
    onModelChange({ mode: mode === 'rendered' ? 'source' : 'rendered' });
  };
  const prevMode = useRef(mode);
  useLayoutEffect(() => {
    if (prevMode.current === mode) return;
    prevMode.current = mode;
    scrollAnchor.restore();
  }, [mode, scrollAnchor]);

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
            onClick={toggleMode}
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
        <div
          ref={setScrollRefs}
          onScroll={onScroll}
          data-testid="file-scroll"
          // overflow-anchor: none —— 浏览器自带的滚动锚定与我们按块恢复的逻辑会互相拉扯，以后者为准
          className="min-h-0 flex-1 overflow-auto pb-[env(safe-area-inset-bottom)] [overflow-anchor:none]"
        >
          {load.state === 'loading' && <div className="text-text-3 p-6 text-[13px]">正在读取…</div>}
          {load.state === 'error' && (
            <ErrorBox
              message={load.message}
              onRetry={doRefresh}
              // 范围外的文件：给「浏览所在目录」（相对 / `~` 路径按会话 cwd、agent home 解析），信任与否由用户在那里决定
              {...(isOutOfScope(load.error) && absPath !== undefined ? { onBrowseParent: () => onBrowse(parentDir(absPath)) } : {})}
            />
          )}
          {/*
            DOM 结构只随「有没有目录」变（模式 / 内容决定），**不随宽窄变**：跨过侧栏断点时只换 class、
            加减侧栏，正文与滚动容器都不重挂。没有目录时 contents 不产生盒子，PDF 的 h-full 照旧。
            窄屏有浮动按钮时正文右侧留出按钮的位置，不压住标题。
          */}
          <div data-testid="file-doc-row" className={showToc ? 'flex min-w-0 items-start' : 'contents'}>
            <div className={showToc ? cn('min-w-0 flex-1', !rail && 'pr-11') : 'contents'}>{body}</div>
            {rail && <TocRail items={toc.items} active={toc.active} onJump={onTocJump} maxHeight={scrollEl?.clientHeight ?? 0} />}
          </div>
        </div>
        {showToc && !rail && <TocPopover items={toc.items} active={toc.active} onJump={onTocJump} />}
        {/* 锚点失效提示：浮在预览视口底部（不在滚动内容里，滚到哪都看得见；也不与右上角目录按钮重叠） */}
        {missing !== null && (
          <div
            data-testid="file-anchor-missing"
            data-reason={missing.reason}
            role="status"
            className="text-text-2 border-border bg-surface-2 absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-20 mx-auto flex max-w-xl items-center gap-2 rounded-lg border px-3 py-2 text-[12px] shadow-md"
          >
            <span className="min-w-0 flex-1">{MISSING_TEXT[missing.reason](missing.fragment)}</span>
            <button type="button" data-testid="file-anchor-missing-dismiss" className="text-text-3 hover:text-text shrink-0 pointer-coarse:min-h-10" onClick={() => setMissing(null)}>
              知道了
            </button>
          </div>
        )}
      </div>
    </>
  );
}

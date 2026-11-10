/**
 * 工具卡（原型 `.tool`）——**原地更新，绝不刷屏**（NOTES.chat 第 2 条）。
 *
 * 一行：图标 · 工具名 · 参数摘要（mono，单行省略）· 右侧状态。
 * 开始时右侧是转圈 + 已耗时；`tool.end` 到了同一个条目改成 ✓/⚠/✗ + 结果摘要。
 * reducer 按 `toolUseId` 原地更新条目，所以这里只要跟着 props 走就自然是
 * 原地更新——**不要**在这层再加任何「新增一条」的逻辑。
 *
 * 点整行展开 `outputPreview`（agent 已经截断过，尾部给提示）。
 *
 * 完整参数：折叠态的参数摘要是单行省略的（agent 给的 argSummary 本身也限长 120）。
 * 有 `argDetail`（长 / 多行命令原文，agent ≥ 0.25.0）或摘要较长时卡片可展开，展开后
 * 第一块是可换行、可复制的完整参数——手机上没有悬停，只能靠展开看全。
 *
 * ## 子 agent（Agent / Task，subagent-view）
 *
 * 子 agent 里的工具调用挂在这张卡的 `children` 下（reducer 按 parentToolUseId 挂）。
 * - 折叠态：运行中且已有子工具时多一行「N 次工具调用 · 当前：<子工具 参数>」；
 *   完成后右侧的 resultSummary（agent 给的「✓ N 次工具调用 · 耗时」）已经说清楚了。
 * - 展开：子工具卡列表（复用本组件、缩进一级，嵌套同理）+ 报告预览。
 * - 历史回看里的卡没有实时收到的子工具：展开时经 `onLoadChildren` 向 agent 拉子转录
 *   （版本不够时调用方不给这个回调）；加载中 / 失败 / 空结果都有一行提示。
 * - 标题「Agent · 类型 · 前台/后台」，展开第一块是写给子 agent 的提示词（argDetail）。
 * - 启动工具返回 ≠ 子 agent 结束（plan §7，见 lib/subagent-view.ts）：后台的右侧显示
 *   「后台运行中 · 计时」（后台任务快照派生），结束后是 agent 的收尾摘要，拿不到结束证据
 *   是「状态未知」。并行的子 agent 各自按开始时刻走秒（`now` 只给在跑的卡）。
 * - Codex 的 SubAgent 卡：右侧是调用状态，另起一行是子 agent 自己的昵称 / 状态 / 模型。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { CopyIcon, FileSearchIcon } from 'lucide-react';
import type { BgTask, SubagentState } from '@trine/core';
import { copyText } from '@/lib/clipboard.ts';
import { targetForClick, useFileLinks } from '@/components/files/file-links.ts';
import type { ToolEntry } from '@/lib/reducer.ts';
import { formatClockSeconds, formatDuration, formatSeconds } from '@/lib/format.ts';
import {
  claudeSubagentView,
  codexSubagentLine,
  subagentArgSummary,
  subagentStateLabel,
  subagentTitle,
  type ClaudeSubagentView,
} from '@/lib/subagent-view.ts';
import { childTotal, currentChild, isSubagentTool } from '@/lib/tool-tree.ts';
import { cn } from '@/lib/utils.ts';

/** 工具名 → 行首图标，与原型一致（未知工具回落扳手） */
const TOOL_ICON: Record<string, string> = {
  Bash: '🔧',
  Shell: '🔧',
  BashOutput: '🔧',
  Edit: '✏️',
  Write: '📝',
  Read: '📖',
  Glob: '🔍',
  Grep: '🔍',
  WebFetch: '🌐',
  WebSearch: '🌐',
  Task: '🤖',
  Agent: '🤖',
  // Codex：派生、等待子 agent 等操作；压缩上下文
  SubAgent: '🤖',
  Compact: '🗜️',
  TodoWrite: '☑️',
  NotebookEdit: '📓',
  // 后台任务相关（agent 的 summarize.ts 给的摘要：`后台 · cmd` / `stop <id>` / `<id> · 等待完成`）
  TaskOutput: '📋',
  TaskStop: '⏹️',
  KillShell: '⏹️',
  // 任务清单工具（Claude Code 内置的 TaskCreate/Update/List/Get），先给个图标
  TaskCreate: '🗒️',
  TaskUpdate: '🗒️',
  TaskList: '🗒️',
  TaskGet: '🗒️',
};

function toolIcon(name: string): string {
  return TOOL_ICON[name] ?? (name.startsWith('mcp__') ? '🧩' : '🔧');
}

const STATUS_CLASS = {
  ok: 'text-green',
  warn: 'text-amber',
  error: 'text-red',
} as const;

/**
 * agent 的 `resultSummary` **已经**带了状态号与耗时（`✓ +9 −2 · 820ms`，见
 * agent 的 summarize.ts），所以这里只上色、不再自己拼号和时长——否则会渲染成
 * 「✓ ✓ 已写入 · 2m10s · 2:10」。只有 agent 没给摘要时才回落到本地号 + 时长。
 */
const STATUS_MARK = { ok: '✓', warn: '⚠', error: '✗' } as const;

export function resultText(entry: ToolEntry, status: NonNullable<ToolEntry['status']>): string {
  if (entry.resultSummary !== undefined && entry.resultSummary !== '') return entry.resultSummary;
  const mark = STATUS_MARK[status];
  return entry.durationMs === undefined ? mark : `${mark} ${formatDuration(entry.durationMs)}`;
}

/** 状态 / 耗时区域的悬停提示：「开始 14:05:32 · 耗时 3s」；没有可信时间时不给 */
export function toolTimeTitle(entry: ToolEntry): string | undefined {
  if (!(entry.ts > 0)) return undefined;
  const start = `开始 ${formatClockSeconds(entry.ts)}`;
  return entry.durationMs === undefined ? start : `${start} · 耗时 ${formatDuration(entry.durationMs)}`;
}

/**
 * 子 agent 卡折叠态的进度行：父在跑、或父已结束但最新子工具还在跑（后台子 agent）
 * 时给「N 次工具调用 · 当前：…」，其余情况 null（完成后看右侧 resultSummary）。
 */
export function subagentProgressText(entry: ToolEntry): string | null {
  if (!isSubagentTool(entry.toolName)) return null;
  const total = childTotal(entry);
  const cur = currentChild(entry);
  if (total === 0 || cur === undefined) return null;
  // 父卡已结束但子工具还在跑 = 后台子 agent（父卡在「已启动」时就收尾了，评审 M1）
  if (entry.status !== undefined && cur.status !== undefined) return null;
  const what = cur.argSummary === '' ? cur.toolName : `${cur.toolName} ${cur.argSummary}`;
  return `${total} 次工具调用 · ${cur.status === undefined ? '当前' : '最近'}：${what}`;
}

type LoadState = 'idle' | 'loading' | 'error';

/** 摘要超过这个长度就允许展开看全（窄屏上大约一行放得下的量） */
export const ARG_EXPAND_MIN = 40;

/** 展开后显示的完整参数；摘要短到一行放得下、又没有原文时为 undefined */
export function fullArgText(entry: Pick<ToolEntry, 'argSummary' | 'argDetail'>): string | undefined {
  if (entry.argDetail !== undefined && entry.argDetail !== '') return entry.argDetail;
  return entry.argSummary.length > ARG_EXPAND_MIN ? entry.argSummary : undefined;
}

/** 完整参数块的标题：命令类工具写「命令」，子 agent 写「提示词」，其余写「参数」 */
function argLabel(toolName: string): string {
  if (toolName === 'Bash' || toolName === 'Shell') return '命令';
  return isSubagentTool(toolName) ? '提示词' : '参数';
}

/** 子 agent 卡右侧状态的号（运行中另画转圈） */
const STATE_MARK: Partial<Record<SubagentState, string>> = {
  pending: '…',
  completed: '✓',
  failed: '✗',
  stopped: '⊘',
  interrupted: '⊘',
  shutdown: '⊘',
  not_found: '?',
  ended: '⊙',
  unknown: '?',
};

function stateTone(state: SubagentState): string {
  if (state === 'completed') return 'text-green';
  if (state === 'failed') return 'text-red';
  return 'text-text-3';
}

/**
 * 后台子 agent 卡右侧（Claude）：运行中给「后台运行中 · 计时」，结束给 agent 的收尾摘要
 * （没有收尾帧时给状态词），拿不到结束证据给「状态未知」。不是后台卡返回 null。
 */
export function backgroundStatusText(
  entry: ToolEntry,
  view: ClaudeSubagentView | undefined,
  now: number,
): { text: string; tone: string; running: boolean } | null {
  if (view === undefined) return null;
  const { state } = view;
  if (state === 'running') {
    // 后台运行中：计时；前台 / 启动工具还没返回：照常是「运行中」，由上层的通用分支画
    if (view.background !== true || view.startedAt === undefined) return null;
    const elapsed = now > 0 ? ` · ${formatDuration(Math.max(0, now - view.startedAt))}` : '';
    return { text: `后台运行中${elapsed}`, tone: 'text-brand', running: true };
  }
  // 结束状态统一成「图标 + 短语」（手测反馈）：原始错误文本不进卡头，展开区看全文
  const summary = entry.resultSummary ?? '';
  // 后台卡没有 agent 的收尾帧却报错：是启动这一步失败了
  const launchFailed = view.background === true && state === 'failed' && entry.status === 'error' && !summary.startsWith('✗ 子 agent ');
  const phrase = launchFailed ? '启动失败' : subagentStateLabel(state);
  // 子 agent 自报的统计（「3 次工具调用 · 18.3s」）附在后面；别的文字（报告、英文错误）不进卡头
  const stats = summary.replace(/^[✓✗⏹⚠⊘]\s*/, '').replace(/^子 agent (?:已完成|失败|已停止)\s*(?:·\s*)?/, '');
  const detail = !launchFailed && /^\d+ 次工具调用/.test(stats) ? ` · ${stats}` : '';
  return { text: `${STATE_MARK[state] ?? ''} ${phrase}${detail}`.trim(), tone: stateTone(state), running: false };
}

/** 卡头摘要可能被截断（长错误）：展开区给完整的结果摘要 */
function fullResultText(entry: ToolEntry): string | undefined {
  const summary = entry.resultSummary;
  if (summary === undefined || summary === '') return undefined;
  return entry.status === 'error' || summary.length > ARG_EXPAND_MIN ? summary : undefined;
}

function FullArgs({ toolName, text }: { toolName: string; text: string }): React.JSX.Element {
  const copy = (): void => {
    copyText(text).then(
      () => toast.success(`已复制${argLabel(toolName)}`),
      (err: unknown) => toast.error(`复制失败：${err instanceof Error ? err.message : String(err)}`),
    );
  };
  return (
    <div data-testid="tool-args" className="border-border border-b">
      <div className="text-text-3 flex items-center justify-between px-3 pt-1.5 text-[11px]">
        <span>{argLabel(toolName)}</span>
        <button
          type="button"
          data-testid="tool-args-copy"
          className="hover:text-text inline-flex items-center gap-1 rounded px-1 py-0.5"
          onClick={copy}
        >
          <CopyIcon aria-hidden className="size-3" />
          复制
        </button>
      </div>
      <pre
        data-testid="tool-args-text"
        className="text-text-2 max-h-64 overflow-auto px-3 pt-0.5 pb-2 font-mono text-[11.5px] break-all whitespace-pre-wrap"
      >
        {text}
      </pre>
    </div>
  );
}

export function ToolCard({
  entry,
  runningElapsedMs,
  onLoadChildren,
  depth = 0,
  historyUnknown = false,
  bgTask,
  bgStale = false,
  now = 0,
}: {
  entry: ToolEntry;
  /** 运行中工具的已耗时（来自心跳快照 + 本地插值）；不在运行或没有心跳时为 null */
  runningElapsedMs: number | null;
  /** 这张子 agent 卡对应的后台任务（toolUseId 关联）；没有 / 不是子 agent 卡时不给 */
  bgTask?: BgTask | undefined;
  /** 后台任务快照已陈旧（agent 重启后的 running 不可信，按状态未知） */
  bgStale?: boolean;
  /** 1s tick（只给在跑的子 agent 卡，用来各自计时）；0 = 不走秒 */
  now?: number;
  /** 拉子 agent 过程（subagent.history.request）；agent 不支持时不给 */
  onLoadChildren?: ((toolUseId: string) => Promise<void>) | undefined;
  /** 嵌套深度（子工具卡为 1，孙为 2…），只影响样式 */
  depth?: number;
  /** 没给 onLoadChildren 是因为 agent 版本还不知道（machine.info 未到），不是版本过旧 */
  historyUnknown?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<LoadState>('idle');
  const fileLinks = useFileLinks();
  const filePath = fileLinks === null ? undefined : entry.filePath;
  const status = entry.status;
  const hasPreview = entry.outputPreview !== undefined && entry.outputPreview !== '';
  const sub = isSubagentTool(entry.toolName);
  const children = entry.children ?? [];
  // 只对**已结束**、还没拉过、没有子工具在跑的卡拉子转录（子工具正实时到达时不拉）。
  // 已有部分实时子条目也允许拉一次补全（中途连上 / 补发窗口外，评审 M3）
  const live = currentChild(entry)?.status === undefined && children.length > 0;
  const view = claudeSubagentView(entry, bgTask, bgStale);
  const bgStatus = backgroundStatusText(entry, view, now);
  // 后台子 agent 还在跑：子工具正实时到达，这时拉回看只会拿到一半、之后也不再补拉
  const canLoad =
    sub && onLoadChildren !== undefined && entry.childrenLoaded !== true && status !== undefined && !live && bgStatus?.running !== true;
  const args = fullArgText(entry);
  const fullResult = fullResultText(entry);
  const expandable =
    hasPreview ||
    args !== undefined ||
    fullResult !== undefined ||
    (sub && (children.length > 0 || canLoad || entry.childrenLoaded === true || status === undefined || bgStatus?.running === true));
  const progress = subagentProgressText(entry) ?? (bgStatus?.running === true && view?.progress !== undefined ? view.progress : null);
  const codexLine = codexSubagentLine(entry);
  // 并行的子 agent 各自计时：心跳只跟踪一个工具，其余在跑的子 agent 卡按自己的开始时刻走秒
  const ownElapsed = sub && status === undefined && runningElapsedMs === null && now > 0 && entry.ts > 0 ? Math.max(0, now - entry.ts) : null;

  const fetchChildren = (): void => {
    if (!canLoad || onLoadChildren === undefined || load === 'loading') return;
    setLoad('loading');
    onLoadChildren(entry.id).then(
      () => setLoad('idle'),
      () => setLoad('error'),
    );
  };

  const toggle = (): void => {
    if (!expandable) return;
    const next = !open;
    setOpen(next);
    if (next) fetchChildren();
  };

  return (
    <li
      data-testid="entry-tool"
      data-tool={entry.toolName}
      data-status={entry.status ?? 'running'}
      data-depth={depth}
      data-subagent-state={view?.state ?? entry.subagent?.state}
      className={cn(
        'overflow-hidden rounded-xl border text-[13px]',
        depth === 0 ? 'border-border bg-surface' : 'border-border bg-surface-2',
      )}
    >
      <div className="flex items-center">
        <button
          type="button"
          data-testid="tool-header"
          disabled={!expandable}
          aria-expanded={expandable ? open : undefined}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 py-2 pl-3 text-left',
            filePath === undefined ? 'pr-3' : 'pr-1',
            expandable ? 'cursor-pointer' : 'cursor-default',
          )}
          onClick={toggle}
        >
          <span aria-hidden className="w-[18px] shrink-0 text-center">
            {toolIcon(entry.toolName)}
          </span>
          <span data-testid="tool-name" className="shrink-0 font-semibold">
            {subagentTitle(entry, view)}
          </span>
          {/* 描述留最小宽度：右侧再长（长错误）也只能截断自己，不能把描述挤没（手测反馈） */}
          <span
            data-testid="tool-arg-summary"
            className="text-text-2 min-w-[5rem] flex-1 truncate font-mono text-[12px]"
            title={entry.argSummary === '' ? undefined : entry.argSummary}
          >
            {subagentArgSummary(entry, view)}
          </span>
          {bgStatus !== null ? (
            <span
              data-testid="tool-subagent-status"
              title={toolTimeTitle(entry)}
              className={cn('tabular min-w-0 max-w-[55%] truncate font-mono text-[12px]', bgStatus.tone)}
            >
              {bgStatus.running && (
                <span aria-hidden className="mr-1 inline-block motion-safe:animate-spin">
                  ◠
                </span>
              )}
              {bgStatus.text}
            </span>
          ) : status === undefined ? (
            <span title={toolTimeTitle(entry)} className="text-brand tabular shrink-0 font-mono text-[12px]">
              <span aria-hidden className="mr-1 inline-block motion-safe:animate-spin">
                ◠
              </span>
              {/* 已耗时取自心跳里的 currentTool.elapsedMs（agent 自己算的）+ 本地插值：
                  entry.ts 是 agent 时钟，直接拿本地 now 去减会被两端时钟差打歪。
                  心跳只跟一个工具：并行的子 agent 卡按自己的开始时刻走秒（与后台任务条同口径） */}
              {runningElapsedMs !== null ? formatSeconds(runningElapsedMs) : ownElapsed !== null ? formatDuration(ownElapsed) : '运行中'}
            </span>
          ) : (
            <span
              data-testid="tool-result"
              title={toolTimeTitle(entry)}
              className={cn('tabular min-w-0 max-w-[55%] truncate font-mono text-[12px]', STATUS_CLASS[status])}
            >
              {resultText(entry, status)}
            </span>
          )}
        </button>
        {filePath !== undefined && (
          <button
            type="button"
            data-testid="tool-open-file"
            title={`预览 ${filePath}（Alt+点击在侧边打开）`}
            aria-label={`预览 ${filePath}`}
            onClick={(e) => fileLinks?.open({ path: filePath, target: targetForClick(e) })}
            className="text-text-3 hover:text-text shrink-0 self-stretch px-2.5"
          >
            <FileSearchIcon className="size-3.5" />
          </button>
        )}
      </div>
      {codexLine !== null && (
        <div data-testid="tool-subagent-line" className="text-text-3 -mt-1 truncate px-3 pb-2 pl-[38px] text-[11.5px]">
          {codexLine}
        </div>
      )}
      {progress !== null && !open && (
        <div
          data-testid="tool-subagent-progress"
          className="text-text-3 -mt-1 truncate px-3 pb-2 pl-[38px] font-mono text-[11.5px]"
        >
          {progress}
        </div>
      )}
      {expandable && open && (
        <div className="border-border border-t">
          {args !== undefined && <FullArgs toolName={entry.toolName} text={args} />}
          {fullResult !== undefined && (
            <div data-testid="tool-result-full" className="border-border border-b px-3 py-1.5">
              <div className="text-text-3 text-[11px]">结果</div>
              <div className={cn('font-mono text-[11.5px] break-all whitespace-pre-wrap', status === undefined ? 'text-text-2' : STATUS_CLASS[status])}>
                {fullResult}
              </div>
            </div>
          )}
          {sub && (
            <SubagentChildren
              entry={entry}
              childEntries={children}
              load={load}
              onRetry={fetchChildren}
              onLoadChildren={onLoadChildren}
              depth={depth}
              historyUnknown={historyUnknown}
              running={status === undefined || bgStatus?.running === true}
            />
          )}
          {hasPreview && (
            <pre className="bg-code-bg text-text-2 max-h-64 overflow-auto px-3 py-2 font-mono text-[11.5px] whitespace-pre">
              {entry.outputPreview}
            </pre>
          )}
          {/* 开始时刻放在展开后的脚注里：折叠态一行不加东西，触屏点开也能看到 */}
          {(hasPreview || entry.ts > 0) && (
            <div
              data-testid="tool-footer"
              className="text-text-3 border-border bg-code-bg tabular border-t px-3 py-1 text-[11px]"
            >
              {[entry.ts > 0 ? `开始 ${formatClockSeconds(entry.ts)}` : '', hasPreview ? '输出由 agent 截断，仅供预览' : '']
                .filter((x) => x !== '')
                .join(' · ')}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** 展开后的子工具卡列表与加载提示 */
function SubagentChildren({
  entry,
  childEntries,
  load,
  onRetry,
  onLoadChildren,
  depth,
  historyUnknown,
  running,
}: {
  entry: ToolEntry;
  childEntries: ToolEntry[];
  load: LoadState;
  onRetry: () => void;
  onLoadChildren: ((toolUseId: string) => Promise<void>) | undefined;
  depth: number;
  historyUnknown: boolean;
  /** 子 agent 还在跑（前台未返回，或后台运行中） */
  running: boolean;
}): React.JSX.Element {
  const note = (testId: string, text: React.ReactNode): React.JSX.Element => (
    <div data-testid={testId} className="text-text-3 px-3 py-2 text-[12px]">
      {text}
    </div>
  );
  if (childEntries.length === 0) {
    if (load === 'loading') return note('tool-children-loading', '正在加载子 agent 的过程…');
    if (load === 'error') {
      return note(
        'tool-children-error',
        <>
          加载子 agent 的过程失败{' '}
          <button type="button" className="text-brand underline" onClick={onRetry}>
            重试
          </button>
        </>,
      );
    }
    if (running) return note('tool-children-empty', '子 agent 还没有调用工具');
    if (entry.childrenLoaded === true) return note('tool-children-empty', '没有找到子 agent 的过程记录');
    if (onLoadChildren === undefined && historyUnknown) {
      return note('tool-children-empty', '正在获取 agent 信息，稍后再展开查看子 agent 的过程');
    }
    return note('tool-children-empty', '没有子 agent 的过程记录（agent 版本过旧，无法回看）');
  }
  const hidden = childTotal(entry) - childEntries.length;
  return (
    <ol data-testid="tool-children" className="flex flex-col gap-1.5 px-2 py-2 pl-4">
      {load === 'loading' && (
        <li data-testid="tool-children-loading" className="text-text-3 text-[11.5px]">
          正在补全子 agent 的完整过程…
        </li>
      )}
      {load === 'error' && (
        <li data-testid="tool-children-error" className="text-text-3 text-[11.5px]">
          补全子 agent 的过程失败{' '}
          <button type="button" className="text-brand underline" onClick={onRetry}>
            重试
          </button>
        </li>
      )}
      {hidden > 0 && (
        <li data-testid="tool-children-hidden" className="text-text-3 text-[11.5px]">
          …更早的 {hidden} 次工具调用未保留
        </li>
      )}
      {childEntries.map((child) => (
        <ToolCard
          key={child.id}
          entry={child}
          runningElapsedMs={null}
          onLoadChildren={onLoadChildren}
          depth={depth + 1}
          historyUnknown={historyUnknown}
        />
      ))}
    </ol>
  );
}

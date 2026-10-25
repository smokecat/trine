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
 * ## 子 agent（Agent / Task，subagent-view）
 *
 * 子 agent 里的工具调用挂在这张卡的 `children` 下（reducer 按 parentToolUseId 挂）。
 * - 折叠态：运行中且已有子工具时多一行「N 次工具调用 · 当前：<子工具 参数>」；
 *   完成后右侧的 resultSummary（agent 给的「✓ N 次工具调用 · 耗时」）已经说清楚了。
 * - 展开：子工具卡列表（复用本组件、缩进一级，嵌套同理）+ 报告预览。
 * - 历史回看里的卡没有实时收到的子工具：展开时经 `onLoadChildren` 向 agent 拉子转录
 *   （版本不够时调用方不给这个回调）；加载中 / 失败 / 空结果都有一行提示。
 */
import { useState } from 'react';
import { FileSearchIcon } from 'lucide-react';
import { useFileLinks } from '@/components/files/file-links.ts';
import type { ToolEntry } from '@/lib/reducer.ts';
import { formatClockSeconds, formatDuration, formatSeconds } from '@/lib/format.ts';
import { childTotal, currentChild, isSubagentTool } from '@/lib/tool-tree.ts';
import { cn } from '@/lib/utils.ts';

/** 工具名 → 行首图标，与原型一致（未知工具回落扳手） */
const TOOL_ICON: Record<string, string> = {
  Bash: '🔧',
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

export function ToolCard({
  entry,
  runningElapsedMs,
  onLoadChildren,
  depth = 0,
  historyUnknown = false,
}: {
  entry: ToolEntry;
  /** 运行中工具的已耗时（来自心跳快照 + 本地插值）；不在运行或没有心跳时为 null */
  runningElapsedMs: number | null;
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
  const canLoad = sub && onLoadChildren !== undefined && entry.childrenLoaded !== true && status !== undefined && !live;
  const expandable = hasPreview || (sub && (children.length > 0 || canLoad || entry.childrenLoaded === true || status === undefined));
  const progress = subagentProgressText(entry);

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
          <span className="shrink-0 font-semibold">{entry.toolName}</span>
          <span className="text-text-2 min-w-0 flex-1 truncate font-mono text-[12px]">
            {entry.argSummary}
          </span>
          {status === undefined ? (
            <span title={toolTimeTitle(entry)} className="text-brand tabular shrink-0 font-mono text-[12px]">
              <span aria-hidden className="mr-1 inline-block motion-safe:animate-spin">
                ◠
              </span>
              {/* 已耗时取自心跳里的 currentTool.elapsedMs（agent 自己算的）+ 本地插值：
                  entry.ts 是 agent 时钟，直接拿本地 now 去减会被两端时钟差打歪 */}
              {runningElapsedMs === null ? '运行中' : formatSeconds(runningElapsedMs)}
            </span>
          ) : (
            <span
              data-testid="tool-result"
              title={toolTimeTitle(entry)}
              className={cn('tabular shrink-0 font-mono text-[12px]', STATUS_CLASS[status])}
            >
              {resultText(entry, status)}
            </span>
          )}
        </button>
        {filePath !== undefined && (
          <button
            type="button"
            data-testid="tool-open-file"
            title={`预览 ${filePath}`}
            aria-label={`预览 ${filePath}`}
            onClick={() => fileLinks?.open(filePath)}
            className="text-text-3 hover:text-text shrink-0 self-stretch px-2.5"
          >
            <FileSearchIcon className="size-3.5" />
          </button>
        )}
      </div>
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
          {sub && (
            <SubagentChildren
              entry={entry}
              childEntries={children}
              load={load}
              onRetry={fetchChildren}
              onLoadChildren={onLoadChildren}
              depth={depth}
              historyUnknown={historyUnknown}
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
}: {
  entry: ToolEntry;
  childEntries: ToolEntry[];
  load: LoadState;
  onRetry: () => void;
  onLoadChildren: ((toolUseId: string) => Promise<void>) | undefined;
  depth: number;
  historyUnknown: boolean;
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
    if (entry.status === undefined) return note('tool-children-empty', '子 agent 还没有调用工具');
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

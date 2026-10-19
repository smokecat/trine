/**
 * 时间线：判别式渲染 + 自动跟随底部。
 *
 * ## 判别式渲染（NOTES.chat 第 1 条）
 *
 * `TimelineEntry` 是 zod 判别联合，这里 switch 到底——TS 会保证漏了哪种
 * kind 就编译不过。每种条目一个独立组件，**不共享一条 markdown 管道**。
 *
 * ## 自动跟随
 *
 * 默认贴着底部走（流式回复要一直能看见新字）；用户一旦上滑就停止跟随并
 * 给一个「↓ 回到底部」——远程场景里翻历史时被强行拽回底部比不跟随更烦。
 * 判据是「距底部 <80px 即视为在底部」，避免亚像素与惯性滚动的抖动。
 *
 * 虚拟滚动不做（方案：时间线上限 500 条/会话，够用且不值那份复杂度）。
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownIcon } from 'lucide-react';
import { rewindTargetId, type TimelineEntry, type ToolEntry, type UserEntry } from '@/lib/reducer.ts';
import { cn } from '@/lib/utils.ts';
import { AssistantMessage, SyncingRow, SystemNote, UserMessage } from './Messages.tsx';
import { PermissionCard, type PermissionDecision } from './PermissionCard.tsx';
import { ToolCard } from './ToolCard.tsx';
import { AskQuestionCard } from './AskQuestionCard.tsx';
import { isAskQuestionRequest } from './ask-question-model.ts';
import { PlanCard } from './PlanCard.tsx';
import { isPlanRequest } from './plan-model.ts';
import { DoneCard, FatalCard } from './RunCards.tsx';
import type { UserEntryAction } from './entry-status.ts';
import type { RunStateEntry } from './entry-kinds.ts';

/** 距底部多近算「在底部」 */
const FOLLOW_THRESHOLD_PX = 80;

/**
 * run.state 迁移的一行说明；running/idle 不进时间线（pill 已经在头部了）。
 *
 * 例外：`running` 带 `detail` 是**自发轮**的开始标记（协议 RunStateSchema）——
 * 后台任务完成后 CLI 自己开的一轮，没有用户消息在前面，不标出来的话那段回复
 * 看着像是凭空长在上一轮完成卡后面。
 */
export function runStateNote(entry: RunStateEntry): { text: string; tone: 'muted' | 'amber'; testId: string } | null {
  switch (entry.state) {
    case 'stopped':
      return { text: `⊘ 已停止${entry.detail ? ` · ${entry.detail}` : ''} —— 已产出内容保留，可继续发消息`, tone: 'muted', testId: 'entry-run-state' };
    case 'error':
      return { text: `⚠ 会话出错${entry.detail ? ` · ${entry.detail}` : ''}`, tone: 'amber', testId: 'entry-run-state' };
    case 'running':
      return entry.detail === undefined || entry.detail === ''
        ? null
        : { text: `⟳ ${entry.detail}，Claude 继续`, tone: 'muted', testId: 'entry-run-trigger' };
    default:
      return null;
  }
}

export interface TimelineHandlers {
  onUserAction: (action: UserEntryAction, entry: UserEntry) => void;
  onRespondPermission: (requestId: string, decision: PermissionDecision) => void;
  onResumeAt: (at: number) => void;
  onStop: () => void;
  /** 拉子 agent 过程并挂到父工具卡（subagent.history.request）；不给 = 不支持回看 */
  onLoadSubagentHistory?: (toolUseId: string) => Promise<void>;
}

/**
 * 工具条目 id → 参数摘要（含任意深度的子条目）：子 agent 权限卡的来源标注用。
 * 父卡的 argSummary 就是 Agent/Task 的 description（agent 的 summarize.ts）。
 */
export function toolLabels(entries: readonly TimelineEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (tools: readonly ToolEntry[]): void => {
    for (const t of tools) {
      out.set(t.id, t.argSummary);
      if (t.children !== undefined) walk(t.children);
    }
  };
  walk(entries.filter((e): e is ToolEntry => e.kind === 'tool'));
  return out;
}

/** 权限条目的来源标注：主线程 undefined；子 agent 的给父卡描述（找不到父卡 ''） */
export function subagentSourceOf(entry: TimelineEntry, labels: ReadonlyMap<string, string>): string | undefined {
  if (entry.kind !== 'permission' || entry.parentToolUseId === undefined) return undefined;
  return labels.get(entry.parentToolUseId) ?? '';
}

export function Timeline({
  entries,
  syncing,
  deviceId,
  now,
  runningToolId,
  runningElapsedMs,
  handlers,
  extra,
  head,
  onEntryRender,
  planOptions = true,
  subagentHistory = false,
  onRewind,
}: {
  entries: TimelineEntry[];
  syncing: 'normal' | 'backfill' | undefined;
  deviceId: string | null;
  /** 由 ChatView 的 1s tick 驱动，供权限卡「已等待 N 秒」计时 */
  now: number;
  /**
   * 心跳里正在跑的那个工具的 toolUseId（没有就 null）。
   *
   * 刻意拆成**两个 primitive prop** 而不是一个 `{toolUseId, elapsedMs}` 对象
   * （评审 N4）：对象字面量每次渲染都是新引用，传给每一个 `Entry` 会把
   * `memo` 的浅比较全部打穿——恰恰在「有工具在跑」（每秒 tick）这个
   * m4 想优化的场景里，500 条时间线每秒整表重画。拆开之后只有 toolUseId
   * 对得上的那一条拿到会变的 `runningElapsedMs`，其余条目拿到常量。
   */
  runningToolId: string | null;
  /** 上面那个工具的本地插值耗时；`runningToolId` 为 null 时无意义 */
  runningElapsedMs: number;
  handlers: TimelineHandlers;
  /** 追加在末尾的本地卡片（/status /mcp 信息卡） */
  extra?: React.ReactNode;
  /** 放在最顶部的行（历史回看：加载中 / 加载更早），须是 `<li>` */
  head?: React.ReactNode;
  /** 测试钩子：每个 `Entry` 真的重渲染一次就调一次（见 timeline-render.test.tsx） */
  onEntryRender?: (entryId: string) => void;
  /** agent 是否支持计划卡的附言 / 切模式（≥ 0.6.0，见 PlanCard）；缺省支持 */
  planOptions?: boolean;
  /** agent 是否支持子 agent 过程回看（≥ 0.8.0）；null = 还不知道（machine.info 未到）；缺省不支持 */
  subagentHistory?: boolean | null;
  /**
   * 回退到某条用户消息之前（agent ≥ 0.9.0）。不给 = 现在不能回退（会话忙 / 离线 /
   * 版本过旧），用户消息上不出入口。引用要稳定，否则会打穿 Entry 的 memo。
   */
  onRewind?: ((entry: UserEntry) => void) | undefined;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLOListElement>(null);
  const [following, setFollowing] = useState(true);
  // 只有有子 agent 权限卡时才需要（多数时间线一张都没有，省掉整树遍历）
  const labels = useMemo(
    () => (entries.some((e) => e.kind === 'permission' && e.parentToolUseId !== undefined) ? toolLabels(entries) : new Map<string, string>()),
    [entries],
  );
  const loadChildren = subagentHistory === true ? handlers.onLoadSubagentHistory : undefined;
  const historyUnknown = subagentHistory === null;

  const isAtBottom = useCallback((el: HTMLElement): boolean => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    setFollowing(true);
  }, []);

  // 内容变了就贴底——用 layout effect，避免先画在半路再跳
  useLayoutEffect(() => {
    if (!following) return;
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  });

  // 前插保位：「加载更早」把历史插到开头时，用户正停在上面翻看（不在跟随），
  // 视口不能被新内容顶走——按内容增高量把 scrollTop 补回去。判据是首条目的
  // key 变了（前插）；尾部追加不动首条目，不会误触发。浏览器原生的 scroll
  // anchoring 会与这里重复补偿，所以列表上关掉了 overflow-anchor。
  const anchorRef = useRef<{ firstKey: string | undefined; height: number }>({ firstKey: undefined, height: 0 });
  const firstKey = entries[0] === undefined ? undefined : `${entries[0].kind}:${entries[0].id}`;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const prev = anchorRef.current;
    if (!following && prev.firstKey !== undefined && firstKey !== prev.firstKey) {
      el.scrollTop += el.scrollHeight - prev.height;
    }
    anchorRef.current = { firstKey, height: el.scrollHeight };
  });

  // 流式期间 entries 引用不变但内容在长，尺寸变化也要跟
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => {
      if (following && scrollRef.current !== null) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [following, entries.length]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/*
        `[&>*]:shrink-0` 不能省：滚动容器是 flex 列，子项默认可收缩；带
        `overflow-hidden` 的卡片（ToolCard / PermissionCard）的 min-height:auto
        会退化成 0，内容一超出一屏就被压成只剩边框的一条线——权限卡的按钮
        跟着消失，手机上根本无从批准。
      */}
      <ol
        ref={scrollRef}
        data-testid="timeline"
        data-following={String(following)}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3.5 [overflow-anchor:none] [&>*]:shrink-0"
        onScroll={(e) => {
          const atBottom = isAtBottom(e.currentTarget);
          setFollowing((prev) => (prev === atBottom ? prev : atBottom));
        }}
      >
        {head}
        {syncing !== undefined && <SyncingRow mode={syncing} />}
        {entries.map((entry) => (
          <Entry
            key={`${entry.kind}:${entry.id}`}
            entry={entry}
            deviceId={deviceId}
            planOptions={planOptions}
            // 每秒的 tick 只喂给**真的按秒走字**的两种条目（评审 m4）：
            // pending 的权限卡（「已等待 N 秒」）与撤回中的用户消息。
            // 其余条目拿到的是常量 0，`memo` 得以把它们挡在重渲染之外
            // ——否则 500 条时间线每秒整表重画。
            now={needsTick(entry) ? now : 0}
            // 只有正在跑的那个工具条目才拿会变的耗时（评审 N4）；
            // 其余条目恒拿 -1，`memo` 得以把它们挡在重渲染之外
            runningElapsedMs={
              entry.kind === 'tool' && entry.status === undefined && entry.id === runningToolId
                ? runningElapsedMs
                : -1
            }
            handlers={handlers}
            onEntryRender={onEntryRender}
            subagentSource={subagentSourceOf(entry, labels)}
            onLoadChildren={loadChildren}
            historyUnknown={historyUnknown}
            onRewind={entry.kind === 'user' && rewindTargetId(entry) !== undefined ? onRewind : undefined}
          />
        ))}
        {extra}
      </ol>
      {!following && (
        <button
          type="button"
          data-testid="jump-to-bottom"
          className={cn(
            'border-border-strong bg-surface text-text-2 absolute right-3.5 bottom-3 flex items-center gap-1',
            'rounded-full border px-3 py-1.5 text-[12px] shadow-[var(--shadow-card)]',
          )}
          onClick={() => scrollToBottom('smooth')}
        >
          <ArrowDownIcon className="size-3.5" />
          回到底部
        </button>
      )}
    </div>
  );
}

/** 这条目是否需要每秒的 tick（决定它要不要跟着计时器重渲染） */
function needsTick(entry: TimelineEntry): boolean {
  if (entry.kind === 'permission') return entry.state === 'pending';
  if (entry.kind === 'user') return entry.recallingAt !== undefined;
  return false;
}

const Entry = memo(function Entry({
  entry,
  deviceId,
  now,
  runningElapsedMs,
  handlers,
  onEntryRender,
  planOptions,
  subagentSource,
  onLoadChildren,
  historyUnknown,
  onRewind,
}: {
  entry: TimelineEntry;
  deviceId: string | null;
  planOptions: boolean;
  /** 子 agent 发起的权限类卡片的来源（见 subagentSourceOf）；primitive，不打穿 memo */
  subagentSource: string | undefined;
  /** 子 agent 过程回看；引用来自 memo 过的 handlers，稳定 */
  onLoadChildren: ((toolUseId: string) => Promise<void>) | undefined;
  historyUnknown: boolean;
  /** 只有能回退的用户条目才拿到它（其余 undefined，不打穿 memo） */
  onRewind: ((entry: UserEntry) => void) | undefined;
  now: number;
  /** 这一条正在跑时的插值耗时；`-1` = 不是当前运行的工具（评审 N4） */
  runningElapsedMs: number;
  handlers: TimelineHandlers;
  onEntryRender?: (entryId: string) => void;
}): React.JSX.Element | null {
  onEntryRender?.(`${entry.kind}:${entry.id}`);
  switch (entry.kind) {
    case 'user':
      return <UserMessage entry={entry} now={now} onAction={handlers.onUserAction} onRewind={onRewind} />;
    case 'assistant':
      return <AssistantMessage entry={entry} />;
    case 'tool':
      // 运行中工具的耗时只在它就是心跳里那个 currentTool 时才给
      // （toolUseId 的匹配在上游 map 里做，这里 -1 即「不是它」）
      return (
        <ToolCard
          entry={entry}
          runningElapsedMs={runningElapsedMs < 0 ? null : runningElapsedMs}
          onLoadChildren={onLoadChildren}
          historyUnknown={historyUnknown}
        />
      );
    case 'permission':
      // AskUserQuestion / ExitPlanMode 也走权限通道；input 解析得通才画专用卡，
      // 否则回落普通权限卡（至少能看全参数、能拒绝）
      if (isPlanRequest(entry.toolName, entry.input)) {
        return (
          <PlanCard
            entry={entry}
            deviceId={deviceId}
            now={now}
            supportsOptions={planOptions}
            onRespond={(decision) => handlers.onRespondPermission(entry.id, decision)}
            subagentSource={subagentSource}
          />
        );
      }
      if (isAskQuestionRequest(entry.toolName, entry.input)) {
        return (
          <AskQuestionCard
            entry={entry}
            deviceId={deviceId}
            now={now}
            onRespond={(decision) => handlers.onRespondPermission(entry.id, decision)}
            subagentSource={subagentSource}
          />
        );
      }
      return (
        <PermissionCard
          entry={entry}
          deviceId={deviceId}
          now={now}
          onRespond={(decision) => handlers.onRespondPermission(entry.id, decision)}
          subagentSource={subagentSource}
        />
      );
    case 'run_state': {
      const note = runStateNote(entry);
      return note === null ? null : (
        <SystemNote tone={note.tone} testId={note.testId}>
          {note.text}
        </SystemNote>
      );
    }
    case 'run_done':
      return <DoneCard entry={entry} />;
    case 'error':
      return entry.level === 'fatal' ? (
        <FatalCard entry={entry} onResumeAt={handlers.onResumeAt} onStop={handlers.onStop} />
      ) : (
        // 瞬时错误只留一行痕迹——agent 已经在自动 resume 了
        <SystemNote testId="entry-transient">
          <span aria-hidden>⚡ </span>
          已自动恢复（第 {entry.attempt ?? '?'} 次）：{entry.message}
        </SystemNote>
      );
  }
});

/**
 * 会话卡（原型 `.sess`：三行 r1/r2/r3）。列表页与 PC 侧栏共用同一个组件，
 * 靠 `variant` 切紧凑（原型 `.desk-side .sess{padding:9px 11px}`）。
 *
 * r1：状态 pill · 标题 · 相对时间
 * r2：lastEvent 单行摘要（等待批准 ✋ amber、运行中 🔧）
 * r3：机器名 · cwd 尾段 · 成本
 *
 * 紧凑变体省掉 r3 的成本（侧栏 300px 放不下且不是导航信息），机器名在
 * 「全部」过滤时才显示——选定了机器时每行都印同一个名字是噪音。
 *
 * ## stretched-link 结构（session-list-v2 §4.4，评审 M6）
 *
 * 容器 div（relative，承担描边/底色）里放两个**兄弟**：铺满卡片的 NavLink
 * 与右上角 absolute 的「⋯」菜单槽。按钮绝不能嵌进 `<a>`：那是非法的交互
 * 内容嵌套（读屏把整卡读成一个链接），而且 Radix 菜单项虽然渲染在 portal
 * 里，React 合成事件仍沿**组件树**冒泡——嵌在 NavLink 里就会冒到它的
 * onClick 触发导航。做成兄弟后，菜单事件冒泡到的是没有任何处理器的容器。
 */
import { NavLink } from 'react-router';
import type { SessionMeta } from '@trine/core';
import { StatePill } from '@/components/shell/StatusDot.tsx';
import { formatCost, formatRelativeTime, truncate } from '@/lib/format.ts';
import { cn } from '@/lib/utils.ts';
import { lastEventPrefix, sessionTitle, shortCwd } from './sorting.ts';

export function SessionRow({
  machineId,
  machineName,
  meta,
  variant = 'full',
  showMachine = true,
  active = false,
  now,
  menu,
  linkState,
}: {
  machineId: string;
  machineName: string;
  meta: SessionMeta;
  variant?: 'full' | 'compact';
  /** 「全部」过滤下才有意义 */
  showMachine?: boolean;
  /** PC 侧栏：当前打开的会话高亮 */
  active?: boolean;
  /** 注入「现在」便于测试与统一刷新节拍 */
  now?: number;
  /** 右上角「⋯」菜单（由 SessionList 给；不给就不占位） */
  menu?: React.ReactNode;
  /** 跳转时带的 location.state（归档视图带 `{from:'/archived'}`，聊天页据此决定返回到哪） */
  linkState?: { from: string };
}): React.JSX.Element {
  const compact = variant === 'compact';
  const attn = meta.state === 'waiting_permission';
  const prefix = lastEventPrefix(meta.state);

  return (
    <div
      data-testid="session-row"
      data-session-id={meta.sessionId}
      data-state={meta.state}
      data-archived={meta.archived === true || undefined}
      className={cn(
        'border-border bg-surface hover:border-border-strong relative rounded-[14px] border transition-colors',
        // 等待批准：amber 描边 + 软底（原型 .sess.attn）
        attn && 'border-amber-border bg-amber-soft',
        active && 'border-brand-border bg-brand-soft',
      )}
    >
      <NavLink
        to={`/s/${machineId}/${meta.sessionId}`}
        {...(linkState === undefined ? {} : { state: linkState })}
        data-testid="session-row-link"
        className={cn(
          'focus-visible:ring-ring/50 block rounded-[14px] outline-none focus-visible:ring-3',
          compact ? 'px-2.5 py-2' : 'px-3.5 py-3',
          // 给右上角「⋯」让位，免得盖住相对时间
          menu !== undefined && (compact ? 'pr-8' : 'pr-9'),
        )}
      >
        <div className={cn('flex items-center gap-2', compact ? 'mb-0.5' : 'mb-1')}>
          <StatePill state={meta.state} waitingFor={meta.waitingFor} />
          {/* 空闲但子进程里还有后台任务在跑（agent ≥ 0.7.0 的 bgRunning）：弱提示，不当成运行中 */}
          {meta.bgRunning !== undefined && meta.bgRunning > 0 && meta.state !== 'running' && meta.state !== 'waiting_permission' && (
            <span data-testid="bg-running-badge" className="text-text-3 shrink-0 text-[11px]">
              后台 {meta.bgRunning}
            </span>
          )}
          <span className={cn('min-w-0 flex-1 truncate font-semibold', compact ? 'text-sm' : 'text-[14px]')}>
            {sessionTitle(meta)}
          </span>
          <span className="text-text-3 tabular shrink-0 text-[11.5px]">
            {formatRelativeTime(meta.lastActivityAt, now)}
          </span>
        </div>

        <div
          className={cn(
            'flex items-baseline gap-1.5 truncate text-[12.5px]',
            attn ? 'text-amber' : 'text-text-2',
          )}
        >
          {prefix !== '' && <span aria-hidden>{prefix}</span>}
          <span className="min-w-0 flex-1 truncate">
            {meta.lastEvent === undefined || meta.lastEvent === ''
              ? '—'
              : truncate(meta.lastEvent, compact ? 44 : 80)}
          </span>
        </div>

        <div className={cn('flex items-center gap-2', compact ? 'mt-1' : 'mt-1.5')}>
          <span className="text-text-3 min-w-0 flex-1 truncate font-mono text-[11px]">
            {showMachine ? `${machineName} · ` : ''}
            {shortCwd(meta.cwd)}
          </span>
          {!compact && (
            <span className="text-text-3 tabular shrink-0 font-mono text-[11px]">
              {formatCost(meta.costUsd)}
            </span>
          )}
        </div>
      </NavLink>
      {menu !== undefined && (
        <div className={cn('absolute z-10', compact ? 'top-1 right-1' : 'top-2 right-1.5')}>{menu}</div>
      )}
    </div>
  );
}

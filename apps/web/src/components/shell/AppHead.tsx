/**
 * 页头——原型 `.app-head`：返回 · 标题 · 元信息行 · 右侧槽位。
 *
 * 「各视图自带页头」是方案定的（移动端双栈导航没有全局 tab bar，返回按钮
 * 属于视图自己）。本组件只提供统一的排版与返回行为，内容全由视图给：
 *
 * ```tsx
 * <AppHead
 *   back="/"                        // 给了才显示返回箭头；PC 上自动隐藏
 *   title={meta.title}
 *   meta={<button …>~/repo · opus · default ▾</button>}   // 元信息行槽位
 *   right={<ChipLabel>…</ChipLabel>}
 * />
 * ```
 *
 * `back` 在 PC（≥900px）默认不显示——侧栏常驻，没有「回到列表」这回事。
 * 视图若确实需要（比如机器详情回机器列表），传 `backOnDesktop`。
 */
import { NavLink } from 'react-router';
import { ChevronLeftIcon } from 'lucide-react';
import { cn } from '@/lib/utils.ts';
import { useIsDesktop } from './use-media-query.ts';

export function AppHead({
  back,
  backOnDesktop = false,
  backLabel = '返回',
  title,
  meta,
  right,
  className,
}: {
  back?: string;
  backOnDesktop?: boolean;
  backLabel?: string;
  title: React.ReactNode;
  /** 元信息行（原型 .t2）：cwd · model · mode ▾ 之类 */
  meta?: React.ReactNode;
  /** 右侧槽位：机器 chip、更多菜单 */
  right?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const isDesktop = useIsDesktop();
  const showBack = back !== undefined && (backOnDesktop || !isDesktop);

  return (
    <header
      data-testid="app-head"
      className={cn(
        'border-border bg-background flex shrink-0 items-center gap-2.5 border-b px-3.5 pt-3 pb-2.5',
        className,
      )}
    >
      {showBack && (
        <NavLink
          to={back}
          aria-label={backLabel}
          className="text-text-2 hover:text-text -ml-1 shrink-0 rounded p-0.5 transition-colors"
        >
          <ChevronLeftIcon className="size-5" />
        </NavLink>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold">{title}</div>
        {meta !== undefined && <div className="text-text-3 truncate font-mono text-[11.5px]">{meta}</div>}
      </div>
      {right}
    </header>
  );
}

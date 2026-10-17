/**
 * 横幅细条的通用外观（原型 `.reconnect-bar` / `.offline-banner`）。
 *
 * 横幅通栏压在页面顶部，所以字号小、只有一行、动作是文字按钮——它要
 * 「告知并给出路」，不能抢走当前任务的注意力（原型 `NOTES.states`：
 * 「顶部细条常驻……不弹窗不打断阅读」）。
 */
import { cn } from '@/lib/utils.ts';

export type BarTone = 'amber' | 'red' | 'neutral';

const TONE: Record<BarTone, string> = {
  amber: 'border-amber-border bg-amber-soft text-amber',
  red: 'border-red bg-red-soft text-red',
  neutral: 'border-border-strong bg-surface-2 text-text-2',
};

export function Bar({
  tone = 'amber',
  icon,
  children,
  actions,
  testId,
}: {
  tone?: BarTone;
  icon?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className={cn(
        'tabular flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-center text-[12.5px]',
        TONE[tone],
      )}
    >
      {icon}
      <span className="min-w-0">{children}</span>
      {actions}
    </div>
  );
}

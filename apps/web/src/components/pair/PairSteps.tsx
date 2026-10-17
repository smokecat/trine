/**
 * 配对页的三步骨架（原型 `.step` / `.step-n` / `.step-body`）与代码块。
 */
import { cn } from '@/lib/utils.ts';

export function Step({
  n,
  active,
  title,
  desc,
  children,
}: {
  n: number;
  active: boolean;
  title: string;
  desc?: React.ReactNode;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="mb-5 flex gap-3" data-testid="pair-step" data-step={n} data-active={active}>
      <div
        aria-hidden
        className={cn(
          'flex size-[26px] shrink-0 items-center justify-center rounded-full text-[13px] font-semibold',
          active ? 'bg-brand text-brand-fg' : 'bg-surface-3 text-text-2',
        )}
      >
        {n}
      </div>
      <div className="min-w-0 flex-1">
        <div className="pt-0.5 font-semibold">{title}</div>
        {desc !== undefined && <div className="text-text-2 mt-1 text-[13px]">{desc}</div>}
        {children !== undefined && <div className="mt-2">{children}</div>}
      </div>
    </section>
  );
}

/** 原型 `.codeblock`：可横向滚动的等宽命令块 */
export function CodeBlock({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <pre className="bg-code-bg border-border overflow-x-auto rounded-[10px] border px-3 py-2.5 font-mono text-xs whitespace-pre">
      {children}
    </pre>
  );
}

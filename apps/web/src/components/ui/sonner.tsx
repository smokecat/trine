/**
 * shadcn sonner（Toaster）。
 *
 * 与上游模板的唯一差别：上游从 `next-themes` 读主题，trine 没有（也不需要）
 * next-themes——主题在 `src/app/theme.ts`，所以这里改成读我们自己的
 * `useResolvedTheme()`，其余（图标、CSS 变量映射、classNames）保持原样。
 */
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from 'lucide-react';
import { useResolvedTheme } from '@/app/theme.ts';

const Toaster = ({ ...props }: ToasterProps): React.JSX.Element => {
  // sonner 只认 'light' | 'dark' | 'system'；我们给它已解析的具体值，
  // 免得它自己再读一遍 prefers-color-scheme 与页面主题打架。
  const theme = useResolvedTheme();

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };

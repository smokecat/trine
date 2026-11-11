/**
 * dockview 工作区的懒加载 + 独立错误边界（主包里）。
 *
 * - React.lazy 会缓存 rejected promise：加载失败后再渲染同一个 lazy 组件仍然报错，
 *   所以「重试」= 换一个新的 lazy 实例（attempt 计数）。
 * - 渲染出错（如坏布局让 dockview 抛错）也落到这里：可以重试，或「重置布局」（丢掉布局、
 *   按 tab 元数据重建单组）。聊天不受影响。
 */
import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button.tsx';
import type { WorkspaceDockProps } from './WorkspaceDock.tsx';

type DockModule = { default: React.ComponentType<WorkspaceDockProps> };

export const loadWorkspace = (): Promise<DockModule> => import('./WorkspaceEntry.tsx');

let prefetched = false;
/** 桌面空闲时预取 chunk（只发一次；失败无妨，真正展开时再加载并可重试） */
export function prefetchWorkspace(): void {
  if (prefetched) return;
  prefetched = true;
  loadWorkspace().catch(() => {
    prefetched = false;
  });
}

class Boundary extends Component<{ fallback: (error: unknown, reset: () => void) => ReactNode; onReset: () => void; children: ReactNode }, { error: unknown; failed: boolean }> {
  override state = { error: null as unknown, failed: false };
  static getDerivedStateFromError(error: unknown): { error: unknown; failed: boolean } {
    return { error, failed: true };
  }
  override render(): ReactNode {
    if (this.state.failed) {
      return this.props.fallback(this.state.error, () => {
        this.setState({ error: null, failed: false });
        this.props.onReset();
      });
    }
    return this.props.children;
  }
}

export function LazyWorkspace(
  props: WorkspaceDockProps & {
    load?: () => Promise<DockModule>;
    /** 错误时「重置布局」：控制器丢掉布局（保留 tab），随后重新挂载 */
    onResetLayout: () => void;
  },
): React.JSX.Element {
  const { load = loadWorkspace, onResetLayout, ...rest } = props;
  const [attempt, setAttempt] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const Dock = useMemo(() => lazy(load), [attempt, load]);
  return (
    <Boundary
      key={attempt}
      onReset={() => setAttempt((a) => a + 1)}
      fallback={(_error, reset) => (
        <div role="alert" data-testid="ws-error" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-[13px]">
          <div className="text-text-2">工作区加载或显示出错了</div>
          <div className="flex gap-2">
            <Button size="sm" data-testid="ws-retry" onClick={reset}>
              重试
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="ws-reset-layout"
              onClick={() => {
                onResetLayout();
                reset();
              }}
            >
              重置布局
            </Button>
          </div>
        </div>
      )}
    >
      <Suspense fallback={<div data-testid="ws-loading" className="text-text-3 p-6 text-[13px]">正在加载工作区…</div>}>
        <Dock {...rest} />
      </Suspense>
    </Boundary>
  );
}

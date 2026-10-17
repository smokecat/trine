/**
 * 应用外壳。
 *
 * ## 两套导航（原型的分界：900px）
 *
 * - **移动端（<900px）**：双栈导航——列表页 ⇄ 聊天页整页切换，返回靠各视图
 *   自带的 `AppHead back=…`。**底部没有 tab bar**（原型如此：会话是主任务，
 *   机器/设置是低频入口，塞进列表页头部与侧栏底部即可）。
 * - **PC（≥900px）**：左 300px 常驻侧栏 + 右主区。侧栏里的机器过滤与会话
 *   列表将来复用列表页的同一套组件（2b shell 组），此刻是占位实现。
 *
 * PC 上路由到 `/` 时主区显示什么？照原型：主区是**聊天**，侧栏才是列表。
 * 但还没选中会话时聊天区没内容，所以 `/` 在 PC 上主区给一个空态提示，
 * 会话列表的完整形态（成本、lastEvent、排序分组）仍由侧栏承担。
 * 移动端 `/` 就是完整列表页，不受影响。
 *
 * ## 启动门
 *
 * booting / error / follower 三态整页接管，不渲染外壳——这些状态下没有
 * client，侧栏的数据源也不存在。
 */
import { createContext, useContext, useMemo, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { Toaster } from '@/components/ui/sonner.tsx';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { Button } from '@/components/ui/button.tsx';
import { BannerStack } from '@/components/shell/BannerStack.tsx';
import { Sidebar } from '@/components/shell/Sidebar.tsx';
import { useIsDesktop } from '@/components/shell/use-media-query.ts';
import { useSessionListAutoRefresh } from '@/components/list/use-session-refresh.ts';
import type { StatusFilter } from '@/components/list/filtering.ts';
import { takeOver, useRuntime, useTrine } from './runtime.ts';

/** 从页遮罩：整页接管，不渲染外壳 */
export function LeaderOverlay(): React.JSX.Element {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="text-brand font-mono text-3xl" aria-hidden>
        ◈
      </div>
      <h1 className="text-xl font-semibold">trine 已在另一标签页运行</h1>
      <p className="text-text-2 text-sm">
        同一浏览器只允许一个标签页保持连接，避免序号冲突与重复补发。
      </p>
      <Button onClick={() => takeOver()} data-testid="take-over">
        在此接管
      </Button>
    </main>
  );
}

function BootGate({ phase, error }: { phase: 'booting' | 'error'; error: string | null }): React.JSX.Element {
  if (phase === 'booting') {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <div className="text-text-3 flex flex-col items-center gap-3 text-sm">
          <span className="text-brand font-mono text-3xl motion-safe:animate-pulse" aria-hidden>
            ◈
          </span>
          启动中…
        </div>
      </main>
    );
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 p-6 text-sm">
      <h1 className="text-red text-lg font-semibold">启动失败</h1>
      <pre className="bg-code-bg border-border overflow-x-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap">
        {error}
      </pre>
      <p className="text-text-2">
        若提示本地身份损坏：清除本站点数据后刷新（会需要重新配对）。
      </p>
    </main>
  );
}

/**
 * 机器过滤的选中态。值本来就住在 Layout（2a 的注释已写明「为了 2b 把列表页
 * 接上来之后两边能共享同一个过滤值」），这里只是把它开放给 `<Outlet>` 下的
 * 视图——移动端列表页拿不到侧栏的 props，只能走 context。
 */
type MachineFilterContextValue = readonly [string | null, (machineId: string | null) => void];
const MachineFilterContext = createContext<MachineFilterContextValue>([null, () => {}]);

export function useMachineFilter(): MachineFilterContextValue {
  return useContext(MachineFilterContext);
}

/**
 * 列表的搜索词与状态 chip（session-list-v2 §4.2，评审 S4）。与机器过滤同处
 * 持有：手机上点进会话再返回，列表页会重新挂载，放在视图里筛选就丢了；
 * PC 上侧栏与主区的归档视图也共用同一份值。
 */
export interface ListFilters {
  search: string;
  setSearch: (search: string) => void;
  status: StatusFilter;
  setStatus: (status: StatusFilter) => void;
}
const ListFiltersContext = createContext<ListFilters>({
  search: '',
  setSearch: () => {},
  status: 'all',
  setStatus: () => {},
});

export function useListFilters(): ListFilters {
  return useContext(ListFiltersContext);
}

/** PC 上 `/` 的主区空态——侧栏已经是列表了，主区等着选会话 */
function EmptyMain(): React.JSX.Element {
  return (
    <div className="text-text-3 flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center text-sm">
      <span className="text-brand/40 font-mono text-4xl" aria-hidden>
        ◈
      </span>
      从左侧选一个会话，或新建一个
    </div>
  );
}

export function Layout(): React.JSX.Element {
  // 会话列表的自动拉取挂在这一层，两套布局共享：PC 的 `/` 渲染的是
  // EmptyMain 不是 SessionListView，挂在视图里 PC 上就永远不会发（评审 M1）
  useSessionListAutoRefresh();
  const runtime = useRuntime();
  const leader = useTrine((s) => s.leader);
  const paired = useTrine((s) => s.paired);
  const isDesktop = useIsDesktop();
  const location = useLocation();
  // 侧栏机器过滤的选中态。放在外壳里而不是侧栏内部，是为了 2b 把列表页
  // 接上来之后两边能共享同一个过滤值（列表页选了机器，侧栏跟着变）。
  const [machineFilter, setMachineFilter] = useState<string | null>(null);
  const filterValue = useMemo<MachineFilterContextValue>(
    () => [machineFilter, setMachineFilter],
    [machineFilter],
  );
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const listFilters = useMemo<ListFilters>(
    () => ({ search, setSearch, status, setStatus }),
    [search, status],
  );

  if (runtime.phase === 'booting' || runtime.phase === 'error') {
    return <BootGate phase={runtime.phase} error={runtime.error} />;
  }
  if (leader.state === 'follower') return <LeaderOverlay />;

  // 配对页在两种布局下都独占整页——还没有机器，侧栏是空的，没有意义
  const soloRoute = location.pathname === '/pair' || !paired;

  const content = (
    <>
      <BannerStack persistent={runtime.persistent} />
      <div className="flex min-h-0 flex-1 flex-col">
        <Outlet />
      </div>
    </>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <MachineFilterContext value={filterValue}>
        <ListFiltersContext value={listFilters}>
          {isDesktop && !soloRoute ? (
            // 横幅在侧栏**之上**通栏：断连、需升级这些是整个应用的状态，
            // 只压在右主区上会显得像某个视图自己的提示
            <div className="flex h-dvh flex-col overflow-hidden">
              <BannerStack persistent={runtime.persistent} />
              <div className="flex min-h-0 flex-1">
                <Sidebar filter={machineFilter} onFilterChange={setMachineFilter} />
                <div className="flex min-w-0 flex-1 flex-col">
                  {location.pathname === '/' ? <EmptyMain /> : <Outlet />}
                </div>
              </div>
            </div>
          ) : (
            <div className="mx-auto flex h-dvh max-w-[560px] flex-col overflow-hidden">{content}</div>
          )}
        </ListFiltersContext>
      </MachineFilterContext>
      <Toaster position="top-center" richColors closeButton />
    </TooltipProvider>
  );
}

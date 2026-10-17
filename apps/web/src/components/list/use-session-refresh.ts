/**
 * 会话列表的数据刷新与时钟。
 *
 * - `useSessionListAutoRefresh()`：**挂在 Layout 上**，两套布局共享。机器上线
 *   即拉一次 `session.list.request`（不轮询，方案 §0 行 i「status/mcp 请求占
 *   agent 并发名额」同理适用）。早先它只在 `SessionListView` 里，而 PC 布局
 *   （≥900px）的 `/` 渲染的是 `EmptyMain` 不是 `SessionListView`——于是 PC 上
 *   **从来没有人发过 `session.list.request`**，侧栏永远空（评审 M1）。
 * - 去重与 TTL 在 `list-refresh-policy.ts`（模块级状态 + 纯判据），不再随视图
 *   卸载而丢：列表 → 机器页 → 返回列表不该又是一次全量 listSessions（M5）。
 * - `useSessionRefresh()`：手动刷新按钮用，绕过 TTL。
 * - `useNow(ms)`：相对时间文案的统一刷新节拍。相对时间是纯展示，靠一个
 *   定时器整体重渲染，比每个卡片各自计时省事也省 CPU。
 *
 * **只对在线机器发**——离线机器的机器级请求会被服务端静默忽略，`request()`
 * 白等 10s（评审 C4 最后一条）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useClient, useTrine } from '@/app/runtime.ts';
import {
  connectionGeneration,
  observeConnection,
  invalidateFetched,
  LIST_TTL_MS,
  markFetched,
  pickMachinesToFetch,
} from './list-refresh-policy.ts';

export interface SessionRefresh {
  /** 手动刷新（下拉/刷新按钮）。只对在线机器发，绕过 TTL */
  refresh: () => void;
  refreshing: boolean;
  /** 最近一次刷新的错误（超时/机器离线），null 表示正常 */
  error: string | null;
  /** 有没有在线机器可刷 */
  canRefresh: boolean;
}

/** 在线机器 id 的稳定字符串（避免对象引用变化触发 effect） */
function useOnlineIds(): string {
  const machines = useTrine((s) => s.machines);
  return Object.values(machines)
    .filter((m) => m.online === true)
    .map((m) => m.machineId)
    .sort()
    .join(',');
}

/**
 * 连接代际（评审 N5）。
 *
 * 计数器本身是 `list-refresh-policy.ts` 里的**模块级单例**；三个调用点
 * （Layout / Sidebar / ChatView）读到的永远是同一个数。早先它是
 * per-component 的 `useRef` 且在 render 阶段自增，各算各的、互不可比，
 * 判据两边 ping-pong 多发全量 listSessions（详见那边的注释）。
 *
 * 推进动作 `observeConnection(status)` 放在**渲染期**调用，看着像副作用，
 * 但它是**幂等**的：模块级的 `wasOpen` 让「同一个 open 状态被读几次」只
 * 记一代，StrictMode 的双渲染与多个组件同时读都不会多算。
 *
 * 为什么不挂在 runtime 的 store 订阅里：`boot()` 在 App 的 effect 里跑，
 * 组件的 `useStore` 订阅可能先于它注册；那样代际的推进就落在组件重渲染
 * **之后**，真重连的那一帧组件仍拿着上一代去判，补拉会被吞掉。幂等 +
 * 渲染期读取没有这个顺序依赖。
 */
function useConnectionGeneration(): number {
  const status = useTrine((s) => s.connection.status);
  observeConnection(status);
  return connectionGeneration();
}

/**
 * 「这台机器的会话列表该不该现在拉一次」——聊天页直开时补拉用，
 * 与 Layout 的自动拉取共用同一套 TTL/代际判据（评审 M5）。
 *
 * 返回的函数按判据决定发不发，发了就记账；调用方只管在需要时调它。
 */
export function useListSessionsOnce(): (machineId: string) => void {
  const client = useClient();
  const generation = useConnectionGeneration();
  return useCallback(
    (machineId: string) => {
      if (!client || machineId === '') return;
      const now = Date.now();
      // 单机判定：不要把别的在线机器当成「已下线」清掉记账
      const due = pickMachinesToFetch([machineId], now, generation, LIST_TTL_MS, { prune: false });
      if (due.length === 0) return;
      markFetched(due, now, generation);
      void client.listSessions(machineId).catch(() => undefined);
    },
    [client, generation],
  );
}

/** 应用级自动拉取：挂在 Layout，整个应用只此一处 */
export function useSessionListAutoRefresh(): void {
  const client = useClient();
  const onlineIds = useOnlineIds();
  const generation = useConnectionGeneration();

  useEffect(() => {
    if (!client) return;
    const ids = onlineIds.split(',').filter(Boolean);
    const due = pickMachinesToFetch(ids, Date.now(), generation);
    if (due.length === 0) return;
    // 发出即记账，不等结果：失败让 TTL 自然重试，避免失败时打转
    markFetched(due, Date.now(), generation);
    for (const id of due) void client.listSessions(id).catch(() => undefined);
  }, [client, onlineIds, generation]);
}

export function useSessionRefresh(): SessionRefresh {
  const client = useClient();
  const onlineIds = useOnlineIds();
  const generation = useConnectionGeneration();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const ids = onlineIds.split(',').filter(Boolean);
    if (!client || ids.length === 0) return;
    invalidateFetched(ids); // 手动刷新必须真的发出去
    markFetched(ids, Date.now(), generation);
    setRefreshing(true);
    setError(null);
    void Promise.allSettled(ids.map((id) => client.listSessions(id))).then((results) => {
      setRefreshing(false);
      const failed = results.find((r) => r.status === 'rejected');
      if (failed && failed.status === 'rejected') {
        const reason: unknown = failed.reason;
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
  }, [client, onlineIds, generation]);

  return { refresh, refreshing, error, canRefresh: onlineIds !== '' };
}

/** 相对时间的统一刷新节拍（默认 30s——最细的档是「N 分钟前」） */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

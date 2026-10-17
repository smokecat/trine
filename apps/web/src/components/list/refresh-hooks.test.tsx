/**
 * 三个调用点共用**同一个**连接代际（评审 N5）。
 *
 * 早先 `useConnectionGeneration()` 把计数器放在 per-component 的 `useRef`
 * 且在 render 阶段自增，三个独立调用点（`Layout` / `Sidebar` /
 * `ChatView`）各算各的，互不可比：
 *
 *   Layout 开机即挂、经历一次重连 → 其代际为 2，`lastFetched['a'].generation`
 *   被记成 2。用户首次进聊天页，ChatView 新挂载，代际从 0 起跳为 1 →
 *   `pickMachinesToFetch` 判 `last.generation === generation` 不匹配 →
 *   多发一次全量 `listSessions`（真机 339 会话的慢路径），并把代际**倒着**
 *   盖回 1；下次 Layout 以 2 再判又不匹配，再发一次——两边 ping-pong。
 *
 * 纯函数测试抓不住它：`pickMachinesToFetch` 本身没错，错的是「代际从哪来」。
 * 所以这里真的挂三个组件，各调一个真 hook，数最终发出了几次 listSessions。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';

const { runtimeState, store } = await import('@/app/runtime.ts');
const { resetFetchedForTest, connectionGeneration } = await import('./list-refresh-policy.ts');
const { useSessionListAutoRefresh, useListSessionsOnce } = await import('./use-session-refresh.ts');

const MACHINE = 'mbp';

/** 记下每次 listSessions 调用的假 client（只实现被用到的那一个方法） */
function stubClient(calls: string[]): unknown {
  return {
    listSessions: (machineId: string) => {
      calls.push(machineId);
      return Promise.resolve([]);
    },
  };
}

function setConnection(status: 'open' | 'backoff'): void {
  act(() => {
    store.setState((s) => ({ connection: { ...s.connection, status } }));
  });
}

function online(): void {
  act(() => {
    store.setState({
      machines: {
        [MACHINE]: { machineId: MACHINE, name: 'MBP', online: true, lastSeenAt: 1, parkedCount: 0 },
      } as never,
    });
  });
}

/** Layout 那个调用点 */
function LayoutProbe(): null {
  useSessionListAutoRefresh();
  return null;
}

/** Sidebar / SessionListView 那个调用点（同样是自动拉取） */
function SidebarProbe(): null {
  useSessionListAutoRefresh();
  return null;
}

/** ChatView 那个调用点（直开聊天页补一次） */
function ChatProbe(): null {
  const once = useListSessionsOnce();
  const trigger = (): void => once(MACHINE);
  trigger();
  return null;
}

let roots: Root[] = [];
let hosts: HTMLDivElement[] = [];

function mountAll(): void {
  for (const Comp of [LayoutProbe, SidebarProbe, ChatProbe]) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Comp />));
    roots.push(root);
    hosts.push(host);
  }
}

beforeEach(() => {
  resetFetchedForTest();
  store.setState({ machines: {}, connection: { status: 'idle', attempt: 0, nextRetryAt: null, lastCloseCode: null, lastError: null } });
  runtimeState.setState({ client: null });
});

afterEach(() => {
  for (const r of roots) act(() => r.unmount());
  for (const h of hosts) h.remove();
  roots = [];
  hosts = [];
  runtimeState.setState({ client: null });
});

describe('连接代际是单例（N5）', () => {
  test('三个调用点同时挂载：一台在线机器只发一次 session.list', () => {
    const calls: string[] = [];
    runtimeState.setState({ client: stubClient(calls) as never });
    setConnection('open');
    online();
    mountAll();
    expect(calls).toEqual([MACHINE]);
  });

  test('后挂载的组件不会把代际倒着盖回去（ping-pong 的根因）', () => {
    const calls: string[] = [];
    runtimeState.setState({ client: stubClient(calls) as never });
    // Layout 先挂，经历一次断线重连 → 代际推到 2
    setConnection('open');
    online();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<LayoutProbe />));
    roots.push(root);
    hosts.push(host);
    setConnection('backoff');
    setConnection('open');
    expect(connectionGeneration()).toBe(2);
    const afterLayout = calls.length;
    expect(afterLayout).toBe(2); // 开机一次 + 重连一次，都是该发的

    // 用户首次进聊天页：新挂载的组件读的是同一个代际，不该再发
    const chatHost = document.createElement('div');
    document.body.appendChild(chatHost);
    const chatRoot = createRoot(chatHost);
    act(() => chatRoot.render(<ChatProbe />));
    roots.push(chatRoot);
    hosts.push(chatHost);
    expect(calls.length).toBe(afterLayout);
    expect(connectionGeneration()).toBe(2); // 没被倒着盖回 1
  });

  test('真的重连了还是要重拉（代际推进没被一并关掉）', () => {
    const calls: string[] = [];
    runtimeState.setState({ client: stubClient(calls) as never });
    setConnection('open');
    online();
    mountAll();
    expect(calls).toHaveLength(1);
    setConnection('backoff');
    setConnection('open');
    // 三个组件都重渲染了，但代际只推进一代 → 只补发一次
    expect(calls).toEqual([MACHINE, MACHINE]);
  });
});

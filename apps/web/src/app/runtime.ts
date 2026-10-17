/**
 * 应用运行时：把 lib/ 与 store/ 接到浏览器上。
 *
 * - 浏览器适配器（localStorage / IndexedDB / navigator.locks / BroadcastChannel / WebSocket）；
 * - 单主标签选举：**只有主标签页**创建并 start `TrineClient`；从页只显示
 *   「已在另一标签页运行 / 在此接管」，接管成功后再创建自己的 client
 *   （重新从存储加载，拿到旧主落盘的最新状态）。建/拆的代际保护与错误面
 *   在 lifecycle.ts（可在 bun test 里验）；
 * - visibilitychange 回前台 → 立刻重连；beforeunload → 把去抖中的落盘做掉。
 *
 * 运行时状态单独一个小 store（booting / ready / error + 当前 client），
 * 与协议层镜像 store 分开——client 会随主从切换被替换，UI 不该缓存它。
 */
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { systemClock } from '../lib/adapters.ts';
import {
  browserChannel,
  browserDocStore,
  browserKv,
  browserLocks,
  browserSocketFactory,
} from '../lib/adapters.browser.ts';
import type { TrineClient } from '../lib/client.ts';
import { LeaderElector } from '../lib/leader.ts';
import { ClientLifecycle } from './lifecycle.ts';
import { bindClient, bindLeader, createTrineStore, type TrineStore } from '../store/index.ts';

export interface RuntimeState {
  phase: 'booting' | 'ready' | 'error';
  error: string | null;
  /** 主标签页才有；从页为 null */
  client: TrineClient | null;
  /** 存储是否持久（隐私模式下 localStorage 不可用 → 退回内存，刷新即失忆） */
  persistent: boolean;
}

export const store: TrineStore = createTrineStore();
export const runtimeState = createStore<RuntimeState>()(() => ({
  phase: 'booting',
  error: null,
  client: null,
  persistent: true,
}));

let elector: LeaderElector | null = null;
let booted = false;

export async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  try {
    const { kv, persistent } = browserKv();
    const docs = browserDocStore();
    runtimeState.setState({ persistent });

    // 生命周期接线（代际号保证任何时刻最多一个 client；create 抛错进错误态）
    const lifecycle = new ClientLifecycle({
      // **动态 import**：协议层静态引入 `@trine/core/crypto`，后者又静态引入
      // libsodium——一个 730KB（gzip 240KB）的 asm.js/wasm 单文件。静态引用
      // 会把它钉进 entry 的必下集合，手机上首屏要先下完它才开始画。
      //
      // 客户端本来就是在 effect 里异步起的（App.tsx 的 `void boot()`），
      // 第一帧不需要它，改成按需拉正合语义：外壳先出来，密码学随 client 到位。
      createClient: async () => {
        const { TrineClient } = await import('../lib/client.ts');
        return TrineClient.create({
          kv,
          docs,
          createSocket: browserSocketFactory,
          clock: systemClock,
          log: (line) => console.info(line),
        });
      },
      onClient: (client) => {
        runtimeState.setState({ client });
        return bindClient(store, client);
      },
      onClientGone: () => runtimeState.setState({ client: null }),
      onError: (message) => runtimeState.setState({ phase: 'error', error: message, client: null }),
    });

    elector = new LeaderElector({
      locks: browserLocks(),
      channel: browserChannel('trine'),
      clock: systemClock,
      log: (line) => console.info(line),
      onChange: (snapshot) => {
        store.setState({ leader: snapshot });
        lifecycle.onLeaderChange(snapshot);
      },
    });
    bindLeader(store, elector);
    elector.start();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') runtimeState.getState().client?.wake();
    });
    // beforeunload 在移动端后台被杀时不触发，pagehide 更可靠；两个都挂，flush 幂等
    const flush = (): void => runtimeState.getState().client?.flushSaves();
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    runtimeState.setState({ phase: 'ready' });
  } catch (err) {
    runtimeState.setState({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

/** 「在此接管」 */
export function takeOver(): void {
  elector?.takeOver();
}

export function useRuntime(): RuntimeState {
  return useStore(runtimeState);
}

export function useClient(): TrineClient | null {
  return useStore(runtimeState, (s) => s.client);
}

export function useTrine<T>(selector: (state: import('../store/types.ts').TrineState) => T): T {
  return useStore(store, selector);
}

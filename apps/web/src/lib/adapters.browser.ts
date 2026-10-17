/**
 * adapters.ts 各接口的浏览器实现。**只有这个文件**允许碰浏览器全局，
 * 且它不被任何测试 import。
 *
 * 每个实现都有「不可用」的判定：隐私模式下 localStorage 可能抛错、老浏览器
 * 没有 navigator.locks / BroadcastChannel。拿不到就退回内存实现——页面
 * 仍能用，只是刷新即失忆（identity 丢了要重配对，UI 会提示）。
 */
import { createStore, del, get, keys, set, type UseStore } from 'idb-keyval';
import {
  MemoryChannelHub,
  MemoryDocStore,
  MemoryKv,
  MemoryLockRegistry,
  type ChannelAdapter,
  type DocStore,
  type KvAdapter,
  type LockAdapter,
  type SocketFactory,
} from './adapters.ts';

export function browserKv(): { kv: KvAdapter; persistent: boolean } {
  try {
    const probe = '__trine_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return {
      persistent: true,
      kv: {
        get: (key) => window.localStorage.getItem(key),
        set: (key, value) => window.localStorage.setItem(key, value),
        remove: (key) => window.localStorage.removeItem(key),
      },
    };
  } catch {
    return { kv: new MemoryKv(), persistent: false };
  }
}

export function browserDocStore(): DocStore {
  if (typeof indexedDB === 'undefined') return new MemoryDocStore();
  const store: UseStore = createStore('trine', 'docs');
  return {
    get: (key) => get(key, store),
    set: (key, value) => set(key, value, store),
    del: (key) => del(key, store),
    keys: async () => (await keys(store)).map(String),
  };
}

export function browserLocks(): LockAdapter {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return new MemoryLockRegistry().adapter(false);
  return {
    available: true,
    request: async (name, options, callback) => {
      await locks.request(
        name,
        {
          mode: 'exclusive',
          ...(options.ifAvailable ? { ifAvailable: true } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
        async (lock) => {
          await callback(lock !== null);
        },
      );
    },
  };
}

export function browserChannel(name = 'trine'): ChannelAdapter {
  if (typeof BroadcastChannel === 'undefined') return new MemoryChannelHub().channel();
  const bc = new BroadcastChannel(name);
  const handlers = new Set<(message: unknown) => void>();
  bc.onmessage = (ev) => {
    for (const h of handlers) h(ev.data);
  };
  return {
    post: (message) => bc.postMessage(message),
    subscribe: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close: () => {
      handlers.clear();
      bc.close();
    },
  };
}

export const browserSocketFactory: SocketFactory = (url) => new WebSocket(url);

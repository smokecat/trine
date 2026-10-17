/**
 * 守门测：装 DOM 测试环境**不得**换掉 Bun 的原生全局。
 *
 * 背景（这条测试在防什么）：`bun test` 把全部文件跑在同一进程，而
 * `GlobalRegistrator.register()` 会把一整个 happy-dom window 覆盖到
 * `globalThis`——实测换掉 34 个原生全局，其中 `WebSocket` 是 `ws` 包的实现。
 * 按路径顺序 `components/**` 的 DOM 测试排在 `lib/e2e.test.ts` /
 * `lib/connection.test.ts` 之前，于是协议层测试拿到的是 `ws` 版 WebSocket：
 * Bun 下打印「'upgrade' event is not implemented」，其 error 事件无人监听时
 * 直接抛成「Unhandled error between tests」，**把整个文件的用例打断**
 * （那十几条根本没跑，总数只是悄悄少了一截）。
 *
 * 所以这里在 import 之前先抓住原生引用，import 之后逐个比对。
 * 必须用**动态 import**：静态 import 会被提升到这些 const 之前求值。
 */
import { describe, expect, test } from 'bun:test';

/** import dom-test-env **之前**的原生引用 */
const NATIVE = {
  WebSocket: globalThis.WebSocket,
  fetch: globalThis.fetch,
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  AbortController: globalThis.AbortController,
  AbortSignal: globalThis.AbortSignal,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  queueMicrotask: globalThis.queueMicrotask,
  URL: globalThis.URL,
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  crypto: globalThis.crypto,
  performance: globalThis.performance,
  structuredClone: globalThis.structuredClone,
  console: globalThis.console,
  Blob: globalThis.Blob,
  FormData: globalThis.FormData,
  EventTarget: globalThis.EventTarget,
  atob: globalThis.atob,
  btoa: globalThis.btoa,
} as const;

await import('./dom-test-env.ts');

describe('dom-test-env：装好 DOM 但不动原生全局', () => {
  test.each(Object.keys(NATIVE))('%s 仍是 Bun 原生实现', (name) => {
    expect(globalThis[name as keyof typeof globalThis]).toBe(NATIVE[name as keyof typeof NATIVE]);
  });

  test('WebSocket 不是 ws 包的实现（这条是最要命的那个）', () => {
    // `ws` 包把 WebSocketServer 挂成静态 `Server`，并在原型上带 `_socket`
    // 这类 Node 专有成员；Bun 原生的两者都没有。
    // （`ping` 不能当判据——Bun 原生 WebSocket 也有）
    const WS = globalThis.WebSocket as unknown as { Server?: unknown; prototype: object };
    expect(WS.Server).toBeUndefined();
    expect('_socket' in WS.prototype).toBe(false);
  });

  test('DOM 确实装好了：createElement / HTMLElement / act 标志都在', () => {
    expect(typeof document.createElement).toBe('function');
    expect(document.createElement('div')).toBeInstanceOf(globalThis.HTMLElement);
    expect(typeof globalThis.MutationObserver).toBe('function');
    expect(typeof globalThis.getComputedStyle).toBe('function');
    expect((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT).toBe(true);
  });

  test('重复 import 幂等（同进程里多个测试文件都会 import 它）', async () => {
    await import('./dom-test-env.ts');
    expect(globalThis.WebSocket).toBe(NATIVE.WebSocket);
    expect(typeof document.createElement).toBe('function');
  });
});

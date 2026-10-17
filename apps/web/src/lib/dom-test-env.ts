/**
 * 组件测试的 DOM 环境（happy-dom），**不污染 Bun 的原生全局**。
 *
 * ## 为什么需要这个文件
 *
 * `bun test` 把全部测试文件跑在**同一个进程**里，而
 * `GlobalRegistrator.register()` 是把一整个 happy-dom window 的全局**覆盖**
 * 到 `globalThis` 上——实测覆盖掉 34 个本来就存在的原生全局，其中包括：
 *
 *   WebSocket（happy-dom 20.x 用 `ws` 包实现）、fetch / Request / Response /
 *   Headers、setTimeout / setInterval / clearTimeout / clearInterval /
 *   queueMicrotask、AbortController / AbortSignal、Event / EventTarget /
 *   CustomEvent / ErrorEvent / MessageEvent、URL、Blob / File / FormData、
 *   addEventListener / dispatchEvent、atob / btoa …
 *
 * 按路径顺序，`components/**` 的 DOM 测试排在 `lib/e2e.test.ts`、
 * `lib/connection.test.ts` 之前——于是后者拿到的 `WebSocket` 已经是 `ws` 版。
 * `ws` 在 Bun 下会打印「'upgrade' event is not implemented」，并且它的
 * error 事件没有监听者时直接抛成「Unhandled error between tests」，**把整个
 * 文件的用例打断**（那一文件的十几条测试根本没跑，计数却只少不报错）。
 * 单跑 `apps/web` 或单文件时顺序与内容都不同，所以不会暴露。
 *
 * ## 修法：快照 + 白名单恢复
 *
 * register 前快照 `globalThis` 的**全部自有属性描述符**；register 后，凡是
 * 原生本来就有、又不在 DOM 白名单里的属性，一律把原生描述符装回去。
 * happy-dom 新**加**的那 488 个（Document / HTMLElement / SVG* / …）原样保留
 * ——它们不与任何原生全局冲突，正是渲染需要的东西。
 *
 * 白名单的取舍：只保留 React 渲染与 DOM 查询真正必须的那几个。**定时器族
 * 刻意不在白名单里**——渲染测试该用 `act()` 显式 flush，而不是依赖
 * happy-dom 的定时器实现；放开它们等于把 lib 层所有拨表测试拖下水。
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';

/**
 * register 之后**保留 happy-dom 版本**的全局。
 *
 * 判据是「React 渲染或 DOM 查询离了它就不工作」。其余凡是原生也有的，
 * 一律恢复原生——尤其 WebSocket / fetch / 定时器族 / AbortController，
 * 它们被换掉会直接打断同进程里的协议层与 e2e 测试。
 */
const KEEP_HAPPY_DOM = new Set([
  'window',
  'document',
  'Node',
  'Element',
  'HTMLElement',
  'Event',
  'CustomEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'navigator',
  'IS_REACT_ACT_ENVIRONMENT',
]);

type Globals = Record<string, unknown>;

/**
 * 判据用 `document.createElement` 而不是 `typeof document`：Bun 自带一个
 * 没有 DOM 方法的 `document` 存根，光看它在不在会误以为已经注册过了。
 */
function alreadyRegistered(): boolean {
  const doc = (globalThis as { document?: { createElement?: unknown } }).document;
  return typeof doc?.createElement === 'function';
}

function register(): void {
  // 1. 快照原生：全部自有属性的描述符
  const native = new Map<string, PropertyDescriptor>();
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    const desc = Object.getOwnPropertyDescriptor(globalThis, name);
    if (desc !== undefined) native.set(name, desc);
  }

  GlobalRegistrator.register();

  // 2. 把被覆盖掉的原生全局装回去（白名单里的留 happy-dom 版）
  for (const [name, desc] of native) {
    if (KEEP_HAPPY_DOM.has(name)) continue;
    const current = Object.getOwnPropertyDescriptor(globalThis, name);
    // 没被动过就不折腾（也避免把不可配置的属性重定义成异常）
    if (current !== undefined && 'value' in current && 'value' in desc && current.value === desc.value) continue;
    if (current !== undefined && current.configurable === false) continue;
    try {
      Object.defineProperty(globalThis, name, desc);
    } catch {
      // 极个别不可重定义的属性（如 globalThis 自身）：保持现状，不让环境装配失败
    }
  }

  // 3. navigator：原生有就恢复原生，但补上 DOM 代码要读的 userAgent
  //    （happy-dom 的 Navigator 携带 window 引用，留着它会把 window 的生命周期
  //    拖进 lib 层测试；原生 navigator 已足够 React 与 shadcn 使用）
  const nativeNavigator = native.get('navigator');
  if (nativeNavigator !== undefined && typeof (nativeNavigator.value as { userAgent?: string })?.userAgent === 'string') {
    try {
      Object.defineProperty(globalThis, 'navigator', nativeNavigator);
    } catch {
      // 保持 happy-dom 版
    }
  }
}

if (!alreadyRegistered()) register();

// `act()` 要求宿主显式声明自己是测试环境，否则 React 19 直接抛
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 只是为了让 `import './dom-test-env.ts'` 不被当成未使用而摇掉 */
export const domTestEnvReady = true;

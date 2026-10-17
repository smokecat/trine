/**
 * 主题（system / light / dark 三态）。
 *
 * ## 为什么不能只靠 store.prefs
 *
 * `prefs.theme` 的权威副本在 `TrineClient` 里（lib/storage.ts 的 Kv），而
 * **client 只有主标签页才有**（单主标签，见 app/runtime.ts）。从页、启动
 * 门（booting）、启动失败态都没有 client，但页面照样要有正确的配色——
 * 不能等 client 就绪才上色，否则每次刷新都先闪一下浅色。
 *
 * 所以这里用「localStorage 镜像 + client 权威」的双写：
 *
 * - **读**：模块加载时（React 挂载之前，见 main.tsx 的 import 顺序）就从
 *   localStorage 键 `trine.theme` 读出来立刻贴到 `<html>`，杜绝闪烁；
 *   client 就绪后 `syncFromPrefs()` 把权威值覆盖进来（两者本就同源，
 *   只有「另一台设备改了 prefs 并同步过来」这种未来场景才会不同）。
 * - **写**：`setTheme()` 同时写 localStorage 与 `client.updatePrefs({theme})`。
 *   没有 client（从页）时只写 localStorage，接管成为主页面后
 *   `syncFromPrefs` 的方向是 prefs → 本地，所以从页的改动不会被带丢——
 *   从页改主题本就只该影响本页，这是可接受的行为。
 *
 * ## DOM 表示
 *
 * `<html data-theme="light|dark">` + `class="dark"`（深色时）。两者都挂：
 * - `data-theme` 是原型的写法，styles.css 的三态覆盖规则按它写；
 * - `.dark` 是 shadcn / tailwind 生态的约定，第三方组件按它走。
 * `system` 态下**两者都不挂**，交给 `@media (prefers-color-scheme)`，
 * 这样系统切换时无需 JS 参与即可跟随。
 */
import { useSyncExternalStore } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
/** 解析后的实际外观（system 已按当前系统设置折叠掉） */
export type ResolvedTheme = 'light' | 'dark';

/** localStorage 镜像键。client 不可用时这就是唯一的持久化 */
export const THEME_STORAGE_KEY = 'trine.theme';

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

let current: ThemeMode = 'system';
const listeners = new Set<() => void>();

function readStored(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : 'system';
  } catch {
    // 隐私模式 / 禁用存储：退回跟随系统
    return 'system';
  }
}

function writeStored(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 存不下就算了，本次会话内仍然生效
  }
}

function prefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 把 mode 折叠成实际外观 */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return prefersDark() ? 'dark' : 'light';
  return mode;
}

/** 贴到 `<html>`：system 态不留痕迹，交给 CSS media query */
function applyToDom(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', mode);
  }
  root.classList.toggle('dark', resolveTheme(mode) === 'dark');
  // PWA / 移动端浏览器 UI 的配色条
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    // 取实际生效的背景色，主题一变它就跟着变
    const bg = getComputedStyle(root).getPropertyValue('--phone-bg').trim();
    if (bg !== '') meta.setAttribute('content', bg);
  }
}

function notify(): void {
  for (const fn of listeners) fn();
}

/**
 * 模块加载即执行：在 React 挂载之前把主题贴上去，避免首屏闪烁。
 * main.tsx 里 `import './styles.css'` 与本模块的 import 都在 render 之前。
 */
export function initTheme(): void {
  current = readStored();
  applyToDom(current);
  // 跟随系统时，系统切换要实时反映；手动锁定时不受影响（applyToDom 会判断）
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (current === 'system') {
        applyToDom(current);
        notify();
      }
    });
  }
}

/** 当前模式（未解析，用于设置页三选一的选中态） */
export function getTheme(): ThemeMode {
  return current;
}

/**
 * 改主题。`client` 传入时同时写权威 prefs（主标签页）；不传只写本地镜像。
 * 调用方见 views/SettingsView.tsx 与 components/shell/ThemeToggle.tsx。
 */
export function setTheme(mode: ThemeMode, client?: { updatePrefs: (patch: { theme: ThemeMode }) => void } | null): void {
  current = mode;
  writeStored(mode);
  applyToDom(mode);
  client?.updatePrefs({ theme: mode });
  notify();
}

/**
 * client 就绪（或 prefs 变化）后把权威值拉过来。
 *
 * **只有 prefs 真的被写过才允许覆盖本地镜像。** `TrineClient` 的 prefs
 * 要到用户第一次 `updatePrefs` 才落盘（lib/client.ts），在那之前
 * `loadPrefs` 返回的是默认值 `theme: 'system'`——它与「用户明确选了跟随
 * 系统」在类型上无法区分。若无条件同步，用户在从页（没有 client，只写
 * 得到 localStorage）选的深色，会在下次挂载时被这个默认值悄悄改回
 * system。所以这里要求调用方传入 `persisted`，默认值一律不覆盖。
 *
 * 与本地镜像一致时什么都不做，避免无谓的重渲染。
 */
export function syncFromPrefs(mode: ThemeMode, persisted: boolean): void {
  if (!persisted) return;
  if (mode === current) return;
  current = mode;
  writeStored(mode);
  applyToDom(mode);
  notify();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React 订阅：当前模式（system/light/dark） */
export function useTheme(): ThemeMode {
  return useSyncExternalStore(subscribe, getTheme, () => 'system' as ThemeMode);
}

/** React 订阅：解析后的外观（light/dark）。sonner 等需要具体值的组件用 */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(
    subscribe,
    () => resolveTheme(current),
    () => 'light' as ResolvedTheme,
  );
}

/**
 * theme.ts 的回归测试。
 *
 * bun 没有 DOM，所以这里给 `document` / `localStorage` / `matchMedia` 搭最小
 * 替身——只要够 initTheme / setTheme / syncFromPrefs 跑完即可。测的是**决策**
 * （谁覆盖谁、写不写存储），不是渲染。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

interface Stub {
  attrs: Map<string, string>;
  classes: Set<string>;
  store: Map<string, string>;
}

let stub: Stub;

// Test discovery order differs across platforms. Other files may already have
// registered happy-dom accessors; save and restore their complete descriptors.
const DOM_GLOBALS = ['document', 'localStorage', 'matchMedia', 'getComputedStyle'] as const;
let originalGlobals: Map<string, PropertyDescriptor | undefined>;

beforeEach(() => {
  originalGlobals = new Map(DOM_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
});

afterEach(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function installDom(prefersDark = false): void {
  stub = { attrs: new Map(), classes: new Set(), store: new Map() };
  const root = {
    setAttribute: (k: string, v: string) => void stub.attrs.set(k, v),
    removeAttribute: (k: string) => void stub.attrs.delete(k),
    getAttribute: (k: string) => stub.attrs.get(k) ?? null,
    classList: {
      toggle: (name: string, on: boolean) => {
        if (on) stub.classes.add(name);
        else stub.classes.delete(name);
      },
    },
  };
  const replacements = {
    document: {
      documentElement: root,
      // theme-color meta：本测试不关心，返回 null 走 applyToDom 的短路分支
      querySelector: () => null,
    },
    localStorage: {
      getItem: (k: string) => stub.store.get(k) ?? null,
      setItem: (k: string, v: string) => void stub.store.set(k, v),
      removeItem: (k: string) => void stub.store.delete(k),
    },
    matchMedia: (q: string) => ({
      matches: q.includes('dark') && prefersDark,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  for (const [name, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
}

/** 每个用例都要新鲜的模块实例（模块级 `current` 是状态） */
async function freshTheme(): Promise<typeof import('./theme.ts')> {
  const url = `./theme.ts?t=${Math.random()}`;
  return (await import(url)) as typeof import('./theme.ts');
}

describe('theme · 初始化', () => {
  beforeEach(() => installDom());

  test('没有存过就是 system：不挂 data-theme，交给 CSS media query', async () => {
    const theme = await freshTheme();
    theme.initTheme();
    expect(theme.getTheme()).toBe('system');
    expect(stub.attrs.has('data-theme')).toBe(false);
    expect(stub.classes.has('dark')).toBe(false);
  });

  test('存过 dark 就直接贴上，不等 React 挂载', async () => {
    stub.store.set('trine.theme', 'dark');
    const theme = await freshTheme();
    theme.initTheme();
    expect(theme.getTheme()).toBe('dark');
    expect(stub.attrs.get('data-theme')).toBe('dark');
    expect(stub.classes.has('dark')).toBe(true);
  });

  test('存了非法值按 system 处理，不抛错', async () => {
    stub.store.set('trine.theme', 'neon');
    const theme = await freshTheme();
    theme.initTheme();
    expect(theme.getTheme()).toBe('system');
  });
});

describe('theme · setTheme 双写', () => {
  beforeEach(() => installDom());

  test('同时写 localStorage 与 client.updatePrefs', async () => {
    const theme = await freshTheme();
    theme.initTheme();
    const seen: string[] = [];
    theme.setTheme('dark', { updatePrefs: (p) => seen.push(p.theme) });
    expect(stub.store.get('trine.theme')).toBe('dark');
    expect(seen).toEqual(['dark']);
    expect(stub.attrs.get('data-theme')).toBe('dark');
  });

  test('没有 client（从页）也能改，只是不写权威 prefs', async () => {
    const theme = await freshTheme();
    theme.initTheme();
    theme.setTheme('light', null);
    expect(stub.store.get('trine.theme')).toBe('light');
    expect(stub.attrs.get('data-theme')).toBe('light');
  });
});

describe('theme · syncFromPrefs 不被默认值覆盖（回归）', () => {
  beforeEach(() => installDom());

  test('prefs 没落过盘时，默认的 system 不得覆盖本地已选的 dark', async () => {
    // 复现的场景：用户（在从页或 client 就绪前）选了深色，只写进了本地镜像；
    // 此时 store.prefs.theme 仍是 loadPrefs 的默认值 'system'。
    stub.store.set('trine.theme', 'dark');
    const theme = await freshTheme();
    theme.initTheme();
    expect(theme.getTheme()).toBe('dark');

    theme.syncFromPrefs('system', false);

    expect(theme.getTheme()).toBe('dark');
    expect(stub.store.get('trine.theme')).toBe('dark');
    expect(stub.attrs.get('data-theme')).toBe('dark');
  });

  test('prefs 真的落过盘时，权威值覆盖本地镜像', async () => {
    stub.store.set('trine.theme', 'dark');
    const theme = await freshTheme();
    theme.initTheme();

    theme.syncFromPrefs('light', true);

    expect(theme.getTheme()).toBe('light');
    expect(stub.store.get('trine.theme')).toBe('light');
    expect(stub.attrs.get('data-theme')).toBe('light');
  });

  test('值一致时不做无谓的写入', async () => {
    const theme = await freshTheme();
    theme.initTheme();
    theme.setTheme('dark', null);
    stub.store.delete('trine.theme');

    theme.syncFromPrefs('dark', true);

    // 相同值应当短路，不重新写存储
    expect(stub.store.has('trine.theme')).toBe(false);
  });
});

describe('theme · resolveTheme', () => {
  test('system 跟随 prefers-color-scheme', async () => {
    installDom(true);
    const dark = await freshTheme();
    expect(dark.resolveTheme('system')).toBe('dark');
    expect(dark.resolveTheme('light')).toBe('light');

    installDom(false);
    const light = await freshTheme();
    expect(light.resolveTheme('system')).toBe('light');
    expect(light.resolveTheme('dark')).toBe('dark');
  });
});

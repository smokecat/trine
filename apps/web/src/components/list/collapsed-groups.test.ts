import { afterEach, describe, expect, test } from 'bun:test';
import {
  COLLAPSED_GROUPS_KEY,
  readCollapsedGroupsForTest,
  resetCollapsedGroupsForTest,
  setGroupCollapsed,
} from './collapsed-groups.ts';

const g = globalThis as { localStorage?: unknown };
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function install(ls: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });
  resetCollapsedGroupsForTest();
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else delete g.localStorage;
  resetCollapsedGroupsForTest();
});

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  } as never;
}

describe('分组折叠状态', () => {
  test('折叠 / 展开写进 localStorage，重读后仍在', () => {
    const ls = memoryStorage();
    install(ls);
    setGroupCollapsed('m\u0000/a', true);
    expect(JSON.parse(ls.data.get(COLLAPSED_GROUPS_KEY)!)).toEqual(['m\u0000/a']);
    resetCollapsedGroupsForTest();
    expect(readCollapsedGroupsForTest().has('m\u0000/a')).toBe(true);
    setGroupCollapsed('m\u0000/a', false);
    expect(readCollapsedGroupsForTest().size).toBe(0);
  });

  test('坏数据当空；storage 抛错时退化为内存态不崩', () => {
    const ls = memoryStorage();
    ls.data.set(COLLAPSED_GROUPS_KEY, '{oops');
    install(ls);
    expect(readCollapsedGroupsForTest().size).toBe(0);

    install({
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    });
    expect(readCollapsedGroupsForTest().size).toBe(0);
    setGroupCollapsed('k', true);
    expect(readCollapsedGroupsForTest().has('k')).toBe(true);
  });

  test('没有 localStorage（非浏览器环境）也能用', () => {
    install(undefined);
    setGroupCollapsed('k', true);
    expect(readCollapsedGroupsForTest().has('k')).toBe(true);
  });
});

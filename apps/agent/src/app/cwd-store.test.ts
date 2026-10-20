import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CwdStore, MAX_PINNED_CWDS } from './cwd-store.ts';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trine-cwd-'));
  path = join(dir, 'cwd.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('CwdStore', () => {
  test('默认值：无收藏，defaultCwd 可注入', async () => {
    const store = await CwdStore.load(path, { defaultCwd: '/home/u' });
    expect(store.snapshot()).toEqual({ favorites: [], defaultCwd: '/home/u', pinned: {} });
  });

  test('add/remove/setDefault 落盘并可重载；重复 add 与 remove 不存在的返回 false', async () => {
    const store = await CwdStore.load(path, { defaultCwd: '/home/u' });
    expect(await store.add('/repo/a')).toBe(true);
    expect(await store.add('/repo/a')).toBe(false);
    expect(await store.add('/repo/b')).toBe(true);
    await store.setDefault('/repo/b');
    expect(await store.remove('/repo/a')).toBe(true);
    expect(await store.remove('/repo/zzz')).toBe(false);

    const again = await CwdStore.load(path);
    expect(again.snapshot()).toEqual({ favorites: ['/repo/b'], defaultCwd: '/repo/b', pinned: {} });
  });

  test('文件损坏 → warn 并回到默认值，不抛', async () => {
    await writeFile(path, 'garbage');
    const logs: string[] = [];
    const store = await CwdStore.load(path, { log: (l) => logs.push(l), defaultCwd: '/d' });
    expect(store.snapshot()).toEqual({ favorites: [], defaultCwd: '/d', pinned: {} });
    expect(logs.some((l) => l.includes('损坏'))).toBe(true);
  });

  test('旧文件没有 pinned 键 → 按空读入', async () => {
    await writeFile(path, JSON.stringify({ v: 1, favorites: ['/a'], defaultCwd: '/a' }));
    const store = await CwdStore.load(path);
    expect(store.snapshot()).toEqual({ favorites: ['/a'], defaultCwd: '/a', pinned: {} });
  });

  test('setPinned：置顶落盘、重复置顶保留原时间、取消置顶', async () => {
    const store = await CwdStore.load(path, { defaultCwd: '/home/u' });
    expect(await store.setPinned('/repo/a', true, 100)).toBe(true);
    expect(await store.setPinned('/repo/a', true, 200)).toBe(false);
    expect(await store.setPinned('/repo/b', true, 300)).toBe(true);
    expect(await store.setPinned('/repo/zzz', false, 400)).toBe(false);
    expect((await CwdStore.load(path)).snapshot().pinned).toEqual({ '/repo/a': 100, '/repo/b': 300 });
    expect(await store.setPinned('/repo/a', false, 500)).toBe(true);
    expect((await CwdStore.load(path)).snapshot().pinned).toEqual({ '/repo/b': 300 });
  });

  test('setPinned：超过上限丢最早置顶的；__proto__ 当普通键、不改原型', async () => {
    const store = await CwdStore.load(path, { defaultCwd: '/home/u' });
    for (let i = 0; i < MAX_PINNED_CWDS; i++) await store.setPinned(`/p/${i}`, true, i + 1);
    await store.setPinned('__proto__', true, 10_000);
    const pinned = store.snapshot().pinned;
    expect(Object.keys(pinned)).toHaveLength(MAX_PINNED_CWDS);
    expect(Object.hasOwn(pinned, '/p/0')).toBe(false);
    expect(Object.hasOwn(pinned, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(pinned)).toBe(Object.prototype);
  });
});

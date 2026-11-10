import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { movePinOrder } from '@trine/core';
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
    expect(store.snapshot()).toEqual({ favorites: [], defaultCwd: '/home/u', pinned: {}, pinOrder: [] });
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
    expect(again.snapshot()).toEqual({ favorites: ['/repo/b'], defaultCwd: '/repo/b', pinned: {}, pinOrder: [] });
  });

  test('文件损坏 → warn 并回到默认值，不抛', async () => {
    await writeFile(path, 'garbage');
    const logs: string[] = [];
    const store = await CwdStore.load(path, { log: (l) => logs.push(l), defaultCwd: '/d' });
    expect(store.snapshot()).toEqual({ favorites: [], defaultCwd: '/d', pinned: {}, pinOrder: [] });
    expect(logs.some((l) => l.includes('损坏'))).toBe(true);
  });

  test('旧文件没有 pinned 键 → 按空读入', async () => {
    await writeFile(path, JSON.stringify({ v: 1, favorites: ['/a'], defaultCwd: '/a' }));
    const store = await CwdStore.load(path);
    expect(store.snapshot()).toEqual({ favorites: ['/a'], defaultCwd: '/a', pinned: {}, pinOrder: [] });
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

describe('CwdStore · pinOrder', () => {
  const file = (extra: Record<string, unknown>) =>
    writeFile(path, JSON.stringify({ v: 1, favorites: ['/fav'], defaultCwd: '/fav', ...extra }));

  test('读取时规范化：去重、剔除非置顶与非字符串、缺的按置顶时间倒序补到末尾', async () => {
    await file({ pinned: { '/a': 1, '/b': 2, '/c': 3, '/d': 4 }, pinOrder: ['/b', '/x', '/b', 7, '/a'] });
    expect((await CwdStore.load(path)).snapshot().pinOrder).toEqual(['/b', '/a', '/d', '/c']);
  });

  test('旧文件没有 pinOrder：按置顶时间倒序', async () => {
    await file({ pinned: { '/a': 1, '/b': 3, '/c': 2 } });
    expect((await CwdStore.load(path)).snapshot().pinOrder).toEqual(['/b', '/c', '/a']);
  });

  test('pinOrder 坏了只退化它自己，收藏 / 默认目录 / pinned 不受影响', async () => {
    await file({ pinned: { '/a': 1, '/b': 2 }, pinOrder: { nope: true } });
    const logs: string[] = [];
    const snap = (await CwdStore.load(path, { log: (l) => logs.push(l) })).snapshot();
    expect(snap).toEqual({ favorites: ['/fav'], defaultCwd: '/fav', pinned: { '/a': 1, '/b': 2 }, pinOrder: ['/b', '/a'] });
    expect(logs.some((l) => l.includes('pinOrder'))).toBe(true);
  });

  test('新置顶插最前、取消置顶移除；重复置顶不动位置', async () => {
    const store = await CwdStore.load(path, { defaultCwd: '/h' });
    await store.setPinned('/a', true, 1);
    await store.setPinned('/b', true, 2);
    await store.movePin('/a', null);
    expect(store.snapshot().pinOrder).toEqual(['/b', '/a']);
    await store.setPinned('/c', true, 3);
    await store.setPinned('/a', true, 4);
    expect(store.snapshot().pinOrder).toEqual(['/c', '/b', '/a']);
    await store.setPinned('/b', false, 5);
    expect(store.snapshot().pinOrder).toEqual(['/c', '/a']);
    expect((await CwdStore.load(path)).snapshot().pinOrder).toEqual(['/c', '/a']);
  });

  test('超过上限按 pinOrder 末尾淘汰（不是按置顶时间）', async () => {
    const store = await CwdStore.load(path, { defaultCwd: '/h' });
    for (let i = 0; i < MAX_PINNED_CWDS; i++) await store.setPinned(`/p/${i}`, true, i + 1);
    // 把最新置顶的挪到末尾：它成了淘汰候选
    const newest = `/p/${MAX_PINNED_CWDS - 1}`;
    await store.movePin(newest, null);
    await store.setPinned('/new', true, 10_000);
    const snap = store.snapshot();
    expect(snap.pinOrder).toHaveLength(MAX_PINNED_CWDS);
    expect(snap.pinOrder[0]).toBe('/new');
    expect(Object.hasOwn(snap.pinned, newest)).toBe(false);
    expect(Object.hasOwn(snap.pinned, '/p/0')).toBe(true);
    expect(Object.keys(snap.pinned).sort()).toEqual([...snap.pinOrder].sort());
  });

  test('movePin：移到某项之前 / 末尾；重复请求幂等不写盘', async () => {
    const store = await CwdStore.load(path, { defaultCwd: '/h' });
    for (const [p, at] of [['/a', 1], ['/b', 2], ['/c', 3]] as const) await store.setPinned(p, true, at);
    expect(store.snapshot().pinOrder).toEqual(['/c', '/b', '/a']);
    expect(await store.movePin('/a', '/c')).toBe(true);
    expect(store.snapshot().pinOrder).toEqual(['/a', '/c', '/b']);
    expect(await store.movePin('/a', '/c')).toBe(false);
    expect(await store.movePin('/c', null)).toBe(true);
    expect(store.snapshot().pinOrder).toEqual(['/a', '/b', '/c']);
    expect((await CwdStore.load(path)).snapshot().pinOrder).toEqual(['/a', '/b', '/c']);
  });

  test('movePin 的错误：未置顶 / before 未置顶 / 自己；不隐式置顶', async () => {
    const store = await CwdStore.load(path, { defaultCwd: '/h' });
    await store.setPinned('/a', true, 1);
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
    expect(await code(store.movePin('/zzz', null))).toBe('not_pinned');
    expect(await code(store.movePin('/a', '/zzz'))).toBe('before_not_pinned');
    expect(await code(store.movePin('/a', '/a'))).toBe('invalid');
    expect(store.snapshot().pinned).toEqual({ '/a': 1 });
  });

  test('同一目录的多种拼写按目录身份合并（保留较早置顶时间）；移动与 client 乐观更新同一结果', async () => {
    await file({ pinned: { '/a/': 1, '/b': 2, '/a': 3 }, pinOrder: ['/a/', '/b', '/a'] });
    const store = await CwdStore.load(path);
    expect(store.snapshot().pinned).toEqual({ '/a': 1, '/b': 2 });
    expect(store.snapshot().pinOrder).toEqual(['/a', '/b']);
    // 「把 /a 移到末尾」：真的变成 [b, a]（以前精确匹配 /a 会判成无需移动）
    expect(await store.movePin('/a', null)).toBe(true);
    expect(store.snapshot().pinOrder).toEqual(['/b', '/a']);
    expect(movePinOrder(['/a', '/b'], '/a', null)).toEqual(store.snapshot().pinOrder);
    // 不同拼写也算「移到自己前面」
    const code = await store.movePin('/a/', '/a').then(() => 'ok', (e: { code?: string }) => e.code);
    expect(code).toBe('invalid');
    // 置顶 / 取消也按目录身份
    expect(await store.setPinned('/b/', true, 9)).toBe(false);
    expect(await store.setPinned('/b/', false, 9)).toBe(true);
    expect(store.snapshot()).toMatchObject({ pinned: { '/a': 1 }, pinOrder: ['/a'] });
  });

  test('写盘失败：内存不变（候选快照写成功才替换）', async () => {
    const store = await CwdStore.load(join(dir, 'blocker', 'cwd.json'), { defaultCwd: '/h' });
    await store.setPinned('/a', true, 1);
    await store.setPinned('/b', true, 2);
    // 把目标文件位置换成目录：rename 会失败
    await rm(join(dir, 'blocker', 'cwd.json'));
    await mkdir(join(dir, 'blocker', 'cwd.json'));
    await expect(store.movePin('/a', '/b')).rejects.toThrow();
    expect(store.snapshot().pinOrder).toEqual(['/b', '/a']);
    await expect(store.setPinned('/c', true, 3)).rejects.toThrow();
    expect(store.snapshot().pinned).toEqual({ '/a': 1, '/b': 2 });
  });
});

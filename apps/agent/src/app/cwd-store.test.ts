import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CwdStore } from './cwd-store.ts';

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
    expect(store.snapshot()).toEqual({ favorites: [], defaultCwd: '/home/u' });
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
    expect(again.snapshot()).toEqual({ favorites: ['/repo/b'], defaultCwd: '/repo/b' });
  });

  test('文件损坏 → warn 并回到默认值，不抛', async () => {
    await writeFile(path, 'garbage');
    const logs: string[] = [];
    const store = await CwdStore.load(path, { log: (l) => logs.push(l), defaultCwd: '/d' });
    expect(store.snapshot()).toEqual({ favorites: [], defaultCwd: '/d' });
    expect(logs.some((l) => l.includes('损坏'))).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCHIVED_GC_AGE_MS,
  SessionFlagsStore,
  TOMBSTONE_TTL_MS,
} from './session-flags.ts';

let dir: string;
let path: string;
let logs: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trine-flags-'));
  path = join(dir, 'sessions.json');
  logs = [];
});

afterEach(async () => {
  await chmod(dir, 0o700).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const load = () => SessionFlagsStore.load(path, { log: (l) => logs.push(l) });
const readJson = async () => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

describe('SessionFlagsStore · 读写', () => {
  test('不存在 → 空标记，不写文件', async () => {
    const store = await load();
    expect(store.snapshot()).toEqual({ v: 1, archived: {}, deleted: {}, pendingTitle: {}, pinned: {} });
    await expect(stat(path)).rejects.toThrow();
    expect(logs).toEqual([]);
  });

  test('archived：内存先改立刻可读，落盘后可重载；重复归档保留原 archivedAt', async () => {
    const store = await load();
    const write = store.setArchived('s1', 100);
    expect(store.archivedAt('s1')).toBe(100);
    await write;
    await store.setArchived('s1', 999);
    expect(store.archivedAt('s1')).toBe(100);
    expect((await load()).archivedAt('s1')).toBe(100);
    await store.clearArchived('s1');
    expect(store.archivedAt('s1')).toBeUndefined();
    expect((await readJson()).archived).toEqual({});
  });

  test('unarchiveNow：同步清掉，后台落盘', async () => {
    const store = await load();
    await store.setArchived('s1', 1);
    store.unarchiveNow('s1');
    expect(store.archivedAt('s1')).toBeUndefined();
    await store.flush();
    expect((await load()).archivedAt('s1')).toBeUndefined();
  });

  test('pendingTitle 读写与清除', async () => {
    const store = await load();
    await store.setPendingTitle('s1', '部署脚本');
    expect((await load()).pendingTitle('s1')).toBe('部署脚本');
    await store.clearPendingTitle('s1');
    expect(store.pendingTitle('s1')).toBeUndefined();
  });

  test('pinned：重复置顶保留原时间，取消置顶清掉；旧文件无 pinned 键按空读入', async () => {
    const store = await load();
    await store.setPinned('s1', 10);
    await store.setPinned('s1', 20);
    expect((await load()).pinnedAt('s1')).toBe(10);
    await store.clearPinned('s1');
    expect((await readJson()).pinned).toEqual({});
    await writeFile(path, JSON.stringify({ v: 1, archived: { s2: 1 }, deleted: {}, pendingTitle: {} }));
    const old = await load();
    expect(old.archivedAt('s2')).toBe(1);
    expect(old.pinnedAt('s2')).toBeUndefined();
  });

  test('markDeleted：一次写盘清掉 archived/pendingTitle/pinned 并写墓碑', async () => {
    const store = await load();
    await store.setArchived('s1', 1);
    await store.setPendingTitle('s1', 't');
    await store.setPinned('s1', 2);
    await store.markDeleted('s1', 50);
    const file = await readJson();
    expect(file).toEqual({ v: 1, archived: {}, deleted: { s1: 50 }, pendingTitle: {}, pinned: {} });
    expect((await load()).isDeleted('s1')).toBe(true);
  });

  test('文件权限 0600', async () => {
    const store = await load();
    await store.setArchived('s1', 1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('损坏 / schema 不符 → warn 回空、不抛，且之后能正常写', async () => {
    await writeFile(path, 'garbage');
    const store = await load();
    expect(store.snapshot().archived).toEqual({});
    expect(logs.some((l) => l.includes('文件损坏'))).toBe(true);
    await store.setArchived('s1', 1);
    expect((await load()).archivedAt('s1')).toBe(1);

    await writeFile(path, JSON.stringify({ v: 2, archived: {}, deleted: {}, pendingTitle: {} }));
    expect((await load()).snapshot().archived).toEqual({});
  });

  test('损坏时原文件改名为 sessions.json.corrupt-<ts> 留底，之后写盘不覆盖它（评审 minor 6）', async () => {
    const original = JSON.stringify({ v: 2, archived: { keep: 5 }, deleted: {}, pendingTitle: {} });
    await writeFile(path, original);
    const store = await SessionFlagsStore.load(path, { log: (l) => logs.push(l), now: () => 1234 });
    expect(store.snapshot().archived).toEqual({});
    expect(await readFile(`${path}.corrupt-1234`, 'utf8')).toBe(original);
    expect(logs.some((l) => l.includes('corrupt-1234'))).toBe(true);
    await store.setArchived('s1', 1);
    expect(await readFile(`${path}.corrupt-1234`, 'utf8')).toBe(original);
    expect((await load()).archivedAt('s1')).toBe(1);
  });

  test('内存记录：pendingTitle 设置时刻随清除 / 删除消失；自身写入时刻', async () => {
    const store = await load();
    await store.setPendingTitle('s1', 'A', 100);
    expect(store.pendingTitleSetAt('s1')).toBe(100);
    await store.clearPendingTitle('s1');
    expect(store.pendingTitleSetAt('s1')).toBeUndefined();
    store.noteSelfWrite('s1', 200);
    expect(store.lastSelfWriteAt('s1')).toBe(200);
    await store.markDeleted('s1', 300);
    expect(store.lastSelfWriteAt('s1')).toBeUndefined();
    expect(store.deletedIds()).toEqual(['s1']);
    // 不落盘
    expect((await load()).pendingTitleSetAt('s1')).toBeUndefined();
  });

  test('原型链键不串：__proto__ / constructor 当普通 sessionId', async () => {
    const store = await load();
    expect(store.isDeleted('constructor')).toBe(false);
    expect(store.archivedAt('toString')).toBeUndefined();
    await store.setArchived('__proto__', 7);
    expect(store.archivedAt('__proto__')).toBe(7);
    expect(store.archivedAt('other')).toBeUndefined();
    // 原型没被改：其它键照常是空
    expect(Object.getPrototypeOf(store.snapshot().archived)).toBe(Object.prototype);
  });

  test('写盘失败 → reject + log；显式 setter 回滚，墓碑保留并在下次写入补写', async () => {
    const nested = join(dir, 'ro');
    await mkdir(nested);
    const store = await SessionFlagsStore.load(join(nested, 'sessions.json'), { log: (l) => logs.push(l) });
    await chmod(nested, 0o500);
    // 显式 setter：写盘失败回滚自己的内存改动
    await expect(store.setArchived('s1', 1)).rejects.toThrow();
    expect(logs.some((l) => l.includes('落盘失败'))).toBe(true);
    expect(store.archivedAt('s1')).toBeUndefined();
    await expect(store.setPendingTitle('s1', 't')).rejects.toThrow();
    expect(store.pendingTitle('s1')).toBeUndefined();
    // 同步路径（自动取消归档）/ 墓碑：不回滚，置脏等下次补写
    await store.markDeleted('gone', 5).catch(() => {});
    expect(store.isDeleted('gone')).toBe(true);
    await chmod(nested, 0o700);
    await store.setPendingTitle('s2', 't');
    const reloaded = await SessionFlagsStore.load(join(nested, 'sessions.json'));
    expect(reloaded.archivedAt('s1')).toBeUndefined();
    expect(reloaded.isDeleted('gone')).toBe(true);
    expect(reloaded.pendingTitle('s2')).toBe('t');
  });
});

describe('SessionFlagsStore · sweep / GC', () => {
  test('墓碑 TTL = 8 天（park 24h + relay 7d）：未到期保留，到期清掉', async () => {
    expect(TOMBSTONE_TTL_MS).toBe(8 * 24 * 3600 * 1000);
    const store = await load();
    await store.markDeleted('old', 0);
    await store.markDeleted('new', TOMBSTONE_TTL_MS);
    expect(await store.sweepTombstones(TOMBSTONE_TTL_MS - 1)).toBe(0);
    expect(await store.sweepTombstones(TOMBSTONE_TTL_MS)).toBe(1);
    expect(store.isDeleted('old')).toBe(false);
    expect(store.isDeleted('new')).toBe(true);
    expect((await load()).isDeleted('old')).toBe(false);
  });

  test('deletedAt 读墓碑时刻；clearTombstone 提前撤掉并落盘，没有墓碑时是空操作（N1）', async () => {
    const store = await load();
    await store.markDeleted('s1', 1_234);
    expect(store.deletedAt('s1')).toBe(1_234);
    expect(store.deletedAt('nope')).toBeUndefined();
    await store.clearTombstone('s1');
    expect(store.isDeleted('s1')).toBe(false);
    expect(store.deletedIds()).toEqual([]);
    expect((await load()).isDeleted('s1')).toBe(false);
    await store.clearTombstone('s1');
    await store.clearTombstone('__proto__');
    expect(store.deletedAt('__proto__')).toBeUndefined();
  });

  test('归档 GC：只清 >30 天且明确不存在的；查询抛错按存在处理；不看缺席', async () => {
    const store = await load();
    await store.setArchived('young-gone', ARCHIVED_GC_AGE_MS);
    await store.setArchived('old-alive', 0);
    await store.setArchived('old-gone', 0);
    await store.setArchived('old-error', 0);
    const asked: string[] = [];
    const removed = await store.gcArchived(ARCHIVED_GC_AGE_MS + 1, async (sid) => {
      asked.push(sid);
      if (sid === 'old-error') throw new Error('EMFILE');
      return sid === 'old-alive';
    });
    expect(removed).toBe(1);
    expect(asked).not.toContain('young-gone');
    expect(store.archivedAt('old-gone')).toBeUndefined();
    expect(store.archivedAt('old-alive')).toBe(0);
    expect(store.archivedAt('old-error')).toBe(0);
    expect(store.archivedAt('young-gone')).toBe(ARCHIVED_GC_AGE_MS);
  });
});

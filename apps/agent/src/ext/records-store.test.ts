import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXT_RECORDS_PER_SESSION, type ExtRecord } from '@trine/core';
import { SessionRecordsStore } from './records-store.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'trine-records-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const input = (label: string) => ({ ext: 'tasks', extName: 'Tasks', kind: 'linked', label });

describe('SessionRecordsStore', () => {
  test('追加、通知、落盘（0600）后重载；每会话只留最近 N 条', async () => {
    const path = join(root, 'session-ext-records.json');
    let t = 100;
    let n = 0;
    const store = await SessionRecordsStore.load(path, { now: () => ++t, uuid: () => `r${++n}` });
    const seen: [string, ExtRecord][] = [];
    store.onAppend((sid, record) => seen.push([sid, record]));
    const first = store.append('s1', input('A'));
    expect(first).toEqual({ id: 'r1', at: 101, ext: 'tasks', extName: 'Tasks', kind: 'linked', label: 'A' });
    expect(seen).toEqual([['s1', first]]);
    for (let i = 0; i < EXT_RECORDS_PER_SESSION + 5; i++) store.append('s2', input(`x${i}`));
    const s2 = store.of('s2');
    expect(s2).toHaveLength(EXT_RECORDS_PER_SESSION);
    expect(s2[0]!.label).toBe('x5');
    expect(s2.at(-1)!.label).toBe(`x${EXT_RECORDS_PER_SESSION + 4}`);
    await store.flush();
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const again = await SessionRecordsStore.load(path);
    expect(again.of('s1')).toEqual([first]);
    expect(again.of('s2')).toHaveLength(EXT_RECORDS_PER_SESSION);
  });

  test('forget 清掉会话的记录；未知会话返回空数组；不撞原型链', async () => {
    const path = join(root, 'r.json');
    const store = await SessionRecordsStore.load(path);
    store.append('s1', input('A'));
    store.forget('s1');
    expect(store.of('s1')).toEqual([]);
    expect(store.of('__proto__')).toEqual([]);
    store.append('__proto__', input('B'));
    expect(store.of('__proto__')).toHaveLength(1);
    await store.flush();
    expect(JSON.parse(await readFile(path, 'utf8')).records.__proto__).toHaveLength(1);
  });
});

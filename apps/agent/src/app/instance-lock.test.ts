import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireInstanceLock,
  InstanceLockError,
  isProcessAlive,
  LOCK_FILE,
  lockHolder,
} from './instance-lock.ts';

let dir: string;
let home: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trine-lock-'));
  home = join(dir, 'home');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('acquireInstanceLock', () => {
  test('建目录（0700）+ 写 pid；release 删锁且幂等', () => {
    const lock = acquireInstanceLock(home, { pid: 4242, isAlive: () => true });
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readFileSync(lock.path, 'utf8')).toBe('4242\n');
    expect(lockHolder(home, () => true)).toBe(4242);
    lock.release();
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    expect(lockHolder(home, () => true)).toBeNull();
  });

  test('持锁进程存活 → 拒绝，错误带 pid 与路径', () => {
    acquireInstanceLock(home, { pid: 100, isAlive: () => true });
    let err: unknown;
    try {
      acquireInstanceLock(home, { pid: 200, isAlive: (pid) => pid === 100 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InstanceLockError);
    expect((err as InstanceLockError).pid).toBe(100);
    expect((err as InstanceLockError).message).toContain(join(home, LOCK_FILE));
  });

  test('陈旧锁（进程已不在 / 内容损坏）→ 接管', () => {
    acquireInstanceLock(home, { pid: 100, isAlive: () => true });
    const lock = acquireInstanceLock(home, { pid: 200, isAlive: () => false });
    expect(readFileSync(lock.path, 'utf8')).toBe('200\n');

    writeFileSync(lock.path, 'garbage');
    const again = acquireInstanceLock(home, { pid: 300, isAlive: () => true });
    expect(readFileSync(again.path, 'utf8')).toBe('300\n');
  });

  test('release 不删已被别人接管的锁', () => {
    const mine = acquireInstanceLock(home, { pid: 100, isAlive: () => true });
    const theirs = acquireInstanceLock(home, { pid: 200, isAlive: () => false });
    mine.release();
    expect(readFileSync(theirs.path, 'utf8')).toBe('200\n');
  });

  test('isProcessAlive：自己在，明显不存在的 pid 不在', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });
});

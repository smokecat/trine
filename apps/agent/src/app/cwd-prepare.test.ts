import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CWD_CREATE_MAX_DEPTH } from '@trine/core';
import { CwdPrepareError, CwdPreparer } from './cwd-prepare.ts';

let root: string;
let home: string;
let preparer: CwdPreparer;
let logs: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'trine-cwd-prepare-'));
  home = join(root, 'home');
  await mkdir(join(home, '.trine'), { recursive: true });
  logs = [];
  preparer = new CwdPreparer({ osHome: home, trineHome: join(home, '.trine'), log: (l) => logs.push(l) });
});
afterEach(async () => {
  await chmod(join(root, 'locked'), 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CwdPrepareError) return err.code;
    throw err;
  }
  throw new Error('应当失败');
}

describe('CwdPreparer', () => {
  test('已存在的目录：exists，不新建；~ 展开、去掉首尾空白', async () => {
    expect(await preparer.prepare(`  ${home}  `, true)).toEqual({ path: home, status: 'exists', missing: [] });
    expect(await preparer.prepare('~', false)).toEqual({ path: home, status: 'exists', missing: [] });
    expect(logs).toEqual([]);
  });

  test('已存在的密钥类目录也回 exists（预检不收紧 session.create 原有的范围）', async () => {
    await mkdir(join(home, '.ssh'));
    expect((await preparer.prepare('~/.ssh', false)).status).toBe('exists');
  });

  test('不存在：检查只报要新建的各级，不碰文件系统；create 才 mkdir -p', async () => {
    const target = join(home, 'a', 'b', 'c');
    const missing = [join(home, 'a'), join(home, 'a', 'b'), target];
    expect(await preparer.prepare('~/a/b/c', false)).toEqual({ path: target, status: 'missing', missing });
    expect(await stat(join(home, 'a')).catch(() => undefined)).toBeUndefined();
    expect(await preparer.prepare('~/a/b/c', true)).toEqual({ path: target, status: 'created', missing });
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(logs).toHaveLength(1);
    // 再来一次：已存在
    expect((await preparer.prepare(target, true)).status).toBe('exists');
  });

  test('格式不对：相对路径、空、NUL → invalid', async () => {
    expect(await codeOf(preparer.prepare('proj', true))).toBe('invalid');
    expect(await codeOf(preparer.prepare('   ', true))).toBe('invalid');
    expect(await codeOf(preparer.prepare(`${home}/a\0b`, true))).toBe('invalid');
  });

  test('密钥类 / trine home / 系统目录下不新建', async () => {
    expect(await codeOf(preparer.prepare('~/.ssh/new', true))).toBe('denied');
    expect(await codeOf(preparer.prepare('~/proj/.git/hooks', true))).toBe('denied');
    expect(await codeOf(preparer.prepare('~/.trine/x', true))).toBe('denied');
    expect(await codeOf(preparer.prepare('/proc/trine-test-nope', false))).toBe('denied');
    expect(await stat(join(home, 'proj')).catch(() => undefined)).toBeUndefined();
  });

  test('经符号链接新建到密钥类目录里 → denied', async () => {
    await mkdir(join(home, '.aws'));
    await symlink(join(home, '.aws'), join(home, 'cloud'));
    expect(await codeOf(preparer.prepare('~/cloud/new', true))).toBe('denied');
    expect(await stat(join(home, '.aws', 'new')).catch(() => undefined)).toBeUndefined();
  });

  test('路径或祖先是文件、失效的符号链接 → not_dir', async () => {
    await writeFile(join(home, 'f'), 'x');
    expect(await codeOf(preparer.prepare('~/f', true))).toBe('not_dir');
    expect(await codeOf(preparer.prepare('~/f/sub', true))).toBe('not_dir');
    await symlink(join(root, 'nowhere'), join(home, 'dangling'));
    expect(await codeOf(preparer.prepare('~/dangling', true))).toBe('not_dir');
  });

  test('一次新建的层数有上限', async () => {
    const deep = `~/${Array.from({ length: CWD_CREATE_MAX_DEPTH + 1 }, (_, i) => `d${i}`).join('/')}`;
    expect(await codeOf(preparer.prepare(deep, false))).toBe('invalid');
    const ok = `~/${Array.from({ length: CWD_CREATE_MAX_DEPTH }, (_, i) => `d${i}`).join('/')}`;
    expect((await preparer.prepare(ok, false)).missing).toHaveLength(CWD_CREATE_MAX_DEPTH);
  });

  test.skipIf(process.getuid?.() === 0)('没有写权限 → failed，提示是哪个目录', async () => {
    const locked = join(root, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o500);
    const err = await preparer.prepare(join(locked, 'new'), true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CwdPrepareError);
    expect((err as CwdPrepareError).code).toBe('failed');
    expect((err as CwdPrepareError).message).toContain(locked);
  });
});

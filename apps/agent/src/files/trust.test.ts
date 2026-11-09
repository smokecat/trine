import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILES_ROOTS_MAX, FILES_TRUSTED_MAX } from '@trine/core';
import { FakeBlobs } from '../testing/fake-blobs.ts';
import { FileAccess, FileAccessError } from './access.ts';
import { FileService, TrustError } from './service.ts';
import { TrustStore } from './trust-store.ts';

let base: string;
let osHome: string;
let repo: string;
let sibling: string;
let trineHome: string;

function service(store: TrustStore, allow: string[] = []): FileService {
  return new FileService({
    access: new FileAccess({ allow, trusted: () => store.list().map((d) => d.path), osHome, trineHome }),
    maxBytes: 1024 * 1024,
    blobs: () => new FakeBlobs(),
    trust: store,
    now: () => 1_000,
  });
}

async function denied(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof FileAccessError) return `${err.code}:${err.reason ?? '-'}`;
    if (err instanceof TrustError) return err.code;
    throw err;
  }
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'trine-trust-test-')));
  osHome = join(base, 'home');
  repo = join(osHome, 'work', 'repo');
  sibling = join(osHome, 'work', 'sibling');
  trineHome = join(osHome, '.trine');
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(sibling, 'docs'), { recursive: true });
  mkdirSync(join(osHome, '.ssh'), { recursive: true });
  mkdirSync(trineHome, { recursive: true });
  writeFileSync(join(repo, 'a.md'), 'a');
  writeFileSync(join(sibling, 'docs', 'b.md'), 'b');
  writeFileSync(join(sibling, '.env'), 'TOKEN=synthetic');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('往上浏览', () => {
  test('会话目录之上默认不在范围内，reason = out_of_scope', async () => {
    const files = service(TrustStore.memory());
    expect(await denied(files.list(repo, '..'))).toBe('denied:out_of_scope');
    expect(await denied(files.list(repo, sibling))).toBe('denied:out_of_scope');
    // 不存在的范围外路径也一样，不泄露存在性
    expect(await denied(files.list(repo, join(sibling, 'nope')))).toBe('denied:out_of_scope');
  });

  test('信任上级目录后可以浏览同级目录，密钥类照样拒绝（reason = sensitive）', async () => {
    const store = TrustStore.memory();
    const files = service(store);
    await files.trust(join(osHome, 'work'));
    const up = await files.list(repo, '..');
    expect(up.path).toBe(join(osHome, 'work'));
    expect(up.root).toBe(join(osHome, 'work'));
    expect(up.entries.map((e) => e.name)).toEqual(['repo', 'sibling']);
    // 会话目录本身仍以会话 cwd 为根
    expect((await files.list(repo, undefined)).root).toBe(repo);
    expect((await files.list(repo, join(sibling, 'docs'))).entries.map((e) => e.name)).toEqual(['b.md']);
    expect(await denied(files.read(repo, join(sibling, '.env')))).toBe('denied:sensitive');
  });

  test('取消信任立即生效', async () => {
    const store = TrustStore.memory();
    const files = service(store);
    const saved = await files.trust(sibling);
    expect((await files.list(repo, sibling)).root).toBe(sibling);
    await files.untrust(saved);
    expect(await denied(files.list(repo, sibling))).toBe('denied:out_of_scope');
  });

  test('/proc /sys /dev 一律拒绝，会话 cwd 是 / 也不行', async () => {
    const files = service(TrustStore.memory());
    for (const p of ['/proc/self/environ', '/sys', '/dev']) {
      expect(await denied(files.list('/', p))).toBe('denied:sensitive');
    }
  });
});

describe('评审补充：复查、存在性、上限', () => {
  test('信任后把目录换成指向 / 的链接：不再当根用', async () => {
    const store = TrustStore.memory();
    const files = service(store);
    const link = join(osHome, 'work', 'link');
    symlinkSync(sibling, link);
    await files.trust(link);
    expect((await files.list(repo, link)).root).toBe(link);
    rmSync(link);
    symlinkSync('/', link);
    expect(await denied(files.list(repo, link))).toBe('denied:out_of_scope');
    expect(await denied(files.list(repo, join(link, 'etc')))).toBe('denied:out_of_scope');
  });

  test('范围外的密钥类路径回 sensitive（字面判断，不碰文件系统）', async () => {
    const files = service(TrustStore.memory());
    expect(await denied(files.list(repo, join(osHome, '.ssh')))).toBe('denied:sensitive');
    expect(await denied(files.list(repo, '/proc'))).toBe('denied:sensitive');
  });

  test('指向范围外的断链与指向范围外的真文件回同样的结果', async () => {
    const files = service(TrustStore.memory());
    writeFileSync(join(base, 'outside.md'), 'x');
    symlinkSync(join(base, 'outside.md'), join(repo, 'live'));
    symlinkSync(join(base, 'missing.md'), join(repo, 'dangling'));
    expect(await denied(files.read(repo, 'live'))).toBe('denied:out_of_scope');
    expect(await denied(files.read(repo, 'dangling'))).toBe('denied:out_of_scope');
    // 普通的不存在文件照旧 not_found
    expect(await denied(files.read(repo, 'nope.md'))).toBe('not_found:-');
  });

  test('信任 trine home 的祖先后，trine home 里存在与不存在的文件回同一种拒绝', async () => {
    const files = service(TrustStore.memory());
    await files.trust(osHome);
    writeFileSync(join(trineHome, 'identity.json'), '{}');
    symlinkSync(trineHome, join(osHome, 'th'));
    expect(await denied(files.read(repo, join(osHome, 'th', 'identity.json')))).toBe('denied:sensitive');
    expect(await denied(files.read(repo, join(osHome, 'th', 'missing.json')))).toBe('denied:sensitive');
  });

  test('roots 不超过协议上限（过长的 TRINE_FILES_ALLOW 被截断）', async () => {
    const env = Array.from({ length: FILES_ROOTS_MAX + 10 }, (_, i) => `/env/${i}`);
    const store = TrustStore.memory([{ path: repo, addedAt: 1 }]);
    const roots = service(store, env).roots()!;
    expect(roots.length).toBe(FILES_ROOTS_MAX);
    expect(roots.at(-1)).toEqual({ path: repo, source: 'trusted', addedAt: 1 });
  });
});

describe('信任目录的校验', () => {
  test('相对路径、/、不存在、文件、密钥类、trine home 都拒绝', async () => {
    const files = service(TrustStore.memory());
    expect(await denied(files.trust('work'))).toBe('invalid');
    expect(await denied(files.trust('/'))).toBe('denied');
    expect(await denied(files.trust(join(osHome, 'missing')))).toBe('not_found');
    expect(await denied(files.trust(join(repo, 'a.md')))).toBe('not_found');
    expect(await denied(files.trust(join(osHome, '.ssh')))).toBe('denied');
    expect(await denied(files.trust(trineHome))).toBe('denied');
    expect(await denied(files.trust('/proc'))).toBe('denied');
  });

  test('指向 / 的符号链接也拒绝', async () => {
    symlinkSync('/', join(osHome, 'rootlink'));
    expect(await denied(service(TrustStore.memory()).trust(join(osHome, 'rootlink')))).toBe('denied');
  });

  test('~ 展开；重复加、已在 TRINE_FILES_ALLOW 里都算成功且不重复存', async () => {
    const store = TrustStore.memory();
    const files = service(store, [sibling]);
    expect(await files.trust('~/work/repo')).toBe(repo);
    expect(await files.trust(`${repo}/`)).toBe(repo);
    expect(await files.trust(sibling)).toBe(sibling);
    expect(store.list()).toEqual([{ path: repo, addedAt: 1_000 }]);
    expect(files.roots()).toEqual([
      { path: sibling, source: 'env' },
      { path: repo, source: 'trusted', addedAt: 1_000 },
    ]);
  });

  test('TRINE_FILES_ALLOW 来源和不在列表里的都不能删', async () => {
    const files = service(TrustStore.memory(), [sibling]);
    expect(await denied(files.untrust(sibling))).toBe('not_trusted');
    expect(await denied(files.untrust(repo))).toBe('not_trusted');
  });

  test('上限', async () => {
    const store = TrustStore.memory(Array.from({ length: FILES_TRUSTED_MAX }, (_, i) => ({ path: `/x/${i}`, addedAt: 0 })));
    expect(await denied(service(store).trust(repo))).toBe('limit');
  });

  test('home 本身可以信任（网页侧负责警告）', async () => {
    expect(await service(TrustStore.memory()).trust('~')).toBe(osHome);
  });
});

describe('TrustStore 持久化', () => {
  test('写盘 0600，重新加载一致', async () => {
    const path = join(trineHome, 'files.json');
    const store = await TrustStore.load(path);
    await store.add(repo, 5);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await TrustStore.load(path)).list()).toEqual([{ path: repo, addedAt: 5 }]);
    await store.remove(repo);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 1, trusted: [] });
  });

  test('文件损坏按空列表处理，不抛', async () => {
    const path = join(trineHome, 'files.json');
    writeFileSync(path, '{not json');
    const lines: string[] = [];
    const store = await TrustStore.load(path, { log: (l) => lines.push(l) });
    expect(store.list()).toEqual([]);
    expect(lines.length).toBe(1);
  });

  test('写盘失败时内存不变', async () => {
    // 目标路径是个目录：rename 会失败
    const path = join(trineHome, 'dir-as-file');
    mkdirSync(join(path, 'x'), { recursive: true });
    const store = await TrustStore.load(path);
    await expect(store.add(repo, 1)).rejects.toThrow();
    expect(store.list()).toEqual([]);
  });
});

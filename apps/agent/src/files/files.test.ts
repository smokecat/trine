import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptBlob, sodiumReady } from '@trine/core/crypto';
import { FakeBlobs } from '../testing/fake-blobs.ts';
import { FileAccess, FileAccessError, isSensitiveName } from './access.ts';
import { detectKind } from './kind.ts';
import { FileService } from './service.ts';

let base: string;
let repo: string;
let outside: string;
let osHome: string;
let trineHome: string;
let blobs: FakeBlobs;

function service(opts: { allow?: string[]; maxBytes?: number; blobs?: FakeBlobs | undefined } = {}): FileService {
  return new FileService({
    access: new FileAccess({ allow: opts.allow ?? [], osHome, trineHome }),
    maxBytes: opts.maxBytes ?? 1024 * 1024,
    blobs: () => ('blobs' in opts ? opts.blobs : blobs),
  });
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof FileAccessError) return err.code;
    throw err;
  }
}

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'trine-files-test-')));
  osHome = join(base, 'home');
  repo = join(osHome, 'repo');
  outside = join(base, 'outside');
  trineHome = join(repo, '.trine');
  mkdirSync(join(repo, 'docs', 'design'), { recursive: true });
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(trineHome, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# Synthetic\n');
  writeFileSync(join(repo, 'docs', 'plan.md'), '## plan\n');
  writeFileSync(join(repo, 'notes.txt'), 'hello');
  writeFileSync(join(repo, '.env'), 'TOKEN=synthetic');
  writeFileSync(join(repo, '.env.example'), 'TOKEN=');
  writeFileSync(join(repo, '.git', 'config'), '[core]');
  writeFileSync(join(trineHome, 'identity.json'), '{}');
  writeFileSync(join(outside, 'secret.md'), 'outside');
  blobs = new FakeBlobs();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('isSensitiveName', () => {
  test('密钥类文件名', () => {
    for (const n of ['.env', '.env.local', '.env.production', 'server.pem', 'tls.key', 'id_rsa', 'id_ed25519', '.netrc', '.npmrc', 'credentials.json', 'cert.p12']) {
      expect(isSensitiveName(n)).toBe(true);
    }
    for (const n of ['.env.example', '.env.sample', 'id_rsa.pub', 'README.md', 'keyboard.ts', 'env.ts', 'monkey.txt']) {
      expect(isSensitiveName(n)).toBe(false);
    }
  });
});

describe('detectKind', () => {
  const text = new TextEncoder().encode('plain text\n');
  test('按扩展名', () => {
    expect(detectKind('a.md', text).kind).toBe('markdown');
    expect(detectKind('a.pdf', new Uint8Array([0x25, 0x50, 0, 1])).kind).toBe('pdf');
    expect(detectKind('a.png', new Uint8Array([0x89, 0x50, 0])).kind).toBe('image');
    expect(detectKind('a.ts', text)).toEqual({ kind: 'text', mime: 'text/plain' });
    expect(detectKind('a.json', text)).toEqual({ kind: 'text', mime: 'application/json' });
  });
  test('文本类扩展名也嗅探：二进制内容 → binary', () => {
    expect(detectKind('video.ts', new Uint8Array([0x47, 0, 0x11])).kind).toBe('binary');
  });
  test('无扩展名靠嗅探', () => {
    expect(detectKind('Makefile', text).kind).toBe('text');
    expect(detectKind('unknown', text).kind).toBe('text');
    expect(detectKind('unknown', new Uint8Array([1, 2, 0, 3])).kind).toBe('binary');
    expect(detectKind('latin1', new Uint8Array([0x61, 0xe9, 0x62])).kind).toBe('binary');
    // 截断在多字节字符中间不算非法
    expect(detectKind('cut', new TextEncoder().encode('中文').subarray(0, 4)).kind).toBe('text');
  });
});

describe('FileService.list', () => {
  test('默认列会话 cwd：目录在前、密钥类标 denied', async () => {
    const r = await service().list(repo, undefined);
    expect(r.path).toBe(repo);
    expect(r.root).toBe(repo);
    expect(r.truncated).toBe(false);
    const names = r.entries.map((e) => e.name);
    expect(names.slice(0, 3)).toEqual(['.git', '.trine', 'docs']);
    const byName = new Map(r.entries.map((e) => [e.name, e]));
    expect(byName.get('README.md')).toMatchObject({ type: 'file', size: 12 });
    expect(byName.get('README.md')?.denied).toBeUndefined();
    expect(byName.get('.env')?.denied).toBe(true);
    expect(byName.get('.env.example')?.denied).toBeUndefined();
    expect(byName.get('.git')?.denied).toBe(true);
    expect(byName.get('.trine')?.denied).toBe(true);
  });

  test('相对路径相对 cwd', async () => {
    const r = await service().list(repo, 'docs');
    expect(r.path).toBe(join(repo, 'docs'));
    expect(r.entries.map((e) => e.name)).toEqual(['design', 'plan.md']);
  });

  test('cwd 之外：denied（不论存不存在），白名单放行', async () => {
    expect(await code(service().list(repo, outside))).toBe('denied');
    expect(await code(service().list(repo, join(outside, 'nope')))).toBe('denied');
    expect(await code(service().list(repo, '../'))).toBe('denied');
    expect(await code(service().list(repo, '~'))).toBe('denied');
    const r = await service({ allow: [outside] }).list(repo, outside);
    expect(r.root).toBe(outside);
    expect(r.entries.map((e) => e.name)).toEqual(['secret.md']);
  });

  test('不是目录 / 不存在', async () => {
    expect(await code(service().list(repo, 'README.md'))).toBe('not_dir');
    expect(await code(service().list(repo, 'missing'))).toBe('not_found');
  });

  test('没有 cwd 也没有白名单：denied', async () => {
    expect(await code(service().list(undefined, undefined))).toBe('denied');
  });

  test('指向范围外的符号链接：列出但 denied；断链为 other + denied', async () => {
    symlinkSync(outside, join(repo, 'escape'));
    symlinkSync(join(repo, 'docs'), join(repo, 'docs-link'));
    symlinkSync(join(repo, 'gone'), join(repo, 'dangling'));
    const r = await service().list(repo, undefined);
    const byName = new Map(r.entries.map((e) => [e.name, e]));
    // 范围外的目标只给名字，不给类型 / 大小 / 时间
    expect(byName.get('escape')).toEqual({ name: 'escape', type: 'other', denied: true });
    expect(byName.get('docs-link')?.denied).toBeUndefined();
    expect(byName.get('dangling')).toEqual({ name: 'dangling', type: 'other', denied: true });
  });
});

describe('FileService.read', () => {
  test('读文件：加密上传，引用能解出原文', async () => {
    const f = await service().read(repo, 'docs/plan.md');
    expect(f).toMatchObject({ path: join(repo, 'docs', 'plan.md'), root: repo, name: 'plan.md', size: 8, kind: 'markdown', mime: 'text/markdown' });
    const plain = decryptBlob(blobs.store.get(f.blobId)!, f.key);
    expect(new TextDecoder().decode(plain)).toBe('## plan\n');
  });

  test('绝对路径与 ~', async () => {
    expect((await service().read(repo, join(repo, 'notes.txt'))).kind).toBe('text');
    expect((await service().read(repo, '~/repo/README.md')).name).toBe('README.md');
  });

  test('密钥类、.git 内部、trine home：denied', async () => {
    expect(await code(service().read(repo, '.env'))).toBe('denied');
    expect(await code(service().read(repo, '.git/config'))).toBe('denied');
    expect(await code(service().read(repo, '.trine/identity.json'))).toBe('denied');
    expect((await service().read(repo, '.env.example')).name).toBe('.env.example');
  });

  test('trine home 在白名单里也拒绝', async () => {
    expect(await code(service({ allow: [trineHome] }).read(undefined, join(trineHome, 'identity.json')))).toBe('denied');
  });

  test('符号链接逃逸：denied；链到范围内：可读，path 保留链接名', async () => {
    symlinkSync(join(outside, 'secret.md'), join(repo, 'leak.md'));
    symlinkSync(join(repo, '.env'), join(repo, 'env.txt'));
    symlinkSync(join(repo, 'README.md'), join(repo, 'alias.md'));
    expect(await code(service().read(repo, 'leak.md'))).toBe('denied');
    expect(await code(service().read(repo, 'env.txt'))).toBe('denied');
    const f = await service().read(repo, 'alias.md');
    expect(f.path).toBe(join(repo, 'alias.md'));
    expect(f.size).toBe(12);
  });

  test('密钥类名字经符号链接改名也拒绝：.env → 无害文件、.git → 别的目录', async () => {
    mkdirSync(join(repo, 'cfg'));
    writeFileSync(join(repo, 'cfg', 'live'), 'TOKEN=x');
    symlinkSync(join(repo, 'cfg', 'live'), join(repo, '.env.local'));
    mkdirSync(join(repo, 'git-store'));
    writeFileSync(join(repo, 'git-store', 'config'), '[core]');
    rmSync(join(repo, '.git'), { recursive: true });
    symlinkSync(join(repo, 'git-store'), join(repo, '.git'));
    expect(await code(service().read(repo, '.env.local'))).toBe('denied');
    expect(await code(service().read(repo, '.git/config'))).toBe('denied');
    const r = await service().list(repo, undefined);
    expect(r.entries.find((e) => e.name === '.env.local')).toEqual({ name: '.env.local', type: 'file', denied: true });
  });

  test('密钥类目录不分大小写', async () => {
    mkdirSync(join(repo, '.SSH'));
    writeFileSync(join(repo, '.SSH', 'deploy'), 'k');
    expect(await code(service().read(repo, '.SSH/deploy'))).toBe('denied');
  });

  test('经范围外的符号链接探测不存在的文件：同样回 denied，不泄露存在与否', async () => {
    symlinkSync(outside, join(repo, 'out'));
    expect(await code(service().read(repo, 'out/secret.md'))).toBe('denied');
    expect(await code(service().read(repo, 'out/missing.md'))).toBe('denied');
    expect(await code(service().read(repo, 'docs/missing/deeper.md'))).toBe('not_found');
  });

  test('命名管道不会把读取挂住', async () => {
    const fifo = join(repo, 'pipe');
    if (Bun.spawnSync(['mkfifo', fifo]).exitCode !== 0) return; // 没有 mkfifo 的环境跳过
    expect(await code(service().read(repo, 'pipe'))).toBe('io');
  });

  test('目录 / 不存在 / 过大', async () => {
    expect(await code(service().read(repo, 'docs'))).toBe('is_dir');
    expect(await code(service().read(repo, 'missing.md'))).toBe('not_found');
    writeFileSync(join(repo, 'big.txt'), 'x'.repeat(2000));
    expect(await code(service({ maxBytes: 1000 }).read(repo, 'big.txt'))).toBe('too_large');
    expect(blobs.store.size).toBe(0);
  });

  test('relay 没连上：unavailable', async () => {
    expect(await code(service({ blobs: undefined }).read(repo, 'README.md'))).toBe('unavailable');
  });
});

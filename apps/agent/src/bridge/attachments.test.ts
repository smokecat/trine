import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttachmentRef } from '@trine/core';
import { decryptBlob, sodiumReady } from '@trine/core/crypto';
import { FakeBlobs } from '../testing/fake-blobs.ts';
import {
  AttachmentError,
  AttachmentStore,
  INLINE_IMAGE_MAX_BYTES,
  safeFileName,
  stripAttachedFiles,
} from './attachments.ts';

/** 3×2 PNG（合成） */
const PNG = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAFUlEQVR4nGM8wcXFwMDAwMDAxAADABByAOAp6i43AAAAAElFTkSuQmCC', 'base64'),
);

/** 只有头部的「大图」：sniff 只看 IHDR，像素数据无所谓 */
function pngHeader(width: number, height: number): Uint8Array {
  const out = PNG.slice();
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

let root: string;
let blobs: FakeBlobs;
let store: AttachmentStore;

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trine-attach-test-'));
  blobs = new FakeBlobs();
  store = new AttachmentStore({ root, blobs: () => blobs, now: () => 1000 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ref(name: string, bytes: Uint8Array, kind: 'image' | 'file', mime = 'application/octet-stream'): AttachmentRef {
  return { name, mime, size: bytes.length, kind, ...blobs.put(bytes) };
}

describe('AttachmentStore.prepare', () => {
  test('小图内联在文字前面，文件落盘后附路径清单', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 synthetic');
    const refs = [ref('shot.png', PNG, 'image', 'image/png'), ref('report.pdf', pdf, 'file', 'application/pdf')];
    const prepared = await store.prepare({ sessionId: 's1', clientMsgId: 'c1', text: '看看', refs });

    expect(prepared.attachments).toEqual(refs);
    const content = prepared.content as { type: string; source?: { media_type: string; data: string }; text?: string }[];
    expect(content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: Buffer.from(PNG).toString('base64') } as never,
    });
    const text = content[1]!.text!;
    const pdfPath = join(root, 's1', readdirSync(join(root, 's1'))[0]!, 'report.pdf');
    expect(text).toBe(`看看\n\n<attached-files>\n${pdfPath}\n</attached-files>`);
    expect(readFileSync(pdfPath)).toEqual(Buffer.from(pdf));
    expect(stripAttachedFiles(text)).toBe('看看');
  });

  test('超过内联条件的图片（边长 / 字节 / 认不出格式）走路径；只有附件时没有多余空行', async () => {
    const refs = [
      ref('wide.png', pngHeader(4000, 100), 'image', 'image/png'),
      ref('fake.png', new TextEncoder().encode('not really a png'), 'image', 'image/png'),
      ref('huge.png', new Uint8Array(INLINE_IMAGE_MAX_BYTES + 1), 'image', 'image/png'),
    ];
    const prepared = await store.prepare({ sessionId: 's1', clientMsgId: 'c1', text: '', refs });
    expect(typeof prepared.content).toBe('string');
    const lines = (prepared.content as string).split('\n');
    expect(lines[0]).toBe('<attached-files>');
    expect(lines.slice(1, 4).map((l) => l.split('/').at(-1))).toEqual(['wide.png', 'fake.png', 'huge.png']);
  });

  test('只有内联图片、没有文字：内容只有图片块', async () => {
    const prepared = await store.prepare({
      sessionId: 's1',
      clientMsgId: 'c1',
      text: '',
      refs: [ref('a.png', PNG, 'image', 'image/png')],
    });
    expect((prepared.content as { type: string }[]).map((b) => b.type)).toEqual(['image']);
  });

  test('同一 clientMsgId 再来一次复用落盘结果，不重新下载', async () => {
    const refs = [ref('a.txt', new Uint8Array([1, 2, 3]), 'file')];
    const first = await store.prepare({ sessionId: 's1', clientMsgId: 'c1', text: 'x', refs });
    const second = await store.prepare({ sessionId: 's1', clientMsgId: 'c1', text: 'x', refs });
    expect(second).toEqual(first);
    expect(blobs.downloads).toBe(1);
  });

  test('下载失败 / 大小不符：抛 AttachmentError 并清掉半成品，下次可重试', async () => {
    const good = ref('a.txt', new Uint8Array([1, 2, 3]), 'file');
    const missing = { ...good, blobId: 'missing00000000000000000' };
    await expect(store.prepare({ sessionId: 's1', clientMsgId: 'c1', text: 'x', refs: [good, missing] })).rejects.toThrow(
      AttachmentError,
    );
    expect(readdirSync(join(root, 's1'))).toEqual([]);

    const lying = { ...good, size: 2 };
    await expect(store.prepare({ sessionId: 's1', clientMsgId: 'c2', text: 'x', refs: [lying] })).rejects.toThrow(
      AttachmentError,
    );

    // 重试成功
    await store.prepare({ sessionId: 's1', clientMsgId: 'c1', text: 'x', refs: [good] });
  });

  test('没连上 relay：unavailable', async () => {
    const offline = new AttachmentStore({ root, blobs: () => undefined });
    const err = await offline
      .prepare({ sessionId: 's1', clientMsgId: 'c1', text: 'x', refs: [ref('a', new Uint8Array(1), 'file')] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentError);
    expect((err as AttachmentError).code).toBe('unavailable');
  });

  test('会话 id / 文件名不能逃出上传目录', async () => {
    await store.prepare({
      sessionId: '../../evil',
      clientMsgId: '../x',
      text: '',
      refs: [ref('../../etc/passwd', new Uint8Array([1]), 'file')],
    });
    const sessions = readdirSync(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatch(/^[0-9a-f]{32}$/);
    const msgDir = join(root, sessions[0]!, readdirSync(join(root, sessions[0]!))[0]!);
    expect(readdirSync(msgDir).sort()).toEqual(['_.._etc_passwd', 'manifest.json']);
  });
});

describe('历史与按需拉取', () => {
  test('bindUuid 后 historyIndex 按转录 uuid 给出附件列表', async () => {
    const refs = [ref('a.txt', new Uint8Array([1, 2, 3]), 'file')];
    await store.prepare({ sessionId: 's1', clientMsgId: 'c1', text: 'x', refs });
    expect((await store.historyIndex('s1')).size).toBe(0);
    await store.bindUuid('s1', 'c1', 'uuid-1');
    expect(await store.historyIndex('s1')).toEqual(new Map([['uuid-1', refs]]));
    expect(await store.historyIndex('other')).toEqual(new Map());
  });

  test('fetchRef：有 manifest 从本机副本重新上传，并更新引用', async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    await store.prepare({ sessionId: 's1', clientMsgId: 'c1', text: 'x', refs: [ref('a.bin', bytes, 'file')] });
    await store.bindUuid('s1', 'c1', 'uuid-1');

    const fresh = await store.fetchRef('s1', 'uuid-1', 0, async () => {
      throw new Error('有 manifest 时不该读转录');
    });
    expect(fresh).toMatchObject({ name: 'a.bin', size: 3, kind: 'file' });
    expect(decryptBlob(blobs.store.get(fresh.blobId)!, fresh.key)).toEqual(bytes);
    expect((await store.historyIndex('s1')).get('uuid-1')?.[0]?.blobId).toBe(fresh.blobId);

    await expect(store.fetchRef('s1', 'uuid-1', 5, async () => [])).rejects.toThrow(AttachmentError);
  });

  test('fetchRef：没有 manifest 时取转录里的图片块', async () => {
    const data = Buffer.from(PNG).toString('base64');
    const fresh = await store.fetchRef('s1', 'cli-uuid', 1, async () => [
      { mediaType: 'image/jpeg', data: 'AAAA' },
      { mediaType: 'image/png', data },
    ]);
    expect(fresh).toMatchObject({ name: 'image-2.png', mime: 'image/png', size: PNG.length, kind: 'image' });
    expect(decryptBlob(blobs.store.get(fresh.blobId)!, fresh.key)).toEqual(PNG);

    const err = await store.fetchRef('s1', 'cli-uuid', 2, async () => []).catch((e: unknown) => e);
    expect((err as AttachmentError).code).toBe('not_found');
  });

  test('removeSession 清掉整个会话目录', async () => {
    await store.prepare({ sessionId: 's1', clientMsgId: 'c1', text: 'x', refs: [ref('a', new Uint8Array(1), 'file')] });
    await store.removeSession('s1');
    expect(existsSync(join(root, 's1'))).toBe(false);
  });
});

describe('safeFileName', () => {
  test('保留原名、去掉危险字符、重名加序号、超长截断保留扩展名', () => {
    const used = new Set<string>();
    expect(safeFileName('报告 v2.pdf', used)).toBe('报告 v2.pdf');
    expect(safeFileName('报告 v2.pdf', used)).toBe('报告 v2 (2).pdf');
    expect(safeFileName('.env', used)).toBe('env');
    expect(safeFileName('a/b\\c\u0000.txt', used)).toBe('a_b_c_.txt');
    expect(safeFileName('...', used)).toBe('file');
    const long = safeFileName(`${'x'.repeat(300)}.png`, used);
    expect(long).toBe(`${'x'.repeat(120)}.png`);
  });
});

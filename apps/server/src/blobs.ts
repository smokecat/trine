/**
 * 附件 blob 存储：一目录、一 blob 一文件，按 TTL 清理。
 *
 * relay 只存**密文**（附件在发送端用一次性 key 加密，key 走 E2E 帧，见
 * `@trine/core/crypto` blob.ts），这里不知道也不关心内容。不进 SQLite：
 * 几十 MB 的值放进 sqlite 既拖慢备份又放大 WAL，平铺文件更合适。
 *
 * 上传是流式写盘：边读请求体边写 `<id>.part`、边计数，超过上限立即中止并删掉
 * 半成品，完成后原子改名。不能在前面套 Hono 的 bodyLimit——它遇到没有
 * Content-Length 的 chunked 请求会先把整个请求体读进内存。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** 半成品（.part）超过这么久还在，视为上传中断的残留 */
const PART_STALE_MS = 60 * 60 * 1000;

const BLOB_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export type BlobPutResult =
  | { ok: true; blobId: string; size: number }
  | { ok: false; error: 'too_large' | 'empty' | 'io' };

export interface BlobStoreOptions {
  dir: string;
  /** 单个 blob 字节上限 */
  maxBytes: number;
  ttlMs: number;
  now?: () => number;
}

export class BlobStore {
  readonly dir: string;
  readonly maxBytes: number;
  readonly ttlMs: number;
  readonly #now: () => number;

  constructor(options: BlobStoreOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes;
    this.ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  static isValidId(id: string): boolean {
    return BLOB_ID_RE.test(id);
  }

  async put(body: ReadableStream<Uint8Array> | null): Promise<BlobPutResult> {
    if (body === null) return { ok: false, error: 'empty' };
    const blobId = randomBytes(16).toString('base64url');
    const part = join(this.dir, `${blobId}.part`);
    const writer = Bun.file(part).writer();
    let size = 0;
    let failure: 'too_large' | 'empty' | 'io' | undefined;
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > this.maxBytes) {
          failure = 'too_large';
          await reader.cancel().catch(() => {});
          break;
        }
        writer.write(value);
        // flush 才是背压：不等它的话慢磁盘会让数据全堆在内存里
        await writer.flush();
      }
    } catch {
      failure = 'io';
    }
    try {
      await writer.end();
    } catch {
      failure ??= 'io';
    }
    if (failure === undefined && size === 0) failure = 'empty';
    if (failure !== undefined) {
      await rm(part, { force: true });
      return { ok: false, error: failure };
    }
    try {
      await rename(part, join(this.dir, blobId));
    } catch {
      await rm(part, { force: true });
      return { ok: false, error: 'io' };
    }
    return { ok: true, blobId, size };
  }

  /** 取 blob 文件；不存在 / 已过期 → null */
  async get(blobId: string): Promise<ReturnType<typeof Bun.file> | null> {
    if (!BlobStore.isValidId(blobId)) return null;
    const path = join(this.dir, blobId);
    try {
      const st = await stat(path);
      if (this.#now() - st.mtimeMs > this.ttlMs) return null;
    } catch {
      return null;
    }
    return Bun.file(path);
  }

  /** 删掉过期 blob 和中断上传的残留，返回删除个数 */
  async sweep(): Promise<number> {
    const now = this.#now();
    let removed = 0;
    for (const name of await readdir(this.dir)) {
      const isPart = name.endsWith('.part');
      if (!isPart && !BLOB_ID_RE.test(name)) continue;
      const path = join(this.dir, name);
      try {
        const st = await stat(path);
        const limit = isPart ? PART_STALE_MS : this.ttlMs;
        if (now - st.mtimeMs > limit) {
          await rm(path, { force: true });
          removed++;
        }
      } catch {
        // 并发删除 / 上传刚好改名：下一轮再说
      }
    }
    return removed;
  }
}

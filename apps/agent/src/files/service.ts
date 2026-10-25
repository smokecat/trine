/**
 * 文件查看（协议 §1.10）：目录列表直接回在应答帧里；文件内容加密后上传 relay blob，
 * 应答只带引用（同附件，见 bridge/attachments.ts）。
 *
 * 只读。范围与密钥类文件的判断在 access.ts。
 */
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { FS_LIST_MAX_ENTRIES, type FsEntry, type FsFile } from '@trine/core';
import { encryptBlob, generateBlobKey } from '@trine/core/crypto';
import type { BlobTransport } from '../bridge/attachments.ts';
import { FileAccess, FileAccessError, isWithin, type Root } from './access.ts';
import { detectKind, SNIFF_BYTES } from './kind.ts';

export interface FileServiceOptions {
  access: FileAccess;
  /** 单个文件字节上限 */
  maxBytes: number;
  blobs: () => BlobTransport | undefined;
}

export interface ListResult {
  path: string;
  root: string;
  entries: FsEntry[];
  truncated: boolean;
}

/** 列目录时并发 stat 的批大小 */
const STAT_BATCH = 64;

export class FileService {
  readonly maxBytes: number;
  readonly #access: FileAccess;
  readonly #blobs: () => BlobTransport | undefined;

  constructor(options: FileServiceOptions) {
    this.#access = options.access;
    this.maxBytes = options.maxBytes;
    this.#blobs = options.blobs;
  }

  async list(cwd: string | undefined, input: string | undefined): Promise<ListResult> {
    const roots = await this.#access.roots(cwd);
    const target = await this.#access.resolve(input, roots);
    const st = await stat(target.real).catch(ioError);
    if (!st.isDirectory()) throw new FileAccessError('not_dir', '不是目录');
    const dirents = await readdir(target.real, { withFileTypes: true }).catch(ioError);
    // 目录在前、按名字排；超出上限的不 stat
    dirents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const kept = dirents.slice(0, FS_LIST_MAX_ENTRIES);
    const entries: FsEntry[] = [];
    for (let i = 0; i < kept.length; i += STAT_BATCH) {
      const batch = kept.slice(i, i + STAT_BATCH);
      entries.push(...(await Promise.all(batch.map((d) => this.#entry(join(target.real, d.name), d.name, roots)))));
    }
    // 符号链接 stat 之后才知道是不是目录，再排一次
    entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name));
    return { path: target.path, root: target.root.path, entries, truncated: dirents.length > kept.length };
  }

  async #entry(full: string, name: string, roots: readonly Root[]): Promise<FsEntry> {
    try {
      const st = await stat(full); // 跟随符号链接
      const type: FsEntry['type'] = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
      const real = await realpath(full);
      const denied = !roots.some((r) => isWithin(real, r.real)) || (await this.#access.isSensitivePath(real));
      return {
        name,
        type,
        ...(type === 'file' ? { size: st.size } : {}),
        mtime: Math.floor(st.mtimeMs),
        ...(denied ? { denied: true } : {}),
      };
    } catch {
      // 断掉的符号链接、权限不足：列出来但打不开
      return { name, type: 'other', denied: true };
    }
  }

  async read(cwd: string | undefined, input: string): Promise<FsFile> {
    const blobs = this.#blobs();
    if (blobs === undefined) throw new FileAccessError('unavailable', 'agent 还没连上 relay');
    const roots = await this.#access.roots(cwd);
    const target = await this.#access.resolve(input, roots);
    const handle = await open(target.real, 'r').catch(ioError);
    let bytes: Uint8Array;
    let mtime: number;
    try {
      const st = await handle.stat();
      if (st.isDirectory()) throw new FileAccessError('is_dir', '这是一个目录');
      if (!st.isFile()) throw new FileAccessError('io', '不是普通文件');
      if (st.size > this.maxBytes) {
        throw new FileAccessError('too_large', `文件太大（${st.size} 字节，上限 ${this.maxBytes}）`);
      }
      mtime = Math.floor(st.mtimeMs);
      // 以读到的为准（stat 之后文件可能还在长），多出上限的部分不要
      const buf = new Uint8Array(Math.min(st.size, this.maxBytes) + 1);
      let n = 0;
      while (n < buf.length) {
        const { bytesRead } = await handle.read(buf, n, buf.length - n, n);
        if (bytesRead === 0) break;
        n += bytesRead;
      }
      if (n > this.maxBytes) throw new FileAccessError('too_large', `文件太大（上限 ${this.maxBytes} 字节）`);
      bytes = buf.subarray(0, n);
    } finally {
      await handle.close();
    }
    const name = basename(target.path);
    const { kind, mime } = detectKind(name, bytes.subarray(0, SNIFF_BYTES));
    const key = generateBlobKey();
    let blobId: string;
    try {
      ({ blobId } = await blobs.upload(encryptBlob(bytes, key)));
    } catch (err) {
      throw new FileAccessError('io', `上传失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return { path: target.path, root: target.root.path, name, size: bytes.length, mtime, mime, kind, blobId, key };
  }
}

function ioError(err: unknown): never {
  if (err instanceof FileAccessError) throw err;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') throw new FileAccessError('not_found', '文件不存在');
  if (code === 'EACCES' || code === 'EPERM') throw new FileAccessError('denied', '没有读取权限');
  if (code === 'EISDIR') throw new FileAccessError('is_dir', '这是一个目录');
  throw new FileAccessError('io', `读取失败：${err instanceof Error ? err.message : String(err)}`);
}

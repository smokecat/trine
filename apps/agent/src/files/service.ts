/**
 * 文件查看（协议 §1.10）：目录列表直接回在应答帧里；文件内容加密后上传 relay blob，
 * 应答只带引用（同附件，见 bridge/attachments.ts）。
 *
 * 只读。范围与密钥类文件的判断在 access.ts。
 */
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  FILES_ROOTS_MAX,
  FILES_TRUSTED_MAX,
  FS_LIST_MAX_ENTRIES,
  type FilesRoot,
  type FilesTrustErrorCode,
  type FsEntry,
  type FsFile,
} from '@trine/core';
import { encryptBlob, generateBlobKey } from '@trine/core/crypto';
import type { BlobTransport } from '../bridge/attachments.ts';
import { FileAccess, FileAccessError, isWithin, type Root } from './access.ts';
import { detectKind, SNIFF_BYTES } from './kind.ts';
import type { TrustStore } from './trust-store.ts';

export class TrustError extends Error {
  readonly code: FilesTrustErrorCode;
  constructor(code: FilesTrustErrorCode, message: string) {
    super(message);
    this.name = 'TrustError';
    this.code = code;
  }
}

export interface FileServiceOptions {
  access: FileAccess;
  /** 单个文件字节上限 */
  maxBytes: number;
  blobs: () => BlobTransport | undefined;
  /** 信任目录；缺省 = 不支持远程增删（machine.info 不带 roots） */
  trust?: TrustStore;
  now?: () => number;
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
  readonly #trust: TrustStore | undefined;
  readonly #now: () => number;

  constructor(options: FileServiceOptions) {
    this.#access = options.access;
    this.maxBytes = options.maxBytes;
    this.#blobs = options.blobs;
    this.#trust = options.trust;
    this.#now = options.now ?? Date.now;
  }

  /** machine.info.files.roots：TRINE_FILES_ALLOW 在前；不支持信任目录时返回 undefined */
  roots(): FilesRoot[] | undefined {
    if (this.#trust === undefined) return undefined;
    const env = this.#access.allow.map((path): FilesRoot => ({ path, source: 'env' }));
    const seen = new Set(env.map((r) => r.path));
    const trusted = this.#trust
      .list()
      .filter((d) => !seen.has(d.path))
      .map((d): FilesRoot => ({ path: d.path, source: 'trusted', addedAt: d.addedAt }));
    // 协议上限：信任目录最多 FILES_TRUSTED_MAX 个，超出部分只可能来自过长的 TRINE_FILES_ALLOW，从 env 那头截
    const room = Math.max(0, FILES_ROOTS_MAX - trusted.length);
    return [...env.slice(0, room), ...trusted];
  }

  /** agent 的 home（web 用来提示「信任 home 及其上级」的风险） */
  get osHome(): string {
    return this.#access.osHome;
  }

  /**
   * 加入信任目录。校验：绝对路径或 `~`、存在且是目录、不是 `/`（字面与真实路径都查）、
   * 不是密钥类 / trine home 之内 / 系统伪文件系统。已在列表（含 TRINE_FILES_ALLOW）里算成功。
   * @returns 存下的路径
   */
  async trust(input: string): Promise<string> {
    const store = this.#trust;
    if (store === undefined) throw new TrustError('failed', '这台 agent 不支持信任目录');
    if (input.includes('\0')) throw new TrustError('invalid', '路径不合法');
    const path = this.#access.absolute(input.trim(), undefined);
    if (path === undefined) throw new TrustError('invalid', '必须是绝对路径或以 ~ 开头');
    if (path === '/') throw new TrustError('denied', '不能信任根目录 /');
    let real: string;
    try {
      real = await realpath(path);
      if (!(await stat(real)).isDirectory()) throw new TrustError('not_found', '不是目录');
    } catch (err) {
      if (err instanceof TrustError) throw err;
      throw new TrustError('not_found', '目录不存在或无法访问');
    }
    if (real === '/') throw new TrustError('denied', '不能信任根目录 /（这个路径指向 /）');
    if ((await this.#access.isSensitivePath(path)) || (await this.#access.isSensitivePath(real))) {
      throw new TrustError('denied', '密钥类目录、trine 自己的目录和系统目录不能信任');
    }
    if (this.#access.allow.includes(path) || store.has(path)) return path;
    if (store.size >= FILES_TRUSTED_MAX) throw new TrustError('limit', `信任目录最多 ${FILES_TRUSTED_MAX} 个`);
    try {
      await store.add(path, this.#now());
    } catch (err) {
      throw new TrustError('failed', `保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return path;
  }

  /** 移除信任目录（按存下的路径匹配）。TRINE_FILES_ALLOW 来源的不能删 */
  async untrust(path: string): Promise<void> {
    const store = this.#trust;
    if (store === undefined) throw new TrustError('failed', '这台 agent 不支持信任目录');
    if (!store.has(path)) {
      throw new TrustError(
        'not_trusted',
        this.#access.allow.includes(path) ? '这个目录来自 TRINE_FILES_ALLOW，要在机器上改环境变量' : '不在信任目录里',
      );
    }
    try {
      await store.remove(path);
    } catch (err) {
      throw new TrustError('failed', `保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async list(cwd: string | undefined, input: string | undefined): Promise<ListResult> {
    const roots = await this.#access.roots(cwd);
    const target = await this.#access.resolve(input, roots);
    const st = await stat(target.real).catch(ioError);
    if (!st.isDirectory()) throw new FileAccessError('not_dir', '不是目录');
    const dirents = await readdir(target.real, { withFileTypes: true }).catch(ioError);
    // 检查与读目录之间路径被换成符号链接：再解析一次，变了就不认（见 read 的说明）
    if ((await realpath(target.path).catch(() => undefined)) !== target.real) throw new FileAccessError('denied', CHANGED);
    // 目录在前、按名字排；超出上限的不 stat
    dirents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const kept = dirents.slice(0, FS_LIST_MAX_ENTRIES);
    const entries: FsEntry[] = [];
    for (let i = 0; i < kept.length; i += STAT_BATCH) {
      const batch = kept.slice(i, i + STAT_BATCH);
      entries.push(
        ...(await Promise.all(batch.map((d) => this.#entry(join(target.real, d.name), join(target.path, d.name), d.name, roots)))),
      );
    }
    // 符号链接 stat 之后才知道是不是目录，再排一次
    entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name));
    return { path: target.path, root: target.root.path, entries, truncated: dirents.length > kept.length };
  }

  /**
   * 一个条目。指向范围外的符号链接只给名字（类型、大小、时间都是范围外文件的元数据）；
   * 密钥类条目照常给类型，不给大小与时间。
   */
  async #entry(full: string, lexical: string, name: string, roots: readonly Root[]): Promise<FsEntry> {
    try {
      const real = await realpath(full);
      if (!roots.some((r) => isWithin(real, r.real))) return { name, type: 'other', denied: true };
      const st = await stat(real);
      const type: FsEntry['type'] = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
      if ((await this.#access.isSensitivePath(lexical)) || (await this.#access.isSensitivePath(real))) {
        return { name, type, denied: true };
      }
      return { name, type, ...(type === 'file' ? { size: st.size } : {}), mtime: Math.floor(st.mtimeMs) };
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
    // O_NONBLOCK：范围内的命名管道没有写端时，阻塞式 open 会一直挂着（到不了下面的类型检查）；
    // O_NOFOLLOW：末段在检查之后被换成符号链接 → ELOOP
    const handle = await open(target.real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).catch(ioError);
    let bytes: Uint8Array;
    let mtime: number;
    try {
      const st = await handle.stat();
      // 中间某级目录在检查之后被换成符号链接：再解析一次，必须还是同一个文件
      const again = await realpath(target.path).catch(() => undefined);
      const now = again === undefined ? undefined : await stat(again).catch(() => undefined);
      if (again !== target.real || now === undefined || now.ino !== st.ino || now.dev !== st.dev) {
        throw new FileAccessError('denied', CHANGED);
      }
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

const CHANGED = '文件在读取过程中被替换，请重试';

function ioError(err: unknown): never {
  if (err instanceof FileAccessError) throw err;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ELOOP') throw new FileAccessError('denied', CHANGED);
  if (code === 'ENOENT') throw new FileAccessError('not_found', '文件不存在');
  if (code === 'EACCES' || code === 'EPERM') throw new FileAccessError('denied', '没有读取权限');
  if (code === 'EISDIR') throw new FileAccessError('is_dir', '这是一个目录');
  throw new FileAccessError('io', `读取失败：${err instanceof Error ? err.message : String(err)}`);
}

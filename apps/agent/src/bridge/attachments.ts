/**
 * 用户消息附件：relay blob → 本机文件 → SDK 用户消息内容。
 *
 * ## 流程
 *
 * 1. `prepare()`：按 input.send 带来的引用逐个下载 blob、解密、落盘到
 *    `<uploads>/<会话>/<消息>/<文件名>`，写 manifest。同一 clientMsgId 再来一次
 *    （自愈重发）直接复用已落盘的结果。
 * 2. 组装内容，尽量贴近本机 Claude Code CLI 的体验：
 *    - 图片满足内联条件 → `image` 内容块（相当于在 CLI 里粘贴图片），放在文字前面；
 *    - 其余（普通文件、超限图片）→ 文字末尾附 `<attached-files>` 路径清单（相当于
 *      把文件拖进 CLI），由 Claude 用 Read 读取。Read 读图片会自己缩放。
 *    会话的 SDK options 把本会话的上传目录加进 `additionalDirectories`，读这些文件
 *    不弹权限请求（实测：不加则每次 Read 都走 canUseTool）。
 * 3. 历史回看用 manifest 还原附件列表并去掉路径清单（`historyIndex()`）；blob 过期
 *    或从没上传过（CLI 里直接粘贴的图片，只在转录里）时由 `fetchRef()` 重新上传。
 *
 * ## 内联条件
 *
 * API 单张图片 base64 后不超过 5MB（Bedrock / Vertex；直连 API 是 10MB，取严的），
 * 一次请求超过 20 张图时每张边长不超过 2000px——历史轮次里的图片也算数，所以长边
 * 也按 2000 卡。格式以文件头为准（`sniffImage`），浏览器给的 mime 不可信。
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AttachmentMeta, AttachmentRef, HistoryAttachment } from '@trine/core';
import { encryptBlob, generateBlobKey } from '@trine/core/crypto';
import { sniffImage } from './image-info.ts';

export type UserContent = SDKUserMessage['message']['content'];

/** 内联图片的原始字节上限（base64 后约 5MB） */
export const INLINE_IMAGE_MAX_BYTES = 3_750_000;
/** 内联图片的最长边 */
export const INLINE_IMAGE_MAX_EDGE = 2000;
/** agent 接收单个附件的硬上限（防止被一个谎报大小的引用写满磁盘） */
export const ATTACHMENT_FILE_MAX_BYTES = 1024 * 1024 * 1024;

/** 追加在消息文字末尾的路径清单标签；历史回看时据此剥离 */
export const ATTACHED_FILES_TAG = 'attached-files';
const ATTACHED_FILES_RE = new RegExp(`(?:\\n\\n)?<${ATTACHED_FILES_TAG}>\\n[\\s\\S]*?\\n</${ATTACHED_FILES_TAG}>\\s*$`);

const MANIFEST = 'manifest.json';

/** 下载 / 上传 blob 的最小接口（`@trine/core/net` 的 BlobClient 满足它） */
export interface BlobTransport {
  upload(cipher: Uint8Array): Promise<{ blobId: string }>;
  downloadDecrypted(
    blobId: string,
    key: string,
    sink: (chunk: Uint8Array) => void | Promise<void>,
    opts: { maxBytes: number },
  ): Promise<number>;
}

export type AttachmentErrorCode = 'not_found' | 'io' | 'unavailable';

export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

interface StoredAttachment extends AttachmentMeta {
  /** 消息目录下的文件名 */
  file: string;
  /** 内联给模型时的真实格式；undefined = 走路径清单 */
  mediaType?: string;
  blobId?: string;
  key?: string;
}

interface Manifest {
  v: 1;
  clientMsgId: string;
  /** 转录 uuid（send 之后补写）；历史回看按它对上 user 条目 */
  uuid?: string;
  createdAt: number;
  attachments: StoredAttachment[];
}

/** 转录里一张图片块（CLI 粘贴的图片只存在这里） */
export interface TranscriptImage {
  mediaType: string;
  data: string;
}

export interface AttachmentStoreOptions {
  /** 上传根目录（`<home>/uploads`） */
  root: string;
  /** 取 blob 传输；没连上 relay 时返回 undefined */
  blobs: () => BlobTransport | undefined;
  now?: () => number;
}

export interface PreparedInput {
  content: UserContent;
  /** 回显给各设备的引用（与 input.send 带来的一致） */
  attachments: AttachmentRef[];
}

export class AttachmentStore {
  readonly root: string;
  readonly #blobs: () => BlobTransport | undefined;
  readonly #now: () => number;

  constructor(options: AttachmentStoreOptions) {
    // 绝对路径：这些路径要原样写进发给 Claude 的消息，相对路径会按会话 cwd 去解析
    this.root = resolve(options.root);
    this.#blobs = options.blobs;
    this.#now = options.now ?? Date.now;
  }

  /**
   * 会话的上传目录（SDK additionalDirectories 用）；不存在就建。同步：建会话的路径
   * 是同步的，目录得在 SDK 起进程前就在。
   */
  sessionDir(sessionId: string): string {
    const dir = join(this.root, dirName(sessionId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** 下载并落盘一条消息的附件，返回交给 SDK 的内容 */
  async prepare(args: {
    sessionId: string;
    clientMsgId: string;
    text: string;
    refs: readonly AttachmentRef[];
  }): Promise<PreparedInput> {
    const dir = this.#messageDir(args.sessionId, args.clientMsgId);
    let manifest = await readManifest(dir);
    if (manifest === undefined) {
      manifest = await this.#download(dir, args.clientMsgId, args.refs);
    }
    return {
      content: await buildContent(dir, manifest, args.text),
      attachments: manifest.attachments.flatMap((a) => (a.blobId === undefined || a.key === undefined ? [] : [toRef(a)])),
    };
  }

  /** send 定下转录 uuid 后补写进 manifest */
  async bindUuid(sessionId: string, clientMsgId: string, uuid: string): Promise<void> {
    const dir = this.#messageDir(sessionId, clientMsgId);
    const manifest = await readManifest(dir);
    if (manifest === undefined || manifest.uuid === uuid) return;
    await writeManifest(dir, { ...manifest, uuid });
  }

  /** 转录 uuid → 附件列表（历史回看用）。读不到的 manifest 跳过 */
  async historyIndex(sessionId: string): Promise<Map<string, HistoryAttachment[]>> {
    const index = new Map<string, HistoryAttachment[]>();
    for (const { manifest } of await this.#manifests(sessionId)) {
      if (manifest.uuid === undefined) continue;
      index.set(manifest.uuid, manifest.attachments.map(toHistoryAttachment));
    }
    return index;
  }

  /**
   * 第 index 个附件的新引用：从本机副本（有 manifest）或转录里的图片块重新加密上传。
   * `transcriptImages` 只在没有 manifest 时调用。
   */
  async fetchRef(
    sessionId: string,
    messageUuid: string,
    index: number,
    transcriptImages: () => Promise<readonly TranscriptImage[] | undefined>,
  ): Promise<AttachmentRef> {
    const blobs = this.#blobs();
    if (blobs === undefined) throw new AttachmentError('unavailable', '还没连上 relay，稍后再试');

    const found = (await this.#manifests(sessionId)).find((m) => m.manifest.uuid === messageUuid);
    if (found !== undefined) {
      const entry = found.manifest.attachments[index];
      if (entry === undefined) throw new AttachmentError('not_found', '找不到这个附件');
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(join(found.dir, entry.file)));
      } catch {
        throw new AttachmentError('not_found', '本机上的附件副本已经不在了');
      }
      const ref = await upload(blobs, bytes, entry);
      const attachments = found.manifest.attachments.slice();
      attachments[index] = { ...entry, blobId: ref.blobId, key: ref.key };
      await writeManifest(found.dir, { ...found.manifest, attachments });
      return ref;
    }

    const images = await transcriptImages();
    const image = images?.[index];
    if (image === undefined) throw new AttachmentError('not_found', '找不到这个附件');
    const bytes = new Uint8Array(Buffer.from(image.data, 'base64'));
    return upload(blobs, bytes, transcriptImageMeta(image, index));
  }

  /** 删除会话时一并清掉它的附件 */
  async removeSession(sessionId: string): Promise<void> {
    await rm(join(this.root, dirName(sessionId)), { recursive: true, force: true });
  }

  #messageDir(sessionId: string, clientMsgId: string): string {
    return join(this.root, dirName(sessionId), hashName(clientMsgId));
  }

  async #manifests(sessionId: string): Promise<{ dir: string; manifest: Manifest }[]> {
    const base = join(this.root, dirName(sessionId));
    let names: string[];
    try {
      names = await readdir(base);
    } catch {
      return [];
    }
    const out: { dir: string; manifest: Manifest }[] = [];
    for (const name of names) {
      const dir = join(base, name);
      const manifest = await readManifest(dir);
      if (manifest !== undefined) out.push({ dir, manifest });
    }
    return out;
  }

  async #download(dir: string, clientMsgId: string, refs: readonly AttachmentRef[]): Promise<Manifest> {
    const blobs = this.#blobs();
    if (blobs === undefined) throw new AttachmentError('unavailable', '还没连上 relay，无法下载附件');
    // 半途失败留下的残骸先清掉（没有 manifest 就说明上次没成）
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const used = new Set<string>([MANIFEST]);
    const attachments: StoredAttachment[] = [];
    try {
      for (const ref of refs) {
        if (ref.size > ATTACHMENT_FILE_MAX_BYTES) {
          throw new AttachmentError('io', `附件「${ref.name}」超过 agent 接收上限`);
        }
        const file = safeFileName(ref.name, used);
        const writer = Bun.file(join(dir, file)).writer();
        let total: number;
        try {
          total = await blobs.downloadDecrypted(
            ref.blobId,
            ref.key,
            async (chunk) => {
              writer.write(chunk);
              await writer.flush();
            },
            { maxBytes: ref.size },
          );
        } finally {
          await writer.end();
        }
        if (total !== ref.size) throw new AttachmentError('io', `附件「${ref.name}」大小与声明不符`);
        const mediaType = ref.kind === 'image' ? await inlineMediaType(join(dir, file), ref.size) : undefined;
        attachments.push({
          name: ref.name,
          mime: ref.mime,
          size: ref.size,
          kind: ref.kind,
          file,
          ...(mediaType === undefined ? {} : { mediaType }),
          blobId: ref.blobId,
          key: ref.key,
        });
      }
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      if (err instanceof AttachmentError) throw err;
      throw new AttachmentError('io', `附件下载失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const manifest: Manifest = { v: 1, clientMsgId, createdAt: this.#now(), attachments };
    await writeManifest(dir, manifest);
    return manifest;
  }
}

/** 去掉发给模型时追加的路径清单（历史回看、回退预填用） */
export function stripAttachedFiles(text: string): string {
  return text.replace(ATTACHED_FILES_RE, '');
}

/** 没有 manifest 时，转录图片块对应的附件元数据（历史与 fetch 共用，下标一致） */
export function transcriptImageMeta(image: TranscriptImage, index: number): AttachmentMeta {
  const ext = image.mediaType.split('/')[1] ?? 'png';
  return {
    name: `image-${index + 1}.${ext === 'jpeg' ? 'jpg' : ext}`,
    mime: image.mediaType,
    size: Math.floor((image.data.length * 3) / 4) - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0),
    kind: 'image',
  };
}

async function upload(blobs: BlobTransport, bytes: Uint8Array, meta: AttachmentMeta): Promise<AttachmentRef> {
  const key = generateBlobKey();
  try {
    const { blobId } = await blobs.upload(encryptBlob(bytes, key));
    return { name: meta.name, mime: meta.mime, size: bytes.length, kind: meta.kind, blobId, key };
  } catch (err) {
    throw new AttachmentError('io', `重新上传附件失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function inlineMediaType(path: string, size: number): Promise<string | undefined> {
  if (size > INLINE_IMAGE_MAX_BYTES) return undefined;
  const info = sniffImage(new Uint8Array(await readFile(path)));
  if (info === undefined || Math.max(info.width, info.height) > INLINE_IMAGE_MAX_EDGE) return undefined;
  return info.mediaType;
}

async function buildContent(dir: string, manifest: Manifest, text: string): Promise<UserContent> {
  const images: { type: 'image'; source: { type: 'base64'; media_type: never; data: string } }[] = [];
  const paths: string[] = [];
  for (const a of manifest.attachments) {
    const path = join(dir, a.file);
    if (a.mediaType !== undefined) {
      const data = (await readFile(path)).toString('base64');
      images.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType as never, data } });
    } else {
      paths.push(path);
    }
  }
  const list = paths.length === 0 ? '' : `<${ATTACHED_FILES_TAG}>\n${paths.join('\n')}\n</${ATTACHED_FILES_TAG}>`;
  const full = list === '' ? text : text === '' ? list : `${text}\n\n${list}`;
  if (images.length === 0) return full;
  return full === '' ? images : [...images, { type: 'text', text: full }];
}

function toRef(a: StoredAttachment): AttachmentRef {
  return { name: a.name, mime: a.mime, size: a.size, kind: a.kind, blobId: a.blobId!, key: a.key! };
}

function toHistoryAttachment(a: StoredAttachment): HistoryAttachment {
  return {
    name: a.name,
    mime: a.mime,
    size: a.size,
    kind: a.kind,
    ...(a.blobId === undefined || a.key === undefined ? {} : { blobId: a.blobId, key: a.key }),
  };
}

async function readManifest(dir: string): Promise<Manifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as Manifest;
    return parsed.v === 1 && Array.isArray(parsed.attachments) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 先写临时文件再改名：manifest 存在即代表附件已完整落盘 */
async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  const tmp = join(dir, `${MANIFEST}.tmp`);
  await writeFile(tmp, JSON.stringify(manifest), { mode: 0o600 });
  await rename(tmp, join(dir, MANIFEST));
}

/** 会话 id 原样做目录名（Claude 的会话 id 是 uuid）；不像的哈希掉，杜绝路径穿越 */
function dirName(id: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : hashName(id);
}

function hashName(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/**
 * 清洗文件名：保留原名（Claude 看到的路径就是用户的文件名），去掉路径分隔符和
 * 控制字符、开头的点（不生成隐藏文件），过长截断保留扩展名，同名加序号。
 */
export function safeFileName(name: string, used: Set<string>): string {
  let clean = name
    .normalize('NFC')
    .replace(/[/\\\u0000-\u001f\u007f]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  if (clean === '') clean = 'file';
  const dot = clean.lastIndexOf('.');
  let stem = dot > 0 ? clean.slice(0, dot) : clean;
  let ext = dot > 0 ? clean.slice(dot) : '';
  if (ext.length > 16) {
    stem = clean;
    ext = '';
  }
  if (stem.length > 120) stem = stem.slice(0, 120);
  let candidate = `${stem}${ext}`;
  for (let i = 2; used.has(candidate); i++) candidate = `${stem} (${i})${ext}`;
  used.add(candidate);
  return candidate;
}

/**
 * 附件的纯逻辑：类型判定、上限计算与校验、草稿状态。
 *
 * 不碰加密与网络（那些在 attachment-transfer.ts，只由懒加载的 client 引用），
 * UI 可以放心直接 import——值导入只走 `@trine/core/types`（见 reducer.ts 头部说明）。
 */
import type { AttachmentKind, AttachmentRef, HistoryAttachment } from '@trine/core';
import { ATTACHMENTS_MAX_COUNT } from '@trine/core/types';
import { formatBytes } from './format.ts';
import type { Prefs } from './storage.ts';

const MB = 1024 * 1024;

/** 能作为图片交给模型的格式；其他图片（heic / svg / bmp …）按普通文件发 */
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** 去掉参数（`;charset=…`）并小写 */
function baseType(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

export function attachmentKind(mime: string): AttachmentKind {
  return IMAGE_TYPES.has(baseType(mime)) ? 'image' : 'file';
}

/** 浏览器可以重新编码压缩的图片（gif 可能是动图，不动它） */
export function isCompressibleImage(mime: string): boolean {
  const m = baseType(mime);
  return m === 'image/png' || m === 'image/jpeg' || m === 'image/webp';
}

export interface AttachmentLimits {
  maxCount: number;
  /** 每条消息附件合计字节上限 */
  maxTotalBytes: number;
  /** 单个附件上限（relay 的 blob 上限，扣掉加密开销）；不知道时为 undefined */
  maxFileBytes: number | undefined;
}

/**
 * 实际生效的上限：设置页的值，夹到协议硬上限以内；relay 公布了 blob 上限时，
 * 单个附件也不能超过它（密文比明文略大，留 1% 余量）。
 */
export function effectiveLimits(
  prefs: Pick<Prefs, 'attachMaxCount' | 'attachMaxTotalMb'>,
  relayMaxBytes?: number,
): AttachmentLimits {
  return {
    maxCount: Math.min(Math.max(1, Math.floor(prefs.attachMaxCount)), ATTACHMENTS_MAX_COUNT),
    maxTotalBytes: Math.max(1, prefs.attachMaxTotalMb) * MB,
    maxFileBytes: relayMaxBytes === undefined ? undefined : Math.floor(relayMaxBytes * 0.99),
  };
}

/**
 * 校验要新加的文件：按顺序收，超出个数 / 合计 / 单个上限的拒掉并给出原因。
 * `existing` 是输入框里已有的附件（大小按压缩前的原始大小算，宁严勿松）。
 */
export function checkAdd<T extends { name: string; size: number }>(
  existing: readonly { size: number }[],
  files: readonly T[],
  limits: AttachmentLimits,
): { accepted: T[]; errors: string[] } {
  const accepted: T[] = [];
  const errors: string[] = [];
  let count = existing.length;
  let total = existing.reduce((sum, a) => sum + a.size, 0);
  for (const file of files) {
    if (count >= limits.maxCount) {
      errors.push(`最多 ${limits.maxCount} 个附件，「${file.name}」没有加上`);
      continue;
    }
    if (limits.maxFileBytes !== undefined && file.size > limits.maxFileBytes) {
      errors.push(`「${file.name}」${formatBytes(file.size)}，超过服务端单个附件上限 ${formatBytes(limits.maxFileBytes)}`);
      continue;
    }
    if (total + file.size > limits.maxTotalBytes) {
      errors.push(`附件合计不能超过 ${formatBytes(limits.maxTotalBytes)}，「${file.name}」没有加上`);
      continue;
    }
    accepted.push(file);
    count += 1;
    total += file.size;
  }
  return { accepted, errors };
}

/** 输入框里一个待发的附件 */
export interface DraftAttachment {
  /** 本地 id（列表 key / 移除用） */
  id: string;
  file: File;
  name: string;
  /** 原始大小（压缩前） */
  size: number;
  kind: AttachmentKind;
  status: 'uploading' | 'done' | 'error';
  /** 上传进度 0–1 */
  progress: number;
  ref?: AttachmentRef;
  error?: string;
  /** 图片缩略图（objectURL，移除 / 发出后由持有方回收） */
  previewUrl?: string;
}

/** 输入框的发送条件：有字或有附件，并且附件都传完了、没有失败的 */
export function draftsReady(drafts: readonly DraftAttachment[]): boolean {
  return drafts.every((d) => d.status === 'done');
}

/** 已上传完成的引用（发送用） */
export function draftRefs(drafts: readonly DraftAttachment[]): AttachmentRef[] {
  return drafts.flatMap((d) => (d.status === 'done' && d.ref !== undefined ? [d.ref] : []));
}

/** 拖拽 / 粘贴的数据里有没有文件（拖拽时 dataTransfer.files 还读不到，只能看 types） */
export function hasFiles(types: readonly string[] | DOMStringList | undefined): boolean {
  if (types === undefined) return false;
  return Array.from(types as ArrayLike<string>).includes('Files');
}

/** 条目里可以原样重发的附件引用（都带 blobId + key 的） */
export function attachmentRefs(entry: { attachments?: readonly HistoryAttachment[] | undefined }): AttachmentRef[] {
  return (entry.attachments ?? []).flatMap((a) =>
    a.blobId === undefined || a.key === undefined ? [] : [{ ...a, blobId: a.blobId, key: a.key }],
  );
}

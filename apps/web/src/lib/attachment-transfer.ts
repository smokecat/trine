/**
 * 附件的加密、上传与图片压缩（浏览器侧）。
 *
 * 静态引入 `@trine/core/crypto`（libsodium），所以**只由 client.ts 引用**——client
 * 本身是动态 import 的，不把 libsodium 带进首屏（见 app/runtime.ts）。
 *
 * 上传用 XMLHttpRequest 而不是 fetch：fetch 拿不到上传进度；流式请求体
 * （`duplex: 'half'`）也只有 Chromium 支持且要求 HTTP/2。所以整个文件先加密成一个
 * Blob（64KB 一块，内存约等于文件大小）再一次性发出。
 */
import { BlobEncryptor, generateBlobKey } from '@trine/core/crypto';
import { isCompressibleImage } from './attachment-model.ts';

/** 加密整个文件，返回 key 与密文 Blob */
export async function encryptFile(file: Blob): Promise<{ key: string; body: Blob }> {
  const key = generateBlobKey();
  const enc = new BlobEncryptor(key);
  const parts: Uint8Array[] = [];
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(...enc.push(value));
  }
  parts.push(...enc.finish());
  return { key, body: new Blob(parts as BlobPart[], { type: 'application/octet-stream' }) };
}

export interface UploadArgs {
  url: string;
  token: string;
  body: Blob;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** 上传一段密文，返回 HTTP 状态与解析后的 JSON（测试注入假实现） */
export type UploadFn = (args: UploadArgs) => Promise<{ status: number; body: unknown }>;

export const xhrUpload: UploadFn = ({ url, token, body, onProgress, signal }) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.response as unknown });
    xhr.onerror = () => reject(new Error('上传失败：网络错误'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });

/** 压缩后的最长边：与 agent 的内联上限一致，压过的图都能直接内联给模型 */
export const COMPRESS_MAX_EDGE = 2000;
const COMPRESS_QUALITY = 0.85;

/**
 * 图片超过阈值就缩到长边 ≤ 2000 并重新编码；结果不比原图小（或浏览器不支持）就用原图。
 * `thresholdBytes` 为 0 = 不压缩。
 */
export async function maybeCompressImage(file: File, thresholdBytes: number): Promise<File> {
  if (thresholdBytes <= 0 || file.size <= thresholdBytes || !isCompressibleImage(file.type)) return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, COMPRESS_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    // png 可能有透明度，转 webp；jpeg 仍出 jpeg。Safari 不支持 webp 编码时会回落成 png
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, COMPRESS_QUALITY));
    if (blob === null || blob.size >= file.size) return file;
    return new File([blob], renameExt(file.name, blob.type), { type: blob.type, lastModified: file.lastModified });
  } catch {
    return file;
  }
}

function renameExt(name: string, mime: string): string {
  const ext = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] ?? 'bin');
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
}

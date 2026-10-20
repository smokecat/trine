/**
 * 内存版 relay blob 存储（测试用）：上传存密文，下载按 key 解密后分块交给 sink。
 * `gate` 非空时下载先等它放行（测输入准备链的先后顺序）。
 */
import { decryptBlob, encryptBlob, generateBlobKey } from '@trine/core/crypto';
import type { BlobTransport } from '../bridge/attachments.ts';

export class FakeBlobs implements BlobTransport {
  readonly store = new Map<string, Uint8Array>();
  downloads = 0;
  gate: Promise<void> | undefined;
  #n = 0;

  put(plain: Uint8Array): { blobId: string; key: string } {
    const key = generateBlobKey();
    const blobId = `blob${String(++this.#n).padStart(20, '0')}`;
    this.store.set(blobId, encryptBlob(plain, key));
    return { blobId, key };
  }

  async upload(cipher: Uint8Array): Promise<{ blobId: string }> {
    const blobId = `up${String(++this.#n).padStart(20, '0')}`;
    this.store.set(blobId, cipher);
    return { blobId };
  }

  async downloadDecrypted(
    blobId: string,
    key: string,
    sink: (chunk: Uint8Array) => void | Promise<void>,
    opts: { maxBytes: number },
  ): Promise<number> {
    this.downloads++;
    if (this.gate !== undefined) await this.gate;
    const cipher = this.store.get(blobId);
    if (cipher === undefined) throw new Error('not_found');
    const plain = decryptBlob(cipher, key);
    if (plain.length > opts.maxBytes) throw new Error('too_large');
    for (let i = 0; i < plain.length; i += 1000) await sink(plain.subarray(i, i + 1000));
    return plain.length;
  }
}

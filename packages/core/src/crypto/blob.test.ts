import { beforeAll, describe, expect, test } from 'bun:test';
import {
  BLOB_CHUNK_BYTES,
  BlobDecryptor,
  BlobEncryptor,
  blobCiphertextSize,
  concatBytes,
  decryptBlob,
  encryptBlob,
  generateBlobKey,
  sodiumReady,
} from './index.ts';

beforeAll(async () => {
  await sodiumReady();
});

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

/** 把数据切成不规则片段，模拟网络流的任意边界 */
function split(data: Uint8Array, sizes: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let off = 0;
  let i = 0;
  while (off < data.length) {
    const n = sizes[i++ % sizes.length]!;
    out.push(data.subarray(off, off + n));
    off += n;
  }
  return out;
}

describe('blob 加解密', () => {
  const sizes = [0, 1, BLOB_CHUNK_BYTES - 1, BLOB_CHUNK_BYTES, BLOB_CHUNK_BYTES + 1, 3 * BLOB_CHUNK_BYTES + 5];

  for (const size of sizes) {
    test(`往返 ${size} 字节，密文长度与预估一致`, () => {
      const key = generateBlobKey();
      const plain = bytes(size);
      const cipher = encryptBlob(plain, key);
      expect(cipher.length).toBe(blobCiphertextSize(size));
      expect(decryptBlob(cipher, key)).toEqual(plain);
    });
  }

  test('任意切分的流式加密与解密结果一致', () => {
    const key = generateBlobKey();
    const plain = bytes(5 * BLOB_CHUNK_BYTES + 123);
    const enc = new BlobEncryptor(key);
    const cipherParts: Uint8Array[] = [];
    for (const part of split(plain, [1000, 70_000, 3, 131_072])) cipherParts.push(...enc.push(part));
    cipherParts.push(...enc.finish());
    const cipher = concatBytes(cipherParts);
    expect(cipher.length).toBe(blobCiphertextSize(plain.length));

    const dec = new BlobDecryptor(key);
    const out: Uint8Array[] = [];
    for (const part of split(cipher, [7, 65_553, 20_000])) out.push(...dec.push(part));
    out.push(...dec.finish());
    expect(concatBytes(out)).toEqual(plain);
  });

  test('密钥不对、被篡改、被截断都拒绝', () => {
    const key = generateBlobKey();
    const cipher = encryptBlob(bytes(2 * BLOB_CHUNK_BYTES), key);

    expect(() => decryptBlob(cipher, generateBlobKey())).toThrow();

    const tampered = cipher.slice();
    tampered[100] = tampered[100]! ^ 1;
    expect(() => decryptBlob(tampered, key)).toThrow();

    // 正好截在块边界：每块都能单独认证，只有 FINAL 检查能发现
    const boundary = 24 + BLOB_CHUNK_BYTES + 17;
    expect(() => decryptBlob(cipher.subarray(0, boundary), key)).toThrow(/truncated/);
    expect(() => decryptBlob(cipher.subarray(0, 10), key)).toThrow(/truncated/);
  });

  test('FINAL 之后追加数据被拒绝', () => {
    const key = generateBlobKey();
    const a = encryptBlob(bytes(10), key);
    const extra = concatBytes([a, new Uint8Array(40)]);
    expect(() => decryptBlob(extra, key)).toThrow();
  });
});

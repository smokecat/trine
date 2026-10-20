/**
 * 附件加密：libsodium secretstream（XChaCha20-Poly1305）分块封装。
 *
 * 附件不走 E2E 帧（单帧整体 crypto_box、再 base64 两次，几十 MB 吃不消），而是
 * 先加密成 blob 传到 relay，消息帧里只带 `{blobId, key}`——key 在 E2E 密文里，
 * relay 只见 blob 密文和大小。每个附件一把随机 key，互不复用。
 *
 * ## 密文格式
 *
 * `header(24B) ‖ chunk₀ ‖ chunk₁ ‖ …`：明文按 {@link BLOB_CHUNK_BYTES} 切块，
 * 每块加密后多 {@link BLOB_CHUNK_OVERHEAD} 字节；最后一块（可能是空块）打
 * FINAL tag。secretstream 自带逐块认证、顺序绑定和截断检测，因此不另算哈希：
 * 被篡改、被截断、被换成别的 blob（key 不同）都会在解密时抛错。
 */
import { fromBase64, sodium, toBase64 } from './box.ts';

/** 每块明文大小。固定值：解密方按它切分密文流 */
export const BLOB_CHUNK_BYTES = 64 * 1024;
/** secretstream 每块的额外开销（tag 1B + MAC 16B） */
export const BLOB_CHUNK_OVERHEAD = 17;
/** 密文头长度 */
export const BLOB_HEADER_BYTES = 24;

/** 明文 n 字节加密后的密文长度（上传前校验大小、进度条用） */
export function blobCiphertextSize(plainSize: number): number {
  const chunks = Math.max(1, Math.ceil(plainSize / BLOB_CHUNK_BYTES));
  return BLOB_HEADER_BYTES + plainSize + chunks * BLOB_CHUNK_OVERHEAD;
}

/** 新的附件密钥（base64url） */
export function generateBlobKey(): string {
  return toBase64(sodium().crypto_secretstream_xchacha20poly1305_keygen());
}

/**
 * 流式加密器：按顺序 `push` 明文（任意长度），最后 `finish()`。
 * 每次调用返回这一步产出的密文片段（可能为空），依次拼接就是完整 blob。
 */
export class BlobEncryptor {
  readonly #state: unknown;
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  #header: Uint8Array | undefined;
  #done = false;

  constructor(key: string) {
    const s = sodium();
    const res = s.crypto_secretstream_xchacha20poly1305_init_push(fromBase64(key));
    this.#state = res.state;
    this.#header = res.header;
  }

  push(plain: Uint8Array): Uint8Array[] {
    if (this.#done) throw new Error('BlobEncryptor already finished');
    const out = this.#takeHeader();
    this.#pending.push(plain);
    this.#pendingBytes += plain.length;
    // 留住最后一块：不到 finish 不知道它是不是 FINAL
    while (this.#pendingBytes > BLOB_CHUNK_BYTES) {
      out.push(this.#seal(this.#take(BLOB_CHUNK_BYTES), false));
    }
    return out;
  }

  finish(): Uint8Array[] {
    if (this.#done) throw new Error('BlobEncryptor already finished');
    this.#done = true;
    const out = this.#takeHeader();
    out.push(this.#seal(this.#take(this.#pendingBytes), true));
    return out;
  }

  #takeHeader(): Uint8Array[] {
    const header = this.#header;
    this.#header = undefined;
    return header === undefined ? [] : [header];
  }

  #take(n: number): Uint8Array {
    const chunk = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.#pending[0]!;
      const need = n - filled;
      if (head.length <= need) {
        chunk.set(head, filled);
        filled += head.length;
        this.#pending.shift();
      } else {
        chunk.set(head.subarray(0, need), filled);
        filled += need;
        this.#pending[0] = head.subarray(need);
      }
    }
    this.#pendingBytes -= n;
    return chunk;
  }

  #seal(chunk: Uint8Array, final: boolean): Uint8Array {
    const s = sodium();
    return s.crypto_secretstream_xchacha20poly1305_push(
      this.#state as never,
      chunk,
      null,
      final ? s.crypto_secretstream_xchacha20poly1305_TAG_FINAL : s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    );
  }
}

/**
 * 流式解密器：按顺序 `push` 密文（任意切分），最后 `finish()`。
 * 认证失败、FINAL 之后还有数据、没见到 FINAL 就结束，都抛错。
 */
export class BlobDecryptor {
  readonly #key: Uint8Array;
  #state: unknown;
  #buf: Uint8Array[] = [];
  #bufBytes = 0;
  #final = false;

  constructor(key: string) {
    this.#key = fromBase64(key);
  }

  push(cipher: Uint8Array): Uint8Array[] {
    if (this.#final && cipher.length > 0) throw new Error('blob: data after final chunk');
    this.#buf.push(cipher);
    this.#bufBytes += cipher.length;
    const out: Uint8Array[] = [];
    if (this.#state === undefined) {
      if (this.#bufBytes < BLOB_HEADER_BYTES) return out;
      const header = this.#take(BLOB_HEADER_BYTES);
      this.#state = sodium().crypto_secretstream_xchacha20poly1305_init_pull(header, this.#key);
    }
    // 同样留住最后一块：满块也可能是 FINAL，只有后面还有数据才能确定不是
    const full = BLOB_CHUNK_BYTES + BLOB_CHUNK_OVERHEAD;
    while (this.#bufBytes > full) {
      out.push(this.#open(this.#take(full)));
    }
    return out;
  }

  finish(): Uint8Array[] {
    if (this.#state === undefined) throw new Error('blob: truncated header');
    const out: Uint8Array[] = [];
    if (this.#bufBytes > 0) out.push(this.#open(this.#take(this.#bufBytes)));
    if (!this.#final) throw new Error('blob: truncated (no final chunk)');
    return out;
  }

  #take(n: number): Uint8Array {
    const chunk = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.#buf[0]!;
      const need = n - filled;
      if (head.length <= need) {
        chunk.set(head, filled);
        filled += head.length;
        this.#buf.shift();
      } else {
        chunk.set(head.subarray(0, need), filled);
        filled += need;
        this.#buf[0] = head.subarray(need);
      }
    }
    this.#bufBytes -= n;
    return chunk;
  }

  #open(chunk: Uint8Array): Uint8Array {
    if (this.#final) throw new Error('blob: data after final chunk');
    const s = sodium();
    const res = s.crypto_secretstream_xchacha20poly1305_pull(this.#state as never, chunk, null);
    // libsodium-wrappers 认证失败时返回 false（不抛错）
    if (!res) throw new Error('blob: authentication failed');
    if (res.tag === s.crypto_secretstream_xchacha20poly1305_TAG_FINAL) this.#final = true;
    return res.message;
  }
}

/** 便捷：整块加密（测试、小附件用） */
export function encryptBlob(plain: Uint8Array, key: string): Uint8Array {
  const enc = new BlobEncryptor(key);
  return concatBytes([...enc.push(plain), ...enc.finish()]);
}

/** 便捷：整块解密 */
export function decryptBlob(cipher: Uint8Array, key: string): Uint8Array {
  const dec = new BlobDecryptor(key);
  return concatBytes([...dec.push(cipher), ...dec.finish()]);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

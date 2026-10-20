/**
 * relay blob 存储的 HTTP 客户端（附件密文的上传 / 下载）。
 *
 * relay 只见密文：加密在调用方（`@trine/core/crypto` 的 BlobEncryptor），这里
 * 只搬字节。鉴权与 WS 同一个 bearer token；401 时换一次 token 重试。
 *
 * web 的上传另用 XMLHttpRequest（fetch 拿不到上传进度），下载与 agent 共用这里。
 */
import { BlobDecryptor } from '../crypto/blob.ts';

export class BlobClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 服务端返回的 error 字段（`not_found` / `too_large` / …），网络错误为 `network` */
    readonly reason: string,
  ) {
    super(message);
    this.name = 'BlobClientError';
  }
}

export interface BlobConfig {
  /** 单个 blob（密文）字节上限 */
  maxBytes: number;
  /** blob 保留时长 */
  ttlMs: number;
}

export interface BlobClientOptions {
  /** 服务端根地址（同 AuthClient） */
  baseUrl: string;
  /** 取当前 token；`refresh` 为 true 时必须换一个新的（旧的已被拒） */
  getToken: (refresh: boolean) => Promise<string>;
  fetchImpl?: typeof fetch;
}

export interface BlobRequestOptions {
  signal?: AbortSignal;
}

export class BlobClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(private readonly options: BlobClientOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetchImpl ?? fetch.bind(globalThis);
  }

  async config(opts: BlobRequestOptions = {}): Promise<BlobConfig> {
    const res = await this.#request('/blobs/config', { method: 'GET' }, opts);
    return (await res.json()) as BlobConfig;
  }

  /** 上传一段密文，返回 blobId。body 必须可重放（401 重试会再发一次） */
  async upload(body: Uint8Array | Blob, opts: BlobRequestOptions = {}): Promise<{ blobId: string }> {
    const res = await this.#request(
      '/blobs',
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body },
      opts,
    );
    return (await res.json()) as { blobId: string };
  }

  /** 下载密文流 */
  async download(blobId: string, opts: BlobRequestOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const res = await this.#request(`/blobs/${encodeURIComponent(blobId)}`, { method: 'GET' }, opts);
    if (res.body === null) throw new BlobClientError('blob 响应没有内容', res.status, 'empty');
    return res.body;
  }

  /**
   * 下载并解密，明文逐块交给 `sink`。`maxBytes` 是明文上限，超了中止并抛错
   * （防恶意 / 损坏的 blob 把接收方磁盘或内存撑爆）。
   */
  async downloadDecrypted(
    blobId: string,
    key: string,
    sink: (chunk: Uint8Array) => void | Promise<void>,
    opts: BlobRequestOptions & { maxBytes?: number } = {},
  ): Promise<number> {
    const stream = await this.download(blobId, opts);
    const dec = new BlobDecryptor(key);
    let total = 0;
    const emit = async (parts: Uint8Array[]) => {
      for (const p of parts) {
        total += p.length;
        if (opts.maxBytes !== undefined && total > opts.maxBytes) {
          throw new BlobClientError('附件超过大小上限', 413, 'too_large');
        }
        if (p.length > 0) await sink(p);
      }
    };
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await emit(dec.push(value));
      }
      await emit(dec.finish());
    } finally {
      reader.releaseLock();
      // 中途出错时别让连接挂着
      await stream.cancel().catch(() => {});
    }
    return total;
  }

  async #request(path: string, init: RequestInit, opts: BlobRequestOptions): Promise<Response> {
    let res = await this.#send(path, init, opts, false);
    if (res.status === 401) res = await this.#send(path, init, opts, true);
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as { error?: unknown } | null;
      const reason = String(payload?.error ?? 'unknown');
      throw new BlobClientError(`${path} 失败：HTTP ${res.status} ${reason}`, res.status, reason);
    }
    return res;
  }

  async #send(path: string, init: RequestInit, opts: BlobRequestOptions, refresh: boolean): Promise<Response> {
    const token = await this.options.getToken(refresh);
    try {
      return await this.#fetch(`${this.#base}${path}`, {
        ...init,
        redirect: 'error',
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      throw new BlobClientError(`${path} 网络错误：${String(err)}`, 0, 'network');
    }
  }
}

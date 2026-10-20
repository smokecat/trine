/**
 * 附件 blob：存储单元（BlobStore）+ 真服务上的 /blobs 端点（用 core 的 BlobClient 走一遍）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authChallengeMessage,
  encryptBlob,
  generateBlobKey,
  generateSignKeyPair,
  signDetached,
  sodiumReady,
} from '@trine/core/crypto';
import { BlobClient, BlobClientError } from '@trine/core/net';
import { BlobStore } from './blobs.ts';
import { startServer, type TrineServer } from './server.ts';

let dir: string;

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trine-blobs-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function streamOf(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(ctl) {
      for (const p of parts) ctl.enqueue(p);
      ctl.close();
    },
  });
}

describe('BlobStore', () => {
  test('写入后可读回，id 合法，目录里不留 .part', async () => {
    const store = new BlobStore({ dir, maxBytes: 1000, ttlMs: 60_000 });
    const res = await store.put(streamOf(new Uint8Array([1, 2]), new Uint8Array([3])));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.size).toBe(3);
    expect(BlobStore.isValidId(res.blobId)).toBe(true);
    const file = await store.get(res.blobId);
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(readdirSync(dir)).toEqual([res.blobId]);
  });

  test('超过上限中止并清理半成品；空请求体拒绝', async () => {
    const store = new BlobStore({ dir, maxBytes: 4, ttlMs: 60_000 });
    expect(await store.put(streamOf(new Uint8Array(3), new Uint8Array(3)))).toEqual({ ok: false, error: 'too_large' });
    expect(await store.put(streamOf())).toEqual({ ok: false, error: 'empty' });
    expect(await store.put(null)).toEqual({ ok: false, error: 'empty' });
    expect(readdirSync(dir)).toEqual([]);
  });

  test('非法 id 不碰文件系统；过期的读不到并被 sweep 删除', async () => {
    let now = Date.now();
    const store = new BlobStore({ dir, maxBytes: 100, ttlMs: 1000, now: () => now });
    expect(await store.get('../etc/passwd')).toBeNull();

    const res = await store.put(streamOf(new Uint8Array(5)));
    if (!res.ok) throw new Error('put failed');
    // 残留的半成品：超过 1 小时才删
    const part = join(dir, 'x'.repeat(22) + '.part');
    writeFileSync(part, 'junk');

    now += 2000;
    expect(await store.get(res.blobId)).toBeNull();
    expect(await store.sweep()).toBe(1);
    expect(readdirSync(dir)).toEqual(['x'.repeat(22) + '.part']);

    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(part, old, old);
    expect(await store.sweep()).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('/blobs 端点', () => {
  let server: TrineServer;
  let base: string;

  beforeEach(async () => {
    server = await startServer({
      port: 0,
      hostname: '127.0.0.1',
      dbPath: ':memory:',
      blobDir: dir,
      blobMaxBytes: 200_000,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
    tokens.clear();
  });

  const tokens = new Map<string, string>();

  /** 直接走 AuthService 换 token（认证流程本身由 integration.test 覆盖）；每台设备只注册一次 */
  function token(deviceId = 'phone'): string {
    const cached = tokens.get(deviceId);
    if (cached !== undefined) return cached;
    const keys = generateSignKeyPair();
    server.store.registerDevice(deviceId, 'client', keys.publicKey);
    const chal = server.auth.issueChallenge(deviceId, 'test');
    if (!chal.ok) throw new Error('challenge failed');
    const signature = signDetached(authChallengeMessage(deviceId, chal.value.challenge), keys.secretKey);
    const verified = server.auth.verify(deviceId, chal.value.challenge, signature, 'test');
    if (!verified.ok) throw new Error('verify failed');
    tokens.set(deviceId, verified.value.token);
    return verified.value.token;
  }

  test('上传密文、另一台设备下载并解密', async () => {
    const uploader = new BlobClient({ baseUrl: base, getToken: async () => token('phone') });
    const config = await uploader.config();
    expect(config.maxBytes).toBe(200_000);

    const key = generateBlobKey();
    const plain = new Uint8Array(150_000).map((_, i) => i & 0xff);
    const { blobId } = await uploader.upload(encryptBlob(plain, key));

    const reader = new BlobClient({ baseUrl: base, getToken: async () => token('laptop') });
    const parts: Uint8Array[] = [];
    const total = await reader.downloadDecrypted(blobId, key, (c) => {
      parts.push(c);
    });
    expect(total).toBe(plain.length);
    expect(Buffer.concat(parts).equals(Buffer.from(plain))).toBe(true);

    // 明文上限：超了中止
    await expect(reader.downloadDecrypted(blobId, key, () => {}, { maxBytes: 1000 })).rejects.toThrow(
      BlobClientError,
    );
  });

  test('未认证 401；超限 413；不存在 404；401 时换 token 重试', async () => {
    expect((await fetch(`${base}/blobs/config`)).status).toBe(401);
    expect(
      (await fetch(`${base}/blobs`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: 'x' })).status,
    ).toBe(401);

    const t = token();
    const tooBig = await fetch(`${base}/blobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}` },
      body: new Uint8Array(200_001),
    });
    expect(tooBig.status).toBe(413);
    expect(readdirSync(dir)).toEqual([]);

    const missing = await fetch(`${base}/blobs/${'a'.repeat(22)}`, { headers: { authorization: `Bearer ${t}` } });
    expect(missing.status).toBe(404);

    const refreshes: boolean[] = [];
    const client = new BlobClient({
      baseUrl: base,
      getToken: async (refresh) => {
        refreshes.push(refresh);
        return refresh ? t : 'stale';
      },
    });
    await client.config();
    expect(refreshes).toEqual([false, true]);
  });

  test('blobDir 为空时整组端点 503', async () => {
    const disabled = await startServer({ port: 0, hostname: '127.0.0.1', dbPath: ':memory:', blobDir: '' });
    try {
      const res = await fetch(`http://127.0.0.1:${disabled.port}/blobs/config`);
      expect(res.status).toBe(503);
    } finally {
      await disabled.stop();
    }
  });
});

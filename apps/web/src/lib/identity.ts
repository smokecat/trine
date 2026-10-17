/**
 * 本设备身份：`web-<uuid>` + Ed25519 签名密钥 + X25519 加密密钥，**只生成一次**。
 *
 * deviceId 是服务端登记主键、也进 SAS 哈希；密钥对是配对与 E2E 的根。任何
 * 一项变了就等于换了台设备——所有已配对的机器都不认识你了。所以这里只有
 * 「有就用、没有才生成」一条路径，没有「重新生成」。
 *
 * 私钥明文存 localStorage：浏览器没有更好的密钥根（方案 §4.1 / D11）。
 */
import { generateKeyPair, generateSignKeyPair } from '@trine/core/crypto';
import type { KvAdapter } from './adapters.ts';
import { loadIdentity, saveIdentity, type Identity } from './storage.ts';

export function ensureIdentity(kv: KvAdapter, uuid: () => string): Identity {
  const existing = loadIdentity(kv);
  if (existing) return existing;
  const identity: Identity = {
    v: 1,
    deviceId: `web-${uuid()}`,
    sign: generateSignKeyPair(),
    box: generateKeyPair(),
  };
  saveIdentity(kv, identity);
  return identity;
}

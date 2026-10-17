/**
 * E2E 加密：libsodium crypto_box（X25519 + XSalsa20-Poly1305）封装。
 * 决策 D1：client ↔ agent 端到端加密，服务端只见密文。
 *
 * 所有 API 均为字符串进出（base64url），方便直接放进 RelayFrame；
 * 使用前必须 `await sodiumReady()`（libsodium WASM 异步初始化）。
 */
import _sodium from 'libsodium-wrappers';

let ready = false;

/** 等待 libsodium WASM 初始化完成；所有其他函数调用前必须先 await 本函数 */
export async function sodiumReady(): Promise<void> {
  await _sodium.ready;
  ready = true;
}

/** 内部使用：拿到已初始化的 sodium 实例（未 ready 抛错） */
export function sodium(): typeof _sodium {
  if (!ready) {
    throw new Error('libsodium not ready: call `await sodiumReady()` first');
  }
  return _sodium;
}

const B64 = () => sodium().base64_variants.URLSAFE_NO_PADDING;

export function toBase64(bytes: Uint8Array): string {
  return sodium().to_base64(bytes, B64());
}

export function fromBase64(s: string): Uint8Array {
  return sodium().from_base64(s, B64());
}

/** 公私钥均为 base64url 字符串 */
export interface BoxKeyPair {
  publicKey: string;
  secretKey: string;
}

export function generateKeyPair(): BoxKeyPair {
  const kp = sodium().crypto_box_keypair();
  return {
    publicKey: toBase64(kp.publicKey),
    secretKey: toBase64(kp.privateKey),
  };
}

export interface SealedBox {
  /** 每次加密随机生成，随密文一起放进 RelayFrame */
  nonce: string;
  ciphertext: string;
}

/** crypto_box 加密：sender 私钥 + recipient 公钥 */
export function seal(
  plaintext: Uint8Array | string,
  recipientPublicKey: string,
  senderSecretKey: string,
): SealedBox {
  const s = sodium();
  const nonce = s.randombytes_buf(s.crypto_box_NONCEBYTES);
  const ciphertext = s.crypto_box_easy(
    plaintext,
    nonce,
    fromBase64(recipientPublicKey),
    fromBase64(senderSecretKey),
  );
  return { nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) };
}

/** crypto_box 解密：篡改/密钥不符抛错 */
export function open(
  box: SealedBox,
  senderPublicKey: string,
  recipientSecretKey: string,
): Uint8Array {
  const s = sodium();
  return s.crypto_box_open_easy(
    fromBase64(box.ciphertext),
    fromBase64(box.nonce),
    fromBase64(senderPublicKey),
    fromBase64(recipientSecretKey),
  );
}

/** 便捷封装：对象 → JSON → 密文（E2eEvent 上信封用这个） */
export function sealJson(
  value: unknown,
  recipientPublicKey: string,
  senderSecretKey: string,
): SealedBox {
  return seal(JSON.stringify(value), recipientPublicKey, senderSecretKey);
}

/** 便捷封装：密文 → JSON 值。只做 JSON 解析，schema 校验由调用方负责 */
export function openJson(
  box: SealedBox,
  senderPublicKey: string,
  recipientSecretKey: string,
): unknown {
  const bytes = open(box, senderPublicKey, recipientSecretKey);
  return JSON.parse(sodium().to_string(bytes));
}

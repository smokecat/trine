import { beforeAll, describe, expect, test } from 'bun:test';
import {
  authChallengeMessage,
  fromBase64,
  generateKeyPair,
  generateSignKeyPair,
  isValidSignPublicKey,
  randomToken,
  signDetached,
  sodiumReady,
  toBase64,
  verifyDetached,
  SIGN_PUBLIC_KEY_BYTES,
  SIGN_SECRET_KEY_BYTES,
} from './index.ts';

beforeAll(async () => {
  await sodiumReady();
});

describe('Ed25519 设备身份签名', () => {
  test('密钥对长度符合 Ed25519 规格', () => {
    const kp = generateSignKeyPair();
    expect(isValidSignPublicKey(kp.publicKey)).toBe(true);
    // 私钥 64 字节（含拼接公钥），公钥 32 字节
    expect(fromBase64(kp.publicKey).length).toBe(SIGN_PUBLIC_KEY_BYTES);
    expect(fromBase64(kp.secretKey).length).toBe(SIGN_SECRET_KEY_BYTES);
  });

  test('签名往返：正确密钥验签通过', () => {
    const kp = generateSignKeyPair();
    const msg = authChallengeMessage('mbp-m3', randomToken());
    expect(verifyDetached(msg, signDetached(msg, kp.secretKey), kp.publicKey)).toBe(true);
  });

  test('换一把公钥验签失败', () => {
    const kp = generateSignKeyPair();
    const other = generateSignKeyPair();
    const msg = authChallengeMessage('mbp-m3', randomToken());
    const sig = signDetached(msg, kp.secretKey);
    expect(verifyDetached(msg, sig, other.publicKey)).toBe(false);
  });

  test('消息被篡改则验签失败（挑战串换掉 = 重放旧应答）', () => {
    const kp = generateSignKeyPair();
    const challenge = randomToken();
    const sig = signDetached(authChallengeMessage('mbp-m3', challenge), kp.secretKey);
    // 同一签名拿去应答另一个挑战——必须失败
    expect(
      verifyDetached(authChallengeMessage('mbp-m3', randomToken()), sig, kp.publicKey),
    ).toBe(false);
    // 同一挑战换个 deviceId 冒充——也必须失败
    expect(
      verifyDetached(authChallengeMessage('other-device', challenge), sig, kp.publicKey),
    ).toBe(false);
  });

  test('畸形输入不抛错，一律 false', () => {
    const kp = generateSignKeyPair();
    const msg = 'x';
    expect(verifyDetached(msg, 'not-base64!!', kp.publicKey)).toBe(false);
    expect(verifyDetached(msg, signDetached(msg, kp.secretKey), 'zzz')).toBe(false);
    // 长度不对的公钥（借 X25519 公钥充数长度虽同，但仍非法签名密钥）
    expect(isValidSignPublicKey(toBase64(new Uint8Array(16)))).toBe(false);
    expect(isValidSignPublicKey('!!!')).toBe(false);
  });

  test('X25519 公钥不能当签名公钥用（用途分离）', () => {
    const box = generateKeyPair();
    const sign = generateSignKeyPair();
    const msg = 'trine';
    // 长度都是 32，格式校验过得去，但验签必然失败
    expect(isValidSignPublicKey(box.publicKey)).toBe(true);
    expect(verifyDetached(msg, signDetached(msg, sign.secretKey), box.publicKey)).toBe(false);
  });

  test('待签名串含域分隔前缀与两个绑定字段', () => {
    expect(authChallengeMessage('dev1', 'chal')).toBe('trine-auth-v1|dev1|chal');
  });

  test('randomToken 每次不同且非空', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

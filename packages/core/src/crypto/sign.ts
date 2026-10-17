/**
 * 设备身份签名：libsodium `crypto_sign`（Ed25519）封装。
 *
 * ## 为什么与 box.ts 的 X25519 密钥分开
 *
 * box.ts 的 crypto_box 密钥对（X25519）解决的是 **E2E 内容保密**——服务端
 * 永远拿不到、也永不参与。本文件的 Ed25519 密钥对解决的是另一个正交问题：
 * **向服务端证明「我是这台设备」**（挑战-应答认证，见 apps/server/src/auth）。
 *
 * 两者刻意不复用同一密钥：
 * - 用途分离是密码学工程惯例——同一密钥跨算法/跨用途使用会让某一侧的
 *   实现缺陷污染另一侧（Ed25519↔X25519 虽可数学互转，但签名 oracle 与
 *   加密 oracle 混用的安全证明不成立）；
 * - 生命周期不同：E2E 密钥的信任来源是带外 QR + SAS 人工比对，
 *   服务端不可信；设备签名公钥反而是**登记给服务端**的，两者信任模型相反；
 * - 撤销粒度不同：吊销服务端接入（换签名密钥）不应牵连已配对的 E2E 关系。
 *
 * 与 box.ts 一致：所有 API 字符串进出（base64url），使用前必须
 * `await sodiumReady()`。
 */
import { fromBase64, sodium, toBase64 } from './box.ts';

/** Ed25519 公钥字节数，解码后按此校验 */
export const SIGN_PUBLIC_KEY_BYTES = 32;
/** Ed25519 私钥字节数（libsodium 的私钥含拼接的公钥，故为 64） */
export const SIGN_SECRET_KEY_BYTES = 64;
/** Ed25519 签名字节数 */
export const SIGNATURE_BYTES = 64;

/** 设备身份密钥对，公私钥均为 base64url 字符串 */
export interface SignKeyPair {
  publicKey: string;
  secretKey: string;
}

/** 生成设备身份密钥对（注册时一次，长期持有） */
export function generateSignKeyPair(): SignKeyPair {
  const kp = sodium().crypto_sign_keypair();
  return {
    publicKey: toBase64(kp.publicKey),
    secretKey: toBase64(kp.privateKey),
  };
}

/** 对消息做 detached 签名，返回 base64url 签名 */
export function signDetached(
  message: Uint8Array | string,
  secretKey: string,
): string {
  const bytes =
    typeof message === 'string' ? new TextEncoder().encode(message) : message;
  return toBase64(sodium().crypto_sign_detached(bytes, fromBase64(secretKey)));
}

/**
 * 校验 detached 签名。
 *
 * 任何解码失败/长度非法都返回 false 而不是抛错——校验方多半在处理**不可信
 * 输入**（认证端点），抛错会把「格式错」和「签名错」变成两条不同代码路径，
 * 徒增出错空间。
 */
export function verifyDetached(
  message: Uint8Array | string,
  signature: string,
  publicKey: string,
): boolean {
  try {
    const bytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message;
    const sig = fromBase64(signature);
    const pk = fromBase64(publicKey);
    if (sig.length !== SIGNATURE_BYTES || pk.length !== SIGN_PUBLIC_KEY_BYTES) {
      return false;
    }
    return sodium().crypto_sign_verify_detached(sig, bytes, pk);
  } catch {
    return false;
  }
}

/** 公钥格式/长度是否合法（注册端点登记前校验） */
export function isValidSignPublicKey(publicKey: string): boolean {
  try {
    return fromBase64(publicKey).length === SIGN_PUBLIC_KEY_BYTES;
  } catch {
    return false;
  }
}

/** 生成 n 字节随机值的 base64url（挑战串、token 等） */
export function randomToken(bytes = 32): string {
  return toBase64(sodium().randombytes_buf(bytes));
}

// ---------------------------------------------------------------------------
// 挑战-应答：待签名串的规范形式
// ---------------------------------------------------------------------------

/**
 * 挑战应答签名的待签名串（三端必须逐字节一致，故定义在 core）。
 *
 * 三个成分缺一不可：
 * - `trine-auth-v1` 域分隔前缀——防止这把设备密钥的签名被拿去别处复用
 *   （同一密钥若将来用于其他签名用途，前缀保证两类签名互不通用）；
 * - `deviceId` 绑定身份——否则 A 设备的应答可被挪去冒充 B 设备；
 * - `challenge` 服务端一次性随机数——防重放。
 *
 * 用 `|` 分隔而非 JSON：字段值本身是 base64url / 设备 id，都不含 `|`，
 * 不存在分隔符歧义，且没有 JSON 键序不确定性带来的两端串不一致风险。
 */
export function authChallengeMessage(
  deviceId: string,
  challenge: string,
): string {
  return `trine-auth-v1|${deviceId}|${challenge}`;
}

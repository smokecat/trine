/**
 * 配对：QR 带外 payload 编解码 + 双端 SAS 短认证串派生。
 * 流程见 docs/PROTOCOL-REQUIREMENTS.md §4：
 *   QR(serverUrl + agentPubKey + 一次性 token) → pair.begin → 双端 SAS 比对。
 */
import { z } from 'zod';
import { fromBase64, sodium, toBase64 } from './box.ts';

/** crypto_box 公钥长度（X25519），解码后按此校验 */
const PUBLIC_KEY_BYTES = 32;

/** qrSecret 长度：128 bit，离线爆破 SAS 在算力上不成立 */
const QR_SECRET_BYTES = 16;

/**
 * 回环地址：`ws://127.0.0.1:8787` 这类本机端点。
 *
 * 唯一的 TLS 豁免（见 `ServerUrlSchema`）。判据只认字面量地址，
 * **不做 DNS 解析**——`localhost` 之外任何能被解析到回环的域名都不算，
 * 因为解析结果取决于运行环境的 hosts/DNS，不是这段代码能保证的性质。
 */
function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    // 127.0.0.0/8 整段都是回环
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * 带外通道（QR / 配对码）必须是 TLS 端点：serverUrl 只收 wss / https。
 * 明文 ws/http 会让中间人直接替换 pair.begin 里的公钥。
 *
 * **唯一豁免是回环地址**（本机开发与自动化测试）：流量根本不出网卡，
 * 不存在可插入的中间人，强制 TLS 只会逼开发者去搭一套自签证书，
 * 而自签证书带来的「习惯性点掉证书警告」比这里的豁免危险得多。
 * 判据严格限定为字面量回环地址，见 `isLoopback`。
 */
const ServerUrlSchema = z.url().refine(
  (u) => {
    const { protocol, hostname } = new URL(u);
    if (protocol === 'wss:' || protocol === 'https:') return true;
    return (protocol === 'ws:' || protocol === 'http:') && isLoopback(hostname);
  },
  { message: 'serverUrl 必须是 wss:// 或 https://（回环地址除外）' },
);

/** QR / 配对码承载的带外内容 */
export const PairingPayloadSchema = z.object({
  v: z.literal(1),
  serverUrl: ServerUrlSchema,
  agentPubKey: z.string().min(1),
  /**
   * 一次性配对 token，**给 server 核销**用（client 在 pair.begin 里带上它，
   * server 据此认出这是哪次配对并转发给对应 agent）——服务端必然看得见。
   */
  pairingToken: z.string().min(1),
  /**
   * SAS 的 keyed-hash 密钥（base64url 的 128-bit 随机值）。
   * 与 pairingToken 是**两个完全不同的东西**：qrSecret 由 agent 生成，
   * 只进 QR、只有扫码的人能拿到，**永不发给服务端**。没有它就无法预测
   * 或离线爆破 SAS——这正是防「攻击者磨密钥对撞 6 位数字」的根据。
   */
  qrSecret: z.string().min(1),
  /**
   * 配对方的 machineId（可选）。client 配对成功后要知道「刚配上的是哪台机器」，
   * 才能把 agent 公钥记到正确的 machineId 名下。
   *
   * 缺省时只能回落到「接入后第一条在线的 machine.status」——多机场景下
   * 那条先到的很可能是别的机器，就把公钥记错了机器。QR 由 agent 自己生成、
   * 走带外通道，它当然知道自己的 machineId，直接写进来是最可靠的来源。
   *
   * **可选**是为了向后兼容旧 QR（0.1.0 时期生成的 payload 没有这个字段），
   * 解码端拿不到就走旧的回落路径。
   *
   * 零知识判据：machineId 本就是服务端可见的路由字段（relay 帧的坐标之一），
   * 且 QR 走带外通道不经服务端——写进 QR 不产生任何新的泄露面。
   */
  machineId: z.string().min(1).max(128).optional(),
});
export type PairingPayload = z.infer<typeof PairingPayloadSchema>;

/** 生成 qrSecret：128-bit 随机数 → base64url */
export function generateQrSecret(): string {
  return toBase64(sodium().randombytes_buf(QR_SECRET_BYTES));
}

/** 编成单个 base64url 字符串，直接生成 QR（前缀便于扫码方识别） */
export function encodePairingPayload(payload: PairingPayload): string {
  const json = JSON.stringify(PairingPayloadSchema.parse(payload));
  return `trine1:${toBase64(new TextEncoder().encode(json))}`;
}

export function decodePairingPayload(encoded: string): PairingPayload {
  if (!encoded.startsWith('trine1:')) {
    throw new Error('not a trine pairing payload');
  }
  const json = new TextDecoder().decode(fromBase64(encoded.slice('trine1:'.length)));
  const payload = PairingPayloadSchema.parse(JSON.parse(json));

  // 公钥长度必须恰为 crypto_box_PUBLICKEYBYTES：截断/加长的公钥进不了后续
  // crypto_box，早失败早报错，也堵住畸形 QR 引发的隐式行为。
  const pubKey = fromBase64(payload.agentPubKey);
  if (pubKey.length !== PUBLIC_KEY_BYTES) {
    throw new Error(
      `agentPubKey 长度非法：期望 ${PUBLIC_KEY_BYTES} 字节，实际 ${pubKey.length}`,
    );
  }
  return payload;
}

// ---------------------------------------------------------------------------
// SAS 短认证串
// ---------------------------------------------------------------------------

/** SAS emoji 表：32 个视觉差异大的 emoji，5 bit/个 */
const SAS_EMOJI = [
  '🐶', '🐱', '🦊', '🐼', '🦁', '🐸', '🐙', '🦋',
  '🌵', '🌲', '🍄', '🌻', '🍎', '🍋', '🍇', '🥕',
  '⚽', '🎲', '🎸', '🎈', '🚀', '⛵', '🚲', '⏰',
  '🔑', '💡', '📌', '✂️', '🧲', '🔔', '☂️', '⭐',
] as const;

export interface Sas {
  /** 6 位数字码（口头核对用） */
  digits: string;
  /** 4 个 emoji（屏幕比对用） */
  emoji: string[];
}

/** 按字节序比较两个公钥，用于消除传参顺序的影响 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** 顺序拼接若干字节段 */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** client 单方提交、经不可信 server 中转、且事后被 server 信任的身份字段 */
export interface ClientPairingIdentity {
  /** X25519 内容加密公钥（信封绑定用；SAS 排序组的一员） */
  boxPubKey: string;
  /** Ed25519 设备身份公钥——**背书登记的凭据就是它**（D8），必须进 SAS */
  signPubKey: string;
  /** 登记主键——server 事后拿它当 deviceId 落库，必须进 SAS */
  deviceId: string;
}

/**
 * 由 agent box 公钥 + client 身份 + qrSecret 派生 SAS：两端各自计算，
 * 结果一致即**全部经不可信 server 中转、且事后被信任的字段都未被替换**。
 *
 * ## 为什么不能只哈希两把 box 公钥（评审打回的信任根缺陷）
 *
 * D8 的背书登记里，server 事后信任并落库的凭据是 client 的 **Ed25519
 * signPubKey** 和 **deviceId**——不是 box 公钥。若 SAS 只覆盖 box 公钥，
 * 不可信 server（威胁模型 D1：可任意改明文 pair.* 帧）就能在中转途中
 * **只替换 signPubKey / deviceId、原样保留 box 公钥**：两端 deriveSas 的
 * 输入相同 → SAS 一致 → 用户比对通过 → hub 的 begin↔confirm 一致性校验
 * 也自洽（它防第三方 MITM，防不住 server 自己作恶，缓存的就是攻击者的
 * key）→ auth.register 落下攻击者的签名身份。此后合法 client 持真私钥走
 * verify 恒 `bad_signature` 被永久锁死，换公钥又被硬拒，全程静默。内容
 * 平面被 box 公钥的 SAS 保住了，但**认证平面被劫持**——SAS 的核心承诺
 * 落空。修法就是把这三样一起纳入哈希。
 *
 * ## 必须 keyed hash（原有理由不变）
 *
 * SAS 只有 6 位数字（~2²⁰），相关公钥经明文中转，攻击者知道后可离线
 * keygen 磨一个撞同一 SAS 的中间人密钥（10⁶ 量级，秒级）。以 qrSecret
 * （128-bit，只在 QR 里、server 拿不到）作 generichash 的 key，攻击者
 * 无从预测输出，离线爆破失去着力点。
 *
 * ## 拼接结构（防歧义）
 *
 * `key=qrSecret` 下 hash：
 * `"trine-sas-v1|" || sorted(agentBoxPub, clientBoxPub) || sep ||
 *  H(signPubKey) || sep || H(deviceId)`
 *
 * - **两把 box 公钥排序拼接**：它们是对称的（谁 A 谁 B 无所谓），排序
 *   消除传参顺序影响；排的是 fromBase64 后的**原始字节**，不是 base64
 *   字符串——字母表序与字节序不一致会让两端偶尔取到不同顺序。
 * - **signPubKey / deviceId 不进排序组**：它们是 client 单方的、非对称的，
 *   混进排序会破坏「这两样是 client 身份、那两把是双方内容密钥」的语义。
 * - **每个变长字段先各自 generichash 成定长 16 字节再拼**：deviceId 是
 *   变长字符串，直接拼接会引入分隔符注入歧义（`a|b` 与 `a` + `|b`
 *   无法区分）。定长哈希后每段长度固定，拼接不再有歧义。box 公钥长度
 *   本就固定（32B），但为结构统一也一并走定长哈希。
 */
export function deriveSas(
  agentBoxPubKey: string,
  client: ClientPairingIdentity,
  qrSecret: string,
): Sas {
  const key = fromBase64(qrSecret);
  // 每个变长/单方字段先压成定长摘要，杜绝拼接歧义（尤其 deviceId 是变长串）
  const h16 = (bytes: Uint8Array) => sodium().crypto_generichash(16, bytes, key);

  // 对称的两把 box 公钥按原始字节排序，消除传参顺序影响
  const [lo, hi] = [
    fromBase64(agentBoxPubKey),
    fromBase64(client.boxPubKey),
  ].sort(compareBytes);
  const boxSection = new Uint8Array(lo!.length + hi!.length);
  boxSection.set(lo!, 0);
  boxSection.set(hi!, lo!.length);

  const signDigest = h16(fromBase64(client.signPubKey));
  const deviceDigest = h16(new TextEncoder().encode(client.deviceId));

  const prefix = new TextEncoder().encode('trine-sas-v1|');
  const sep = new TextEncoder().encode('|');
  const input = concatBytes([
    prefix,
    h16(boxSection),
    sep,
    signDigest,
    sep,
    deviceDigest,
  ]);

  const hash = sodium().crypto_generichash(16, input, key);

  // 前 4 字节 → 6 位十进制
  const n =
    ((hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]!) >>> 0;
  const digits = String(n % 1_000_000).padStart(6, '0');

  // 字节 4..7 → 4 个 emoji（每字节取低 5 bit 索引 32 表）
  const emoji = [4, 5, 6, 7].map((i) => SAS_EMOJI[hash[i]! & 0b11111]!);

  return { digits, emoji };
}

/**
 * Transport 帧：client/agent ↔ server 之间的明文控制帧与密文中转信封。
 * 这一层是零知识边界——服务端可见的只有这里定义的字段
 * （docs/PROTOCOL-REQUIREMENTS.md 中的 † 标注），E2E 正文永远是 ciphertext。
 *
 * ## † 清单的判据
 *
 * 一个字段可以出现在这一层，当且仅当它满足两条：**中转本职需要它**，
 * 且**它不透露服务端本来不知道的东西**。machineId / sessionId / seq /
 * recipientDeviceId 都是路由与排序信息——服务端要把帧送到对的地方、按对的
 * 顺序补发，就必须看得见；而设备集合与会话的存在性本来就在 devices 表和
 * 连接身份里，写进帧里不增加任何新知识。
 *
 * 反过来，任何关于**内容**的信息一律不得出现在这一层：正文、事件类型、
 * 会话名、工具名、文件路径。`pushHint` 是唯一的例外，也因此被刻意限成
 * 一个封闭的事件类型枚举（决策 6），而不是任意字符串。
 */
import { z } from 'zod';
import {
  MachineStatusSchema,
  PushHintSchema,
  TimestampSchema,
} from '../types/index.ts';

export const PROTOCOL_VERSION = 1;

/**
 * 单调序号：由发出方（agent 或 client）按会话分配，服务端只校验单调、
 * 存密文 + seq 做断线补发与去重。
 *
 * **首个 seq 必须是 1，不是 0**（`FIRST_SEQ`）。理由：`sync.request.sinceSeq`
 * 复用本 schema（非负），补发语义是「补 sinceSeq 之后的帧」，于是 0 必须
 * 留给「一帧都还没收到」这个含义。若 seq 从 0 起，全新客户端就没有任何
 * 合法的 sinceSeq 能取回第 0 帧——每条流的首帧会在重连后永久丢失。
 */
export const SeqSchema = z.number().int().nonnegative();

/** 每条 (machineId, sessionId) 序列的首个 seq */
export const FIRST_SEQ = 1;

/** `sinceSeq` 取此值表示「该流一帧都没收到过，请从头补发」 */
export const NO_SEQ_RECEIVED = 0;

/** base64（URL-safe, no padding）编码的二进制字段 */
const Base64Schema = z.string().min(1);

// ---------------------------------------------------------------------------
// 连接握手
// ---------------------------------------------------------------------------

/**
 * WS 建连后第一帧：声明身份与角色。
 * 认证凭据的具体设计（token 签发/校验）属 server-relay 任务，这里先留
 * authToken 占位。
 */
export const HelloSchema = z.object({
  type: z.literal('hello'),
  v: z.literal(PROTOCOL_VERSION),
  /**
   * 连接角色。`client` / `agent` 都必须带 `authToken`（身份以 token 为准，
   * 自报值只做交叉检查）。
   *
   * `pairing` 是**免认证的受限角色**（D8）：全新 client 设备在配对完成前
   * 根本没有登记过公钥，换不到 token，物理上发不出 `pair.begin`——这不是
   * 实现细节而是握手层的架构缺口。该角色的连接：
   * - 不带 authToken（带了也忽略）；
   * - 只允许收发 `pair.*` 帧，其余一律拒绝；
   * - 不进 ConnectionRegistry（收不到任何广播、relay、补发）；
   * - 短空闲超时 + 复用 pair 帧频率上限。
   *
   * 配对成功后 client 换到正常 token，以 `role:'client'` 重新接入。
   */
  role: z.enum(['client', 'agent', 'pairing']),
  /**
   * 本设备标识：agent 即 machineId，client 为设备指纹。
   * `pairing` 角色下该值**未经任何验证**，仅用于日志——真正的登记身份
   * 以 agent 在 `pair.confirm` 里背书的那份为准。
   */
  deviceId: z.string().min(1),
  authToken: z.string().optional(),
});

// ---------------------------------------------------------------------------
// 密文中转信封（核心帧）
// ---------------------------------------------------------------------------

/**
 * E2E 密文信封：client → server → agent 或反向。
 * ciphertext 内是 E2eEvent（events.ts）的 crypto_box 密文。
 */
export const RelayFrameSchema = z.object({
  type: z.literal('relay'),
  /** 路由：目标/来源机器 */
  machineId: z.string().min(1),
  /**
   * 路由：会话级事件必带；机器级事件（machine.info、cwd.*）省略。
   * 上限与 recipientDeviceId 一致：它会成为服务端 stream_hwm / relay_frames
   * 的主键一部分，无上界就是一个由 client 任意灌入的存储放大面（实际值是 UUID）。
   */
  sessionId: z.string().min(1).max(128).optional(),
  /**
   * 路由：这一份密文是发给**哪台 client 设备**的（仅 a2c 方向）。
   *
   * ## 为什么必须有这个字段（D8 矩阵式独立配对的直接后果）
   *
   * crypto_box 是点对点的：一份密文只有持有对应私钥的那台设备解得开。
   * 矩阵式配对下 agent 对每个已配对收件人**各 seal 一份**，于是同一个
   * 逻辑事件会产生 N 条 relay 帧——它们的 machineId / sessionId / seq
   * 完全相同（同一逻辑事件就该是同一个 seq，这是与 client 侧单调校验
   * 对齐的前提），唯一的区别就是收件人。没有这个字段，服务端的
   * (machineId, sessionId, dir, seq) 就无法区分它们：去重会把第 2..N 份
   * 当成重复帧丢掉，第二台设备起就永远收不到能解开的密文。
   *
   * 方向约定：
   * - **a2c（agent → client）必带**——每收件人一帧；
   * - **c2a（client → agent）省略**——收件人天然是该 machineId 的 agent，
   *   写出来是冗余，冗余字段就有被写歪的可能。
   *
   * ## 零知识边界（† 清单的口径）
   *
   * 这是一个新增的服务端可见字段，但**不构成新的泄露**：服务端本来就
   * 持有全部已登记设备的清单（devices 表），也本来就知道每条连接是哪台
   * 设备（token 换回的身份）。「把这份密文送到哪台设备」是中转服务的
   * 本职工作——正如 machineId 一样。它没有透露任何关于**内容**的信息，
   * 也没有透露设备之外的新实体。
   */
  recipientDeviceId: z.string().min(1).max(128).optional(),
  /** 发出方分配的单调序号，补发与去重依据 */
  seq: SeqSchema,
  nonce: Base64Schema,
  ciphertext: Base64Schema,
  /**
   * 脱敏推送提示（仅 agent → server 方向使用）：服务端读不了密文，
   * 靠这个明文标记触发推送——只含事件类型，不含正文/会话名（决策 6）。
   */
  pushHint: PushHintSchema.optional(),
});
export type RelayFrame = z.infer<typeof RelayFrameSchema>;

// ---------------------------------------------------------------------------
// 断线补发
// ---------------------------------------------------------------------------

/** client → server：重连后按 seq 请求补发 */
export const SyncRequestSchema = z.object({
  type: z.literal('sync.request'),
  machineId: z.string().min(1),
  /**
   * 省略 = 补发该机器的机器级帧（machine.info、cwd.* 等，即 RelayFrame 上
   * sessionId 省略的那批）；机器级帧的 seq 序列独立于各会话，
   * 所以补发时也要各自按自己的 sinceSeq 走。
   */
  sessionId: z.string().min(1).optional(),
  /**
   * 已收到的最大 seq，服务端补发其后的所有帧。
   * `NO_SEQ_RECEIVED`（0）= 一帧都没收到，请从头补发（见 SeqSchema 注释）。
   */
  sinceSeq: SeqSchema,
});

/**
 * server → 请求方：某条流的补发**已经发完了**。
 *
 * ## 为什么需要一个显式的完成标记
 *
 * 重连后 client 对每条流发 sync.request，服务端把积压的 relay 帧按 seq
 * 补发回来。但连接是**同一条**：补发正在进行时，agent 新产生的 live 帧
 * 也在往同一条连接上发。两者在 client 眼里都是 relay 帧，而 live 帧的
 * seq 必然大于补发帧——于是 live 帧先到、把游标推到高位，随后到达的补发帧
 * 全部 `seq <= 游标` 被当成重放丢弃，重连即丢历史。
 *
 * 正确做法是「补发期间把 live 帧暂存，补完再按 seq 归并」，而这需要一个
 * 「补发到此为止」的信号。没有它，client 只能靠超时猜，猜早了丢帧、
 * 猜晚了卡住界面。
 *
 * `upTo` 是本次补发实际发出的最大 seq；一帧都没补发时等于请求里的
 * `sinceSeq`（即「你已经是最新的了」），这样两种情况的处理是同一条路径。
 *
 * 每条流各发一帧，与 sync.request 一一对应（同样用 machineId + 可选
 * sessionId 标定是哪条流）。
 */
export const SyncDoneSchema = z.object({
  type: z.literal('sync.done'),
  machineId: z.string().min(1),
  /** 省略 = 机器级流，与 sync.request 的同名字段语义一致 */
  sessionId: z.string().min(1).optional(),
  /** 本次补发发出的最大 seq；无帧可补时等于请求的 sinceSeq */
  upTo: SeqSchema,
});

// ---------------------------------------------------------------------------
// 机器在线状态与离线排队（server → client）
// ---------------------------------------------------------------------------

export const MachineStatusFrameSchema = z.object({
  type: z.literal('machine.status'),
  ...MachineStatusSchema.shape,
});

/** agent 离线时 server 排队（决策 1：默认 24h TTL 可配置）的回执 */
export const InputParkedSchema = z.object({
  type: z.literal('input.parked'),
  machineId: z.string().min(1),
  sessionId: z.string().min(1),
  /** 被排队 relay 帧的 seq，client 据此关联本地暂存消息 */
  seq: SeqSchema,
  /** 过期时间，client 展示「已排队，xx 前有效」 */
  expiresAt: TimestampSchema,
});

/**
 * client → server：撤回一条 parked 在服务端的排队帧。
 *
 * 为什么必须是明文 transport 帧：agent 离线时密文根本到不了 agent，
 * E2E 的 `input.recall`（events.ts）只能撤回 **agent 端**队列里的消息。
 * 服务端读不了密文，只能按 seq 定位——seq 正是 `input.parked` 回执给
 * client 的那个值，所以 client 手里一定有。
 *
 * 服务端删掉匹配 (machineId, sessionId, seq) 的 parked 帧；已投递或已过期
 * 则静默无操作（幂等）。
 */
export const ParkRecallSchema = z.object({
  type: z.literal('park.recall'),
  machineId: z.string().min(1),
  sessionId: z.string().min(1),
  /** 被撤回 relay 帧的 seq，来自 input.parked 回执 */
  seq: SeqSchema,
});

/** server → client：按机器报排队帧数（不泄露内容） */
export const ParkedCountSchema = z.object({
  type: z.literal('parked.count'),
  machineId: z.string().min(1),
  parkedCount: z.number().int().nonnegative(),
});

/**
 * server → client：一条排队帧再也送不出去了。
 *
 * 触发场景：TTL 到点，或密文被留存策略裁掉导致 agent 上线时投不出内容。
 * 没有本帧的话，client 手里那张 `input.parked` 回执会永远停在「已排队」，
 * 而消息其实早就蒸发了——用户以为发出去了，实际没有。
 *
 * `seq` 与当初 `input.parked` 回执里的一致，client 据此把本地那条暂存
 * 消息标记为失败并允许重发。
 *
 * 已知缺口（记入协议待办）：本帧只广播给**当前在线**的 client。
 * client 若在过期发生时离线，重连后只能靠 `parked.count` 与自己的
 * `input.parked` 台账对账推断，服务端目前不为其补发过期告知。
 */
export const ParkExpiredSchema = z.object({
  type: z.literal('park.expired'),
  machineId: z.string().min(1),
  sessionId: z.string().min(1),
  /** 被判过期的 relay 帧 seq，与 input.parked 回执同源 */
  seq: SeqSchema,
});

/** 服务端拒收一帧的原因（都是发送方可自行纠正的协议层问题） */
export const RelayRejectReasonSchema = z.enum([
  /** seq 小于该流已存的最大值 */
  'seq_not_monotonic',
  /** seq < FIRST_SEQ（0 保留给 sinceSeq 语义） */
  'seq_below_first',
  /** seq 跳跃过大，疑似毒化整条流 */
  'seq_too_far_ahead',
  /** 该机器的离线排队配额已满 */
  'parked_quota_exceeded',
]);
export type RelayRejectReason = z.infer<typeof RelayRejectReasonSchema>;

/**
 * server → 发送方：你发的那一帧被拒了。
 *
 * 没有本帧的话被拒的帧就是静默蒸发——发送方以为发出去了，接收方从没收到，
 * 而两边都不会察觉。带上 seq 与原因，发送方才能重新分配序号或提示用户。
 */
export const RelayRejectSchema = z.object({
  type: z.literal('relay.reject'),
  machineId: z.string().min(1),
  /** 与被拒 relay 帧一致：机器级帧省略 */
  sessionId: z.string().min(1).optional(),
  seq: SeqSchema,
  reason: RelayRejectReasonSchema,
  /**
   * 该流当前的高水位（服务端已接受的最大 seq）——发送方**自愈**的依据。
   *
   * 只有 seq 类拒绝（`seq_not_monotonic` / `seq_too_far_ahead`）才带：发送方
   * 拿到它就能把自己的计数器跳到 `expectedAfter + 1` 重发，不必猜。没有它，
   * 发送方重启后丢了计数器只能靠「往上猛加一截」赌一次（撞 lookahead 上限
   * 就整条流报废）。可选是为了向后兼容旧服务端；收不到时发送方降级为
   * 报错给用户。
   *
   * † 判据：这个值本来就是服务端从自己库里算出来的（单调校验用的 max），
   * 回给发送方不增加任何新知识。
   */
  expectedAfter: SeqSchema.optional(),
  /**
   * 被拒 relay 帧上的 `recipientDeviceId` 原样回带（a2c 帧才有，c2a 省略）。
   *
   * 矩阵式配对下每个收件人是独立子流、各有各的高水位：同一逻辑事件的 N 份
   * 密文可能只有其中一份被拒。发送方自愈时只该给**被拒的那条子流**重发——
   * 其他收件人早已接受原帧，全员重发会让它们收到重复事件。没有这一维，
   * agent 收到 reject 时无从知道该补给谁。
   *
   * † 判据：这个值就是发送方自己写在被拒帧上的字段，原样回带不增加新知识。
   */
  recipientDeviceId: z.string().min(1).max(128).optional(),
});

// ---------------------------------------------------------------------------
// §4 配对（server 中转明文——此时 E2E 通道尚未建立，安全性靠一次性
// token + 带外 QR + 双端 SAS 比对）
// ---------------------------------------------------------------------------

/**
 * client → server → agent：client 用一次性 token 提交自己的两把公钥。
 *
 * 刻意不带设备名等任何描述性字段：本帧经不可信服务端明文中转，多一个字段
 * 就多一份超出 † 清单的泄露。设备名在配对完成、E2E 通道建立后由 client 用
 * 首帧密文告知 agent。
 *
 * ## 为什么要带 Ed25519 签名公钥（D8）
 *
 * `clientPubKey`（X25519）解决的是 E2E 内容加密，`clientSignPubKey`
 * （Ed25519）解决的是**向服务端证明设备身份**——两套密钥刻意分离
 * （见 crypto/sign.ts）。配对是这两套体系唯一的交汇点：不在这里把签名
 * 公钥递过去，配对成功后 client 就没有任何途径被 `auth.register` 登记。
 *
 * **服务端绝不能凭本帧的自报值登记设备**：本帧是明文广播中转，任何人都能
 * 发。真正的登记依据是 agent 在 `pair.confirm` 里复述的那份（见其注释）。
 */
export const PairBeginSchema = z.object({
  type: z.literal('pair.begin'),
  pairingToken: z.string().min(1),
  /** X25519：E2E 内容加密公钥 */
  clientPubKey: Base64Schema,
  /**
   * Ed25519：设备身份签名公钥，配对成功后由服务端登记。
   *
   * **其完整性由 SAS 人工比对保证，server 不可信**：本字段经明文中转，
   * 是背书登记事后落库的凭据，因此它连同 clientPubKey、clientDeviceId
   * 一起被纳入 `deriveSas` 的哈希输入（core/crypto/pairing.ts）。server
   * 若在途中替换它，两端 SAS 必然不一致，用户比对时发现。
   */
  clientSignPubKey: Base64Schema,
  /**
   * 登记主键：配对成功后该 client 以此 deviceId 走挑战-应答。
   *
   * **其完整性由 SAS 人工比对保证，server 不可信**：同 clientSignPubKey，
   * server 事后拿它当 deviceId 落库，故也纳入 `deriveSas` 哈希输入。
   */
  clientDeviceId: z.string().min(1).max(128),
});

/**
 * agent → server → client：双端人工比对 SAS 一致后确认。
 *
 * ## agent 复述身份 = 背书（D8）
 *
 * agent 必须把它**实际收到**的那份 client 身份原样复述回来。服务端只在
 * 三个条件同时成立时才登记设备：
 * 1. 发帧连接的已认证角色是 `agent`（client 自己发 confirm 无效）；
 * 2. 该 pairingToken 有对应的、未过期的 `pair.begin` 缓存记录；
 * 3. 复述的 `clientDeviceId` / `clientSignPubKey` 与缓存记录逐字相同。
 *
 * 中间人若在中转途中替换了 client 的公钥，agent 收到的就是攻击者的公钥，
 * 双端 SAS（两把公钥 + 只在 QR 里的 qrSecret 派生）必然对不上，用户拒绝，
 * agent 压根不会发出本帧——这就是「谁背书谁登记」把伪造窗口关掉的地方。
 */
export const PairConfirmSchema = z.object({
  type: z.literal('pair.confirm'),
  pairingToken: z.string().min(1),
  /** agent 复述：它实际收到的 clientDeviceId */
  clientDeviceId: z.string().min(1).max(128),
  /** agent 复述：它实际收到并已用 SAS 确认过的 Ed25519 公钥 */
  clientSignPubKey: Base64Schema,
});

export const PairAbortSchema = z.object({
  type: z.literal('pair.abort'),
  pairingToken: z.string().min(1),
  reason: z.string().optional(),
});

// ---------------------------------------------------------------------------
// 联合
// ---------------------------------------------------------------------------

export const TransportFrameSchema = z.discriminatedUnion('type', [
  HelloSchema,
  RelayFrameSchema,
  SyncRequestSchema,
  SyncDoneSchema,
  MachineStatusFrameSchema,
  InputParkedSchema,
  ParkRecallSchema,
  ParkedCountSchema,
  ParkExpiredSchema,
  RelayRejectSchema,
  PairBeginSchema,
  PairConfirmSchema,
  PairAbortSchema,
]);
export type TransportFrame = z.infer<typeof TransportFrameSchema>;

/** 序列化：WS 文本帧 JSON */
export function encodeTransportFrame(frame: TransportFrame): string {
  return JSON.stringify(frame);
}

/** 反序列化 + 校验：非法输入抛 ZodError / SyntaxError */
export function decodeTransportFrame(raw: string): TransportFrame {
  return TransportFrameSchema.parse(JSON.parse(raw));
}

/**
 * E2E 封套：明文事件 ↔ RelayFrame 密文。
 *
 * agent 侧的两个方向：
 * - **出站**（a2c）：一个 `AgentToClientEvent` 对**每个收件人各 seal 一份**
 *   （D8 矩阵式独立配对——crypto_box 是点对点的，见 recipients.ts）；
 * - **入站**（c2a）：用发送方 client 的公钥 open，过
 *   `ClientToAgentEventSchema` 校验，再过 `assertEnvelopeBinding`。
 *
 * ## 入站为什么必须走满这三步
 *
 * 少一步都有实打实的攻击面：
 * - 不解密就没有来源认证（crypto_box 是 AEAD，解得开即证明对方持有私钥）；
 * - 不过 schema 就等于把任意 JSON 喂进业务逻辑；
 * - 不过 `assertEnvelopeBinding` 就挡不住恶意服务端做反射/重放/跨会话拼接
 *   （原理见 core/protocol/events.ts 文件头）。
 *
 * seq 单调性由本层之上的调用方按 (deviceId, sessionId) 游标维护——
 * assertEnvelopeBinding 刻意不管它，因为它需要接收方自己的状态。
 */
import {
  assertEnvelopeBinding,
  ClientToAgentEventSchema,
  openJson,
  sealJson,
  type AgentToClientEvent,
  type ClientToAgentEvent,
  type RelayFrame,
} from '@trine/core';
import type { PushHint } from '@trine/core/types';
import type { Recipient } from './recipients.ts';

/** 出站：一个事件封给一个收件人后的成品 */
export interface SealedForRecipient {
  recipient: Recipient;
  frame: RelayFrame;
}

export interface SealOptions {
  machineId: string;
  /** agent 自己的 X25519 私钥 */
  boxSecretKey: string;
  /** 脱敏推送提示（只含事件类型，绝不含正文——决策 6） */
  pushHint?: PushHint;
}

/**
 * 把一个出站事件封给一个收件人。
 *
 * 信封上的 `sessionId` / `seq` 直接取自事件本身，不另传参：两者必须一致
 * （接收方会 assert），从同一处取值就没有写歪的可能。
 *
 * `recipientDeviceId` 是 a2c 帧坐标的一部分（transport.ts）：同一逻辑事件
 * 发给 N 个收件人的 N 份密文，seq 相同、只差这一维。**同一逻辑事件必须用
 * 同一个 seq**——seq 与逻辑事件一一对应是 client 侧单调游标的前提，
 * 给每个收件人各配一套计数器会让这个对应关系散掉。
 */
export function sealForRecipient(
  event: AgentToClientEvent,
  recipient: Recipient,
  options: SealOptions,
): SealedForRecipient {
  const box = sealJson(event, recipient.boxPubKey, options.boxSecretKey);
  const frame: RelayFrame = {
    type: 'relay',
    machineId: options.machineId,
    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    recipientDeviceId: recipient.deviceId,
    seq: event.seq,
    nonce: box.nonce,
    ciphertext: box.ciphertext,
    ...(options.pushHint ? { pushHint: options.pushHint } : {}),
  };
  return { recipient, frame };
}

/**
 * 把一个出站事件封给全部收件人（fanout）。
 *
 * N 个收件人 → N 条 relay 帧，同 seq、不同 recipientDeviceId、不同密文。
 * 服务端按收件人定向投递，各设备只收到自己那一份。
 *
 * 收件人为空时返回空数组——**这不是错误**：全新 agent 还没配对过任何设备，
 * 此时产生的事件本就无人可收。调用方按需决定是丢弃还是缓存。
 */
export function sealForAll(
  event: AgentToClientEvent,
  recipients: Recipient[],
  options: SealOptions,
): SealedForRecipient[] {
  return recipients.map((r) => sealForRecipient(event, r, options));
}

/** 入站解封失败的归因，便于上层分类计数而不是笼统吞掉 */
export type OpenFailure =
  | 'unknown_sender'
  | 'decrypt_failed'
  | 'schema_invalid'
  | 'binding_invalid';

export type OpenResult =
  | { ok: true; event: ClientToAgentEvent; sender: Recipient }
  | { ok: false; failure: OpenFailure; detail: string };

/**
 * 入站：解一条 relay 帧。
 *
 * **不抛错，返回判别式结果**：入站帧全是不可信输入，异常是常态而非例外
 * （对端版本不齐、恶意服务端瞎改、旧密钥的残留帧）。用返回值表达失败，
 * 调用方就不会因为漏了一层 try/catch 而让整条连接崩掉。
 *
 * `senderDeviceId` 从哪来：relay 帧的明文信封上**没有**发送方标识
 * （刻意的——那会让服务端多知道一件事）。所以 agent 的做法是**逐个收件人
 * 试解**：crypto_box 解密自带认证，解得开的那个就是发送方，解不开的会
 * 在 Poly1305 校验处失败。收件人是个位数，试解的成本可以忽略。
 */
export function openInbound(
  frame: RelayFrame,
  recipients: Recipient[],
  boxSecretKey: string,
): OpenResult {
  for (const sender of recipients) {
    let value: unknown;
    try {
      value = openJson(
        { nonce: frame.nonce, ciphertext: frame.ciphertext },
        sender.boxPubKey,
        boxSecretKey,
      );
    } catch {
      // 不是这个收件人发的，换下一个试
      continue;
    }

    const parsed = ClientToAgentEventSchema.safeParse(value);
    if (!parsed.success) {
      // 解得开说明来源确实是这台已配对设备，那么内容不合 schema 就是
      // 真的有问题（版本不齐或对端有 bug），不该再拿去试别的收件人
      return {
        ok: false,
        failure: 'schema_invalid',
        detail: parsed.error.message,
      };
    }

    try {
      assertEnvelopeBinding(
        parsed.data,
        { sessionId: frame.sessionId, seq: frame.seq },
        // agent 只接受 client → agent 方向；收到 a2c 说明密文被反射回来了
        'c2a',
      );
    } catch (err) {
      return {
        ok: false,
        failure: 'binding_invalid',
        detail: (err as Error).message,
      };
    }
    return { ok: true, event: parsed.data, sender };
  }

  return {
    ok: false,
    failure: recipients.length === 0 ? 'unknown_sender' : 'decrypt_failed',
    detail:
      recipients.length === 0
        ? '还没有任何已配对设备，无从判断发送方'
        : '没有任何已配对设备的公钥能解开这条密文',
  };
}

/**
 * 接收方的 seq 单调游标：每 (发送方 deviceId, sessionId) 一条。
 *
 * assertEnvelopeBinding 只保证「密文里的 seq 与信封一致」，重放一条**完整
 * 未改动**的旧帧它是拦不住的——那得靠接收方记住自己见过的最大 seq。
 * 这个状态只有接收方有，所以单独放在这里。
 */
/**
 * map key 分隔符：用 `\u0000` 转义字面量而非裸 NUL 字节。
 * 裸字节会让整个源文件被 git 判为 binary、diff 不可读（push-bark 已踩过同一坑）。
 * 选 NUL 是因为它不可能出现在 deviceId / sessionId 里，拼 key 无歧义。
 */
export const CURSOR_SEP = '\u0000';

export class SeqCursors {
  /** key = `${senderDeviceId}\u0000${sessionId ?? ''}` → 已见最大 seq */
  readonly #seen = new Map<string, number>();

  #key(senderDeviceId: string, sessionId: string | undefined): string {
    return `${senderDeviceId}${CURSOR_SEP}${sessionId ?? ''}`;
  }

  /**
   * 记录并判断一条帧的 seq 是否可接受（必须严格大于已见最大值）。
   * 返回 false 时调用方应丢弃该帧（重放或乱序的旧帧）。
   */
  accept(senderDeviceId: string, sessionId: string | undefined, seq: number): boolean {
    const key = this.#key(senderDeviceId, sessionId);
    const last = this.#seen.get(key);
    if (last !== undefined && seq <= last) return false;
    this.#seen.set(key, seq);
    return true;
  }

  /** 已见的最大 seq（断线补发时作为 sinceSeq 用） */
  lastSeen(senderDeviceId: string, sessionId: string | undefined): number {
    return this.#seen.get(this.#key(senderDeviceId, sessionId)) ?? 0;
  }

  /**
   * 全部游标的只读快照：key 就是内部的 `${deviceId}${CURSOR_SEP}${sessionId ?? ''}`。
   *
   * 供上层持久化（agent 重启后不从头补发、重放防护不清零）。刻意直接暴露
   * 内部 key 形状而不是拆成结构化数组：持久化层只需要「原样存、原样还回来」，
   * 拆开再拼回去多一次出错机会，而 key 的分隔符是 NUL，JSON 里能安全表示。
   */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.#seen);
  }

  /**
   * 从快照恢复。**只进不退**：对已有 key 取 MAX，恢复不会把进程内已推进的
   * 游标拖回去——启动顺序上「先 restore 再收帧」是常态，但反过来也不该出错。
   * 非法条目（非有限非负数）跳过，坏一条不至于全部作废。
   */
  restore(snapshot: Record<string, number>): void {
    for (const [key, seq] of Object.entries(snapshot)) {
      if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) continue;
      if (!key.includes(CURSOR_SEP)) continue;
      const last = this.#seen.get(key);
      if (last === undefined || seq > last) this.#seen.set(key, seq);
    }
  }

  /**
   * 出现过的全部流标识（去重；机器级用 `undefined` 表示）。
   *
   * 重连补发要**逐流**各发一条 sync.request（每条流的 sinceSeq 各自独立），
   * 这里给出「有哪些流」；每条的 sinceSeq 再用 minLastSeen 取。
   */
  sessionIds(): Array<string | undefined> {
    const out = new Set<string>();
    for (const key of this.#seen.keys()) {
      const sep = key.indexOf(CURSOR_SEP);
      if (sep < 0) continue;
      out.add(key.slice(sep + CURSOR_SEP.length));
    }
    return [...out].map((s) => (s === '' ? undefined : s));
  }

  /**
   * 某条 sessionId 流上、跨全部发送方的最小已见 seq。
   *
   * c2a 在服务端是**单一共享流**（`(machineId, sessionId, c2a, seq)`，
   * 没有发送方维度），补发也不按发送方过滤。所以断线重连要补 c2a 时，
   * 只需按这条流发**一条** sync.request，sinceSeq 取全部发送方游标的最小值
   * ——比任一发送方已收的都不多，谁漏的帧都补得回来，整条流只重放一次。
   * 若按发送方各发一条（N 条），每条都重放整条流，N² 级无谓流量（靠
   * seq<=last 丢弃不出错，但纯属浪费）。
   *
   * 没有任何匹配记录时返回 0（= 从头补发的哨兵）。
   */
  minLastSeen(sessionId: string | undefined): number {
    const target = sessionId ?? '';
    let min: number | undefined;
    for (const [key, seq] of this.#seen) {
      // 按分隔符切出 sessionId 段精确比对，而不是 endsWith——deviceId 里
      // 若恰好含目标 sessionId 的尾串，endsWith 会误命中
      const sep = key.indexOf(CURSOR_SEP);
      if (sep < 0 || key.slice(sep + CURSOR_SEP.length) !== target) continue;
      if (min === undefined || seq < min) min = seq;
    }
    return min ?? 0;
  }
}

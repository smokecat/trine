/**
 * 出站环形缓冲 + relay.reject 自愈（方案 §4c）。
 *
 * ## 解决什么
 *
 * 出站 seq 由 EventEmitter 单点分配，但它是内存态：agent 重启后从 1 重来
 * （state.json 只是快路径，可能丢、可能坏），服务端对既有流按持久高水位
 * 校验单调 → 整条流的后续帧全被 `seq_not_monotonic` 拒收。没有自愈的话，
 * 一次重启就让会话永远发不出东西。
 *
 * ## 机制：乐观分配，冲突后跳号重发（**只覆盖 seq_not_monotonic**）
 *
 * 1. 每帧发出前先记进本 scope 的环形缓冲（最近 64 条——assistant.delta 密集，
 *    64 条足够覆盖一次 reject 往返窗口；溢出即放弃重发最旧的帧并在需要时 warn）；
 * 2. 收到 `relay.reject{reason: seq_not_monotonic, expectedAfter, seq, sessionId, recipientDeviceId}`：
 *    - 若 emitter 的下一个 seq ≤ expectedAfter → 跳到 expectedAfter + 1；
 *    - 缓冲里该 scope 所有「发给该收件人时的 seq ∈ [被拒 seq, expectedAfter]」的帧，
 *      按序重新取 seq、**只发给这个收件人**（`publishTo`）——其他收件人早已接受
 *      原帧，全员重发会让它们收到重复事件；
 * 3. 后续新事件自然用跳高后的 seq；其他收件人子流因此跳号，协议允许。
 *
 * ## 为什么必须按收件人记 seq
 *
 * 矩阵式配对下每个收件人是独立子流、各有各的高水位。phone 的子流可能在 240，
 * tablet 刚配对是 fresh。同一逻辑事件 seq=1 发给两台：phone 拒、tablet 收。
 * 自愈给 phone 重发成 seq=241；之后若 tablet 也拒了什么，判断「哪些帧 tablet
 * 还没收到」必须看**发给 tablet 时**的 seq，而不是最近一次发给任何人的 seq。
 * 所以每条缓冲条目记 `seqFor: recipient → seq`。
 *
 * ## seq_too_far_ahead 不自愈，报错让用户可见
 *
 * 该原因只在 `seq - 高水位 > MAX_SEQ_LOOKAHEAD`（1e6）时出现，即本地计数器
 * **领先**服务端过多——跳号是往前跳，对「领先」无解；重发同样会被拒。正常运行
 * 达不到这个差距，出现即是 bug 或人为误操作（如两台机器共用了一份 state.json）。
 * 处理：放弃 + 机器级 error.fatal + 明确日志。删除 state.json 重启即恢复：
 * 计数器回到 1，撞 not_monotonic 后按高水位跳号。
 *
 * ## 放弃条件
 *
 * - reason 是 seq_too_far_ahead（见上）；
 * - reject 没带 expectedAfter（旧服务端）→ 无从跳号，放弃；
 * - reject 没带 recipientDeviceId 且名册不止一台设备 → 不知道补给谁，放弃
 *   （只有一台时可以确定就是它）；
 * - 同一帧对同一收件人重发 3 次仍被拒 → 放弃该 scope 本轮重发。
 * 放弃时机器级 `error.fatal{kind:'other'}` 告知用户，log 全量信息。**每 scope 只报
 * 一次 fatal**（进程内）：fatal 自身也是一帧，若机器级流正处于放弃状态，它会再被拒、
 * 再触发放弃……不设闸就是无限循环。
 */
import type {
  AgentToClientEvent,
  PushHint,
  TransportFrame,
} from '@trine/core';
import { waitingForTool } from '@trine/core/permission';
import type { EventEmitter } from '../bridge/emitter.ts';
import type { OutboundEvent, SeqScope } from '../bridge/types.ts';

export type RelayRejectFrame = Extract<TransportFrame, { type: 'relay.reject' }>;

/** 每 scope 缓冲条数 */
export const OUTBOX_CAPACITY = 64;
/** 同一帧对同一收件人的最大重发次数 */
export const OUTBOX_MAX_ATTEMPTS = 3;
/** 去重表容量：(scope, seq, recipient) 三元组 */
const DEDUPE_CAPACITY = 1024;

const MACHINE_SCOPE_KEY = '';

export interface OutboxOptions {
  emitter: EventEmitter;
  /** 定向发送（AgentNode.publishTo） */
  publishTo: (
    recipientDeviceId: string,
    event: AgentToClientEvent,
    pushHint?: PushHint,
  ) => boolean;
  /** 当前名册里的设备 id（记每帧发给了谁；reject 缺收件人时的兜底判定） */
  recipientIds: () => string[];
  pushHintFor: (event: AgentToClientEvent) => PushHint | undefined;
  log?: (line: string) => void;
  capacity?: number;
  maxAttempts?: number;
}

/** onReject 的处理结果，供日志与测试观察 */
export type RejectOutcome =
  | { kind: 'ignored'; reason: string }
  | { kind: 'duplicate' }
  /** `lostHead` = 被拒 seq 起有若干帧已滚出缓冲、无从重发（只补了还在的部分） */
  | { kind: 'resent'; recipient: string; count: number; seqs: number[]; lostHead: boolean }
  /** 被拒的帧全部已滚出缓冲，一帧也补不了 */
  | { kind: 'lost'; recipient: string }
  | { kind: 'gave_up'; reason: string };

interface Entry {
  event: AgentToClientEvent;
  /** 首次发出时的 seq（全员相同）；只用来判断被拒的帧是否已滚出缓冲 */
  origSeq: number;
  /** 发给每个收件人时用的 seq（重发后更新） */
  seqFor: Map<string, number>;
  /** 对每个收件人重发过几次 */
  attempts: Map<string, number>;
}

export class Outbox {
  readonly #emitter: EventEmitter;
  readonly #publishTo: OutboxOptions['publishTo'];
  readonly #recipientIds: () => string[];
  readonly #pushHintFor: OutboxOptions['pushHintFor'];
  readonly #log: (line: string) => void;
  readonly #capacity: number;
  readonly #maxAttempts: number;
  /** scope key → 环形缓冲（数组头最旧） */
  readonly #buffers = new Map<string, Entry[]>();
  /** 已处理过的 reject（Set 保插入序，超限淘汰最旧） */
  readonly #seen = new Set<string>();
  /** 已放弃并报过 fatal 的 scope：同一 scope 不重复刷 fatal（防自激循环） */
  readonly #gaveUp = new Set<string>();

  constructor(options: OutboxOptions) {
    this.#emitter = options.emitter;
    this.#publishTo = options.publishTo;
    this.#recipientIds = options.recipientIds;
    this.#pushHintFor = options.pushHintFor;
    this.#log = options.log ?? (() => {});
    this.#capacity = options.capacity ?? OUTBOX_CAPACITY;
    this.#maxAttempts = options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
  }

  /** 每帧发出前记一笔（sink 里、publish 之前调） */
  remember(out: OutboundEvent): void {
    const key = out.scope ?? MACHINE_SCOPE_KEY;
    let buffer = this.#buffers.get(key);
    if (buffer === undefined) {
      buffer = [];
      this.#buffers.set(key, buffer);
    }
    const seqFor = new Map<string, number>();
    // 定向帧只记那一台：别的设备根本没收到它，reject 自愈时也不该补给它们
    const recipients = out.to === undefined ? this.#recipientIds() : [out.to];
    for (const id of recipients) seqFor.set(id, out.event.seq);
    buffer.push({ event: out.event, origSeq: out.event.seq, seqFor, attempts: new Map() });
    // 溢出静默丢最旧：正常运行时缓冲一直在滚动，逐条 warn 只会刷屏；
    // 真到需要它而它已不在时，onReject 会给出 lost 并 warn
    if (buffer.length > this.#capacity) buffer.shift();
  }

  /** 缓冲里某 scope 当前的条数（测试用） */
  size(scope: SeqScope): number {
    return this.#buffers.get(scope ?? MACHINE_SCOPE_KEY)?.length ?? 0;
  }

  /** 收到 relay.reject */
  onReject(frame: RelayRejectFrame): RejectOutcome {
    const scope: SeqScope = frame.sessionId ?? null;
    const scopeKey = frame.sessionId ?? MACHINE_SCOPE_KEY;
    const streamLabel = frame.sessionId ?? '(machine)';

    if (frame.reason === 'seq_too_far_ahead') {
      // 本地领先服务端过多：跳号无解、重发必再拒（见文件头）
      return this.#giveUp(
        scopeKey,
        `本地出站 seq 领先服务端过多（seq_too_far_ahead）stream=${streamLabel} ` +
          `seq=${frame.seq} 服务端高水位=${frame.expectedAfter ?? '?'} ` +
          `recipient=${frame.recipientDeviceId ?? '?'}；该流后续事件将持续被拒。` +
          `恢复方法：停止 agent，删除 state.json 后重启（计数器归零，按服务端高水位自动对齐）`,
      );
    }
    if (frame.reason !== 'seq_not_monotonic') {
      // seq_below_first 发不出来（FIRST_SEQ=1 起分配）；parked_quota 是 c2a 的事
      return { kind: 'ignored', reason: `reason=${frame.reason}` };
    }

    const recipient = frame.recipientDeviceId ?? this.#soleRecipient();
    if (recipient === undefined) {
      return this.#giveUp(
        scopeKey,
        `relay.reject 未带 recipientDeviceId 且已配对设备不止一台，无从判断该补给谁 ` +
          `stream=${streamLabel} seq=${frame.seq}`,
      );
    }
    const expectedAfter = frame.expectedAfter;
    if (expectedAfter === undefined) {
      return this.#giveUp(
        scopeKey,
        `relay.reject 未带 expectedAfter（服务端版本过旧？），无法跳号自愈 ` +
          `stream=${streamLabel} seq=${frame.seq} recipient=${recipient}`,
      );
    }

    // 去重：同一 (scope, seq, recipient) 的 reject 只处理一次
    const dedupeKey = `${scopeKey}\u0000${frame.seq}\u0000${recipient}`;
    if (this.#seen.has(dedupeKey)) return { kind: 'duplicate' };
    this.#seen.add(dedupeKey);
    while (this.#seen.size > DEDUPE_CAPACITY) {
      const oldest = this.#seen.values().next();
      if (oldest.done === true) break;
      this.#seen.delete(oldest.value);
    }

    // 1. 计数器跳到高水位之后
    if (this.#emitter.peekSeq(scope) <= expectedAfter) {
      this.#emitter.setNext(scope, expectedAfter + 1);
    }

    // 2. 找出该收件人没收到的帧：发给它时的 seq 落在 [被拒 seq, 高水位] 内
    const buffer = this.#buffers.get(scopeKey) ?? [];
    const pending = buffer.filter((entry) => {
      const sent = entry.seqFor.get(recipient);
      return sent !== undefined && sent >= frame.seq && sent <= expectedAfter;
    });
    // 被拒的 seq 比缓冲里最旧一条**首发时**的 seq 还小 → 那一段已经滚出去了。
    // 用首发 seq 而不是 seqFor：给别的收件人重发过之后 seqFor 已经跳高，
    // 拿它比会把「同批 reject 的后到者」误判成丢失
    const oldestOrig = buffer[0]?.origSeq;
    const lostHead = oldestOrig === undefined || frame.seq < oldestOrig;
    if (lostHead) {
      this.#log(
        `[outbox] 被拒帧（部分）已滚出缓冲，无法重发 stream=${streamLabel} seq=${frame.seq} ` +
          `recipient=${recipient} 缓冲最旧=${oldestOrig ?? '(空)'}`,
      );
    }
    if (pending.length === 0) {
      if (lostHead) return { kind: 'lost', recipient };
      // 同批 reject 的后到者（更小 seq 的那条已把整段重发完）→ 不用重发，但留痕：
      // 静默是最难查的故障形态
      this.#log(
        `[outbox] reject stream=${streamLabel} seq=${frame.seq} recipient=${recipient} ` +
          `高水位=${expectedAfter}：对应帧已重发过，跳过`,
      );
      return { kind: 'ignored', reason: 'already_resent' };
    }

    // 3. 按序重新取 seq、只发给这个收件人
    const seqs: number[] = [];
    for (const entry of pending) {
      const attempts = (entry.attempts.get(recipient) ?? 0) + 1;
      if (attempts > this.#maxAttempts) {
        return this.#giveUp(
          scopeKey,
          `同一帧对 ${recipient} 重发 ${this.#maxAttempts} 次仍被拒，放弃本轮重发 ` +
            `stream=${streamLabel} type=${entry.event.type}`,
        );
      }
      entry.attempts.set(recipient, attempts);
      const seq = this.#emitter.peekSeq(scope);
      this.#emitter.setNext(scope, seq + 1);
      const resent = { ...entry.event, seq } as AgentToClientEvent;
      entry.seqFor.set(recipient, seq);
      this.#publishTo(recipient, resent, this.#pushHintFor(resent));
      seqs.push(seq);
    }
    this.#log(
      `[outbox] seq 失配自愈 stream=${streamLabel} recipient=${recipient} ` +
        `被拒 seq=${frame.seq} 高水位=${expectedAfter} 重发 ${seqs.length} 帧 ` +
        `→ ${seqs[0]}..${seqs[seqs.length - 1]}`,
    );
    return { kind: 'resent', recipient, count: seqs.length, seqs, lostHead };
  }

  /** 名册只有一台设备时，缺收件人的 reject 也能确定是它 */
  #soleRecipient(): string | undefined {
    const ids = this.#recipientIds();
    return ids.length === 1 ? ids[0] : undefined;
  }

  /**
   * 放弃该 scope 本轮重发：清缓冲（避免下一条 reject 再触发同一批）、告知用户。
   * error.fatal 走 emitter 正常出站（会被 remember + publish），机器级。
   */
  #giveUp(scopeKey: string, detail: string): RejectOutcome {
    this.#log(`[outbox] 放弃自愈：${detail}`);
    this.#buffers.delete(scopeKey);
    // 同一 scope 只报一次：fatal 本身也走出站，机器级流若正处于放弃状态会被
    // 再拒、再放弃……（见文件头）；只 log 不再发帧
    if (!this.#gaveUp.has(scopeKey)) {
      this.#gaveUp.add(scopeKey);
      this.#emitter.emit(
        {
          type: 'error.fatal',
          kind: 'other',
          message: `出站序号自愈失败，部分事件可能未送达：${detail}`.slice(0, 300),
        },
        null,
      );
    }
    return { kind: 'gave_up', reason: detail };
  }
}

/** 协议决策 6：脱敏推送提示——只按事件类型给，不带任何正文 */
export function pushHintFor(event: AgentToClientEvent): PushHint | undefined {
  switch (event.type) {
    case 'permission.request':
      // 按工具分流：提问 / 计划各有推送文案（只看 toolName，不带任何正文）。
      // 注意部署顺序：旧 server 不认识这两个 hint 会整帧拒收（core PushHint 注释）
      switch (waitingForTool(event.toolName)) {
        case 'question':
          return 'question_pending';
        case 'plan':
          return 'plan_pending';
        default:
          return 'permission_pending';
      }
    case 'run.done':
      return 'run_done';
    case 'error.fatal':
      return 'run_error';
    default:
      return undefined;
  }
}

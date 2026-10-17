/**
 * 出站（方案 §4.4）：seq 分配 + 每 scope 环形缓冲 + reject 自愈 + 待发队列。
 * 照 client-demo / agent outbox 的机制，按 web 的需要收窄：c2a 只有一个
 * 收件人（agent），不需要按收件人记 seq。
 *
 * ## 自愈：只覆盖 `seq_not_monotonic`
 *
 * 本地 outSeq 落后于服务端高水位（多设备并发 c2a、或落盘丢了几笔）时，
 * 服务端回 `relay.reject{seq_not_monotonic, expectedAfter}`：把计数器跳到
 * `expectedAfter + 1`，缓冲里 seq ∈ [被拒, expectedAfter] 的帧按序重新取 seq
 * 重发。同一帧重发 ≤3 次仍被拒 → 放弃并回调（UI 报错）。
 *
 * `seq_too_far_ahead` 是本地**领先**服务端过多（> 1e6），跳号往前无解、
 * 重发必再拒——不自愈，标记该 scope fatal，UI 给「重置该会话计数器」
 * （outSeq 置 0，下一帧撞 not_monotonic 后按高水位对齐）。服务端产生该
 * 原因时 `expectedAfter < seq` 恒成立（learnings 2026-09-13）。
 *
 * `parked_quota_exceeded`：机器离线排队满，对应本地条目直接 failed。
 *
 * ## 待发队列
 *
 * 连接不在时 `send()` 仍分配 seq、仍入缓冲，帧放进内存队列，onOpen 后
 * 按序发出。刷新即丢——加载时 sending 条目一律 failed（reducer）。
 */
import { sealJson } from '@trine/core/crypto';
import type { ClientToAgentEvent, TransportFrame } from '@trine/core';

export type RelayRejectFrame = Extract<TransportFrame, { type: 'relay.reject' }>;
export type RelayFrame = Extract<TransportFrame, { type: 'relay' }>;

/** 分配式 Omit：对判别联合逐成员 Omit */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** 调用方给的事件体：ts / seq / dir 由 outbox 补 */
export type OutboundBody = DistributiveOmit<ClientToAgentEvent, 'ts' | 'seq' | 'dir'>;

export const OUTBOX_CAPACITY = 64;
export const OUTBOX_MAX_ATTEMPTS = 3;
const DEDUPE_CAPACITY = 1024;

export interface OutboxOptions {
  seq: {
    /** 该 scope 最后已用 seq（0 = 从未用过） */
    get(machineId: string, scope: string): number;
    /** 设置最后已用 seq（调用方负责落盘取 max） */
    set(machineId: string, scope: string, last: number): void;
  };
  /** 该机器的 agent 公钥（未配对 → undefined，send 抛错） */
  agentKeyFor: (machineId: string) => string | undefined;
  boxSecretKey: string;
  /** 往连接上写帧；连接不在返回 false → 入队 */
  transmit: (frame: TransportFrame) => boolean;
  now: () => number;
  /**
   * 自愈放弃（≤3 次仍被拒 / 缺 expectedAfter）。`clientMsgIds` = 被放弃的缓冲里
   * 全部 input.send 的 clientMsgId——调用方据此把仍为 sending 的本地条目转 failed，
   * 否则它们永远转圈、用户无法重发（评审阶段 1 B3）
   */
  onGaveUp?: (machineId: string, scope: string, detail: string, clientMsgIds: string[]) => void;
  /** seq_too_far_ahead：该 scope 需人工重置计数器；clientMsgIds 语义同上 */
  onScopeFatal?: (machineId: string, scope: string, detail: string, clientMsgIds: string[]) => void;
  /** 某条 input.send 被服务端拒收（parked_quota_exceeded） */
  onInputRejected?: (machineId: string, sessionId: string, clientMsgId: string, reason: string) => void;
  capacity?: number;
  maxAttempts?: number;
  log?: (line: string) => void;
}

/** 对已标 fatal 的 scope 调 send()：不再往服务端发（必被拒），调用方把条目标 failed */
export class OutboxScopeFatalError extends Error {
  constructor(
    readonly machineId: string,
    readonly scope: string,
  ) {
    super(`该会话的出站计数器已失效（seq_too_far_ahead），需先重置计数器再发送`);
    this.name = 'OutboxScopeFatalError';
  }
}

export type RejectOutcome =
  | { kind: 'ignored'; reason: string }
  | { kind: 'duplicate' }
  | { kind: 'resent'; count: number; seqs: number[] }
  | { kind: 'lost' }
  | { kind: 'gave_up'; reason: string }
  | { kind: 'fatal'; reason: string }
  | { kind: 'input_failed'; clientMsgId: string };

interface Entry {
  event: ClientToAgentEvent;
  /** 首次发出时的 seq：只用来判断被拒的帧是否已滚出缓冲（重发后 event.seq 会跳高） */
  origSeq: number;
  attempts: number;
}

export interface QueuedFrame {
  machineId: string;
  event: ClientToAgentEvent;
}

function key(machineId: string, scope: string): string {
  return `${machineId}|${scope}`;
}

export class Outbox {
  readonly #buffers = new Map<string, Entry[]>();
  readonly #queue: QueuedFrame[] = [];
  readonly #seen = new Set<string>();
  readonly #fatalScopes = new Set<string>();
  readonly #capacity: number;
  readonly #maxAttempts: number;
  readonly #log: (line: string) => void;

  constructor(private readonly options: OutboxOptions) {
    this.#capacity = options.capacity ?? OUTBOX_CAPACITY;
    this.#maxAttempts = options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
    this.#log = options.log ?? (() => {});
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  size(machineId: string, scope: string): number {
    return this.#buffers.get(key(machineId, scope))?.length ?? 0;
  }

  isScopeFatal(machineId: string, scope: string): boolean {
    return this.#fatalScopes.has(key(machineId, scope));
  }

  /** 补 {ts, seq, dir} → 缓冲 → seal → 发出（或入队）；返回带 seq 的事件 */
  send(machineId: string, body: OutboundBody): ClientToAgentEvent {
    const scope = body.sessionId ?? '';
    if (this.#fatalScopes.has(key(machineId, scope))) throw new OutboxScopeFatalError(machineId, scope);
    const event = {
      ...body,
      ts: this.options.now(),
      seq: this.#takeSeq(machineId, scope),
      dir: 'c2a',
    } as ClientToAgentEvent;
    const k = key(machineId, scope);
    let buffer = this.#buffers.get(k);
    if (buffer === undefined) {
      buffer = [];
      this.#buffers.set(k, buffer);
    }
    buffer.push({ event, origSeq: event.seq, attempts: 0 });
    if (buffer.length > this.#capacity) buffer.shift();
    this.#transmitOrQueue(machineId, event);
    return event;
  }

  /** 连接 open 后：把待发队列按序发出 */
  flush(): void {
    while (this.#queue.length > 0) {
      const item = this.#queue[0]!;
      if (!this.options.transmit(this.#frameFor(item.machineId, item.event))) return;
      this.#queue.shift();
    }
  }

  /** 丢掉待发队列（返回被丢条目，调用方据此把本地条目标 failed） */
  dropQueue(): QueuedFrame[] {
    return this.#queue.splice(0, this.#queue.length);
  }

  /**
   * 会话被永久删除：丢掉该 scope 的待发帧与重发缓冲（session-list-v2 §4.1，评审 B4）。
   *
   * **不动 outSeq 计数器**：服务端的 stream_hwm 仍在（D10），计数器归零反而会让
   * 万一再用到这个 scope 时撞 not_monotonic；与 agent 侧「不 dropScope」同取向。
   * 返回被丢的待发帧（调用方据此刷新排队计数）。
   */
  dropScope(machineId: string, scope: string): QueuedFrame[] {
    const k = key(machineId, scope);
    this.#buffers.delete(k);
    this.#fatalScopes.delete(k);
    const dropped: QueuedFrame[] = [];
    for (let i = this.#queue.length - 1; i >= 0; i--) {
      const item = this.#queue[i]!;
      if (item.machineId === machineId && (item.event.sessionId ?? '') === scope) {
        dropped.unshift(item);
        this.#queue.splice(i, 1);
      }
    }
    return dropped;
  }

  /** 缓冲里某 (scope, seq) 对应的 input.send 的 clientMsgId（input.parked 关联用） */
  clientMsgIdForSeq(machineId: string, sessionId: string, seq: number): string | undefined {
    const entry = this.#buffers.get(key(machineId, sessionId))?.find((e) => e.event.seq === seq);
    return entry?.event.type === 'input.send' ? entry.event.clientMsgId : undefined;
  }

  /** seq_too_far_ahead 的恢复：计数器归零，靠下一次 not_monotonic 对齐 */
  resetScope(machineId: string, scope: string): void {
    const k = key(machineId, scope);
    this.options.seq.set(machineId, scope, 0);
    this.#fatalScopes.delete(k);
    this.#buffers.delete(k);
    // seq 从 1 重来，reject 去重键 `${k}#${seq}` 必然复用——不清的话重置后的
    // 第一条 not_monotonic 会被判 duplicate 静默吞掉（评审阶段 1 B4）
    for (const seen of [...this.#seen]) {
      if (seen.startsWith(`${k}#`)) this.#seen.delete(seen);
    }
  }

  onReject(frame: RelayRejectFrame): RejectOutcome {
    const scope = frame.sessionId ?? '';
    const k = key(frame.machineId, scope);
    const label = frame.sessionId ?? '(machine)';

    if (frame.reason === 'parked_quota_exceeded') {
      const clientMsgId =
        frame.sessionId === undefined ? undefined : this.clientMsgIdForSeq(frame.machineId, frame.sessionId, frame.seq);
      if (clientMsgId !== undefined && frame.sessionId !== undefined) {
        // 从缓冲移除：否则后续 not_monotonic 的区间重发会把用户已看到「失败」的消息再投一遍
        const buffer = this.#buffers.get(k);
        if (buffer) this.#buffers.set(k, buffer.filter((e) => e.event.seq !== frame.seq));
        this.options.onInputRejected?.(frame.machineId, frame.sessionId, clientMsgId, frame.reason);
        return { kind: 'input_failed', clientMsgId };
      }
      return { kind: 'ignored', reason: 'parked_quota_exceeded (非 input.send 或已滚出缓冲)' };
    }
    if (frame.reason === 'seq_too_far_ahead') {
      const detail =
        `本地出站 seq 领先服务端过多 ${label}#${frame.seq}（服务端高水位 ${frame.expectedAfter ?? '?'}）；` +
        '该流后续消息会持续被拒，需重置该会话的出站计数器';
      if (!this.#fatalScopes.has(k)) {
        this.#fatalScopes.add(k);
        this.#log(`[outbox] ${detail}`);
        // 缓冲里的帧重发也必被拒：清掉并把受影响的 input.send 交给调用方标 failed
        const ids = this.#inputIdsOf(k);
        this.#buffers.delete(k);
        this.options.onScopeFatal?.(frame.machineId, scope, detail, ids);
      }
      return { kind: 'fatal', reason: detail };
    }
    if (frame.reason !== 'seq_not_monotonic') {
      return { kind: 'ignored', reason: `reason=${frame.reason}` };
    }

    const dedupeKey = `${k}#${frame.seq}`;
    if (this.#seen.has(dedupeKey)) return { kind: 'duplicate' };
    this.#seen.add(dedupeKey);
    while (this.#seen.size > DEDUPE_CAPACITY) {
      const oldest = this.#seen.values().next();
      if (oldest.done === true) break;
      this.#seen.delete(oldest.value);
    }

    const expectedAfter = frame.expectedAfter;
    if (expectedAfter === undefined) {
      return this.#giveUp(
        frame.machineId,
        scope,
        `帧被拒（${frame.reason}）且服务端未给 expectedAfter，无法自愈 ${label}#${frame.seq}`,
      );
    }

    // 1. 计数器跳到高水位之后
    if (this.options.seq.get(frame.machineId, scope) < expectedAfter) {
      this.options.seq.set(frame.machineId, scope, expectedAfter);
    }
    // 2. 找出服务端没收下的帧：seq ∈ [被拒, 高水位]
    const buffer = this.#buffers.get(k) ?? [];
    const pending = buffer.filter((e) => e.event.seq >= frame.seq && e.event.seq <= expectedAfter);
    if (pending.length === 0) {
      // 比的是**首发** seq：同批 reject 的后到者对应的帧已被更小 seq 那条重发过、
      // event.seq 已跳高，拿它比会把「已重发」误判成「已滚出」
      const oldest = buffer[0]?.origSeq;
      if (oldest === undefined || frame.seq < oldest) {
        this.#log(`[outbox] 被拒帧已滚出缓冲，无法重发 ${label}#${frame.seq}`);
        return { kind: 'lost' };
      }
      return { kind: 'ignored', reason: 'already_resent' };
    }
    // 3. 按序重新取 seq、重发
    const seqs: number[] = [];
    for (const entry of pending) {
      entry.attempts++;
      if (entry.attempts > this.#maxAttempts) {
        return this.#giveUp(
          frame.machineId,
          scope,
          `同一帧重发 ${this.#maxAttempts} 次仍被拒，放弃 ${label} type=${entry.event.type}`,
        );
      }
      const seq = this.#takeSeq(frame.machineId, scope);
      entry.event = { ...entry.event, seq } as ClientToAgentEvent;
      this.#transmitOrQueue(frame.machineId, entry.event);
      seqs.push(seq);
    }
    this.#log(
      `[outbox] seq 失配自愈 ${label}：被拒 #${frame.seq}，高水位 ${expectedAfter}，重发 ${seqs.length} 帧 → ${seqs[0]}..${seqs[seqs.length - 1]}`,
    );
    return { kind: 'resent', count: seqs.length, seqs };
  }

  // ---- 内部 ----

  #takeSeq(machineId: string, scope: string): number {
    const seq = this.options.seq.get(machineId, scope) + 1;
    this.options.seq.set(machineId, scope, seq);
    return seq;
  }

  #frameFor(machineId: string, event: ClientToAgentEvent): RelayFrame {
    const agentKey = this.options.agentKeyFor(machineId);
    if (agentKey === undefined) throw new Error(`机器 ${machineId} 未配对，无法加密`);
    const box = sealJson(event, agentKey, this.options.boxSecretKey);
    return {
      type: 'relay',
      machineId,
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      seq: event.seq,
      nonce: box.nonce,
      ciphertext: box.ciphertext,
    };
  }

  #transmitOrQueue(machineId: string, event: ClientToAgentEvent): void {
    // 队列非空时新帧必须排在后面，否则乱序
    if (this.#queue.length > 0 || !this.options.transmit(this.#frameFor(machineId, event))) {
      this.#queue.push({ machineId, event });
    }
  }

  #giveUp(machineId: string, scope: string, detail: string): RejectOutcome {
    this.#log(`[outbox] 放弃自愈：${detail}`);
    const k = key(machineId, scope);
    const ids = this.#inputIdsOf(k);
    this.#buffers.delete(k);
    this.options.onGaveUp?.(machineId, scope, detail, ids);
    return { kind: 'gave_up', reason: detail };
  }

  /** 某 scope 缓冲里全部 input.send 的 clientMsgId */
  #inputIdsOf(k: string): string[] {
    const ids: string[] = [];
    for (const e of this.#buffers.get(k) ?? []) {
      if (e.event.type === 'input.send') ids.push(e.event.clientMsgId);
    }
    return ids;
  }
}

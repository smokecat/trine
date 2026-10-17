/**
 * 事件发送层：给 translate 产出的「事件体」补上信封字段，分配 seq。
 *
 * 决策 1（主会话拍板）：seq 归发送方单点管辖。
 * - 每个 sessionId 一条独立的单调递增序列；
 * - 机器级帧（sessionId 省略的 machine.info / cwd.*）共用另一条独立序列，
 *   与 core/protocol/transport.ts 里 `sync.request` 省略 sessionId 时
 *   「补发机器级帧」的语义对齐——两边都必须把机器级当独立序列看。
 *
 * 这里刻意**不做**加密与网络发送：那是 WS 层的事（本任务 out of scope）。
 * 本层的产出是明文完整事件 + scope，交给注入的 sink。
 */
import type { AgentToClientEvent } from '@trine/core';
import type { EventBody, EventSink, OutboundEvent, SeqScope } from './types.ts';

/** 机器级序列在 seq 表里的键（sessionId 不可能为空串，不会撞） */
const MACHINE_SCOPE_KEY = '';

/**
 * 每条流的首个 seq。
 *
 * **必须从 1 起，0 是保留值**：`sync.request` 的 `sinceSeq: 0` 表示「一帧都没收到，
 * 请从头补发」。若发送方也从 0 开始分配，那第 0 帧就永远落在「已收到」的语义之外，
 * 断线补发会漏掉它；服务端因此直接拒收 seq=0 的 relay 帧。
 *
 * TODO(合入 main 后)：改用 packages/core 的 `FIRST_SEQ` 常量——该常量目前在
 * server-relay 分支上，本分支还看不到，两分支合并后统一切过去。
 */
const FIRST_SEQ = 1;

export interface EmitterOptions {
  /** 事件出口 */
  sink: EventSink;
  /** 时钟注入，测试用 */
  now?: () => number;
}

/**
 * 信封装配器：把事件体变成可发送的 `AgentToClientEvent`。
 *
 * 单实例服务整个 agent 进程（所有会话 + 机器级），因为 seq 序列表就住在这里。
 */
export class EventEmitter {
  readonly #sink: EventSink;
  readonly #now: () => number;
  /** scope key → 下一个待分配的 seq */
  readonly #nextSeq = new Map<string, number>();

  constructor(options: EmitterOptions) {
    this.#sink = options.sink;
    this.#now = options.now ?? (() => Date.now());
  }

  /** 取 scope 的下一个 seq 并推进游标（首个为 FIRST_SEQ，见其注释） */
  #takeSeq(scope: SeqScope): number {
    const key = scope ?? MACHINE_SCOPE_KEY;
    const seq = this.#nextSeq.get(key) ?? FIRST_SEQ;
    this.#nextSeq.set(key, seq + 1);
    return seq;
  }

  /**
   * 发送一个事件体。
   *
   * @param body translate 层产出的事件体（不含信封字段）
   * @param scope 会话级传 sessionId；机器级传 null（帧上 sessionId 省略）
   * @param options.to 定向收件人（见 OutboundEvent.to）；省略 = 全员
   */
  emit(body: EventBody, scope: SeqScope, options: { to?: string } = {}): OutboundEvent {
    const seq = this.#takeSeq(scope);
    // 会话级帧带 sessionId，机器级帧必须**省略**该键（而非置 undefined 后仍存在），
    // 否则 assertEnvelopeBinding 与信封的「都省略」比对虽仍成立，
    // 但 JSON 序列化后的帧形状与 schema 的 optional 语义更清晰。
    const envelope =
      scope === null
        ? { ts: this.#now(), seq, dir: 'a2c' as const }
        : { ts: this.#now(), seq, dir: 'a2c' as const, sessionId: scope };

    const event = { ...body, ...envelope } as AgentToClientEvent;
    const out: OutboundEvent =
      options.to === undefined ? { event, scope } : { event, scope, to: options.to };
    this.#sink(out);
    return out;
  }

  /** 当前 scope 下一个将分配的 seq（测试/断线补发游标用；未发过即 FIRST_SEQ） */
  peekSeq(scope: SeqScope): number {
    return this.#nextSeq.get(scope ?? MACHINE_SCOPE_KEY) ?? FIRST_SEQ;
  }

  /**
   * 把某 scope 的下一个 seq 直接设到指定值。
   *
   * 给 relay.reject 自愈用：服务端回执 `expectedAfter`（该流高水位）时，
   * 发送方把计数器跳到 `expectedAfter + 1`，后续帧就不会再撞。**只允许往前跳**
   * ——往回设会让之后的帧重演 seq_not_monotonic；小于当前值的调用静默忽略，
   * 返回是否真的改了。
   */
  setNext(scope: SeqScope, seq: number): boolean {
    const key = scope ?? MACHINE_SCOPE_KEY;
    const current = this.#nextSeq.get(key) ?? FIRST_SEQ;
    if (!Number.isInteger(seq) || seq <= current) return false;
    this.#nextSeq.set(key, seq);
    return true;
  }

  /**
   * 全部序列的快照：`{ scopeKey: nextSeq }`，机器级的 key 是空串。
   *
   * 供接线层持久化。这是「下一个待分配」而非「最后已用」——两者差 1，
   * 持久化层原样存、原样 restore 即可，不要自己加减。
   */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.#nextSeq);
  }

  /**
   * 从快照恢复序列起点（进程启动时调，此时还没发过任何帧）。
   *
   * 只进不退（对已有 key 取 MAX）；非法值跳过。恢复的起点**不必精确**：
   * 起点偏低会被服务端 reject 后走 setNext 自愈，偏高只是子流跳号，协议允许。
   * 所以调用方可以在恢复值上加一截余量，少一次 reject 往返。
   */
  restore(snapshot: Record<string, number>): void {
    for (const [key, seq] of Object.entries(snapshot)) {
      if (!Number.isInteger(seq) || seq < FIRST_SEQ) continue;
      const current = this.#nextSeq.get(key);
      if (current === undefined || seq > current) this.#nextSeq.set(key, seq);
    }
  }

  /**
   * 丢弃某会话的 seq 序列（会话彻底结束、不再有帧时）。
   * 注意：会话仍可能被 resume——resume 会复用同一 sessionId，届时 seq 从 0 重来
   * 会破坏 client 的单调校验。所以**只在会话被删除时**调用，
   * 空闲回收（会话仍可 resume）绝不能调。
   */
  dropScope(scope: SeqScope): void {
    this.#nextSeq.delete(scope ?? MACHINE_SCOPE_KEY);
  }
}

/** 绑定到固定 scope 的发送口，交给单个会话用，免得每次传 sessionId */
export interface ScopedEmitter {
  emit(body: EventBody): OutboundEvent;
}

export function scopedEmitter(emitter: EventEmitter, scope: SeqScope): ScopedEmitter {
  return { emit: (body) => emitter.emit(body, scope) };
}

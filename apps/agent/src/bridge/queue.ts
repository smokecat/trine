/**
 * 同会话消息排队 + clientMsgId 幂等去重。
 *
 * ## 为什么排队而不是拒绝
 *
 * 借鉴 feishu-claude-code 最被用户认可的一条：任务运行中来了新消息，
 * **入队并立即回执**（`input.queued`），绝不静默丢弃、绝不打断当前任务。
 * 「禁止发送」的体验差得多——人在手机上想到什么就想发出去，
 * 让他等任务跑完再手动重发是最容易丢想法的设计。
 *
 * ## 为什么必须去重
 *
 * 三段 WS（client ↔ server ↔ agent）任一段重连都会复推，上游重复投递是必然事件
 * 而非异常。clientMsgId 是发起端生成的幂等键：已见过的直接忽略，
 * 但**仍回一次 input.queued 回执**——因为重复投递往往正是因为发起端没收到回执。
 *
 * 去重表用有界 LRU：会话可能很长，无界 Set 是内存泄漏。
 */
import type { UserContent } from './attachments.ts';

/** 队列里的一条待处理消息 */
export interface QueuedInput {
  clientMsgId: string;
  text: string;
  /** 交给 SDK 的内容（带附件时是内容块数组）；省略 = 就是 text */
  content?: UserContent;
  /** 入队时刻 */
  queuedAt: number;
}

/** 入队结果：告诉会话层该发什么回执 */
export type EnqueueResult =
  /** 新消息，已入队；会话空闲时 shouldRunNow 为 true */
  | { accepted: true; duplicate: false; shouldRunNow: boolean }
  /** 重复的 clientMsgId：不重复执行，但仍要回执 */
  | { accepted: false; duplicate: true };

export interface InputQueueOptions {
  /** 去重表容量上限（条），超出按插入序淘汰最旧的 */
  dedupeCapacity?: number;
  now?: () => number;
}

const DEFAULT_DEDUPE_CAPACITY = 500;

/**
 * 单会话的输入队列。
 *
 * 状态机很小：`running` 标志 + 一条 FIFO。会话层在 run 结束时调 `takeNext()`
 * 决定是否继续跑下一条。
 */
export class InputQueue {
  readonly #items: QueuedInput[] = [];
  /** 已见过的 clientMsgId，插入序即淘汰序（Map 保序） */
  readonly #seen = new Map<string, true>();
  readonly #capacity: number;
  readonly #now: () => number;
  #running = false;

  constructor(options: InputQueueOptions = {}) {
    this.#capacity = options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY;
    this.#now = options.now ?? (() => Date.now());
  }

  /** 会话是否正在跑（跑着就只排队不立即执行） */
  get running(): boolean {
    return this.#running;
  }

  /** 队列长度 */
  get length(): number {
    return this.#items.length;
  }

  /** 队列快照（状态查询用） */
  get items(): readonly QueuedInput[] {
    return this.#items;
  }

  /** 标记 run 开始/结束，由会话层驱动 */
  setRunning(running: boolean): void {
    this.#running = running;
  }

  /**
   * 收到 `input.send`。
   *
   * @returns 见 EnqueueResult：重复消息不入队，但调用方仍应回 `input.queued`
   */
  enqueue(clientMsgId: string, text: string, content?: UserContent): EnqueueResult {
    if (this.#seen.has(clientMsgId)) {
      return { accepted: false, duplicate: true };
    }
    this.#remember(clientMsgId);
    this.#items.push({ clientMsgId, text, ...(content === undefined ? {} : { content }), queuedAt: this.#now() });
    return { accepted: true, duplicate: false, shouldRunNow: !this.#running };
  }

  /**
   * 取出队首待执行的消息；队列空返回 undefined。
   */
  takeNext(): QueuedInput | undefined {
    return this.#items.shift();
  }

  /**
   * 撤回一条尚未执行的排队消息（协议 `input.recall`）。
   *
   * @returns 是否真的撤回了（false = 已经开始执行或根本不存在，调用方据此决定
   *   要不要告诉用户「来不及了」）
   */
  recall(clientMsgId: string): boolean {
    const index = this.#items.findIndex((item) => item.clientMsgId === clientMsgId);
    if (index === -1) return false;
    this.#items.splice(index, 1);
    // 注意：**不**从去重表里删。撤回后又收到同 id 的重复投递（上游重推），
    // 不该因为撤回过就重新执行一遍。
    return true;
  }

  /** 清空队列（会话关闭），返回被丢弃的条目供上层告知用户 */
  clear(): QueuedInput[] {
    return this.#items.splice(0, this.#items.length);
  }

  #remember(clientMsgId: string): void {
    this.#seen.set(clientMsgId, true);
    while (this.#seen.size > this.#capacity) {
      const oldest = this.#seen.keys().next();
      if (oldest.done === true) break;
      this.#seen.delete(oldest.value);
    }
  }
}

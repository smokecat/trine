/**
 * 单主标签选举（方案 §4.0，评审 A1）。
 *
 * ## 为什么必须只有一个标签页连服务端
 *
 * 服务端允许同 deviceId 多条连接并向每条投递，reject 只回肇事连接。两个
 * 标签页共用一份 identity 却各持一份内存 outSeq：B 每发一条都撞一次
 * seq_not_monotonic；inCursors 的 last-writer-wins 落盘会让游标倒退、补发
 * 帧被重复应用。与其在每处读写上加锁，不如整个进程只让一个标签页
 * （主标签）建 WS、持有 outbox 与游标写权。
 *
 * ## 机制
 *
 * - 有 `navigator.locks`：`request('trine:leader', exclusive)`——拿到锁的是主，
 *   回调返回的 Promise 一直挂着直到主动释放；其余标签页排队等锁，同时显示
 *   「已在另一标签页运行」。
 * - 「在此接管」：本页广播 `release`，主页收到后释放锁（回调 resolve），
 *   排队中的请求随即拿到锁成为新主。多个从页时谁先排队谁先得（Web Locks
 *   FIFO），MVP 接受。
 * - 无 Web Locks（老浏览器）：退化为广播心跳选举——主每秒广播心跳，从页
 *   3s 没听到心跳就自任为主；两个主相遇（几乎同时自任）按 instanceId 字典序
 *   小者留任。
 *
 * 状态变化通过 `onChange` 通知（只在实际切换时触发）。
 */
import type { ChannelAdapter, Clock, LockAdapter } from './adapters.ts';

export type LeaderState = 'idle' | 'leader' | 'follower';

export interface LeaderSnapshot {
  state: LeaderState;
  instanceId: string;
  /** 用的是真锁还是退化选举 */
  mode: 'locks' | 'heartbeat';
}

export interface LeaderOptions {
  locks: LockAdapter;
  channel: ChannelAdapter;
  clock: Clock;
  onChange: (snapshot: LeaderSnapshot) => void;
  /** 本标签页的实例 id（默认随机） */
  instanceId?: string;
  lockName?: string;
  heartbeatMs?: number;
  claimAfterMs?: number;
  log?: (line: string) => void;
}

type Message =
  | { t: 'trine.leader'; kind: 'release'; from: string }
  | { t: 'trine.leader'; kind: 'heartbeat'; from: string };

function isMessage(m: unknown): m is Message {
  return typeof m === 'object' && m !== null && (m as { t?: unknown }).t === 'trine.leader';
}

export const DEFAULT_LOCK_NAME = 'trine:leader';

export class LeaderElector {
  readonly instanceId: string;
  readonly mode: 'locks' | 'heartbeat';
  #state: LeaderState = 'idle';
  #stopped = false;
  #unsubscribe: (() => void) | null = null;
  /** 锁模式：持有中的锁靠这个 resolve 释放 */
  #releaseLock: (() => void) | null = null;
  #abort: AbortController | null = null;
  /** 心跳模式 */
  #heartbeatTimer: unknown = null;
  #claimTimer: unknown = null;
  readonly #heartbeatMs: number;
  readonly #claimAfterMs: number;
  readonly #lockName: string;
  readonly #log: (line: string) => void;

  constructor(private readonly options: LeaderOptions) {
    this.instanceId = options.instanceId ?? Math.random().toString(36).slice(2, 10);
    this.mode = options.locks.available ? 'locks' : 'heartbeat';
    this.#heartbeatMs = options.heartbeatMs ?? 1_000;
    this.#claimAfterMs = options.claimAfterMs ?? 3_000;
    this.#lockName = options.lockName ?? DEFAULT_LOCK_NAME;
    this.#log = options.log ?? (() => {});
  }

  get state(): LeaderState {
    return this.#state;
  }

  snapshot(): LeaderSnapshot {
    return { state: this.#state, instanceId: this.instanceId, mode: this.mode };
  }

  start(): void {
    if (this.#unsubscribe !== null) return;
    this.#stopped = false;
    this.#unsubscribe = this.options.channel.subscribe((m) => this.#onMessage(m));
    if (this.mode === 'locks') void this.#acquire(true);
    else this.#startHeartbeatElection();
  }

  /** 本页要成为主：让现任主释放 */
  takeOver(): void {
    if (this.#state === 'leader') return;
    this.options.channel.post({ t: 'trine.leader', kind: 'release', from: this.instanceId } satisfies Message);
    if (this.mode === 'heartbeat') this.#becomeLeader();
    // 锁模式下本页早已在排队，主释放后自然轮到
  }

  stop(): void {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#abort?.abort();
    this.#abort = null;
    this.#releaseLock?.();
    this.#releaseLock = null;
    this.#clearTimers();
    this.#setState('idle');
  }

  // ---- 锁模式 ----

  async #acquire(firstTry: boolean): Promise<void> {
    if (this.#stopped) return;
    if (firstTry) {
      // 先 ifAvailable 探一下：拿不到立刻知道自己是从页，不用等
      let granted = false;
      await this.options.locks.request(this.#lockName, { ifAvailable: true }, async (ok) => {
        granted = ok;
        if (ok) await this.#hold();
      });
      if (this.#stopped) return;
      // 曾持锁而现在回到这里 = 已让位（takeOver）→ 重新排队；没拿到 → 从页，排队等
      if (granted) return this.#acquire(false);
    }
    if (this.#stopped) return;
    this.#setState('follower');
    this.#abort = new AbortController();
    try {
      await this.options.locks.request(this.#lockName, { signal: this.#abort.signal }, async (ok) => {
        if (ok) await this.#hold();
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') this.#log(`[leader] 锁请求失败：${String(err)}`);
      return;
    }
    // 锁被释放（takeOver 让位 / stop）：若未停止则重新排队
    if (!this.#stopped) void this.#acquire(false);
  }

  /** 持锁：resolve 即释放 */
  #hold(): Promise<void> {
    this.#setState('leader');
    return new Promise<void>((resolve) => {
      this.#releaseLock = () => {
        this.#releaseLock = null;
        resolve();
      };
    });
  }

  // ---- 心跳模式 ----

  #startHeartbeatElection(): void {
    this.#setState('follower');
    this.#armClaim();
  }

  #armClaim(): void {
    if (this.#claimTimer !== null) this.options.clock.clearTimeout(this.#claimTimer);
    this.#claimTimer = this.options.clock.setTimeout(() => {
      this.#claimTimer = null;
      if (!this.#stopped && this.#state !== 'leader') this.#becomeLeader();
    }, this.#claimAfterMs);
  }

  #becomeLeader(): void {
    if (this.#claimTimer !== null) {
      this.options.clock.clearTimeout(this.#claimTimer);
      this.#claimTimer = null;
    }
    this.#setState('leader');
    this.#beat();
  }

  #beat(): void {
    if (this.#stopped || this.#state !== 'leader') return;
    this.options.channel.post({ t: 'trine.leader', kind: 'heartbeat', from: this.instanceId } satisfies Message);
    this.#heartbeatTimer = this.options.clock.setTimeout(() => this.#beat(), this.#heartbeatMs);
  }

  #yield(): void {
    if (this.#heartbeatTimer !== null) {
      this.options.clock.clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#setState('follower');
    this.#armClaim();
  }

  #clearTimers(): void {
    if (this.#heartbeatTimer !== null) this.options.clock.clearTimeout(this.#heartbeatTimer);
    if (this.#claimTimer !== null) this.options.clock.clearTimeout(this.#claimTimer);
    this.#heartbeatTimer = null;
    this.#claimTimer = null;
  }

  // ---- 消息 ----

  #onMessage(raw: unknown): void {
    if (!isMessage(raw) || raw.from === this.instanceId || this.#stopped) return;
    if (raw.kind === 'release') {
      if (this.#state !== 'leader') return;
      this.#log(`[leader] 收到接管请求（${raw.from}），让位`);
      if (this.mode === 'locks') this.#releaseLock?.();
      else this.#yield();
      return;
    }
    // heartbeat（只在退化模式有意义；锁模式下不会有人发）
    if (this.mode !== 'heartbeat') return;
    if (this.#state === 'leader') {
      // 两个主相遇：instanceId 小者留任
      if (raw.from < this.instanceId) this.#yield();
      return;
    }
    this.#armClaim();
  }

  #setState(state: LeaderState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.options.onChange(this.snapshot());
  }
}

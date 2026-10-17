/**
 * agent 离线排队队列（决策点 1：排队 + 可撤回 + 默认 24h TTL）。
 *
 * ## 终态防覆盖
 *
 * parked 帧的状态机只允许**单向**迁移：
 *
 *   pending ──┬─→ delivered   （agent 上线，帧已投出）
 *             ├─→ recalled    （client park.recall 撤回）
 *             └─→ expired     （超过 TTL）
 *
 * delivered / recalled / expired 三者都是**终态**，任何后到的更新都不得把
 * 它们改回 pending 或改成另一个终态。这不是洁癖——三条真实竞态都会撞上：
 *
 * 1. agent 上线投递（→ delivered）与 sweep 扫到 TTL 边界（→ expired）
 *    几乎同时发生：已经投出去的帧不能再对 client 谎报"已过期"；
 * 2. client 的 park.recall 与 agent 上线投递赛跑：先到者定终态，
 *    后到者必须无操作（recall 的幂等语义正是 transport.ts 写明的）；
 * 3. 重复的 park.recall（client 重连后重发）不能把 delivered 改成 recalled。
 *
 * 实现手法：所有迁移都用 `WHERE state = 'pending'` 的条件更新，
 * 靠 SQL 的 changes 判断本次是否真的拿到了这次迁移，而不是先读后写
 * （先读后写在两个请求间留了窗口）。
 */
import type { ParkedRow, ParkedState, Store } from './index.ts';

/** 终态集合：进去就出不来 */
export const TERMINAL_STATES: ReadonlySet<ParkedState> = new Set([
  'delivered',
  'recalled',
  'expired',
]);

export interface ParkResult {
  /** 本次调用是否真的新排入（false = 已存在，幂等返回原记录） */
  parked: boolean;
  row: ParkedRow;
}

export class ParkedQueue {
  constructor(
    private readonly store: Store,
    private readonly ttlMs: number,
    private readonly maxPerMachine: number,
  ) {}

  private get db() {
    return this.store.db;
  }

  /**
   * 把一帧排入队列。已存在同坐标记录时不覆盖（幂等）——重复的 relay
   * 复推不该刷新 TTL，否则客户端不断重发即可无限延长过期时间。
   */
  park(
    machineId: string,
    sessionId: string,
    seq: number,
    now = Date.now(),
  ): ParkResult | { parked: false; row: null; reason: 'quota_exceeded' } {
    const existing = this.get(machineId, sessionId, seq);
    if (existing) return { parked: false, row: existing };

    if (this.pendingCount(machineId, now) >= this.maxPerMachine) {
      return { parked: false, row: null, reason: 'quota_exceeded' };
    }

    const expiresAt = now + this.ttlMs;
    this.db
      .query(
        `INSERT INTO parked_frames
           (machine_id, session_id, seq, state, parked_at, expires_at, settled_at)
         VALUES (?, ?, ?, 'pending', ?, ?, NULL)`,
      )
      .run(machineId, sessionId, seq, now, expiresAt);
    return { parked: true, row: this.get(machineId, sessionId, seq)! };
  }

  get(machineId: string, sessionId: string, seq: number): ParkedRow | null {
    const row = this.db
      .query(
        `SELECT machine_id, session_id, seq, state, parked_at, expires_at, settled_at
         FROM parked_frames
         WHERE machine_id = ? AND session_id = ? AND seq = ?`,
      )
      .get(machineId, sessionId, seq) as Record<string, unknown> | null;
    return row ? toRow(row) : null;
  }

  /** 待投递（pending 且未过期）的帧，按排队顺序 */
  pending(machineId: string, now = Date.now()): ParkedRow[] {
    const rows = this.db
      .query(
        `SELECT machine_id, session_id, seq, state, parked_at, expires_at, settled_at
         FROM parked_frames
         WHERE machine_id = ? AND state = 'pending' AND expires_at > ?
         ORDER BY parked_at ASC, seq ASC`,
      )
      .all(machineId, now) as Record<string, unknown>[];
    return rows.map(toRow);
  }

  /** parked.count 广播的数字来源：只数还有效的 pending */
  pendingCount(machineId: string, now = Date.now()): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM parked_frames
         WHERE machine_id = ? AND state = 'pending' AND expires_at > ?`,
      )
      .get(machineId, now) as { n: number };
    return row.n;
  }

  /**
   * 条件迁移到终态：仅当当前是 pending 才生效。
   * 返回 true 表示本次调用赢得了这次迁移。
   */
  private settle(
    machineId: string,
    sessionId: string,
    seq: number,
    state: ParkedState,
    now: number,
  ): boolean {
    const changes = this.db
      .query(
        `UPDATE parked_frames SET state = ?, settled_at = ?
         WHERE machine_id = ? AND session_id = ? AND seq = ? AND state = 'pending'`,
      )
      .run(state, now, machineId, sessionId, seq).changes;
    return changes > 0;
  }

  /** agent 上线投出后标记；已是终态则无操作 */
  markDelivered(
    machineId: string,
    sessionId: string,
    seq: number,
    now = Date.now(),
  ): boolean {
    return this.settle(machineId, sessionId, seq, 'delivered', now);
  }

  /** 单条判过期（如密文已被 relay TTL 清掉，投不出去了）；已是终态则无操作 */
  expire(
    machineId: string,
    sessionId: string,
    seq: number,
    now = Date.now(),
  ): boolean {
    return this.settle(machineId, sessionId, seq, 'expired', now);
  }

  /**
   * park.recall：撤回一条排队帧。
   *
   * 幂等语义（transport.ts 明确要求）：记录不存在、或已投递/已过期/已撤回，
   * 一律静默返回 false，不报错——client 重连后重发 recall 是常态。
   */
  recall(
    machineId: string,
    sessionId: string,
    seq: number,
    now = Date.now(),
  ): boolean {
    return this.settle(machineId, sessionId, seq, 'recalled', now);
  }

  /**
   * 扫描过期：只把仍是 pending 的转 expired。
   *
   * 返回被判过期的**每一条**坐标，调用方据此逐条广播 park.expired
   * （client 要按 seq 关联自己那条本地暂存消息），并按机器广播新的
   * parked.count。
   */
  sweepExpired(now = Date.now()): ParkedRow[] {
    return this.db.transaction(() => {
      const rows = this.db
        .query(
          `SELECT machine_id, session_id, seq, state, parked_at, expires_at, settled_at
           FROM parked_frames
           WHERE state = 'pending' AND expires_at <= ?`,
        )
        .all(now) as Record<string, unknown>[];
      if (rows.length === 0) return [];
      this.db
        .query(
          `UPDATE parked_frames SET state = 'expired', settled_at = ?
           WHERE state = 'pending' AND expires_at <= ?`,
        )
        .run(now, now);
      return rows.map(toRow);
    })();
  }

  /** 清掉早已结算的历史记录，避免表无限增长 */
  purgeSettled(olderThan: number): number {
    return this.db
      .query(
        `DELETE FROM parked_frames
         WHERE state != 'pending' AND settled_at IS NOT NULL AND settled_at < ?`,
      )
      .run(olderThan).changes;
  }
}

function toRow(row: Record<string, unknown>): ParkedRow {
  return {
    machineId: row.machine_id as string,
    sessionId: row.session_id as string,
    seq: row.seq as number,
    state: row.state as ParkedState,
    parkedAt: row.parked_at as number,
    expiresAt: row.expires_at as number,
    settledAt: (row.settled_at as number | null) ?? null,
  };
}

/**
 * SQLite 存储层：设备/认证/relay 补发/parked 队列。
 * 表结构与零知识约束见 ./schema.ts。
 */
import { Database } from 'bun:sqlite';
import { FIRST_SEQ, NO_SEQ_RECEIVED } from '@trine/core/protocol';
import { migrate } from './schema.ts';

/** 机器级帧（RelayFrame 上 sessionId 省略）在库里用空串表示，见 schema.ts */
export const MACHINE_STREAM = '';

/**
 * 无收件人维度（c2a 帧）在库里的 recipient_id 列值。
 * 与 MACHINE_STREAM 同样是空串哨兵，理由相同：NULL 在主键里互不相等，
 * 会让「同坐标只有一条」的约束对这批行失效。
 */
export const NO_RECIPIENT = '';

/** 把可选 sessionId 归一成库里的 session_id 列值 */
export function streamKey(sessionId: string | undefined): string {
  return sessionId ?? MACHINE_STREAM;
}

/** 把库里的 session_id 还原成可选 sessionId（空串 = 机器级） */
export function unstreamKey(sessionId: string): string | undefined {
  return sessionId === MACHINE_STREAM ? undefined : sessionId;
}

/** 把可选 recipientDeviceId 归一成库里的 recipient_id 列值 */
export function recipientKey(recipientDeviceId: string | undefined): string {
  return recipientDeviceId ?? NO_RECIPIENT;
}

/** 把库里的 recipient_id 还原成可选 recipientDeviceId（空串 = 无此维度） */
export function unrecipientKey(recipientId: string): string | undefined {
  return recipientId === NO_RECIPIENT ? undefined : recipientId;
}

export type DeviceRole = 'client' | 'agent';
export type FrameDir = 'a2c' | 'c2a';
export type ParkedState = 'pending' | 'delivered' | 'recalled' | 'expired';

export interface DeviceRow {
  deviceId: string;
  role: DeviceRole;
  signPubKey: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

export interface StoredRelayFrame {
  machineId: string;
  sessionId: string | undefined;
  /**
   * 这一份密文发给哪台 client 设备；c2a 帧省略（收件人天然是该机器 agent）。
   * 与 (machineId, sessionId, dir, seq) 一起构成帧的完整坐标——矩阵式配对
   * 下同一逻辑事件的 N 份密文只靠这一维区分，见 schema.ts 的 v2 迁移。
   */
  recipientDeviceId: string | undefined;
  seq: number;
  dir: FrameDir;
  nonce: string;
  ciphertext: string;
  pushHint: string | null;
  createdAt: number;
}

export interface ParkedRow {
  machineId: string;
  sessionId: string;
  seq: number;
  state: ParkedState;
  parkedAt: number;
  expiresAt: number;
  settledAt: number | null;
}

/** relay 写入结果：区分「新帧」「重复帧（已丢弃）」「seq 回退（拒绝）」 */
export type RelayAppendResult =
  | { ok: true; duplicate: false }
  | { ok: true; duplicate: true }
  | { ok: false; reason: 'seq_not_monotonic'; expectedAfter: number }
  | { ok: false; reason: 'seq_below_first' }
  | { ok: false; reason: 'seq_too_far_ahead'; expectedAfter: number };

/**
 * 单帧允许比该流持久高水位领先多少。
 *
 * 有了持久高水位（schema.ts v3）之后，这个上限**只剩一个目的**：防己方 bug
 * 单次把基线顶到天花板（一帧 seq=MAX_SAFE_INTEGER 落库后，该流此后所有正常帧
 * 都被判回退）。它**不是安全防线**——能往一条流写帧的只有持有凭据的己方设备，
 * 持凭据者本来就能毒化任何流，fresh 流首帧也不受此限。
 *
 * 取值要足够大，让**正常运行**永远撞不到：agent 断线期间 claude 照跑，emitter
 * 无条件推进、断线丢帧不排队，重连后本地 seq 可能领先服务端上万（assistant.delta
 * 是 token 级）。早先的 10_000 会把这种正常累积当 bug 拒掉，且拒了就永久拒
 * （发送方无法回退）。一百万约等于连续几天不间断输出，正常达不到；而 bug 场景
 * 的特征是一步跳到 2^53 量级，一百万仍能拦住。
 *
 * 多 client 并发给同一会话分配 seq 的协调另见 D10（不在本常量的职责内）。
 */
export const MAX_SEQ_LOOKAHEAD = 1_000_000;

export class Store {
  readonly db: Database;

  /**
   * @param pathOrDb 库文件路径（默认内存库），或一个**已打开**的 Database——
   *   后者供测试把预先造好的老版本库（含存量数据）交进来验证迁移。
   */
  constructor(pathOrDb: string | Database = ':memory:') {
    this.db =
      typeof pathOrDb === 'string'
        ? new Database(pathOrDb, { create: true })
        : pathOrDb;
    // WAL：并发读不阻塞写，单进程下也降低 fsync 抖动
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    migrate(this.db as never);
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // 设备
  // -------------------------------------------------------------------------

  /**
   * 登记设备公钥。已存在同 deviceId 时**不覆盖公钥**——覆盖等于允许任何人
   * 用新公钥顶掉已注册设备（无需证明持有旧私钥），是典型的接管漏洞。
   * 换密钥必须先显式 revoke。
   */
  registerDevice(
    deviceId: string,
    role: DeviceRole,
    signPubKey: string,
    now = Date.now(),
  ): { created: boolean; device: DeviceRow } {
    const existing = this.getDevice(deviceId);
    if (existing) return { created: false, device: existing };

    this.db
      .query(
        `INSERT INTO devices (device_id, role, sign_pub_key, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(deviceId, role, signPubKey, now, 0);
    return { created: true, device: this.getDevice(deviceId)! };
  }

  getDevice(deviceId: string): DeviceRow | null {
    const row = this.db
      .query(
        `SELECT device_id, role, sign_pub_key, created_at, last_seen_at, revoked_at
         FROM devices WHERE device_id = ?`,
      )
      .get(deviceId) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      deviceId: row.device_id as string,
      role: row.role as DeviceRole,
      signPubKey: row.sign_pub_key as string,
      createdAt: row.created_at as number,
      lastSeenAt: row.last_seen_at as number,
      revokedAt: (row.revoked_at as number | null) ?? null,
    };
  }

  listDevices(role?: DeviceRole): DeviceRow[] {
    const rows = (
      role
        ? this.db
            .query(
              `SELECT device_id, role, sign_pub_key, created_at, last_seen_at, revoked_at
               FROM devices WHERE role = ? ORDER BY created_at`,
            )
            .all(role)
        : this.db
            .query(
              `SELECT device_id, role, sign_pub_key, created_at, last_seen_at, revoked_at
               FROM devices ORDER BY created_at`,
            )
            .all()
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      deviceId: row.device_id as string,
      role: row.role as DeviceRole,
      signPubKey: row.sign_pub_key as string,
      createdAt: row.created_at as number,
      lastSeenAt: row.last_seen_at as number,
      revokedAt: (row.revoked_at as number | null) ?? null,
    }));
  }

  /** 吊销设备：同时清掉其全部 token，已建立的连接由调用方负责断开 */
  revokeDevice(deviceId: string, now = Date.now()): void {
    this.db.transaction(() => {
      this.db
        .query('UPDATE devices SET revoked_at = ? WHERE device_id = ?')
        .run(now, deviceId);
      this.db.query('DELETE FROM auth_tokens WHERE device_id = ?').run(deviceId);
    })();
  }

  countDevices(): number {
    const row = this.db.query('SELECT COUNT(*) AS n FROM devices').get() as {
      n: number;
    };
    return row.n;
  }

  touchDevice(deviceId: string, now = Date.now()): void {
    this.db
      .query('UPDATE devices SET last_seen_at = ? WHERE device_id = ?')
      .run(now, deviceId);
  }

  // -------------------------------------------------------------------------
  // 挑战串与 token
  // -------------------------------------------------------------------------

  /**
   * 删掉某设备的全部挑战串。
   * 发新挑战前调用，保证每设备最多只有一个未过期挑战——挑战表因此恒定为
   * 「设备数」量级，不随认证请求次数无界增长。
   */
  clearChallengesFor(deviceId: string): number {
    return this.db
      .query('DELETE FROM auth_challenges WHERE device_id = ?')
      .run(deviceId).changes;
  }

  /** 挑战表当前行数（限流/容量测试用） */
  countChallenges(): number {
    const row = this.db
      .query('SELECT COUNT(*) AS n FROM auth_challenges')
      .get() as { n: number };
    return row.n;
  }

  putChallenge(challenge: string, deviceId: string, expiresAt: number): void {
    this.db
      .query(
        'INSERT OR REPLACE INTO auth_challenges (challenge, device_id, expires_at) VALUES (?, ?, ?)',
      )
      .run(challenge, deviceId, expiresAt);
  }

  /**
   * 消费挑战串：取出并**立即删除**，无论后续验签成败。
   * 一次性是防重放的根据——若验签失败时留着，攻击者可对同一挑战反复试。
   */
  consumeChallenge(
    challenge: string,
    now = Date.now(),
  ): { deviceId: string } | null {
    return this.db.transaction(() => {
      const row = this.db
        .query(
          'SELECT device_id, expires_at FROM auth_challenges WHERE challenge = ?',
        )
        .get(challenge) as { device_id: string; expires_at: number } | null;
      if (!row) return null;
      this.db
        .query('DELETE FROM auth_challenges WHERE challenge = ?')
        .run(challenge);
      if (row.expires_at <= now) return null;
      return { deviceId: row.device_id };
    })();
  }

  putToken(
    tokenHash: string,
    deviceId: string,
    issuedAt: number,
    expiresAt: number,
  ): void {
    this.db
      .query(
        'INSERT OR REPLACE INTO auth_tokens (token_hash, device_id, issued_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(tokenHash, deviceId, issuedAt, expiresAt);
  }

  /** 按摘要查 token；过期的当作不存在（清理交给 sweep） */
  lookupToken(
    tokenHash: string,
    now = Date.now(),
  ): { deviceId: string; expiresAt: number } | null {
    const row = this.db
      .query(
        'SELECT device_id, expires_at FROM auth_tokens WHERE token_hash = ?',
      )
      .get(tokenHash) as { device_id: string; expires_at: number } | null;
    if (!row || row.expires_at <= now) return null;
    return { deviceId: row.device_id, expiresAt: row.expires_at };
  }

  revokeToken(tokenHash: string): void {
    this.db.query('DELETE FROM auth_tokens WHERE token_hash = ?').run(tokenHash);
  }

  // -------------------------------------------------------------------------
  // 认证失败限流
  // -------------------------------------------------------------------------

  /**
   * 记一次认证失败并返回窗口内累计次数。窗口过期自动重置。
   */
  recordAuthFailure(source: string, windowMs: number, now = Date.now()): number {
    return this.db.transaction(() => {
      const row = this.db
        .query(
          'SELECT attempts, window_start FROM auth_failures WHERE source = ?',
        )
        .get(source) as { attempts: number; window_start: number } | null;
      if (!row || now - row.window_start >= windowMs) {
        this.db
          .query(
            'INSERT OR REPLACE INTO auth_failures (source, attempts, window_start) VALUES (?, 1, ?)',
          )
          .run(source, now);
        return 1;
      }
      const attempts = row.attempts + 1;
      this.db
        .query('UPDATE auth_failures SET attempts = ? WHERE source = ?')
        .run(attempts, source);
      return attempts;
    })();
  }

  /** 当前窗口内的失败次数（窗口已过期则视为 0） */
  authFailureCount(source: string, windowMs: number, now = Date.now()): number {
    const row = this.db
      .query('SELECT attempts, window_start FROM auth_failures WHERE source = ?')
      .get(source) as { attempts: number; window_start: number } | null;
    if (!row || now - row.window_start >= windowMs) return 0;
    return row.attempts;
  }

  clearAuthFailures(source: string): void {
    this.db.query('DELETE FROM auth_failures WHERE source = ?').run(source);
  }

  // -------------------------------------------------------------------------
  // relay 帧
  // -------------------------------------------------------------------------

  /**
   * 某条子流的持久高水位（已接受过的最大 seq）；**从未有帧落过**的流
   * 返回 null——这个「从未有过」与「有过但都被清理了」的区别正是
   * appendRelayFrame 判定 fresh 流的依据。
   *
   * 读的是 stream_hwm 而不是 `MAX(seq) FROM relay_frames`：留存帧会被
   * TTL sweep / trimStream 裁掉，MAX 会随之蒸发归零，见 schema.ts v3。
   * 不变量：hwm ≥ 当前留存帧的 MAX(seq)（hwm 只在成功落帧时上推，且不清理）。
   *
   * **「流」的完整定义含收件人维度**：(machineId, sessionId, dir,
   * recipientDeviceId)。矩阵式配对下每个收件人是各自独立的一条子流——
   * 不按收件人分开的话，先落库的那份会把单调基线顶上去，同一逻辑事件
   * 发给其他收件人的那几份（seq 相同）就会被判 seq 回退而拒收。
   */
  streamHwm(
    machineId: string,
    sessionId: string | undefined,
    dir: FrameDir,
    recipientDeviceId?: string | undefined,
  ): number | null {
    const row = this.db
      .query(
        `SELECT max_seq FROM stream_hwm
         WHERE machine_id = ? AND session_id = ? AND dir = ? AND recipient_id = ?`,
      )
      .get(
        machineId,
        streamKey(sessionId),
        dir,
        recipientKey(recipientDeviceId),
      ) as { max_seq: number } | null;
    return row?.max_seq ?? null;
  }

  /**
   * 某条子流已接受过的最大 seq；空流返回 `NO_SEQ_RECEIVED`（0）。
   * 合法 seq 从 `FIRST_SEQ`（1）起，所以 0 可以安全地兼作「空」哨兵。
   * 就是 `streamHwm()` 的哨兵化版本，供不关心 fresh 与否的调用方用。
   */
  maxSeq(
    machineId: string,
    sessionId: string | undefined,
    dir: FrameDir,
    recipientDeviceId?: string | undefined,
  ): number {
    return (
      this.streamHwm(machineId, sessionId, dir, recipientDeviceId) ??
      NO_SEQ_RECEIVED
    );
  }

  /**
   * 落一帧密文。
   *
   * seq 规则（与 agent 端对齐）：由发出方按
   * (machineId, sessionId, recipientDeviceId) 分配、单调递增；机器级帧、
   * 以及每个收件人，都各是独立的一条序列。服务端只做两件事：
   * - **去重**：同坐标 seq 已存在 → 丢弃，返回 duplicate（三段 WS 都可能
   *   复推，见 PROTOCOL-REQUIREMENTS §5）；
   * - **单调校验**：seq 小于该子流高水位 → 拒绝，避免乱序帧插进补发
   *   序列后让 sinceSeq 语义失真。
   *
   * 「坐标」含收件人维度是本表的关键（见 maxSeq 注释与 schema.ts v2）：
   * 同一逻辑事件发给 N 个收件人的 N 份密文 seq 相同，不分开就会被判重复。
   *
   * ## 「重复」= 同坐标 **且** 同一份密文（nonce + ciphertext 逐字相同）
   *
   * 三段 WS 复推的是**同一条帧**——字节一样。而「同坐标、不同密文」是另一回事：
   * 发送方丢了计数器（agent 重启、state.json 丢失）从 1 重来，新事件撞上了
   * 留存里还没清掉的老 seq。早先这两种情况都判 duplicate 静默丢弃，于是第二种
   * 情况下发送方**永远收不到 reject**、无从自愈，事件就这么蒸发了；只有留存被
   * 清掉的那一段才会撞到单调校验拿到 reject。区分之后：
   * - 字节一样 → duplicate，静默丢（全链路幂等，PROTOCOL-REQUIREMENTS §5）；
   * - 字节不一样 → seq_not_monotonic + expectedAfter，发送方跳号重发。
   * 服务端比对的是两段不透明字节，不涉及任何内容知识。
   *
   * ## 基线是持久高水位，不是留存帧的 MAX（schema.ts v3）
   *
   * 成功落帧即把 stream_hwm 上推到 `MAX(max_seq, seq)`。基线与留存脱钩后，
   * 「seq ≤ 高水位但留存里已没有这一帧」也成了可能：无从比对字节，一律按
   * seq_not_monotonic 处理——它更可能是发送方计数器落后（该自愈），而不是一条
   * 迟到了 7 天的复推；即便真是复推，代价也只是接收方多收一条早已收过的事件。
   *
   * ## fresh 流跳过 lookahead
   *
   * 该子流**从未有帧落过**（无 hwm 行）时，首帧不论 seq 多大都接受、直接
   * 当基线。lookahead 防的是「一帧把在跑的流顶到天花板」这种毒化，而能往
   * 某条流写帧的只有持有对应凭据的己方设备：攻击者拿到凭据时随时能毒化
   * 任何流，fresh 流上并没有额外攻击面；反过来不跳过的话，新配对设备的子流
   * 基线是 0，agent 已经跑到几万的老会话第一帧就撞上限，永远发不进去。
   *
   * 永远不解读 ciphertext。
   */
  appendRelayFrame(
    frame: StoredRelayFrame,
  ): RelayAppendResult {
    // seq 0 保留给 sinceSeq 的「一帧未收」语义，不是合法的帧序号
    if (frame.seq < FIRST_SEQ) return { ok: false, reason: 'seq_below_first' };

    const session = streamKey(frame.sessionId);
    const recipient = recipientKey(frame.recipientDeviceId);
    return this.db.transaction((): RelayAppendResult => {
      const existing = this.db
        .query(
          `SELECT nonce, ciphertext FROM relay_frames
           WHERE machine_id = ? AND session_id = ? AND dir = ?
             AND recipient_id = ? AND seq = ?`,
        )
        .get(frame.machineId, session, frame.dir, recipient, frame.seq) as {
        nonce: string;
        ciphertext: string;
      } | null;
      // 同坐标同字节才是复推（见上）；同坐标不同字节落到下面的单调校验去拿 reject
      if (
        existing !== null &&
        existing.nonce === frame.nonce &&
        existing.ciphertext === frame.ciphertext
      ) {
        return { ok: true, duplicate: true };
      }

      const hwm = this.streamHwm(
        frame.machineId,
        frame.sessionId,
        frame.dir,
        frame.recipientDeviceId,
      );
      // null = fresh 流：首帧即基线，不做单调与 lookahead 校验（见上）
      if (hwm !== null) {
        // ≤ 高水位：这个 seq 已被接受过（且不是同一份密文）→ 发送方计数器落后
        if (frame.seq <= hwm) {
          return { ok: false, reason: 'seq_not_monotonic', expectedAfter: hwm };
        }
        // 跳跃过大（己方 bug 防线，见 MAX_SEQ_LOOKAHEAD）：一帧 seq=MAX_SAFE_INTEGER
        // 会把单调基线顶到天花板，此后所有正常帧都被判回退，整条流报废
        if (frame.seq - hwm > MAX_SEQ_LOOKAHEAD) {
          return { ok: false, reason: 'seq_too_far_ahead', expectedAfter: hwm };
        }
      }

      this.db
        .query(
          `INSERT INTO relay_frames
             (machine_id, session_id, recipient_id, seq, dir, nonce, ciphertext, push_hint, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          frame.machineId,
          session,
          recipient,
          frame.seq,
          frame.dir,
          frame.nonce,
          frame.ciphertext,
          frame.pushHint,
          frame.createdAt,
        );
      // 高水位只进不退：与落帧同一事务，不会出现「帧落了、基线没跟上」
      this.db
        .query(
          `INSERT INTO stream_hwm (machine_id, session_id, dir, recipient_id, max_seq, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (machine_id, session_id, dir, recipient_id)
           DO UPDATE SET max_seq = MAX(max_seq, excluded.max_seq),
                         updated_at = excluded.updated_at`,
        )
        .run(
          frame.machineId,
          session,
          frame.dir,
          recipient,
          frame.seq,
          frame.createdAt,
        );
      return { ok: true, duplicate: false };
    })();
  }

  /**
   * 断线补发：取 sinceSeq 之后的全部帧，按 seq 升序。
   *
   * `recipientDeviceId` 省略时**不按收件人过滤**（取该 (机器,会话,方向)
   * 下的全部子流）——c2a 补发走的就是这条路径，它本就没有收件人维度。
   * a2c 补发必须显式传值：调用方要按请求连接的已认证 deviceId 过滤，
   * 只回该设备自己那条子流。别人的密文它虽然解不开，但也没有任何理由
   * 发过去（见 hub.handleSync）。
   */
  framesSince(
    machineId: string,
    sessionId: string | undefined,
    dir: FrameDir,
    sinceSeq: number,
    limit = 1000,
    recipientDeviceId?: string | undefined,
  ): StoredRelayFrame[] {
    const filterRecipient = recipientDeviceId !== undefined;
    const rows = this.db
      .query(
        `SELECT machine_id, session_id, recipient_id, seq, dir, nonce, ciphertext, push_hint, created_at
         FROM relay_frames
         WHERE machine_id = ? AND session_id = ? AND dir = ? AND seq > ?
           ${filterRecipient ? 'AND recipient_id = ?' : ''}
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(
        ...(filterRecipient
          ? [
              machineId,
              streamKey(sessionId),
              dir,
              sinceSeq,
              recipientKey(recipientDeviceId),
              limit,
            ]
          : [machineId, streamKey(sessionId), dir, sinceSeq, limit]),
      ) as Record<string, unknown>[];
    return rows.map(rowToFrame);
  }

  /**
   * 按坐标取单帧（parked 投递时用）。
   *
   * parked 只装 c2a 帧（发往离线 agent 的 client 帧），所以默认取
   * recipient_id = '' 那一行——c2a 本就没有收件人维度。
   */
  getFrame(
    machineId: string,
    sessionId: string | undefined,
    dir: FrameDir,
    seq: number,
    recipientDeviceId?: string | undefined,
  ): StoredRelayFrame | null {
    const row = this.db
      .query(
        `SELECT machine_id, session_id, recipient_id, seq, dir, nonce, ciphertext, push_hint, created_at
         FROM relay_frames
         WHERE machine_id = ? AND session_id = ? AND dir = ?
           AND recipient_id = ? AND seq = ?`,
      )
      .get(
        machineId,
        streamKey(sessionId),
        dir,
        recipientKey(recipientDeviceId),
        seq,
      ) as Record<string, unknown> | null;
    return row ? rowToFrame(row) : null;
  }

  /**
   * 按流裁剪到最近 keep 条，防单会话把库撑爆。
   *
   * **必须跳过仍是 pending 的 parked 帧**，理由与 sweepRelayFrames 相同：
   * 密文被裁掉后 agent 上线时就投不出内容，那条消息会被判过期静默吞掉，
   * 而 client 手里明明攥着一张 input.parked 回执。裁剪是「省空间」的
   * 尽力而为动作，绝不能拿正确性去换。
   *
   * 配额上的保证见 config.ts 的不变量校验（relayMaxPerStream >=
   * parkedMaxPerMachine）：即使全部排队帧都挤在同一条流上，
   * 裁剪也不会碰到它们。这里的子句是第二道防线。
   */
  trimStream(
    machineId: string,
    sessionId: string | undefined,
    dir: FrameDir,
    keep: number,
    recipientDeviceId?: string | undefined,
  ): number {
    // 裁剪按**子流**进行（含收件人维度）：keep 的语义是「这条流留多少帧」，
    // 而矩阵式配对下每个收件人各是一条流。不分开的话，N 个收件人的帧混在
    // 一起算 keep，等于把每台设备的实际留存窗口压到 1/N——断线补发能力
    // 会随配对设备数悄悄缩水。
    const recipient = recipientKey(recipientDeviceId);
    return this.db
      .query(
        `DELETE FROM relay_frames
         WHERE machine_id = ? AND session_id = ? AND dir = ? AND recipient_id = ?
           AND seq <= (
             SELECT seq FROM relay_frames
             WHERE machine_id = ? AND session_id = ? AND dir = ? AND recipient_id = ?
             ORDER BY seq DESC LIMIT 1 OFFSET ?
           )
           -- 同 sweepRelayFrames：只有 c2a 帧会进排队队列
           AND NOT (
             relay_frames.dir = 'c2a'
             AND EXISTS (
               SELECT 1 FROM parked_frames p
               WHERE p.machine_id = relay_frames.machine_id
                 AND p.session_id = relay_frames.session_id
                 AND p.seq = relay_frames.seq
                 AND p.state = 'pending'
             )
           )`,
      )
      .run(
        machineId,
        streamKey(sessionId),
        dir,
        recipient,
        machineId,
        streamKey(sessionId),
        dir,
        recipient,
        keep,
      ).changes;
  }

  /**
   * 清理超期 relay 帧。**不动仍是 pending 的 parked 帧对应的密文**——
   * parked 有自己更长/更短的 TTL，密文被 relay 清理提前删掉会让 agent
   * 上线后投递不出内容。
   *
   * 收件人维度不需要出现在这里：清理判据是时间，逐行独立成立；而保护
   * 子句限定 `dir='c2a'`，那批行的 recipient_id 恒为空串
   * （c2a 没有收件人维度），parked 的三元坐标因此仍然唯一定位到它们。
   */
  sweepRelayFrames(olderThan: number): number {
    return this.db
      .query(
        `DELETE FROM relay_frames
         WHERE created_at < ?
           -- 只有 c2a 帧会进排队队列（parked 装的是发往离线 agent 的
           -- client 帧），所以保护子句限定 dir='c2a'：否则同坐标的 a2c
           -- 帧会被一条无关的 parked 记录白白 pin 住不让清理
           AND NOT (
             relay_frames.dir = 'c2a'
             AND EXISTS (
               SELECT 1 FROM parked_frames p
               WHERE p.machine_id = relay_frames.machine_id
                 AND p.session_id = relay_frames.session_id
                 AND p.seq = relay_frames.seq
                 AND p.state = 'pending'
             )
           )`,
      )
      .run(olderThan).changes;
  }

  /**
   * 清理长期没动过的高水位行。
   *
   * stream_hwm 一行一条子流、永不随 relay 留存清理——这正是它的价值，但也让它
   * 成了唯一**无上界**的表：已配对 client 可以对任意随机 sessionId 无限开 fresh
   * 流，每条永久留一行（relay_frames 自己会被 7 天 sweep 收走，这张表不会）。
   * 一台被 XSS 的 web client 就能慢慢填满 VPS 磁盘。所以给它一个很长的 TTL
   * （默认 90 天，`TRINE_HWM_TTL_MS`）：90 天没有任何帧的流被删掉后变回 fresh，
   * 下一帧不论 seq 多大都成为新基线——按 D10 的 fresh 语义这是安全的，代价只是
   * 一条 90 天以上的极老重放帧会被接受一次。上界因此是「90 天内活跃的流数」。
   */
  sweepStreamHwm(olderThan: number): number {
    return this.db
      .query('DELETE FROM stream_hwm WHERE updated_at < ?')
      .run(olderThan).changes;
  }

  // -------------------------------------------------------------------------
  // 游标
  // -------------------------------------------------------------------------

  setCursor(
    deviceId: string,
    machineId: string,
    sessionId: string | undefined,
    ackedSeq: number,
    now = Date.now(),
  ): void {
    this.db
      .query(
        `INSERT INTO stream_cursors (device_id, machine_id, session_id, acked_seq, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (device_id, machine_id, session_id)
         -- 游标只进不退：迟到的旧 sync.request 不能把已推进的游标拖回去
         DO UPDATE SET acked_seq = MAX(acked_seq, excluded.acked_seq),
                       updated_at = excluded.updated_at`,
      )
      .run(deviceId, machineId, streamKey(sessionId), ackedSeq, now);
  }

  getCursor(
    deviceId: string,
    machineId: string,
    sessionId: string | undefined,
  ): number | null {
    const row = this.db
      .query(
        `SELECT acked_seq FROM stream_cursors
         WHERE device_id = ? AND machine_id = ? AND session_id = ?`,
      )
      .get(deviceId, machineId, streamKey(sessionId)) as {
      acked_seq: number;
    } | null;
    return row?.acked_seq ?? null;
  }

  // -------------------------------------------------------------------------
  // 清理入口
  // -------------------------------------------------------------------------

  sweepExpiredAuth(now = Date.now()): { challenges: number; tokens: number } {
    this.db.query('DELETE FROM agent_invitations WHERE expires_at <= ?').run(now);
    const challenges = this.db
      .query('DELETE FROM auth_challenges WHERE expires_at <= ?')
      .run(now).changes;
    const tokens = this.db
      .query('DELETE FROM auth_tokens WHERE expires_at <= ?')
      .run(now).changes;
    return { challenges, tokens };
  }
}

function rowToFrame(row: Record<string, unknown>): StoredRelayFrame {
  return {
    machineId: row.machine_id as string,
    sessionId: unstreamKey(row.session_id as string),
    recipientDeviceId: unrecipientKey(row.recipient_id as string),
    seq: row.seq as number,
    dir: row.dir as FrameDir,
    nonce: row.nonce as string,
    ciphertext: row.ciphertext as string,
    pushHint: (row.push_hint as string | null) ?? null,
    createdAt: row.created_at as number,
  };
}

/**
 * SQLite 表结构（bun:sqlite）。
 *
 * ## 零知识硬约束
 *
 * 本文件是「服务端到底存了什么」的唯一事实源，落库字段必须逐一对得上
 * `packages/core/src/protocol/transport.ts` 的明文字段
 * （docs/PROTOCOL-REQUIREMENTS.md 的 † 清单）：
 *
 * - 存：machineId / sessionId / recipientDeviceId / seq / nonce / ciphertext /
 *   pushHint / 设备公钥 / 时间戳 —— 全部是路由与元数据；
 * - 不存：任何 E2E 正文（ciphertext 是密文，服务端无密钥，也不尝试解）、
 *   会话标题、cwd、工具参数、消息文本、机器名。
 *
 * 认证凭据摘要与有效期是认证元数据，不属于 E2E 正文。
 * 加字段前先问：这个字段在 transport.ts 里有对应吗？没有就不该存。
 */

/** 递增式迁移：每项跑一次，version 记在 user_version 里 */
const MIGRATIONS: string[] = [
  // ---- v1：设备、认证、relay、parked ----
  `
  -- 设备注册表：一条 = 一台 client 设备或一台 agent 机器
  CREATE TABLE devices (
    device_id     TEXT PRIMARY KEY,
    -- 'agent' 的 device_id 即 machineId（transport.ts HelloSchema 注释）
    role          TEXT NOT NULL CHECK (role IN ('client', 'agent')),
    -- Ed25519 设备身份公钥（base64url）。注意：**不是** E2E 的 X25519 公钥，
    -- 后者服务端永远不需要也不该持有。
    sign_pub_key  TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    -- 服务端观测到的最后活跃时刻（machine.status.lastSeenAt 的来源）
    last_seen_at  INTEGER NOT NULL DEFAULT 0,
    revoked_at    INTEGER
  );

  -- 挑战串：一次性、短 TTL，消费后立即删除（防重放）
  CREATE TABLE auth_challenges (
    challenge   TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_challenges_expiry ON auth_challenges (expires_at);

  -- 认证 token：不透明随机串，只存 sha256 摘要（库泄露不等于 token 泄露）
  CREATE TABLE auth_tokens (
    token_hash  TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
    issued_at   INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_tokens_device ON auth_tokens (device_id);
  CREATE INDEX idx_tokens_expiry ON auth_tokens (expires_at);

  -- relay 密文帧：断线补发与去重的依据。
  -- session_id 用 '' 表示「机器级帧」（RelayFrame 上 sessionId 省略的那批）：
  -- 机器级帧有独立于各会话的 seq 序列，用空串把它建模成一条并列的流，
  -- 主键即可直接表达「per-(machine, stream) seq 唯一」，避免 NULL 在
  -- UNIQUE 约束里不相等的坑。
  CREATE TABLE relay_frames (
    machine_id  TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    -- 帧的流向：'a2c'（agent→client 广播）/ 'c2a'（client→agent）
    dir         TEXT NOT NULL CHECK (dir IN ('a2c', 'c2a')),
    nonce       TEXT NOT NULL,
    ciphertext  TEXT NOT NULL,
    push_hint   TEXT,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (machine_id, session_id, dir, seq)
  );
  CREATE INDEX idx_relay_created ON relay_frames (created_at);

  -- agent 离线排队：只记元数据 + 指向 relay_frames 的坐标，密文不重复存。
  -- state 是有终态的状态机，见 store/parked.ts 的终态防覆盖说明。
  CREATE TABLE parked_frames (
    machine_id   TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    state        TEXT NOT NULL CHECK (
                   state IN ('pending', 'delivered', 'recalled', 'expired')
                 ),
    parked_at    INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    -- 终态发生的时刻，NULL 表示仍是 pending
    settled_at   INTEGER,
    PRIMARY KEY (machine_id, session_id, seq)
  );
  CREATE INDEX idx_parked_machine_state ON parked_frames (machine_id, state);
  CREATE INDEX idx_parked_expiry ON parked_frames (state, expires_at);

  -- 每设备的接收游标：客户端 sync.request 的兜底/诊断用，非路由必需
  CREATE TABLE stream_cursors (
    device_id   TEXT NOT NULL,
    machine_id  TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    acked_seq   INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (device_id, machine_id, session_id)
  );

  -- 认证失败计数：限流用，按来源标识聚合
  CREATE TABLE auth_failures (
    source       TEXT PRIMARY KEY,
    attempts     INTEGER NOT NULL,
    window_start INTEGER NOT NULL
  );
  `,

  // ---- v2：relay_frames 主键加 recipient_id（矩阵式配对的收件人维度）----
  //
  // 为什么必须动主键：D8 的矩阵式独立配对下，agent 对每个已配对 client
  // 各 seal 一份密文，于是同一个逻辑事件产生 N 条 a2c 帧——它们的
  // (machine_id, session_id, dir, seq) 完全相同（同一逻辑事件就该是同一个
  // seq，这是与 client 侧 seq 单调校验对齐的前提），唯一区别是收件人。
  // 旧主键会把第 2..N 份判成重复帧丢掉，结果第二台设备起永远收不到
  // 能解开的密文。
  //
  // recipient_id 用空串哨兵表示「无收件人维度」，沿用 session_id 的既有
  // 手法（见 v1 里的说明）：c2a 帧的收件人天然是该机器的 agent，不需要
  // 这一维；空串而非 NULL，是因为 NULL 在 UNIQUE/主键约束里互不相等，
  // 会让「同坐标只有一条」这个约束对它们失效。
  //
  // SQLite 不支持改主键，只能建新表搬数据。项目尚未上线、无存量数据，
  // 但仍照搬一次：迁移的语义是「任何版本的库都能升上来」，
  // 依赖「反正现在是空的」就是给将来埋雷。
  `
  CREATE TABLE relay_frames_v2 (
    machine_id    TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    -- 这一份密文发给哪台 client 设备（a2c 每收件人一条）；
    -- '' = 无收件人维度（c2a 帧）
    recipient_id  TEXT NOT NULL DEFAULT '',
    seq           INTEGER NOT NULL,
    dir           TEXT NOT NULL CHECK (dir IN ('a2c', 'c2a')),
    nonce         TEXT NOT NULL,
    ciphertext    TEXT NOT NULL,
    push_hint     TEXT,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (machine_id, session_id, dir, recipient_id, seq)
  );

  INSERT INTO relay_frames_v2
    (machine_id, session_id, recipient_id, seq, dir, nonce, ciphertext, push_hint, created_at)
  SELECT machine_id, session_id, '', seq, dir, nonce, ciphertext, push_hint, created_at
  FROM relay_frames;

  DROP TABLE relay_frames;
  ALTER TABLE relay_frames_v2 RENAME TO relay_frames;

  CREATE INDEX idx_relay_created ON relay_frames (created_at);
  `,

  // ---- v3：每条子流的持久高水位 stream_hwm ----
  //
  // 为什么不能继续用 `MAX(seq) FROM relay_frames` 当单调基线：relay_frames
  // 会被 TTL sweep（7 天）与 trimStream 裁掉，基线随之**蒸发归零**。归零后
  // 发送方接着按自己的计数器发（比如会话 seq 已到几万），一帧就撞上
  // MAX_SEQ_LOOKAHEAD（`seq - 0 > 上限`）——被判「疑似毒化」拒收，而且
  // 之后每一帧都这样，整条流**永久报废**；新配对设备的子流 max=0 撞老会话
  // 的高 seq 也是同一回事。基线必须与留存脱钩，单独存。
  //
  // 一行 = 一条子流（含收件人维度，与 relay_frames 主键前四列一致），只存
  // 一个整数，规模是「流的条数」而非「帧的条数」。它不随留存清理，但有
  // 独立的、很长的 TTL（默认 90 天，见 Store.sweepStreamHwm）：否则它是唯一
  // 无上界的表，随机 sessionId 可以把它无限灌大。
  //
  // 存量回填：用现有留存帧的 MAX(seq) 初始化——留存帧的最大值就是当前基线，
  // 与升级前 maxSeq() 的返回值完全一致，升级对在跑的流零感知。
  //
  // † 判据：max_seq 是从 relay_frames 已有的 seq 列派生的，服务端本来就知道。
  `
  CREATE TABLE stream_hwm (
    machine_id    TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    dir           TEXT NOT NULL CHECK (dir IN ('a2c', 'c2a')),
    recipient_id  TEXT NOT NULL DEFAULT '',
    -- 该子流已接受过的最大 seq，只增不减，不随留存清理变化
    max_seq       INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (machine_id, session_id, dir, recipient_id)
  );

  INSERT INTO stream_hwm (machine_id, session_id, dir, recipient_id, max_seq, updated_at)
  SELECT machine_id, session_id, dir, recipient_id, MAX(seq), MAX(created_at)
  FROM relay_frames
  GROUP BY machine_id, session_id, dir, recipient_id;
  `,
  // v4: agent enrollment credentials; only hashes and administrative metadata.
  `CREATE TABLE agent_invitations (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL
  );`,
];

/** 当前 schema 版本 = 迁移条数 */
export const SCHEMA_VERSION = MIGRATIONS.length;

export interface MigrateOptions {
  /**
   * 只升到这个版本为止（默认升到最新）。**仅供测试**造「老版本库」用：
   * 先 `migrate(db, { upTo: 2 })` 灌存量数据，再 `migrate(db)` 验证
   * 后续迁移对存量数据的处理是否正确。生产路径永远不传。
   */
  upTo?: number;
}

/** 幂等升级：从 user_version 记录处继续跑未执行的迁移 */
export function migrate(
  db: {
    query: (sql: string) => { get: () => unknown };
    run: (sql: string) => unknown;
    exec: (sql: string) => unknown;
    transaction: <T>(fn: () => T) => () => T;
  },
  options: MigrateOptions = {},
): void {
  const target = options.upTo ?? SCHEMA_VERSION;
  if (target > SCHEMA_VERSION) {
    throw new Error(`目标版本 ${target} 超出已定义的迁移数 ${SCHEMA_VERSION}`);
  }
  const row = db.query('PRAGMA user_version').get() as
    | { user_version: number }
    | undefined;
  const current = row?.user_version ?? 0;

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `数据库 schema 版本 ${current} 高于本进程支持的 ${SCHEMA_VERSION}：` +
        '拒绝降级运行，请升级服务端',
    );
  }

  for (let v = current; v < target; v++) {
    const sql = MIGRATIONS[v]!;
    db.transaction(() => {
      db.exec(sql);
      // PRAGMA 不支持参数绑定，v+1 是本地整数常量，无注入面
      db.run(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

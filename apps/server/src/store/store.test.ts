import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  MACHINE_STREAM,
  MAX_SEQ_LOOKAHEAD,
  Store,
  streamKey,
  type StoredRelayFrame,
} from './index.ts';
import { ParkedQueue } from './parked.ts';
import { migrate, SCHEMA_VERSION } from './schema.ts';

let store: Store;

beforeEach(() => {
  store = new Store(':memory:');
});

function frame(over: Partial<StoredRelayFrame> = {}): StoredRelayFrame {
  return {
    machineId: 'mbp',
    sessionId: 's1',
    // 默认造 a2c 帧，按方向约定必带收件人（transport.ts）
    recipientDeviceId: 'phone',
    seq: 1,
    dir: 'a2c',
    nonce: 'n',
    ciphertext: 'c',
    pushHint: null,
    createdAt: 1000,
    ...over,
  };
}

/** c2a 帧：没有收件人维度（收件人天然是该机器的 agent） */
function c2aFrame(over: Partial<StoredRelayFrame> = {}): StoredRelayFrame {
  return frame({ dir: 'c2a', recipientDeviceId: undefined, ...over });
}

describe('schema 迁移', () => {
  test('新建库跑到最新版本且幂等', () => {
    const v = store.db.query('PRAGMA user_version').get() as {
      user_version: number;
    };
    expect(v.user_version).toBe(SCHEMA_VERSION);
    // 同一路径再开一次不应重复建表
    expect(() => new Store(':memory:')).not.toThrow();
  });

  /**
   * v3 的关键性质：**带存量数据**的 v2 库升上来后，每条子流的高水位等于
   * 升级前留存帧的 MAX(seq)——升级对在跑的流零感知。空库上跑迁移测不出
   * 回填写错（比如 GROUP BY 漏了收件人维度会把两台设备的子流合成一条）。
   */
  test('v2 → v3：stream_hwm 按子流回填存量 relay 帧的 MAX(seq)', () => {
    const db = new Database(':memory:');
    migrate(db as never, { upTo: 2 });
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
    // v2 时代的库还没有 stream_hwm
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='stream_hwm'").get(),
    ).toBeNull();

    // 用 v2 的表结构直接灌存量：三条子流（phone 会话级 / tablet 会话级 /
    // c2a 机器级），每条多帧，MAX 各不相同
    const insert = db.query(
      `INSERT INTO relay_frames
         (machine_id, session_id, recipient_id, seq, dir, nonce, ciphertext, push_hint, created_at)
       VALUES (?, ?, ?, ?, ?, 'n', 'c', NULL, ?)`,
    );
    for (const seq of [1, 2, 7]) insert.run('mbp', 's1', 'phone', seq, 'a2c', 100 + seq);
    for (const seq of [1, 3]) insert.run('mbp', 's1', 'tablet', seq, 'a2c', 200 + seq);
    for (const seq of [4, 5]) insert.run('mbp', '', '', seq, 'c2a', 300 + seq);

    // 交给 Store：构造函数里的 migrate 把它从 v2 升到最新
    const upgraded = new Store(db);
    expect(
      (upgraded.db.query('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(SCHEMA_VERSION);

    expect(upgraded.streamHwm('mbp', 's1', 'a2c', 'phone')).toBe(7);
    expect(upgraded.streamHwm('mbp', 's1', 'a2c', 'tablet')).toBe(3);
    expect(upgraded.streamHwm('mbp', undefined, 'c2a')).toBe(5);
    // 没有存量的流仍是 fresh（null），不是 0——两者语义不同（见 appendRelayFrame）
    expect(upgraded.streamHwm('mbp', 's2', 'a2c', 'phone')).toBeNull();
    // updated_at 取该子流最新一帧的时刻
    const row = upgraded.db
      .query(
        `SELECT updated_at FROM stream_hwm
         WHERE machine_id = 'mbp' AND session_id = 's1' AND dir = 'a2c' AND recipient_id = 'phone'`,
      )
      .get() as { updated_at: number };
    expect(row.updated_at).toBe(107);

    // 升级后的单调校验以回填的基线为准：回退被拒、正常续发接受
    expect(
      upgraded.appendRelayFrame(frame({ seq: 6, recipientDeviceId: 'phone', createdAt: 999 })),
    ).toEqual({ ok: false, reason: 'seq_not_monotonic', expectedAfter: 7 });
    expect(
      upgraded.appendRelayFrame(frame({ seq: 8, recipientDeviceId: 'phone', createdAt: 999 })).ok,
    ).toBe(true);
    expect(upgraded.streamHwm('mbp', 's1', 'a2c', 'phone')).toBe(8);
  });

  test('migrate 的 upTo 不能超过已定义的迁移数', () => {
    const db = new Database(':memory:');
    expect(() => migrate(db as never, { upTo: SCHEMA_VERSION + 1 })).toThrow();
  });
});

describe('设备表', () => {
  test('注册与查询', () => {
    const r = store.registerDevice('mbp', 'agent', 'PK', 100);
    expect(r.created).toBe(true);
    expect(store.getDevice('mbp')?.role).toBe('agent');
    expect(store.countDevices()).toBe(1);
  });

  test('同 deviceId 重复注册不覆盖公钥（防设备接管）', () => {
    store.registerDevice('mbp', 'agent', 'PK-original', 100);
    const again = store.registerDevice('mbp', 'agent', 'PK-attacker', 200);
    expect(again.created).toBe(false);
    expect(store.getDevice('mbp')?.signPubKey).toBe('PK-original');
  });

  test('吊销设备同时清掉其 token', () => {
    store.registerDevice('mbp', 'agent', 'PK', 100);
    store.putToken('hash1', 'mbp', 100, 999_999_999_999);
    expect(store.lookupToken('hash1', 200)).not.toBeNull();
    store.revokeDevice('mbp', 300);
    expect(store.getDevice('mbp')?.revokedAt).toBe(300);
    expect(store.lookupToken('hash1', 400)).toBeNull();
  });

  test('listDevices 可按角色过滤', () => {
    store.registerDevice('mbp', 'agent', 'A', 1);
    store.registerDevice('phone', 'client', 'B', 2);
    expect(store.listDevices('agent').map((d) => d.deviceId)).toEqual(['mbp']);
    expect(store.listDevices()).toHaveLength(2);
  });
});

describe('挑战串与 token', () => {
  test('挑战串取出即删（一次性，防重放）', () => {
    store.putChallenge('ch1', 'mbp', 5000);
    expect(store.consumeChallenge('ch1', 1000)?.deviceId).toBe('mbp');
    // 第二次必然拿不到
    expect(store.consumeChallenge('ch1', 1000)).toBeNull();
  });

  test('过期挑战串消费返回 null 但同样被删除', () => {
    store.putChallenge('ch1', 'mbp', 1000);
    expect(store.consumeChallenge('ch1', 2000)).toBeNull();
    expect(
      store.db.query('SELECT COUNT(*) AS n FROM auth_challenges').get(),
    ).toEqual({ n: 0 });
  });

  test('token 过期后查不到', () => {
    store.registerDevice('mbp', 'agent', 'PK', 1);
    store.putToken('h', 'mbp', 100, 500);
    expect(store.lookupToken('h', 400)?.deviceId).toBe('mbp');
    expect(store.lookupToken('h', 500)).toBeNull();
    expect(store.lookupToken('h', 600)).toBeNull();
  });
});

describe('认证失败限流', () => {
  test('窗口内累计，窗口过期重置', () => {
    expect(store.recordAuthFailure('mbp', 1000, 0)).toBe(1);
    expect(store.recordAuthFailure('mbp', 1000, 100)).toBe(2);
    expect(store.authFailureCount('mbp', 1000, 200)).toBe(2);
    // 窗口过期
    expect(store.authFailureCount('mbp', 1000, 1500)).toBe(0);
    expect(store.recordAuthFailure('mbp', 1000, 1500)).toBe(1);
  });

  test('成功后清零', () => {
    store.recordAuthFailure('mbp', 1000, 0);
    store.clearAuthFailures('mbp');
    expect(store.authFailureCount('mbp', 1000, 10)).toBe(0);
  });
});

describe('relay 帧：seq 单调、去重、补发', () => {
  test('顺序写入并按 sinceSeq 补发', () => {
    for (let i = 1; i <= 5; i++) {
      expect(store.appendRelayFrame(frame({ seq: i }))).toEqual({
        ok: true,
        duplicate: false,
      });
    }
    const since3 = store.framesSince('mbp', 's1', 'a2c', 3);
    expect(since3.map((f) => f.seq)).toEqual([4, 5]);
    // sinceSeq=0 表示「一条都没收到」，全量补发
    expect(store.framesSince('mbp', 's1', 'a2c', 0)).toHaveLength(5);
  });

  test('seq 0 不是合法帧序号（0 保留给 sinceSeq 的「一帧未收」）', () => {
    expect(store.appendRelayFrame(frame({ seq: 0 }))).toEqual({
      ok: false,
      reason: 'seq_below_first',
    });
  });

  test('同坐标同字节（复推）判 duplicate 并丢弃', () => {
    store.appendRelayFrame(frame({ seq: 1, ciphertext: 'original' }));
    const dup = store.appendRelayFrame(frame({ seq: 1, ciphertext: 'original' }));
    expect(dup).toEqual({ ok: true, duplicate: true });
    expect(store.getFrame('mbp', 's1', 'a2c', 1, 'phone')?.ciphertext).toBe(
      'original',
    );
  });

  test('同坐标不同字节（发送方计数器落后撞上留存 seq）判 seq_not_monotonic，不覆盖原密文', () => {
    // agent 重启丢了计数器从 1 重来，新事件撞上还没清掉的老 seq：早先判成
    // duplicate 静默丢，发送方拿不到 reject 就没法自愈，事件凭空蒸发
    store.appendRelayFrame(frame({ seq: 1, ciphertext: 'original' }));
    store.appendRelayFrame(frame({ seq: 2, ciphertext: 'second' }));
    expect(store.appendRelayFrame(frame({ seq: 1, ciphertext: 'fresh-event' }))).toEqual({
      ok: false,
      reason: 'seq_not_monotonic',
      expectedAfter: 2,
    });
    // nonce 不同同样算不同字节
    expect(store.appendRelayFrame(frame({ seq: 2, ciphertext: 'second', nonce: 'other' }))).toEqual({
      ok: false,
      reason: 'seq_not_monotonic',
      expectedAfter: 2,
    });
    expect(store.getFrame('mbp', 's1', 'a2c', 1, 'phone')?.ciphertext).toBe('original');
    expect(store.getFrame('mbp', 's1', 'a2c', 2, 'phone')?.nonce).toBe('n');
  });

  test('seq 回退被拒绝', () => {
    store.appendRelayFrame(frame({ seq: 5 }));
    const back = store.appendRelayFrame(frame({ seq: 3 }));
    expect(back).toEqual({
      ok: false,
      reason: 'seq_not_monotonic',
      expectedAfter: 5,
    });
    expect(store.getFrame('mbp', 's1', 'a2c', 3)).toBeNull();
  });

  test('N3：seq 跳跃过大被拒（防毒化整条流）', () => {
    store.appendRelayFrame(frame({ seq: 1 }));
    // MAX_SAFE_INTEGER 落库后单调基线被顶到天花板，此后正常帧全被判回退
    expect(
      store.appendRelayFrame(frame({ seq: Number.MAX_SAFE_INTEGER })),
    ).toEqual({
      ok: false,
      reason: 'seq_too_far_ahead',
      expectedAfter: 1,
    });
    // 基线没被污染，正常帧照常接收
    expect(store.appendRelayFrame(frame({ seq: 2 })).ok).toBe(true);
  });

  test('N3：上限之内的跳跃仍然允许（发送方可能因丢帧跳号）', () => {
    store.appendRelayFrame(frame({ seq: 1 }));
    expect(
      store.appendRelayFrame(frame({ seq: 1 + MAX_SEQ_LOOKAHEAD })).ok,
    ).toBe(true);
  });

  test('机器级帧与会话帧是各自独立的 seq 序列', () => {
    store.appendRelayFrame(frame({ sessionId: undefined, seq: 10 }));
    // 机器级已到 10，会话级仍可从 1 开始，互不干扰
    expect(store.appendRelayFrame(frame({ sessionId: 's1', seq: 1 })).ok).toBe(
      true,
    );
    expect(store.maxSeq('mbp', undefined, 'a2c', 'phone')).toBe(10);
    expect(store.maxSeq('mbp', 's1', 'a2c', 'phone')).toBe(1);
    // 补发也各走各的
    expect(
      store.framesSince('mbp', undefined, 'a2c', 0).map((f) => f.seq),
    ).toEqual([10]);
    expect(store.framesSince('mbp', 's1', 'a2c', 0).map((f) => f.seq)).toEqual([
      1,
    ]);
    // 机器级帧读回来 sessionId 是 undefined，不是空串
    expect(store.framesSince('mbp', undefined, 'a2c', 0)[0]!.sessionId).toBeUndefined();
  });

  test('两个方向的 seq 序列互不干扰', () => {
    store.appendRelayFrame(frame({ dir: 'a2c', seq: 7 }));
    expect(store.appendRelayFrame(c2aFrame({ seq: 1 })).ok).toBe(true);
    expect(store.maxSeq('mbp', 's1', 'c2a')).toBe(1);
  });

  test('空 stream 的 maxSeq 是 0（= NO_SEQ_RECEIVED 哨兵）', () => {
    expect(store.maxSeq('mbp', 's1', 'a2c')).toBe(0);
  });

  test('同一逻辑事件发给多个收件人：同 seq 各自落库，不判重复', () => {
    // 矩阵式配对的核心场景。加 recipient_id 到主键之前，第二份会被判
    // duplicate 丢掉，第二台设备就永远收不到能解开的密文
    expect(
      store.appendRelayFrame(
        frame({ seq: 1, recipientDeviceId: 'phone', ciphertext: 'FOR-PHONE' }),
      ),
    ).toEqual({ ok: true, duplicate: false });
    expect(
      store.appendRelayFrame(
        frame({ seq: 1, recipientDeviceId: 'tablet', ciphertext: 'FOR-TABLET' }),
      ),
    ).toEqual({ ok: true, duplicate: false });

    // 两份密文各自完好，没有互相覆盖
    expect(store.getFrame('mbp', 's1', 'a2c', 1, 'phone')?.ciphertext).toBe(
      'FOR-PHONE',
    );
    expect(store.getFrame('mbp', 's1', 'a2c', 1, 'tablet')?.ciphertext).toBe(
      'FOR-TABLET',
    );
    // 同一收件人的同 seq 同字节（复推）仍然去重
    expect(
      store.appendRelayFrame(
        frame({ seq: 1, recipientDeviceId: 'phone', ciphertext: 'FOR-PHONE' }),
      ),
    ).toEqual({ ok: true, duplicate: true });
  });

  test('每个收件人是独立的 seq 子流，单调校验互不牵连', () => {
    store.appendRelayFrame(frame({ seq: 9, recipientDeviceId: 'phone' }));
    // tablet 刚配对，从 1 开始——不分子流的话这里会被判 seq 回退
    expect(
      store.appendRelayFrame(frame({ seq: 1, recipientDeviceId: 'tablet' })).ok,
    ).toBe(true);
    expect(store.maxSeq('mbp', 's1', 'a2c', 'phone')).toBe(9);
    expect(store.maxSeq('mbp', 's1', 'a2c', 'tablet')).toBe(1);
  });

  test('framesSince 按收件人过滤，不传则取全部子流', () => {
    store.appendRelayFrame(frame({ seq: 1, recipientDeviceId: 'phone' }));
    store.appendRelayFrame(frame({ seq: 2, recipientDeviceId: 'phone' }));
    store.appendRelayFrame(frame({ seq: 1, recipientDeviceId: 'tablet' }));

    const phoneOnly = store.framesSince('mbp', 's1', 'a2c', 0, 1000, 'phone');
    expect(phoneOnly.map((f) => f.seq)).toEqual([1, 2]);
    expect(phoneOnly.every((f) => f.recipientDeviceId === 'phone')).toBe(true);
    expect(
      store.framesSince('mbp', 's1', 'a2c', 0, 1000, 'tablet').map((f) => f.seq),
    ).toEqual([1]);
    // 不传收件人 = 不过滤（c2a 补发走的就是这条路径）
    expect(store.framesSince('mbp', 's1', 'a2c', 0)).toHaveLength(3);
  });

  test('trimStream 按子流各算各的 keep', () => {
    for (let i = 1; i <= 10; i++) {
      store.appendRelayFrame(frame({ seq: i, recipientDeviceId: 'phone' }));
      store.appendRelayFrame(frame({ seq: i, recipientDeviceId: 'tablet' }));
    }
    store.trimStream('mbp', 's1', 'a2c', 3, 'phone');
    // phone 被裁到 3 条，tablet 一条不动——混着算的话每台的留存窗口
    // 会缩到 1/N，断线补发能力随配对设备数悄悄变差
    expect(
      store.framesSince('mbp', 's1', 'a2c', 0, 1000, 'phone').map((f) => f.seq),
    ).toEqual([8, 9, 10]);
    expect(store.framesSince('mbp', 's1', 'a2c', 0, 1000, 'tablet')).toHaveLength(
      10,
    );
  });

  test('c2a 帧读回来 recipientDeviceId 是 undefined，不是空串', () => {
    store.appendRelayFrame(c2aFrame({ seq: 1 }));
    const got = store.getFrame('mbp', 's1', 'c2a', 1);
    expect(got?.recipientDeviceId).toBeUndefined();
  });

  test('trimStream 只留最近 N 条', () => {
    for (let i = 1; i <= 10; i++) store.appendRelayFrame(frame({ seq: i }));
    store.trimStream('mbp', 's1', 'a2c', 3, 'phone');
    const left = store.framesSince('mbp', 's1', 'a2c', 0).map((f) => f.seq);
    expect(left).toEqual([8, 9, 10]);
  });

  test('B1 回归：trimStream 不删仍 pending 的 parked 对应密文', () => {
    // 评审实测的场景：128 条排队帧，留存窗口只有 32。
    // 修复前每 64 帧一次的裁剪会削掉 96 条密文，agent 上线后这些消息
    // 被判过期静默吞掉——而 client 手里明明攥着 128 张 parked 回执。
    const BATCH = 128;
    const KEEP = 32;
    const queue = new ParkedQueue(store, 10_000, BATCH);
    for (let i = 1; i <= BATCH; i++) {
      store.appendRelayFrame(c2aFrame({ seq: i }));
      queue.park('mbp', 's1', i, 1000);
      // 复刻 hub 的裁剪节奏
      if (i % 64 === 0) store.trimStream('mbp', 's1', 'c2a', KEEP);
    }

    // 一条都不能少
    const missing: number[] = [];
    for (let i = 1; i <= BATCH; i++) {
      if (store.getFrame('mbp', 's1', 'c2a', i) === null) missing.push(i);
    }
    expect(missing).toEqual([]);
    expect(queue.pendingCount('mbp', 1000)).toBe(BATCH);
  });

  test('B1 回归：已结算的 parked 帧不再受保护，正常被裁', () => {
    const queue = new ParkedQueue(store, 10_000, 100);
    for (let i = 1; i <= 10; i++) {
      store.appendRelayFrame(c2aFrame({ seq: i }));
      queue.park('mbp', 's1', i, 1000);
    }
    // 前 8 条已投递（终态），只剩 9、10 还 pending
    for (let i = 1; i <= 8; i++) queue.markDelivered('mbp', 's1', i, 1100);

    store.trimStream('mbp', 's1', 'c2a', 2);
    // 已结算的被裁掉，pending 的留下
    expect(store.getFrame('mbp', 's1', 'c2a', 1)).toBeNull();
    expect(store.getFrame('mbp', 's1', 'c2a', 9)).not.toBeNull();
    expect(store.getFrame('mbp', 's1', 'c2a', 10)).not.toBeNull();
  });

  test('N4：parked 保护只作用于 c2a，不白白 pin 住同坐标的 a2c 帧', () => {
    const queue = new ParkedQueue(store, 10_000, 100);
    // 同一 (machine, session, seq) 上两个方向各有一帧
    store.appendRelayFrame(c2aFrame({ seq: 1, createdAt: 100 }));
    store.appendRelayFrame(frame({ dir: 'a2c', seq: 1, createdAt: 100 }));
    queue.park('mbp', 's1', 1, 100);

    expect(store.sweepRelayFrames(1000)).toBe(1);
    // c2a 被 parked 保护住；a2c 与排队无关，照常清理
    expect(store.getFrame('mbp', 's1', 'c2a', 1)).not.toBeNull();
    expect(store.getFrame('mbp', 's1', 'a2c', 1)).toBeNull();
  });

  test('sweepRelayFrames 不删仍 pending 的 parked 对应密文', () => {
    store.appendRelayFrame(c2aFrame({ seq: 1, createdAt: 100 }));
    store.appendRelayFrame(c2aFrame({ seq: 2, createdAt: 100 }));
    const queue = new ParkedQueue(store, 10_000, 100);
    queue.park('mbp', 's1', 1, 100);

    const purged = store.sweepRelayFrames(1000);
    // seq=2 无人排队，清掉；seq=1 还 pending，留着
    expect(purged).toBe(1);
    expect(store.getFrame('mbp', 's1', 'c2a', 1)).not.toBeNull();
    expect(store.getFrame('mbp', 's1', 'c2a', 2)).toBeNull();
  });
});

/**
 * 持久高水位（schema.ts v3）：单调基线与留存脱钩。
 *
 * 缺它的后果（agent-wiring 评审 B1）：留存被 TTL sweep 清空后 MAX 归零，
 * 发送方接着按自己的计数器发（会话 seq 早已过万），一帧就撞 lookahead
 * 上限被判「毒化」，此后每帧都被拒，整条流永久报废。
 */
describe('relay 帧：持久高水位 stream_hwm', () => {
  test('sweep 清空留存后高水位不降，续发不撞 lookahead、回退仍被拒', () => {
    for (let seq = 1; seq <= 3; seq++) {
      store.appendRelayFrame(frame({ seq, createdAt: 1000 }));
    }
    expect(store.sweepRelayFrames(5000)).toBe(3);
    // 留存空了，基线还在
    expect(store.framesSince('mbp', 's1', 'a2c', 0, 1000, 'phone')).toHaveLength(0);
    expect(store.maxSeq('mbp', 's1', 'a2c', 'phone')).toBe(3);
    expect(store.streamHwm('mbp', 's1', 'a2c', 'phone')).toBe(3);

    // 正常续发：4 紧接 3，不是「相对 0 跳了 4」
    expect(store.appendRelayFrame(frame({ seq: 4, createdAt: 6000 })).ok).toBe(true);
    // 回退照样被拒，expectedAfter 是持久基线而不是留存 MAX
    expect(store.appendRelayFrame(frame({ seq: 2, createdAt: 6000 }))).toEqual({
      ok: false,
      reason: 'seq_not_monotonic',
      expectedAfter: 4,
    });
  });

  test('会话 seq 过万 + 留存被清空 → 续发不再被判 seq_too_far_ahead（B1 场景）', () => {
    const high = MAX_SEQ_LOOKAHEAD + 500;
    // 一条已经跑到很高的流：为省时间只落基线附近两帧（fresh 首帧即基线）
    store.appendRelayFrame(frame({ seq: high - 1, createdAt: 1000 }));
    store.appendRelayFrame(frame({ seq: high, createdAt: 1000 }));
    store.sweepRelayFrames(5000);
    // 旧实现这里 MAX 归零，high+1 - 0 > MAX_SEQ_LOOKAHEAD → 永久拒收
    expect(store.appendRelayFrame(frame({ seq: high + 1, createdAt: 6000 })).ok).toBe(true);
  });

  test('trimStream 裁掉旧帧后高水位不降', () => {
    for (let seq = 1; seq <= 10; seq++) {
      store.appendRelayFrame(frame({ seq, createdAt: 1000 + seq }));
    }
    store.trimStream('mbp', 's1', 'a2c', 3, 'phone');
    expect(store.framesSince('mbp', 's1', 'a2c', 0, 1000, 'phone').map((f) => f.seq)).toEqual([
      8, 9, 10,
    ]);
    expect(store.maxSeq('mbp', 's1', 'a2c', 'phone')).toBe(10);
    expect(store.appendRelayFrame(frame({ seq: 5 })).ok).toBe(false);
  });

  test('fresh 流：首帧 seq 再大也接受，直接成为基线', () => {
    // 新配对设备的子流撞老会话的高 seq：不跳过 lookahead 的话这一帧永远进不去
    const first = 50_000;
    expect(store.appendRelayFrame(frame({ seq: first, recipientDeviceId: 'new-tablet' }))).toEqual({
      ok: true,
      duplicate: false,
    });
    expect(store.streamHwm('mbp', 's1', 'a2c', 'new-tablet')).toBe(first);
    // 成为基线之后 lookahead 立刻生效（fresh 只是首帧的特权）
    expect(
      store.appendRelayFrame(
        frame({ seq: first + MAX_SEQ_LOOKAHEAD + 1, recipientDeviceId: 'new-tablet' }),
      ),
    ).toEqual({ ok: false, reason: 'seq_too_far_ahead', expectedAfter: first });
    expect(
      store.appendRelayFrame(frame({ seq: first + 1, recipientDeviceId: 'new-tablet' })).ok,
    ).toBe(true);
  });

  test('非 fresh 流：lookahead 照旧生效，且 expectedAfter 为高水位', () => {
    store.appendRelayFrame(frame({ seq: 1 }));
    expect(store.appendRelayFrame(frame({ seq: 2 + MAX_SEQ_LOOKAHEAD }))).toEqual({
      ok: false,
      reason: 'seq_too_far_ahead',
      expectedAfter: 1,
    });
  });

  test('seq 等于高水位但帧已被清理：无从比对字节，按 seq_not_monotonic 让发送方跳号', () => {
    store.appendRelayFrame(frame({ seq: 3, createdAt: 1000 }));
    store.sweepRelayFrames(5000);
    expect(store.appendRelayFrame(frame({ seq: 3, createdAt: 6000 }))).toEqual({
      ok: false,
      reason: 'seq_not_monotonic',
      expectedAfter: 3,
    });
    // 没有复活成一条「新帧」被再次投递/补发
    expect(store.getFrame('mbp', 's1', 'a2c', 3, 'phone')).toBeNull();
  });

  test('高水位按子流分开：收件人 / 方向 / 机器级各自独立', () => {
    store.appendRelayFrame(frame({ seq: 9, recipientDeviceId: 'phone' }));
    store.appendRelayFrame(frame({ seq: 2, recipientDeviceId: 'tablet' }));
    store.appendRelayFrame(c2aFrame({ seq: 4 }));
    store.appendRelayFrame(frame({ sessionId: undefined, seq: 6 }));
    expect(store.streamHwm('mbp', 's1', 'a2c', 'phone')).toBe(9);
    expect(store.streamHwm('mbp', 's1', 'a2c', 'tablet')).toBe(2);
    expect(store.streamHwm('mbp', 's1', 'c2a')).toBe(4);
    expect(store.streamHwm('mbp', undefined, 'a2c', 'phone')).toBe(6);
    expect(store.streamHwm('mbp', 's2', 'a2c', 'phone')).toBeNull();
  });

  test('sweepStreamHwm：长期不活跃的流删基线、变回 fresh；活跃流不动', () => {
    store.appendRelayFrame(frame({ seq: 500, createdAt: 1000 }));
    store.appendRelayFrame(frame({ seq: 7, sessionId: 's2', createdAt: 900_000 }));
    // 只清 updated_at < olderThan 的
    expect(store.sweepStreamHwm(500_000)).toBe(1);
    expect(store.streamHwm('mbp', 's1', 'a2c', 'phone')).toBeNull();
    expect(store.streamHwm('mbp', 's2', 'a2c', 'phone')).toBe(7);
    // 变回 fresh：下一帧任意 seq 成为新基线（D10 fresh 语义），此后单调照常
    expect(store.appendRelayFrame(frame({ seq: 3, createdAt: 1_000_000 })).ok).toBe(true);
    expect(store.streamHwm('mbp', 's1', 'a2c', 'phone')).toBe(3);
    expect(store.appendRelayFrame(frame({ seq: 2, createdAt: 1_000_000 })).ok).toBe(false);
  });

  test('高水位的 updated_at 随每帧刷新（活跃流不会被 TTL 误清）', () => {
    store.appendRelayFrame(frame({ seq: 1, createdAt: 1000 }));
    store.appendRelayFrame(frame({ seq: 2, createdAt: 999_000 }));
    expect(store.sweepStreamHwm(500_000)).toBe(0);
    expect(store.streamHwm('mbp', 's1', 'a2c', 'phone')).toBe(2);
  });

  test('被拒的帧不推高水位', () => {
    store.appendRelayFrame(frame({ seq: 5 }));
    store.appendRelayFrame(frame({ seq: 5 + MAX_SEQ_LOOKAHEAD + 1 }));
    store.appendRelayFrame(frame({ seq: 2 }));
    expect(store.streamHwm('mbp', 's1', 'a2c', 'phone')).toBe(5);
  });
});

describe('游标', () => {
  test('只进不退：迟到的旧 sync 不会把游标拖回去', () => {
    store.setCursor('dev', 'mbp', 's1', 10, 1);
    store.setCursor('dev', 'mbp', 's1', 3, 2);
    expect(store.getCursor('dev', 'mbp', 's1')).toBe(10);
  });

  test('机器级与会话级游标分开记', () => {
    store.setCursor('dev', 'mbp', undefined, 5, 1);
    store.setCursor('dev', 'mbp', 's1', 9, 1);
    expect(store.getCursor('dev', 'mbp', undefined)).toBe(5);
    expect(store.getCursor('dev', 'mbp', 's1')).toBe(9);
  });
});

describe('stream key 归一', () => {
  test('机器级用空串表示', () => {
    expect(streamKey(undefined)).toBe(MACHINE_STREAM);
    expect(streamKey('s1')).toBe('s1');
  });
});

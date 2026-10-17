/**
 * outbox 单测。自愈用例的数据形状按服务端真实产生的来（learnings 2026-09-13）：
 * - `seq_not_monotonic` 只在 seq ≤ 高水位时产生 → `expectedAfter ≥ 被拒 seq`；
 * - `seq_too_far_ahead` 只在 seq − 高水位 > 1e6 时产生 → `expectedAfter < seq`。
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPair, openJson, sodiumReady, type BoxKeyPair } from '@trine/core/crypto';
import type { ClientToAgentEvent, TransportFrame } from '@trine/core';
import { Outbox, OutboxScopeFatalError, type RelayRejectFrame } from './outbox.ts';

let agent: BoxKeyPair;
let client: BoxKeyPair;

beforeAll(async () => {
  await sodiumReady();
  agent = generateKeyPair();
  client = generateKeyPair();
});

interface Harness {
  outbox: Outbox;
  frames: Extract<TransportFrame, { type: 'relay' }>[];
  seqs: Map<string, number>;
  online: { value: boolean };
  gaveUp: string[];
  fatal: string[];
  rejectedInputs: string[];
  decrypt: (frame: Extract<TransportFrame, { type: 'relay' }>) => ClientToAgentEvent;
}

function harness(over: { capacity?: number; maxAttempts?: number } = {}): Harness {
  const frames: Harness['frames'] = [];
  const seqs = new Map<string, number>();
  const online = { value: true };
  const gaveUp: string[] = [];
  const fatal: string[] = [];
  const rejectedInputs: string[] = [];
  const outbox = new Outbox({
    seq: {
      get: (m, s) => seqs.get(`${m}/${s}`) ?? 0,
      set: (m, s, v) => void seqs.set(`${m}/${s}`, v),
    },
    agentKeyFor: (m) => (m === 'mbp' ? agent.publicKey : undefined),
    boxSecretKey: client.secretKey,
    transmit: (frame) => {
      if (!online.value) return false;
      frames.push(frame as Extract<TransportFrame, { type: 'relay' }>);
      return true;
    },
    now: () => 1_000,
    onGaveUp: (_m, _s, detail) => void gaveUp.push(detail),
    onScopeFatal: (_m, _s, detail) => void fatal.push(detail),
    onInputRejected: (_m, _s, clientMsgId) => void rejectedInputs.push(clientMsgId),
    ...over,
  });
  const decrypt = (frame: Extract<TransportFrame, { type: 'relay' }>) =>
    openJson({ nonce: frame.nonce, ciphertext: frame.ciphertext }, client.publicKey, agent.secretKey) as ClientToAgentEvent;
  return { outbox, frames, seqs, online, gaveUp, fatal, rejectedInputs, decrypt };
}

const reject = (over: Partial<RelayRejectFrame> & Pick<RelayRejectFrame, 'seq' | 'reason'>): RelayRejectFrame => ({
  type: 'relay.reject',
  machineId: 'mbp',
  ...over,
});

describe('outbox · 发送', () => {
  test('每 scope 独立分配 seq（从 1 起）；信封与密文一致，agent 能解', () => {
    const h = harness();
    h.outbox.send('mbp', { type: 'session.list.request', reqId: 'q1' });
    h.outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c1', text: 'a' });
    h.outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c2', text: 'b' });
    expect(h.frames.map((f) => [f.sessionId, f.seq])).toEqual([[undefined, 1], ['s1', 1], ['s1', 2]]);
    const decrypted = h.decrypt(h.frames[2]!);
    expect(decrypted).toMatchObject({ type: 'input.send', sessionId: 's1', seq: 2, dir: 'c2a', ts: 1_000, clientMsgId: 'c2' });
    // 帧上没有 recipientDeviceId（c2a 约定）
    expect('recipientDeviceId' in h.frames[0]!).toBe(false);
  });

  test('未配对机器 → 抛错', () => {
    const h = harness();
    expect(() => h.outbox.send('ghost', { type: 'session.list.request', reqId: 'q' })).toThrow(/未配对/);
  });

  test('连接不在 → 入队；flush 后按序发出；队列非空时新帧排队尾', () => {
    const h = harness();
    h.online.value = false;
    h.outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c1', text: 'a' });
    h.online.value = true; // 连接回来了但还没 flush
    h.outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c2', text: 'b' });
    expect(h.frames).toHaveLength(0);
    expect(h.outbox.queuedCount).toBe(2);
    h.outbox.flush();
    expect(h.frames.map((f) => f.seq)).toEqual([1, 2]);
    expect(h.outbox.queuedCount).toBe(0);
  });
});

describe('outbox · seq_not_monotonic 自愈（服务端真实形状：expectedAfter ≥ 被拒 seq）', () => {
  test('计数器落后：跳到高水位、重发 [被拒, 高水位] 区间内的帧；同批后到的 reject 不重发；重复 reject 去重', () => {
    const h = harness();
    // 本地从 1 起发了 3 帧，服务端该流高水位其实是 10（另一台设备发过）
    h.outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c1', text: 'a' });
    h.outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c2', text: 'b' });
    h.outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c3', text: 'c' });
    h.frames.length = 0;

    const first = h.outbox.onReject(reject({ sessionId: 's1', seq: 1, reason: 'seq_not_monotonic', expectedAfter: 10 }));
    expect(first).toEqual({ kind: 'resent', count: 3, seqs: [11, 12, 13] });
    expect(h.frames.map((f) => f.seq)).toEqual([11, 12, 13]);
    expect(h.frames.map((f) => h.decrypt(f).seq)).toEqual([11, 12, 13]);
    expect(h.decrypt(h.frames[0]!)).toMatchObject({ clientMsgId: 'c1' });
    expect(h.seqs.get('mbp/s1')).toBe(13);
    // 同批：服务端对 2、3 也各回一条 reject
    expect(h.outbox.onReject(reject({ sessionId: 's1', seq: 2, reason: 'seq_not_monotonic', expectedAfter: 10 }))).toEqual({ kind: 'ignored', reason: 'already_resent' });
    expect(h.outbox.onReject(reject({ sessionId: 's1', seq: 1, reason: 'seq_not_monotonic', expectedAfter: 10 }))).toEqual({ kind: 'duplicate' });
    // 后续新帧接着 14
    h.outbox.send('mbp', { type: 'run.stop', sessionId: 's1' });
    expect(h.frames.at(-1)!.seq).toBe(14);
    // 缓冲里的 seq 已更新：input.parked{seq:12} 能关联回 c2
    expect(h.outbox.clientMsgIdForSeq('mbp', 's1', 12)).toBe('c2');
    expect(h.outbox.clientMsgIdForSeq('mbp', 's1', 2)).toBeUndefined();
  });

  test('机器级 scope 与会话 scope 互不影响', () => {
    const h = harness();
    h.outbox.send('mbp', { type: 'session.list.request', reqId: 'q' });
    h.outbox.send('mbp', { type: 'run.stop', sessionId: 's1' });
    h.frames.length = 0;
    h.outbox.onReject(reject({ seq: 1, reason: 'seq_not_monotonic', expectedAfter: 5 }));
    expect(h.frames.map((f) => [f.sessionId, f.seq])).toEqual([[undefined, 6]]);
    expect(h.seqs.get('mbp/s1')).toBe(1);
  });

  test('同一帧重发 3 次仍被拒 → 放弃并回调，不无限重发', () => {
    const h = harness();
    h.outbox.send('mbp', { type: 'run.stop', sessionId: 's1' });
    let hwm = 10;
    let seq = 1;
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const outcome = h.outbox.onReject(reject({ sessionId: 's1', seq, reason: 'seq_not_monotonic', expectedAfter: hwm }));
      outcomes.push(outcome.kind);
      if (outcome.kind === 'resent') {
        seq = outcome.seqs[0]!;
        hwm = seq + 10;
      }
    }
    expect(outcomes).toEqual(['resent', 'resent', 'resent', 'gave_up']);
    expect(h.gaveUp).toHaveLength(1);
    expect(h.gaveUp[0]).toMatch(/3 次仍被拒/);
    expect(h.outbox.size('mbp', 's1')).toBe(0);
  });

  test('缺 expectedAfter（旧服务端）→ 放弃；被拒帧已滚出缓冲 → lost', () => {
    const h = harness({ capacity: 2 });
    h.outbox.send('mbp', { type: 'run.stop', sessionId: 's1' });
    expect(h.outbox.onReject(reject({ sessionId: 's1', seq: 1, reason: 'seq_not_monotonic' })).kind).toBe('gave_up');

    const h2 = harness({ capacity: 2 });
    for (let i = 0; i < 4; i++) h2.outbox.send('mbp', { type: 'run.stop', sessionId: 's1' });
    // seq 1、2 已滚出（只剩 3、4）
    expect(h2.outbox.onReject(reject({ sessionId: 's1', seq: 1, reason: 'seq_not_monotonic', expectedAfter: 2 })).kind).toBe('lost');
  });

  test('多 client 并发场景：另一台设备把高水位推高，本地一撞即收敛，之后不再撞', () => {
    const h = harness();
    // 模拟服务端：记录高水位，seq ≤ hwm 就拒
    let hwm = 0;
    const server = (frame: Extract<TransportFrame, { type: 'relay' }>): RelayRejectFrame | null => {
      if (frame.seq <= hwm) return reject({ sessionId: frame.sessionId!, seq: frame.seq, reason: 'seq_not_monotonic', expectedAfter: hwm });
      hwm = frame.seq;
      return null;
    };
    hwm = 40; // 另一台设备已发到 40
    h.outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c1', text: 'x' });
    const rej = server(h.frames[0]!);
    expect(rej).not.toBeNull();
    h.outbox.onReject(rej!);
    expect(server(h.frames[1]!)).toBeNull();
    expect(h.frames[1]!.seq).toBe(41);
    h.outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c2', text: 'y' });
    expect(server(h.frames[2]!)).toBeNull();
    expect(h.frames[2]!.seq).toBe(42);
  });
});

describe('outbox · 不自愈的拒绝', () => {
  test('seq_too_far_ahead（expectedAfter < seq）→ 不重发、scope 标 fatal、只回调一次；resetScope 归零', () => {
    const h = harness();
    // 本地计数器被人为拨到 2_000_000 附近（如导入了别处的状态）
    h.seqs.set('mbp/s1', 2_000_000);
    h.outbox.send('mbp', { type: 'run.stop', sessionId: 's1' });
    h.frames.length = 0;
    const outcome = h.outbox.onReject(reject({ sessionId: 's1', seq: 2_000_001, reason: 'seq_too_far_ahead', expectedAfter: 3 }));
    expect(outcome.kind).toBe('fatal');
    expect(h.frames).toHaveLength(0);
    expect(h.outbox.isScopeFatal('mbp', 's1')).toBe(true);
    // 计数器没被拉到 expectedAfter（那是往后跳，对领先无解）
    expect(h.seqs.get('mbp/s1')).toBe(2_000_001);
    h.outbox.onReject(reject({ sessionId: 's1', seq: 2_000_002, reason: 'seq_too_far_ahead', expectedAfter: 3 }));
    expect(h.fatal).toHaveLength(1);
    h.outbox.resetScope('mbp', 's1');
    expect(h.seqs.get('mbp/s1')).toBe(0);
    expect(h.outbox.isScopeFatal('mbp', 's1')).toBe(false);
    h.outbox.send('mbp', { type: 'run.stop', sessionId: 's1' });
    expect(h.frames.at(-1)!.seq).toBe(1);
  });

  test('B4：resetScope 清该 scope 的 reject 去重表——重置后同 seq 再被拒仍会重发', () => {
    const h = harness();
    h.outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c1', text: 'a' });
    expect(h.outbox.onReject(reject({ sessionId: 's1', seq: 1, reason: 'seq_not_monotonic', expectedAfter: 10 })).kind).toBe('resent');
    h.outbox.resetScope('mbp', 's1');
    h.frames.length = 0;
    h.outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c2', text: 'b' });
    expect(h.frames.at(-1)!.seq).toBe(1);
    const again = h.outbox.onReject(reject({ sessionId: 's1', seq: 1, reason: 'seq_not_monotonic', expectedAfter: 11 }));
    expect(again).toEqual({ kind: 'resent', count: 1, seqs: [12] });
    expect(h.decrypt(h.frames.at(-1)!)).toMatchObject({ clientMsgId: 'c2', seq: 12 });
    // 别的 scope 的去重表不受影响
    h.outbox.send('mbp', { type: 'session.list.request', reqId: 'q' });
    expect(h.outbox.onReject(reject({ seq: 1, reason: 'seq_not_monotonic', expectedAfter: 3 })).kind).toBe('resent');
    expect(h.outbox.onReject(reject({ seq: 1, reason: 'seq_not_monotonic', expectedAfter: 3 })).kind).toBe('duplicate');
  });

  test('parked_quota_exceeded → 对应 input.send 的本地条目 failed', () => {
    const h = harness();
    h.outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c9', text: 'x' });
    const outcome = h.outbox.onReject(reject({ sessionId: 's1', seq: 1, reason: 'parked_quota_exceeded' }));
    expect(outcome).toEqual({ kind: 'input_failed', clientMsgId: 'c9' });
    expect(h.rejectedInputs).toEqual(['c9']);
    // 已从缓冲移除：后续 not_monotonic 区间重发不会把它再投一遍
    expect(h.outbox.size('mbp', 's1')).toBe(0);
    expect(h.outbox.clientMsgIdForSeq('mbp', 's1', 1)).toBeUndefined();
  });

  test('seq_below_first 等其他原因忽略', () => {
    const h = harness();
    expect(h.outbox.onReject(reject({ sessionId: 's1', seq: 0, reason: 'seq_below_first' })).kind).toBe('ignored');
  });
});

describe('outbox · B3 放弃/fatal 时受影响的 input.send 回传，fatal scope 拒绝发送', () => {
  test('缺 expectedAfter 放弃：回调带缓冲里全部 input.send 的 clientMsgId', () => {
    const ids: string[][] = [];
    const h = harness();
    const outbox = new Outbox({
      seq: { get: (m, s) => h.seqs.get(`${m}/${s}`) ?? 0, set: (m, s, v) => void h.seqs.set(`${m}/${s}`, v) },
      agentKeyFor: () => agent.publicKey,
      boxSecretKey: client.secretKey,
      transmit: () => true,
      now: () => 1,
      onGaveUp: (_m, _s, _d, clientMsgIds) => void ids.push(clientMsgIds),
    });
    outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c1', text: 'a' });
    outbox.send('mbp', { type: 'run.stop', sessionId: 's1' });
    outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c2', text: 'b' });
    expect(outbox.onReject(reject({ sessionId: 's1', seq: 1, reason: 'seq_not_monotonic' })).kind).toBe('gave_up');
    expect(ids).toEqual([['c1', 'c2']]);
  });

  test('seq_too_far_ahead：回调带 clientMsgId、清缓冲；之后 send() 抛 OutboxScopeFatalError 不发帧；resetScope 后恢复', () => {
    const fatalIds: string[][] = [];
    const h = harness();
    const outbox = new Outbox({
      seq: { get: (m, s) => h.seqs.get(`${m}/${s}`) ?? 0, set: (m, s, v) => void h.seqs.set(`${m}/${s}`, v) },
      agentKeyFor: () => agent.publicKey,
      boxSecretKey: client.secretKey,
      transmit: (f) => {
        h.frames.push(f as never);
        return true;
      },
      now: () => 1,
      onScopeFatal: (_m, _s, _d, clientMsgIds) => void fatalIds.push(clientMsgIds),
    });
    h.seqs.set('mbp/s1', 2_000_000);
    outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c1', text: 'a' });
    outbox.onReject(reject({ sessionId: 's1', seq: 2_000_001, reason: 'seq_too_far_ahead', expectedAfter: 3 }));
    expect(fatalIds).toEqual([['c1']]);
    expect(outbox.size('mbp', 's1')).toBe(0);
    h.frames.length = 0;
    expect(() => outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c2', text: 'b' })).toThrow(OutboxScopeFatalError);
    expect(h.frames).toHaveLength(0);
    // 别的 scope 不受影响
    outbox.send('mbp', { type: 'session.list.request', reqId: 'q' });
    expect(h.frames).toHaveLength(1);
    outbox.resetScope('mbp', 's1');
    outbox.send('mbp', { type: 'input.send', sessionId: 's1', clientMsgId: 'c3', text: 'c' });
    expect(h.frames.at(-1)!.seq).toBe(1);
  });
});

describe('outbox · dropScope（会话被永久删除）', () => {
  test('只丢该 scope 的待发帧与缓冲，其他 scope 顺序不变；outSeq 计数器保留', () => {
    const h = harness();
    h.online.value = false;
    h.outbox.send('mbp', { type: 'input.send', sessionId: 'gone', clientMsgId: 'c1', text: 'a' });
    h.outbox.send('mbp', { type: 'input.send', sessionId: 'keep', clientMsgId: 'c2', text: 'b' });
    h.outbox.send('mbp', { type: 'run.stop', sessionId: 'gone' });
    h.outbox.send('mbp', { type: 'session.list.request', reqId: 'q' });
    expect(h.outbox.queuedCount).toBe(4);
    const dropped = h.outbox.dropScope('mbp', 'gone');
    expect(dropped.map((d) => d.event.type)).toEqual(['input.send', 'run.stop']);
    expect(h.outbox.queuedCount).toBe(2);
    expect(h.outbox.size('mbp', 'gone')).toBe(0);
    expect(h.outbox.size('mbp', 'keep')).toBe(1);
    expect(h.seqs.get('mbp/gone')).toBe(2);
    h.online.value = true;
    h.outbox.flush();
    expect(h.frames.map((f) => [f.sessionId, h.decrypt(f).type])).toEqual([
      ['keep', 'input.send'],
      [undefined, 'session.list.request'],
    ]);
  });
});

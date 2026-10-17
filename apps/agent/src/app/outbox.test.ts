/**
 * relay.reject 自愈（方案 §4c）：去重、跳号、只重发给被拒收件人、降级与放弃。
 */
import { describe, expect, test } from 'bun:test';
import type { AgentToClientEvent, PushHint } from '@trine/core';
import { EventEmitter } from '../bridge/emitter.ts';
import type { OutboundEvent } from '../bridge/types.ts';
import { Outbox, pushHintFor, type RelayRejectFrame } from './outbox.ts';

interface Sent {
  recipient: string;
  event: AgentToClientEvent;
  hint: PushHint | undefined;
}

function makeHarness(options: { recipients?: string[]; capacity?: number; maxAttempts?: number } = {}) {
  const recipients = options.recipients ?? ['phone'];
  const published: OutboundEvent[] = [];
  const sent: Sent[] = [];
  const logs: string[] = [];
  let outbox!: Outbox;
  const emitter = new EventEmitter({
    now: () => 1000,
    // 与 app.ts 的 sink 同形：先 remember 再「发给全员」（这里只记录）
    sink: (out) => {
      outbox.remember(out);
      published.push(out);
    },
  });
  outbox = new Outbox({
    emitter,
    publishTo: (recipient, event, hint) => {
      sent.push({ recipient, event, hint });
      return true;
    },
    recipientIds: () => recipients,
    pushHintFor,
    log: (l) => logs.push(l),
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });
  return { emitter, outbox, published, sent, logs, recipients };
}

function reject(over: Partial<RelayRejectFrame> = {}): RelayRejectFrame {
  return {
    type: 'relay.reject',
    machineId: 'mbp',
    sessionId: 's1',
    recipientDeviceId: 'phone',
    seq: 1,
    reason: 'seq_not_monotonic',
    expectedAfter: 240,
    ...over,
  };
}

const delta = (text: string) => ({ type: 'assistant.delta' as const, messageId: 'm1', text });

describe('Outbox · 自愈重发', () => {
  test('被拒后跳号并按序重发缓冲里 seq ≥ 被拒 seq 的帧，只发给该收件人', () => {
    const { emitter, outbox, sent } = makeHarness();
    // agent 重启后从 1 起发了三帧，服务端该子流高水位 240
    emitter.emit(delta('a'), 's1');
    emitter.emit(delta('b'), 's1');
    emitter.emit(delta('c'), 's1');
    expect(emitter.peekSeq('s1')).toBe(4);

    const outcome = outbox.onReject(reject({ seq: 1 }));
    expect(outcome).toMatchObject({
      kind: 'resent',
      recipient: 'phone',
      count: 3,
      seqs: [241, 242, 243],
      lostHead: false,
    });
    expect(sent.map((s) => [s.recipient, s.event.seq, (s.event as { text: string }).text])).toEqual([
      ['phone', 241, 'a'],
      ['phone', 242, 'b'],
      ['phone', 243, 'c'],
    ]);
    // 后续新帧自然接在跳高后的位置
    expect(emitter.emit(delta('d'), 's1').event.seq).toBe(244);
    // 重发帧保留原有信封其余字段（sessionId / dir / ts）
    expect(sent[0]!.event).toMatchObject({ sessionId: 's1', dir: 'a2c', ts: 1000 });
  });

  test('同批 reject 的后到者（seq 2、3）不重复重发', () => {
    const { emitter, outbox, sent } = makeHarness();
    emitter.emit(delta('a'), 's1');
    emitter.emit(delta('b'), 's1');
    emitter.emit(delta('c'), 's1');
    outbox.onReject(reject({ seq: 1 }));
    expect(outbox.onReject(reject({ seq: 2 }))).toEqual({ kind: 'ignored', reason: 'already_resent' });
    expect(outbox.onReject(reject({ seq: 3 }))).toEqual({ kind: 'ignored', reason: 'already_resent' });
    expect(sent).toHaveLength(3);
  });

  test('去重：同一 (scope, seq, recipient) 的 reject 只处理一次', () => {
    const { emitter, outbox, sent } = makeHarness();
    emitter.emit(delta('a'), 's1');
    outbox.onReject(reject({ seq: 1 }));
    expect(outbox.onReject(reject({ seq: 1 }))).toEqual({ kind: 'duplicate' });
    expect(sent).toHaveLength(1);
  });

  test('机器级 scope（sessionId 省略）同样自愈', () => {
    const { emitter, outbox, sent } = makeHarness();
    emitter.emit({ type: 'cwd.updated', favorites: [], defaultCwd: '/' }, null);
    const outcome = outbox.onReject(reject({ sessionId: undefined, seq: 1, expectedAfter: 9 }));
    expect(outcome).toMatchObject({ kind: 'resent', seqs: [10] });
    expect(sent[0]!.event.sessionId).toBeUndefined();
    expect(emitter.peekSeq(null)).toBe(11);
  });

  test('矩阵式配对：phone 拒、tablet 收——只补 phone，tablet 一帧不多', () => {
    const { emitter, outbox, sent } = makeHarness({ recipients: ['phone', 'tablet'] });
    emitter.emit(delta('a'), 's1');
    emitter.emit(delta('b'), 's1');
    const outcome = outbox.onReject(reject({ seq: 1, recipientDeviceId: 'phone' }));
    expect(outcome).toMatchObject({ kind: 'resent', recipient: 'phone', count: 2 });
    expect(sent.every((s) => s.recipient === 'phone')).toBe(true);

    // 随后 tablet 也拒（它的高水位是 5）：判断「tablet 没收到哪些」要看发给 tablet
    // 时的 seq（1、2），不能被刚给 phone 重发的 241、242 干扰
    const second = outbox.onReject(reject({ seq: 1, recipientDeviceId: 'tablet', expectedAfter: 5 }));
    expect(second).toMatchObject({ kind: 'resent', recipient: 'tablet', count: 2 });
    const toTablet = sent.filter((s) => s.recipient === 'tablet');
    expect(toTablet.map((s) => (s.event as { text: string }).text)).toEqual(['a', 'b']);
    // 计数器已在 243，不回退；tablet 那份用新 seq 243、244
    expect(toTablet.map((s) => s.event.seq)).toEqual([243, 244]);
  });

  test('定向帧（to）只记那一台：别的设备拒了也不会被补发', () => {
    const { emitter, outbox, sent, published } = makeHarness({ recipients: ['phone', 'tablet'] });
    emitter.emit(delta('all'), 's1');
    emitter.emit(delta('only-tablet'), 's1', { to: 'tablet' });
    expect(published[1]!.to).toBe('tablet');
    expect(published[0]!.to).toBeUndefined();
    // phone 拒了 seq 1 起：只补它真收到过的那条 'all'，不补定向给 tablet 的帧
    const phoneOutcome = outbox.onReject(reject({ seq: 1, recipientDeviceId: 'phone', expectedAfter: 10 }));
    expect(phoneOutcome).toMatchObject({ kind: 'resent', recipient: 'phone', count: 1 });
    expect(sent.map((s) => (s.event as { text: string }).text)).toEqual(['all']);
    // tablet 拒了：两条都补
    const tabletOutcome = outbox.onReject(reject({ seq: 1, recipientDeviceId: 'tablet', expectedAfter: 20 }));
    expect(tabletOutcome).toMatchObject({ kind: 'resent', recipient: 'tablet', count: 2 });
  });

  test('缺 recipientDeviceId：名册只有一台就当是它；多台则放弃并报 fatal', () => {
    const single = makeHarness();
    single.emitter.emit(delta('a'), 's1');
    expect(single.outbox.onReject(reject({ recipientDeviceId: undefined }))).toMatchObject({
      kind: 'resent',
      recipient: 'phone',
    });

    const multi = makeHarness({ recipients: ['phone', 'tablet'] });
    multi.emitter.emit(delta('a'), 's1');
    const before = multi.published.length;
    expect(multi.outbox.onReject(reject({ recipientDeviceId: undefined }))).toMatchObject({ kind: 'gave_up' });
    expect(multi.sent).toHaveLength(0);
    // 机器级 error.fatal 告知用户
    const fatal = multi.published.slice(before).map((p) => p.event);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({ type: 'error.fatal', kind: 'other' });
    expect(fatal[0]!.sessionId).toBeUndefined();
  });

  test('无 expectedAfter（旧服务端）→ 放弃 + fatal，不瞎猜', () => {
    const { emitter, outbox, sent, published } = makeHarness();
    emitter.emit(delta('a'), 's1');
    const outcome = outbox.onReject(reject({ expectedAfter: undefined }));
    expect(outcome).toMatchObject({ kind: 'gave_up' });
    expect(sent).toHaveLength(0);
    expect(published.at(-1)!.event.type).toBe('error.fatal');
    // 计数器没被动过
    expect(emitter.peekSeq('s1')).toBe(2);
  });

  test('同一帧重发 3 次仍被拒 → 放弃该 scope，清缓冲', () => {
    const { emitter, outbox, published } = makeHarness({ maxAttempts: 3 });
    emitter.emit(delta('a'), 's1');
    // 服务端每次都用更高的高水位拒回来（模拟持续失配）
    let seq = 1;
    let hwm = 10;
    for (let i = 0; i < 3; i++) {
      const outcome = outbox.onReject(reject({ seq, expectedAfter: hwm }));
      expect(outcome.kind).toBe('resent');
      seq = (outcome as { seqs: number[] }).seqs[0]!;
      hwm = seq + 10;
    }
    const fourth = outbox.onReject(reject({ seq, expectedAfter: hwm }));
    expect(fourth).toMatchObject({ kind: 'gave_up' });
    expect(published.at(-1)!.event.type).toBe('error.fatal');
    // s1 的缓冲已清（fatal 是机器级，进的是另一条 scope 的缓冲）
    expect(outbox.size('s1')).toBe(0);
    expect(outbox.size(null)).toBe(1);
  });

  test('被拒帧部分滚出缓冲 → 补还在的、warn 丢掉的；全滚出 → lost', () => {
    const { emitter, outbox, logs, sent } = makeHarness({ capacity: 2 });
    emitter.emit(delta('a'), 's1'); // seq 1，随后被挤出
    emitter.emit(delta('b'), 's1');
    emitter.emit(delta('c'), 's1');
    expect(outbox.size('s1')).toBe(2);
    // 服务端拒了 seq 1（高水位 240）：2、3 同样在高水位之下，能补的补上
    expect(outbox.onReject(reject({ seq: 1 }))).toMatchObject({ kind: 'resent', count: 2, lostHead: true });
    expect(sent.map((s) => (s.event as { text: string }).text)).toEqual(['b', 'c']);
    expect(logs.some((l) => l.includes('滚出缓冲'))).toBe(true);

    // 缓冲空时被拒：一帧也补不了
    const empty = makeHarness();
    expect(empty.outbox.onReject(reject({ seq: 1 }))).toEqual({ kind: 'lost', recipient: 'phone' });
  });

  test('非 seq 类原因忽略', () => {
    const { outbox } = makeHarness();
    expect(outbox.onReject(reject({ reason: 'parked_quota_exceeded' }))).toMatchObject({ kind: 'ignored' });
    expect(outbox.onReject(reject({ reason: 'seq_below_first' }))).toMatchObject({ kind: 'ignored' });
  });

  test('seq_too_far_ahead（真实形状：seq 领先高水位超过 lookahead）→ 不重发，放弃 + 一次 fatal + 明确日志', () => {
    const { emitter, outbox, sent, published, logs } = makeHarness();
    // 本地计数器领先服务端太多：服务端只在 seq - hwm > 1e6 时给这个原因，
    // 所以 expectedAfter < seq 恒成立——跳号往前无解，重发必再拒
    emitter.setNext('s1', 1_000_100);
    emitter.emit(delta('a'), 's1');
    const outcome = outbox.onReject(
      reject({ reason: 'seq_too_far_ahead', seq: 1_000_100, expectedAfter: 3 }),
    );
    expect(outcome).toMatchObject({ kind: 'gave_up' });
    expect(sent).toHaveLength(0);
    // 计数器不动（跳号对领先无意义）
    expect(emitter.peekSeq('s1')).toBe(1_000_101);
    const fatal = published.filter((p) => p.event.type === 'error.fatal');
    expect(fatal).toHaveLength(1);
    expect((fatal[0]!.event as { message: string }).message).toContain('state.json');
    expect(logs.some((l) => l.includes('seq_too_far_ahead') && l.includes('高水位=3'))).toBe(true);
    // 同 scope 再次被拒：不再刷第二条 fatal（fatal 自身也是一帧，防自激循环）
    emitter.emit(delta('b'), 's1');
    outbox.onReject(reject({ reason: 'seq_too_far_ahead', seq: 1_000_101, expectedAfter: 3 }));
    expect(published.filter((p) => p.event.type === 'error.fatal')).toHaveLength(1);
  });

  test('机器级流 too_far_ahead：fatal 本身被拒也不会自激循环', () => {
    const { emitter, outbox, published } = makeHarness();
    emitter.setNext(null, 2_000_000);
    emitter.emit({ type: 'cwd.updated', favorites: [], defaultCwd: '/' }, null);
    outbox.onReject(reject({ sessionId: undefined, reason: 'seq_too_far_ahead', seq: 2_000_000, expectedAfter: 5 }));
    const fatalSeq = published.at(-1)!.event.seq;
    expect(published.at(-1)!.event.type).toBe('error.fatal');
    // 服务端把这条 fatal 也拒回来
    outbox.onReject(reject({ sessionId: undefined, reason: 'seq_too_far_ahead', seq: fatalSeq, expectedAfter: 5 }));
    expect(published.filter((p) => p.event.type === 'error.fatal')).toHaveLength(1);
  });

  test('同批 reject 的后到者被跳过时留一行日志', () => {
    const { emitter, outbox, logs } = makeHarness();
    emitter.emit(delta('a'), 's1');
    emitter.emit(delta('b'), 's1');
    outbox.onReject(reject({ seq: 1 }));
    outbox.onReject(reject({ seq: 2 }));
    expect(logs.some((l) => l.includes('已重发过，跳过'))).toBe(true);
  });

  test('重发保留 pushHint 映射', () => {
    const { emitter, outbox, sent } = makeHarness();
    emitter.emit(
      { type: 'permission.request', requestId: 'r1', toolName: 'Bash', input: {}, requestedAt: 1 },
      's1',
    );
    outbox.onReject(reject({ seq: 1 }));
    expect(sent[0]!.hint).toBe('permission_pending');
  });
});

describe('pushHintFor', () => {
  const base = { ts: 1, seq: 1, dir: 'a2c' as const, sessionId: 's1' };
  test('三类事件映射，其余 undefined', () => {
    expect(
      pushHintFor({ ...base, type: 'permission.request', requestId: 'r', toolName: 'T', input: {}, requestedAt: 1 }),
    ).toBe('permission_pending');
    expect(
      pushHintFor({ ...base, type: 'run.done', durationMs: 1, costUsd: 0, toolCount: 0, permissionCount: 0 }),
    ).toBe('run_done');
    expect(pushHintFor({ ...base, type: 'error.fatal', kind: 'other', message: 'x' })).toBe('run_error');
    expect(pushHintFor({ ...base, type: 'assistant.delta', messageId: 'm', text: 'x' })).toBeUndefined();
  });

  test('permission.request 按 toolName 分流：提问 / 计划 / 其余', () => {
    const req = (toolName: string) =>
      pushHintFor({ ...base, type: 'permission.request', requestId: 'r', toolName, input: {}, requestedAt: 1 });
    expect(req('AskUserQuestion')).toBe('question_pending');
    expect(req('ExitPlanMode')).toBe('plan_pending');
    expect(req('Bash')).toBe('permission_pending');
  });
});

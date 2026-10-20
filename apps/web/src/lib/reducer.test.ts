/**
 * reducer 单测：对照方案 §4.3 的每条要点。事件用 a2c 形状直接构造
 * （ts/seq/dir 齐全），不经加密——reducer 不关心信封。
 */
import { describe, expect, test } from 'bun:test';
import type { AgentToClientEvent, BgTask } from '@trine/core';
import { MemoryDocStore } from './adapters.ts';
import { loadTimeline, saveTimeline } from './storage.ts';
import {
  addLocalUserEntry,
  agentSupportsBgTaskStop,
  applyEvent,
  bgRunningCount,
  bgTasksStale,
  applyMachineEvent,
  applySessionsEvent,
  emptyMachine,
  emptyTimeline,
  expireParked,
  expireParkedBySeq,
  markSendingAsFailed,
  nextParkedExpiry,
  setLocalStatus,
  transitionLocalStatus,
  type Timeline,
  type UserEntry,
} from './reducer.ts';

type Body = { [K in AgentToClientEvent['type']]: Omit<Extract<AgentToClientEvent, { type: K }>, 'ts' | 'seq' | 'dir'> }[AgentToClientEvent['type']];

let seqCounter = 0;
function ev(body: Body, seq?: number): AgentToClientEvent {
  const s = seq ?? ++seqCounter;
  return { ...body, ts: 1_000 + s, seq: s, dir: 'a2c' } as AgentToClientEvent;
}
const S = { sessionId: 's1' } as const;

function apply(tl: Timeline, ...events: AgentToClientEvent[]): Timeline {
  return events.reduce((acc, e) => applyEvent(acc, e), tl);
}

describe('reducer · assistant 流', () => {
  test('delta 按 messageId 原地追加；thinking.start 在首个 delta 后隐藏；done 终态覆盖；done 后的 delta 忽略', () => {
    let tl = apply(
      emptyTimeline(),
      ev({ type: 'thinking.start', ...S, messageId: 'm1' }),
    );
    expect(tl.entries).toEqual([expect.objectContaining({ kind: 'assistant', id: 'm1', thinking: true, text: '' })]);
    tl = apply(tl, ev({ type: 'assistant.delta', ...S, messageId: 'm1', text: 'Hel' }), ev({ type: 'assistant.delta', ...S, messageId: 'm1', text: 'lo' }));
    expect(tl.entries).toHaveLength(1);
    expect(tl.entries[0]).toMatchObject({ text: 'Hello', thinking: false, done: false });
    tl = apply(tl, ev({ type: 'assistant.done', ...S, messageId: 'm1', text: 'Hello!' }));
    expect(tl.entries[0]).toMatchObject({ text: 'Hello!', done: true });
    tl = apply(tl, ev({ type: 'assistant.delta', ...S, messageId: 'm1', text: 'late' }));
    expect(tl.entries[0]).toMatchObject({ text: 'Hello!' });
    // 另一个 messageId 是另一条
    tl = apply(tl, ev({ type: 'assistant.delta', ...S, messageId: 'm2', text: 'x' }));
    expect(tl.entries).toHaveLength(2);
    expect(tl.lastAppliedSeq).toBe(seqCounter);
  });
});

describe('reducer · user.message 判别', () => {
  test('带 clientMsgId 且命中本地条目 → 升级 confirmed（沿用本地 id，记 messageId 与 seq）', () => {
    let tl = addLocalUserEntry(emptyTimeline(), { clientMsgId: 'c1', text: 'hi', ts: 1 });
    tl = apply(tl, ev({ type: 'user.message', ...S, messageId: 'u1', clientMsgId: 'c1', text: 'hi' }, 7));
    expect(tl.entries).toHaveLength(1);
    expect(tl.entries[0]).toMatchObject({ kind: 'user', id: 'c1', local: true, status: 'confirmed', messageId: 'u1', seq: 7 });
  });

  test('确认时 ts 换成 agent 帧的时间（统一时钟，时间线时刻不错位）', () => {
    let tl = addLocalUserEntry(emptyTimeline(), { clientMsgId: 'c1', text: 'hi', ts: 1 });
    tl = apply(tl, { ...ev({ type: 'user.message', ...S, messageId: 'u1', clientMsgId: 'c1', text: 'hi' }, 7), ts: 5000 });
    expect(tl.entries[0]?.ts).toBe(5000);
  });

  test('带 clientMsgId 但不命中（别的设备发的）→ 追加为非本地条目', () => {
    const tl = apply(emptyTimeline(), ev({ type: 'user.message', ...S, messageId: 'u2', clientMsgId: 'other-device-msg', text: 'yo' }));
    expect(tl.entries).toEqual([expect.objectContaining({ kind: 'user', id: 'u2', local: false, text: 'yo' })]);
  });

  test('不带 clientMsgId → 追加；同 messageId 重复应用不重复', () => {
    let tl = apply(emptyTimeline(), ev({ type: 'user.message', ...S, messageId: 'u3', text: 'a' }, 3));
    tl = apply(tl, ev({ type: 'user.message', ...S, messageId: 'u3', text: 'a' }, 3));
    expect(tl.entries).toHaveLength(1);
  });
});

describe('reducer · tool / permission 原地更新', () => {
  test('tool.start/end 按 toolUseId 合并；end 先于 start 也能落', () => {
    let tl = apply(emptyTimeline(), ev({ type: 'tool.start', ...S, toolUseId: 't1', toolName: 'Bash', argSummary: 'ls' }));
    tl = apply(tl, ev({ type: 'tool.end', ...S, toolUseId: 't1', status: 'ok', durationMs: 5, resultSummary: '✓', outputPreview: 'a\nb' }));
    expect(tl.entries).toEqual([expect.objectContaining({ kind: 'tool', toolName: 'Bash', status: 'ok', outputPreview: 'a\nb' })]);
    tl = apply(tl, ev({ type: 'tool.end', ...S, toolUseId: 't2', status: 'error', durationMs: 1, resultSummary: '✗' }));
    expect(tl.entries[1]).toMatchObject({ kind: 'tool', id: 't2', toolName: '?', status: 'error' });
  });

  test('permission.request 同 requestId 幂等；resolved 后重发不回退 pending；invalidated 不覆盖 resolved', () => {
    const req = ev({ type: 'permission.request', ...S, requestId: 'r1', toolName: 'Bash', input: { command: 'rm x' }, requestedAt: 1 });
    let tl = apply(emptyTimeline(), req, req);
    expect(tl.entries).toHaveLength(1);
    tl = apply(tl, ev({ type: 'permission.resolved', ...S, requestId: 'r1', verdict: 'allow', resolvedBy: 'phone' }));
    expect(tl.entries[0]).toMatchObject({ state: 'resolved', verdict: 'allow', resolvedBy: 'phone' });
    // 重连重发同 requestId
    tl = apply(tl, ev({ type: 'permission.request', ...S, requestId: 'r1', toolName: 'Bash', input: {}, requestedAt: 1 }));
    expect(tl.entries[0]).toMatchObject({ state: 'resolved' });
    tl = apply(tl, ev({ type: 'permission.invalidated', ...S, requestId: 'r1', reason: 'restart' }));
    expect(tl.entries[0]).toMatchObject({ state: 'resolved' });
    // 未决的可以失效
    tl = apply(tl, ev({ type: 'permission.request', ...S, requestId: 'r2', toolName: 'Edit', input: {}, requestedAt: 2 }));
    tl = apply(tl, ev({ type: 'permission.invalidated', ...S, requestId: 'r2', reason: 'stopped' }));
    expect(tl.entries[1]).toMatchObject({ id: 'r2', state: 'invalidated', reason: 'stopped' });
  });

  test('permission.resolved 的 updatedInput 落进 approvedInput，原始 input 保留（验收 5）', () => {
    const original = { command: 'rm -rf /tmp/x' };
    const approved = { command: 'ls -la /tmp/x' };
    let tl = apply(
      emptyTimeline(),
      ev({ type: 'permission.request', ...S, requestId: 'r1', toolName: 'Bash', input: original, requestedAt: 1 }),
    );
    tl = apply(
      tl,
      ev({ type: 'permission.resolved', ...S, requestId: 'r1', verdict: 'allow', updatedInput: approved }),
    );
    // 两者都要留着：卡片要能说清「请求的是这个、实际批的是那个」
    expect(tl.entries[0]).toMatchObject({ state: 'resolved', input: original, approvedInput: approved });
  });

  test('没有 updatedInput（没改参数 / 旧 agent）时不写 approvedInput', () => {
    let tl = apply(
      emptyTimeline(),
      ev({ type: 'permission.request', ...S, requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, requestedAt: 1 }),
    );
    tl = apply(tl, ev({ type: 'permission.resolved', ...S, requestId: 'r1', verdict: 'allow' }));
    expect(tl.entries[0]).not.toHaveProperty('approvedInput');
  });

  test('approvedInput 真的落盘并能读回来（刷新后仍在）', async () => {
    const approved = { command: 'ls -la', nested: { a: [1, 2] } };
    let tl = apply(
      emptyTimeline(),
      ev({ type: 'permission.request', ...S, requestId: 'r1', toolName: 'Bash', input: { command: 'rm' }, requestedAt: 1 }),
    );
    tl = apply(tl, ev({ type: 'permission.resolved', ...S, requestId: 'r1', verdict: 'allow', updatedInput: approved }));
    // 走真正的落盘路径（zod 校验 + 结构化克隆），不是手搓 JSON round-trip
    const docs = new MemoryDocStore();
    await saveTimeline(docs, 'mbp/s1', tl);
    const loaded = await loadTimeline(docs, 'mbp/s1');
    expect(loaded?.entries[0]).toMatchObject({ approvedInput: approved });
  });

  test('permission.resolved 的 message / setMode 落进 denyMessage / approvedMode，并能落盘读回', async () => {
    let tl = apply(
      emptyTimeline(),
      ev({ type: 'permission.request', ...S, requestId: 'r1', toolName: 'ExitPlanMode', input: { plan: 'p' }, requestedAt: 1 }),
    );
    tl = apply(
      tl,
      ev({ type: 'permission.request', ...S, requestId: 'r2', toolName: 'ExitPlanMode', input: { plan: 'q' }, requestedAt: 2 }),
    );
    tl = apply(tl, ev({ type: 'permission.resolved', ...S, requestId: 'r1', verdict: 'deny', message: '先补测试' }));
    tl = apply(tl, ev({ type: 'permission.resolved', ...S, requestId: 'r2', verdict: 'allow', setMode: 'acceptEdits' }));
    expect(tl.entries[0]).toMatchObject({ verdict: 'deny', denyMessage: '先补测试' });
    expect(tl.entries[0]).not.toHaveProperty('approvedMode');
    expect(tl.entries[1]).toMatchObject({ verdict: 'allow', approvedMode: 'acceptEdits' });
    expect(tl.entries[1]).not.toHaveProperty('denyMessage');
    const docs = new MemoryDocStore();
    await saveTimeline(docs, 'mbp/s1', tl);
    const loaded = await loadTimeline(docs, 'mbp/s1');
    expect(loaded?.entries[0]).toMatchObject({ denyMessage: '先补测试' });
    expect(loaded?.entries[1]).toMatchObject({ approvedMode: 'acceptEdits' });
  });
});

describe('reducer · 运行状态与错误', () => {
  test('heartbeat 只更新快照；run.state 进时间线并更新 state；run.done / error.transient 追加；同事件两次只落一条', () => {
    const hb = ev({ type: 'run.heartbeat', ...S, runElapsedMs: 100, silentMs: 5, phase: 'run' });
    let tl = apply(emptyTimeline(), hb);
    expect(tl.entries).toHaveLength(0);
    expect(tl.heartbeat).toMatchObject({ runElapsedMs: 100, phase: 'run' });
    const running = ev({ type: 'run.state', ...S, state: 'running' });
    tl = apply(tl, running, running);
    expect(tl.entries).toHaveLength(1);
    expect(tl.state).toBe('running');
    tl = apply(tl, ev({ type: 'error.transient', ...S, attempt: 2, reason: 'rate limit' }));
    tl = apply(tl, ev({ type: 'run.done', ...S, durationMs: 9, costUsd: 0.01, toolCount: 1, permissionCount: 0 }));
    tl = apply(tl, ev({ type: 'run.state', ...S, state: 'idle' }));
    expect(tl.entries.map((e) => e.kind)).toEqual(['run_state', 'error', 'run_done', 'run_state']);
    expect(tl.state).toBe('idle');
    // 运行结束后心跳快照清掉
    expect(tl.heartbeat).toBeNull();
  });

  test('error.fatal 有 sessionId → 会话时间线卡片（含 retryAt）；无 sessionId → 不进时间线，进机器级错误', () => {
    const tl = apply(emptyTimeline(), ev({ type: 'error.fatal', ...S, kind: 'quota', message: 'quota', retryAt: 99 }));
    expect(tl.entries).toEqual([expect.objectContaining({ kind: 'error', level: 'fatal', errorKind: 'quota', retryAt: 99 })]);

    const machineFatal = ev({ type: 'error.fatal', kind: 'other', message: '出站序号自愈失败' });
    expect(applyEvent(emptyTimeline(), machineFatal).entries).toHaveLength(0);
    const m = applyMachineEvent(emptyMachine('mbp'), machineFatal);
    expect(m.lastError).toMatchObject({ kind: 'other', message: '出站序号自愈失败' });
    // 会话级 fatal 不进机器级
    expect(applyMachineEvent(emptyMachine('mbp'), ev({ type: 'error.fatal', ...S, kind: 'auth', message: 'x' })).lastError).toBeNull();
  });
});

describe('reducer · 本地条目状态机不可倒退', () => {
  const status = (tl: Timeline, id = 'c1') => (tl.entries.find((e) => e.kind === 'user' && e.id === id) as UserEntry).status;

  test('sending → queued → confirmed；confirmed 后再来的 input.queued 不回退', () => {
    let tl = addLocalUserEntry(emptyTimeline(), { clientMsgId: 'c1', text: 'hi', ts: 1 });
    expect(status(tl)).toBe('sending');
    tl = apply(tl, ev({ type: 'input.queued', ...S, clientMsgId: 'c1' }));
    expect(status(tl)).toBe('queued');
    tl = apply(tl, ev({ type: 'user.message', ...S, messageId: 'u1', clientMsgId: 'c1', text: 'hi' }));
    expect(status(tl)).toBe('confirmed');
    tl = apply(tl, ev({ type: 'input.queued', ...S, clientMsgId: 'c1' }));
    expect(status(tl)).toBe('confirmed');
  });

  test('sending → parked → expired；expired 后的回显不覆盖终态', () => {
    let tl = addLocalUserEntry(emptyTimeline(), { clientMsgId: 'c1', text: 'hi', ts: 1 });
    tl = setLocalStatus(tl, 'c1', 'parked', { parkedSeq: 12, expiresAt: 500 });
    expect(tl.entries[0]).toMatchObject({ status: 'parked', parkedSeq: 12, expiresAt: 500 });
    expect(nextParkedExpiry(tl)).toBe(500);
    tl = expireParked(tl, 499);
    expect(status(tl)).toBe('parked');
    tl = expireParked(tl, 500);
    expect(status(tl)).toBe('expired');
    expect(nextParkedExpiry(tl)).toBeNull();
    tl = apply(tl, ev({ type: 'user.message', ...S, messageId: 'u1', clientMsgId: 'c1', text: 'hi' }));
    expect(status(tl)).toBe('expired');
  });

  test('park.expired 按 parkedSeq 找条目；parked → confirmed（agent 上线投递后回显）', () => {
    let tl = addLocalUserEntry(emptyTimeline(), { clientMsgId: 'c1', text: 'a', ts: 1 });
    tl = addLocalUserEntry(tl, { clientMsgId: 'c2', text: 'b', ts: 2 });
    tl = setLocalStatus(tl, 'c1', 'parked', { parkedSeq: 3, expiresAt: 9e12 });
    tl = setLocalStatus(tl, 'c2', 'parked', { parkedSeq: 4, expiresAt: 9e12 });
    tl = expireParkedBySeq(tl, 3);
    expect(status(tl, 'c1')).toBe('expired');
    tl = apply(tl, ev({ type: 'user.message', ...S, messageId: 'u2', clientMsgId: 'c2', text: 'b' }));
    expect(status(tl, 'c2')).toBe('confirmed');
  });

  test('failed 是终态；重发（addLocalUserEntry 同 clientMsgId）把 failed 复位为 sending，confirmed 的不动', () => {
    let tl = addLocalUserEntry(emptyTimeline(), { clientMsgId: 'c1', text: 'hi', ts: 1 });
    tl = setLocalStatus(tl, 'c1', 'failed', { failReason: 'quota' });
    tl = setLocalStatus(tl, 'c1', 'queued');
    expect(status(tl)).toBe('failed');
    tl = addLocalUserEntry(tl, { clientMsgId: 'c1', text: 'hi', ts: 2 });
    expect(status(tl)).toBe('sending');
    tl = apply(tl, ev({ type: 'user.message', ...S, messageId: 'u1', clientMsgId: 'c1', text: 'hi' }));
    tl = addLocalUserEntry(tl, { clientMsgId: 'c1', text: 'hi', ts: 3 });
    expect(status(tl)).toBe('confirmed');
    expect(tl.entries).toHaveLength(1);
  });

  test('加载时残留 sending 一律 failed；transitionLocalStatus 终态判定', () => {
    let tl = addLocalUserEntry(emptyTimeline(), { clientMsgId: 'c1', text: 'hi', ts: 1 });
    tl = addLocalUserEntry(tl, { clientMsgId: 'c2', text: 'yo', ts: 1 });
    tl = setLocalStatus(tl, 'c2', 'queued');
    tl = markSendingAsFailed(tl);
    expect(status(tl, 'c1')).toBe('failed');
    expect(status(tl, 'c2')).toBe('queued');
    for (const terminal of ['confirmed', 'expired', 'failed'] as const) {
      expect(transitionLocalStatus(terminal, 'sending')).toBe(terminal);
      expect(transitionLocalStatus(terminal, 'queued')).toBe(terminal);
    }
    expect(transitionLocalStatus('sending', 'parked')).toBe('parked');
    expect(transitionLocalStatus('parked', 'confirmed')).toBe('confirmed');
  });
});

describe('reducer · sessions / machine / prefs', () => {
  const meta = (sessionId: string, state: 'idle' | 'running' = 'idle') => ({
    sessionId,
    title: sessionId,
    state,
    lastActivityAt: 10,
    cwd: '/tmp',
    model: 'm',
    permissionMode: 'default' as const,
    costUsd: 0,
  });

  test('list.response 全量覆盖；created/updated/create.response 幂等合并；run.state 更新状态', () => {
    let s = applySessionsEvent({}, ev({ type: 'session.list.response', reqId: 'q', sessions: [meta('a'), meta('b')] }));
    expect(Object.keys(s)).toEqual(['a', 'b']);
    s = applySessionsEvent(s, ev({ type: 'session.created', session: meta('c') }));
    s = applySessionsEvent(s, ev({ type: 'session.create.response', reqId: 'q2', session: meta('c') }));
    expect(Object.keys(s)).toEqual(['a', 'b', 'c']);
    s = applySessionsEvent(s, ev({ type: 'run.state', sessionId: 'a', state: 'running' }));
    expect(s['a']).toMatchObject({ state: 'running' });
    s = applySessionsEvent(s, ev({ type: 'session.list.response', reqId: 'q3', sessions: [meta('a')] }));
    expect(Object.keys(s)).toEqual(['a']);
  });

  test('session.removed 删条目；mutate.response 的 deleted 视同删除，其他应答不动列表', () => {
    let s = applySessionsEvent({}, ev({ type: 'session.list.response', reqId: 'q', sessions: [meta('a'), meta('b'), meta('c')] }));
    s = applySessionsEvent(s, ev({ type: 'session.removed', targetSessionId: 'a' }));
    expect(Object.keys(s)).toEqual(['b', 'c']);
    // 不认识的 id：原样返回（引用不变，client 据此不触发落盘/emit）
    expect(applySessionsEvent(s, ev({ type: 'session.removed', targetSessionId: 'zzz' }))).toBe(s);
    const busy = ev({ type: 'session.mutate.response', reqId: 'r1', targetSessionId: 'b', ok: false, error: { code: 'busy', message: '忙' } });
    expect(applySessionsEvent(s, busy)).toBe(s);
    expect(applySessionsEvent(s, ev({ type: 'session.mutate.response', reqId: 'r2', targetSessionId: 'b', ok: true }))).toBe(s);
    s = applySessionsEvent(s, ev({ type: 'session.mutate.response', reqId: 'r3', targetSessionId: 'b', ok: false, error: { code: 'deleted', message: '已删' } }));
    expect(Object.keys(s)).toEqual(['c']);
  });

  test('run.state → running 本地取消归档（agent 的 session.updated 到之前不再藏在归档视图）', () => {
    let s = applySessionsEvent({}, ev({ type: 'session.updated', session: { ...meta('a'), archived: true, archivedAt: 5 } }));
    s = applySessionsEvent(s, ev({ type: 'run.state', sessionId: 'a', state: 'waiting_permission' }));
    expect(s['a']?.archived).toBe(true);
    s = applySessionsEvent(s, ev({ type: 'run.state', sessionId: 'a', state: 'running' }));
    expect(s['a']).toMatchObject({ state: 'running' });
    expect(s['a']?.archived).toBeUndefined();
    expect(s['a']?.archivedAt).toBeUndefined();
  });

  test('machine.info / cwd.* 存机器；knownModels 并集保序', () => {
    let m = applyMachineEvent(emptyMachine('mbp'), ev({ type: 'machine.info', info: { name: 'MBP', platform: 'darwin', osVersion: '25', agentVersion: '0.1', claudeVersion: '2', activeSessionCount: 1 } }));
    expect(m.name).toBe('MBP');
    m = applyMachineEvent(m, ev({ type: 'cwd.updated', favorites: ['/a'], defaultCwd: '/a' }));
    expect(m.cwd).toEqual({ favorites: ['/a'], defaultCwd: '/a' });
  });
});

describe('reducer · 后台任务（background-tasks）', () => {
  const task = (over: Partial<BgTask> = {}): BgTask => ({
    taskId: 't1',
    kind: 'bash',
    description: 'sleep 25',
    status: 'running',
    startedAt: 1_000,
    ...over,
  });

  test('bgtask.snapshot 整份替换 timeline.bgTasks 并推进游标；不进 entries', () => {
    let tl = apply(emptyTimeline(), ev({ type: 'bgtask.snapshot', ...S, tasks: [task()] }, 1));
    expect(tl.bgTasks).toEqual([task()]);
    expect(tl.entries).toHaveLength(0);
    expect(tl.lastAppliedSeq).toBe(1);
    // 下一帧是全量：旧条目不保留
    tl = apply(tl, ev({ type: 'bgtask.snapshot', ...S, tasks: [task({ taskId: 't2', status: 'completed', endedAt: 2_000, summary: 'ok' })] }, 2));
    expect(tl.bgTasks!.map((t) => t.taskId)).toEqual(['t2']);
    expect(bgRunningCount(tl.bgTasks)).toBe(0);
    tl = apply(tl, ev({ type: 'bgtask.snapshot', ...S, tasks: [] }, 3));
    expect(tl.bgTasks).toEqual([]);
    expect(bgRunningCount(undefined)).toBe(0);
    expect(bgRunningCount([task(), task({ taskId: 'x', status: 'failed' })])).toBe(1);
  });

  test('run.state running 带 detail（自发轮标记）照常进时间线，state 仍是 running', () => {
    const tl = apply(
      emptyTimeline(),
      ev({ type: 'run.state', ...S, state: 'running' }),
      ev({ type: 'run.state', ...S, state: 'running', detail: '后台任务“x”已完成' }),
    );
    expect(tl.entries).toHaveLength(2);
    expect(tl.entries[1]).toMatchObject({ kind: 'run_state', state: 'running', detail: '后台任务“x”已完成' });
    expect(tl.state).toBe('running');
  });

  test('agentSupportsBgTaskStop：≥ 0.7.0 才支持', () => {
    expect(agentSupportsBgTaskStop('0.7.0')).toBe(true);
    expect(agentSupportsBgTaskStop('1.0.0')).toBe(true);
    expect(agentSupportsBgTaskStop('0.6.0')).toBe(false);
    expect(agentSupportsBgTaskStop('0.6.9')).toBe(false);
    expect(agentSupportsBgTaskStop(undefined)).toBe(false);
    expect(agentSupportsBgTaskStop('garbage')).toBe(false);
  });

  test('bgTasks 随时间线落盘并读回', async () => {
    const docs = new MemoryDocStore();
    const tl = apply(emptyTimeline(), ev({ type: 'bgtask.snapshot', ...S, tasks: [task({ status: 'completed', endedAt: 5, summary: 'done' })] }));
    await saveTimeline(docs, 'm/s', tl);
    const loaded = await loadTimeline(docs, 'm/s');
    expect(loaded?.bgTasks).toEqual(tl.bgTasks);
    // 没收到过快照的时间线读回来也没有这个字段
    await saveTimeline(docs, 'm/t', emptyTimeline());
    expect((await loadTimeline(docs, 'm/t'))?.bgTasks).toBeUndefined();
  });

  test('bgTasksStale（评审 M2）：agent ≥ 0.7.0 且 meta 说没有在跑、快照却有 running → 陈旧；其余情形不下结论', () => {
    const running = [task()];
    expect(bgTasksStale({ bgTasks: running, meta: { bgRunning: undefined }, agentVersion: '0.7.0' })).toBe(true);
    expect(bgTasksStale({ bgTasks: running, meta: {}, agentVersion: '1.2.0' })).toBe(true);
    expect(bgTasksStale({ bgTasks: running, meta: { bgRunning: 0 }, agentVersion: '0.7.0' })).toBe(true);
    // agent 说有在跑 → 不陈旧
    expect(bgTasksStale({ bgTasks: running, meta: { bgRunning: 1 }, agentVersion: '0.7.0' })).toBe(false);
    // meta 还没拿到 / 旧 agent（不发 bgRunning，缺省不能当 0）/ 快照里本来就没有 running → 不陈旧
    expect(bgTasksStale({ bgTasks: running, meta: undefined, agentVersion: '0.7.0' })).toBe(false);
    expect(bgTasksStale({ bgTasks: running, meta: {}, agentVersion: '0.6.0' })).toBe(false);
    expect(bgTasksStale({ bgTasks: [task({ status: 'completed' })], meta: {}, agentVersion: '0.7.0' })).toBe(false);
    expect(bgTasksStale({ bgTasks: undefined, meta: {}, agentVersion: '0.7.0' })).toBe(false);
  });
});

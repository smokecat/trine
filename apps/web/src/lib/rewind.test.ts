/**
 * 回退（rewind）的 web 侧：user.message 的 uuid、session.rewound 截断时间线、
 * 与历史页按 uuid 去重、回退目标 id、版本门控。
 */
import { describe, expect, test } from 'bun:test';
import type { AgentToClientEvent, HistoryItem } from '@trine/core';
import {
  addLocalUserEntry,
  agentSupportsRewind,
  applyEvent,
  emptyTimeline,
  mergeHistory,
  rewindTargetId,
  type Timeline,
  type UserEntry,
} from './reducer.ts';

const ev = (body: Record<string, unknown>, seq: number, ts = 1_000 + seq) =>
  ({ ...body, sessionId: 's1', ts, seq, dir: 'a2c' }) as unknown as AgentToClientEvent;

const apply = (tl: Timeline, ...events: AgentToClientEvent[]) => events.reduce((acc, e) => applyEvent(acc, e), tl);
const ids = (tl: Timeline) => tl.entries.map((e) => `${e.kind}:${e.id}`);
const u = (id: string, ts: number): HistoryItem => ({ kind: 'user', id, text: id, ts });
const a = (id: string, ts: number): HistoryItem => ({ kind: 'assistant', id, text: id, ts });

/** 三轮实时对话：本设备发的 c1、别的设备发的 c2、本设备发的 c3 */
function liveTimeline(): Timeline {
  let tl = addLocalUserEntry(emptyTimeline(), { clientMsgId: 'c1', text: 'q1', ts: 1 });
  tl = apply(
    tl,
    ev({ type: 'user.message', messageId: 'c1', clientMsgId: 'c1', text: 'q1', uuid: 'u1' }, 1),
    ev({ type: 'assistant.done', messageId: 'm1', text: 'a1' }, 2),
    ev({ type: 'user.message', messageId: 'c2', clientMsgId: 'c2', text: 'q2', uuid: 'u2' }, 3),
    ev({ type: 'assistant.done', messageId: 'm2', text: 'a2' }, 4),
  );
  tl = addLocalUserEntry(tl, { clientMsgId: 'c3', text: 'q3', ts: 1_010 });
  return apply(tl, ev({ type: 'user.message', messageId: 'c3', clientMsgId: 'c3', text: 'q3', uuid: 'u3' }, 5));
}

describe('rewind · user.message 的转录 uuid', () => {
  test('本地条目升级时记下 uuid；别的设备的条目也带上；旧 agent 不带就没有', () => {
    const tl = liveTimeline();
    expect(tl.entries[0]).toMatchObject({ id: 'c1', local: true, status: 'confirmed', uuid: 'u1' });
    expect(tl.entries[2]).toMatchObject({ id: 'c2', local: false, uuid: 'u2' });
    const old = apply(emptyTimeline(), ev({ type: 'user.message', messageId: 'c9', text: 'x' }, 1));
    expect(old.entries[0]).not.toHaveProperty('uuid');
  });

  test('历史页里同一条消息（id = uuid）按 uuid 去重，不再重复出现', () => {
    // 实时条目的 ts 比历史晚（cutoff 挡不住同 ts 之前的），只能靠 uuid 去重
    const tl = apply(emptyTimeline(), ev({ type: 'user.message', messageId: 'c1', clientMsgId: 'c1', text: 'q1', uuid: 'u1' }, 1, 5_000));
    const merged = mergeHistory(tl, { items: [u('u0', 100), a('m0', 200), u('u1', 300)], hasMore: false });
    expect(ids(merged)).toEqual(['user:u0', 'assistant:m0', 'user:c1']);
  });
});

describe('rewind · session.rewound', () => {
  test('回退对话：按任一 id 对上目标，从它起（含）截掉', () => {
    const byUuid = apply(liveTimeline(), ev({ type: 'session.rewound', targetMessageIds: ['u2'], mode: 'conversation' }, 6));
    expect(ids(byUuid)).toEqual(['user:c1', 'assistant:m1']);
    expect(byUuid.lastAppliedSeq).toBe(6);

    const byClientMsgId = apply(liveTimeline(), ev({ type: 'session.rewound', targetMessageIds: ['zzz', 'c3'], mode: 'both', filesChanged: 1 }, 6));
    expect(ids(byClientMsgId)).toEqual(['user:c1', 'assistant:m1', 'user:c2', 'assistant:m2']);
  });

  test('历史条目也能对上（id 即 uuid），翻页状态保留', () => {
    const tl = mergeHistory(emptyTimeline(), { items: [u('h1', 1), a('hm1', 2), u('h2', 3), a('hm2', 4)], hasMore: true, nextBefore: 'h1' });
    const out = apply(tl, ev({ type: 'session.rewound', targetMessageIds: ['h2'], mode: 'conversation' }, 1));
    expect(ids(out)).toEqual(['user:h1', 'assistant:hm1']);
    expect(out.history).toEqual({ hasMore: true, cursor: 'h1' });
  });

  test('对不上任何条目：清空时间线并忘掉翻页状态（视图随后重拉历史）', () => {
    const tl = { ...liveTimeline(), history: { hasMore: false } };
    const out = apply(tl, ev({ type: 'session.rewound', targetMessageIds: ['elsewhere'], mode: 'conversation' }, 6));
    expect(out.entries).toEqual([]);
    expect(out.history).toBeUndefined();
    expect(out.lastAppliedSeq).toBe(6);
  });

  test('只回退代码：时间线不动，只推进游标', () => {
    const tl = liveTimeline();
    const out = apply(tl, ev({ type: 'session.rewound', targetMessageIds: ['u1'], mode: 'code', filesChanged: 2 }, 6));
    expect(out.entries).toBe(tl.entries);
    expect(out.lastAppliedSeq).toBe(6);
  });

  test('预览 / 结果应答不进时间线', () => {
    const tl = liveTimeline();
    const out = apply(tl, ev({ type: 'session.rewind.response', reqId: 'r', ok: true }, 6));
    expect(out.entries).toBe(tl.entries);
    expect(out.lastAppliedSeq).toBe(6);
  });
});

describe('rewind · 目标 id 与门控', () => {
  test('rewindTargetId：uuid 优先，其次 messageId；未确认的本地条目不能回退', () => {
    const base: UserEntry = { kind: 'user', id: 'c1', text: 'x', local: true, seq: 0, ts: 1 };
    expect(rewindTargetId({ ...base, status: 'sending' })).toBeUndefined();
    expect(rewindTargetId({ ...base, status: 'queued' })).toBeUndefined();
    expect(rewindTargetId({ ...base, status: 'failed' })).toBeUndefined();
    expect(rewindTargetId({ ...base, status: 'confirmed', messageId: 'c1' })).toBe('c1');
    expect(rewindTargetId({ ...base, status: 'confirmed', messageId: 'c1', uuid: 'u1' })).toBe('u1');
    expect(rewindTargetId({ ...base, local: false, id: 'h1' })).toBe('h1');
  });

  test('agentSupportsRewind：≥ 0.9.0', () => {
    expect(agentSupportsRewind('0.9.0')).toBe(true);
    expect(agentSupportsRewind('1.0.0')).toBe(true);
    expect(agentSupportsRewind('0.8.9')).toBe(false);
    expect(agentSupportsRewind(undefined)).toBe(false);
  });
});

/**
 * 信封装配与 seq 分配（决策 1）。
 *
 * 重点验证：会话级与机器级是**两条独立序列**——这条如果错了，
 * server 的 seq 单调校验会在机器级帧上炸掉，且断线补发会拿错游标。
 */
import { describe, expect, test } from 'bun:test';
import { AgentToClientEventSchema, assertEnvelopeBinding } from '@trine/core';
import { EventEmitter, scopedEmitter } from './emitter.ts';
import type { OutboundEvent } from './types.ts';

/** 机器级帧的最小合法 info，只为拿到 seq */
const dummyInfo = {
  name: 'mbp',
  platform: 'darwin',
  osVersion: '25',
  agentVersion: '0.1.0',
  claudeVersion: 'unknown',
  activeSessionCount: 0,
};

function collector(): { sink: (out: OutboundEvent) => void; events: OutboundEvent[] } {
  const events: OutboundEvent[] = [];
  return { sink: (out) => events.push(out), events };
}

describe('EventEmitter', () => {
  test('补齐信封四字段，dir 恒为 a2c', () => {
    const { sink, events } = collector();
    const emitter = new EventEmitter({ sink, now: () => 1000 });

    emitter.emit({ type: 'run.state', state: 'running' }, 'sess-1');

    expect(events).toHaveLength(1);
    const event = events[0]!.event;
    expect(event).toMatchObject({
      type: 'run.state',
      state: 'running',
      ts: 1000,
      seq: 1,
      dir: 'a2c',
      sessionId: 'sess-1',
    });
  });

  test('seq 从 1 起——0 是 sync.request sinceSeq 的保留值，服务端拒收', () => {
    const { sink, events } = collector();
    const emitter = new EventEmitter({ sink, now: () => 0 });

    emitter.emit({ type: 'run.state', state: 'running' }, 'sess-1');
    emitter.emit({ type: 'cwd.updated', favorites: [], defaultCwd: '/x' }, null);

    // 两条流的首帧都必须是 1，且任何帧都不得为 0
    expect(events.map((e) => e.event.seq)).toEqual([1, 1]);
    expect(events.every((e) => e.event.seq >= 1)).toBe(true);
  });

  test('产出的帧通过 core 的 schema 校验', () => {
    const { sink, events } = collector();
    const emitter = new EventEmitter({ sink, now: () => 42 });

    emitter.emit(
      { type: 'tool.start', toolUseId: 't1', toolName: 'Bash', argSummary: 'ls' },
      'sess-1',
    );

    const parsed = AgentToClientEventSchema.safeParse(events[0]!.event);
    expect(parsed.success).toBe(true);
  });

  test('每个 sessionId 一条独立单调序列', () => {
    const { sink, events } = collector();
    const emitter = new EventEmitter({ sink, now: () => 0 });

    emitter.emit({ type: 'run.state', state: 'running' }, 'a');
    emitter.emit({ type: 'run.state', state: 'idle' }, 'a');
    emitter.emit({ type: 'run.state', state: 'running' }, 'b');
    emitter.emit({ type: 'run.state', state: 'idle' }, 'a');

    const seqs = events.map((e) => ({ sessionId: e.event.sessionId, seq: e.event.seq }));
    expect(seqs).toEqual([
      { sessionId: 'a', seq: 1 },
      { sessionId: 'a', seq: 2 },
      { sessionId: 'b', seq: 1 },
      { sessionId: 'a', seq: 3 },
    ]);
  });

  test('机器级帧走独立序列且省略 sessionId', () => {
    const { sink, events } = collector();
    const emitter = new EventEmitter({ sink, now: () => 0 });

    emitter.emit({ type: 'run.state', state: 'running' }, 'sess-1');
    emitter.emit({ type: 'cwd.updated', favorites: ['/a'], defaultCwd: '/a' }, null);
    emitter.emit({ type: 'cwd.updated', favorites: ['/b'], defaultCwd: '/b' }, null);

    // 机器级从 1 起，不受会话级影响
    expect(events[1]!.event.seq).toBe(1);
    expect(events[2]!.event.seq).toBe(2);
    // 且 sessionId 这个键根本不存在（而非置 undefined）
    expect('sessionId' in events[1]!.event).toBe(false);
  });

  test('与 assertEnvelopeBinding 对接：信封取自帧本身即通过', () => {
    const { sink, events } = collector();
    const emitter = new EventEmitter({ sink, now: () => 7 });

    emitter.emit({ type: 'run.state', state: 'running' }, 'sess-1');
    emitter.emit({ type: 'cwd.updated', favorites: [], defaultCwd: '/x' }, null);

    for (const { event } of events) {
      expect(() =>
        assertEnvelopeBinding(
          event,
          { sessionId: event.sessionId, seq: event.seq },
          'a2c',
        ),
      ).not.toThrow();
    }
  });

  test('peekSeq 反映下一个待分配值', () => {
    const { sink } = collector();
    const emitter = new EventEmitter({ sink, now: () => 0 });

    expect(emitter.peekSeq('s')).toBe(1);
    emitter.emit({ type: 'run.state', state: 'idle' }, 's');
    expect(emitter.peekSeq('s')).toBe(2);
  });

  test('setNext 只往前跳：自愈跳号后新帧从新起点起', () => {
    const emitter = new EventEmitter({ sink: () => {} });
    emitter.emit({ type: 'run.state', state: 'idle' }, 's1');
    expect(emitter.peekSeq('s1')).toBe(2);
    // 服务端 expectedAfter=17 → 下一帧该是 18
    expect(emitter.setNext('s1', 18)).toBe(true);
    expect(emitter.emit({ type: 'run.state', state: 'idle' }, 's1').event.seq).toBe(18);
    // 往回设被忽略（会重演 not_monotonic）
    expect(emitter.setNext('s1', 5)).toBe(false);
    expect(emitter.setNext('s1', 19)).toBe(false);
    expect(emitter.peekSeq('s1')).toBe(19);
    // 机器级 scope 同样可跳
    expect(emitter.setNext(null, 100)).toBe(true);
    expect(emitter.emit({ type: 'machine.info', info: dummyInfo }, null).event.seq).toBe(100);
  });

  test('snapshot/restore 往返：重启后序列接着往上，不回到 1', () => {
    const first = new EventEmitter({ sink: () => {} });
    first.emit({ type: 'run.state', state: 'idle' }, 's1');
    first.emit({ type: 'run.state', state: 'idle' }, 's1');
    first.emit({ type: 'machine.info', info: dummyInfo }, null);
    const snap = first.snapshot();
    expect(snap).toEqual({ s1: 3, '': 2 });

    const second = new EventEmitter({ sink: () => {} });
    // 已在进程内推进的 scope 不被拖回（只进不退）；坏值跳过
    second.setNext('s1', 10);
    second.restore({ ...snap, s2: 0, s3: 1.5 });
    expect(second.peekSeq('s1')).toBe(10);
    expect(second.peekSeq(null)).toBe(2);
    expect(second.peekSeq('s2')).toBe(1);
    expect(second.peekSeq('s3')).toBe(1);
  });

  test('scopedEmitter 绑定固定 scope', () => {
    const { sink, events } = collector();
    const emitter = new EventEmitter({ sink, now: () => 0 });
    const scoped = scopedEmitter(emitter, 'bound');

    scoped.emit({ type: 'run.state', state: 'running' });

    expect(events[0]!.event.sessionId).toBe('bound');
    expect(events[0]!.scope).toBe('bound');
  });
});

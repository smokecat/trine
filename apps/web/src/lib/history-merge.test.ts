/**
 * 历史回看合并（mergeHistory）与判据（agentSupportsHistory / shouldAutoLoadHistory）、
 * 落盘裁剪时的游标回退（trimTimelineForSave）。
 */
import { describe, expect, test } from 'bun:test';
import type { AgentToClientEvent, HistoryItem } from '@trine/core';
import { MemoryDocStore } from './adapters.ts';
import {
  addLocalUserEntry,
  agentSupportsHistory,
  applyEvent,
  emptyMachine,
  emptyTimeline,
  mergeHistory,
  shouldAutoLoadHistory,
  type Timeline,
} from './reducer.ts';
import { loadTimeline, saveTimeline, TIMELINE_MAX_ENTRIES, trimTimelineForSave } from './storage.ts';

const ev = (body: Record<string, unknown>, seq: number, ts: number) =>
  ({ ...body, sessionId: 's1', ts, seq, dir: 'a2c' }) as unknown as AgentToClientEvent;

const u = (id: string, ts: number, text = id): HistoryItem => ({ kind: 'user', id, text, ts });
const a = (id: string, ts: number, text = id): HistoryItem => ({ kind: 'assistant', id, text, ts });
const t = (id: string, ts: number): HistoryItem => ({
  kind: 'tool',
  id,
  toolName: 'Bash',
  argSummary: 'ls',
  status: 'ok',
  durationMs: 3,
  resultSummary: '✓ 完成',
  ts,
});

const keys = (tl: Timeline) => tl.entries.map((e) => `${e.kind}:${e.id}@${e.seq}`);

describe('mergeHistory', () => {
  test('空时间线：全收，seq 0 按 ts 顺序；user 非本地、assistant done', () => {
    const tl = mergeHistory(emptyTimeline(), { items: [u('u1', 10), a('msg_1', 11), t('toolu_1', 12)], hasMore: false });
    expect(keys(tl)).toEqual(['user:u1@0', 'assistant:msg_1@0', 'tool:toolu_1@0']);
    expect(tl.entries[0]).toMatchObject({ local: false, messageId: 'u1' });
    expect(tl.entries[1]).toMatchObject({ done: true, thinking: false });
    expect(tl.entries[2]).toMatchObject({ status: 'ok', durationMs: 3, resultSummary: '✓ 完成' });
    expect(tl.history).toEqual({ hasMore: false });
    expect(tl.lastAppliedSeq).toBe(0);
  });

  test('cutoff：只收早于 agent 条目（seq>0）最早 ts 的项；本地未确认条目不参与 cutoff', () => {
    let tl = addLocalUserEntry(emptyTimeline(), { clientMsgId: 'c-local', text: 'x', ts: 5 });
    tl = applyEvent(tl, ev({ type: 'assistant.done', messageId: 'msg_live', text: 'live' }, 7, 100));
    const merged = mergeHistory(tl, { items: [u('u0', 1), a('msg_0', 50), u('u9', 100), a('msg_9', 150)], hasMore: false });
    // ts=100 不早于 cutoff(100)：排除
    expect(keys(merged)).toEqual(['user:u0@0', 'assistant:msg_0@0', 'user:c-local@0', 'assistant:msg_live@7']);
  });

  test('去重：assistant 与实时 messageId 同源、tool 按 toolUseId、user 按 messageId', () => {
    let tl = emptyTimeline();
    tl = mergeHistory(tl, { items: [u('u1', 1), a('msg_1', 2), t('toolu_1', 3)], hasMore: true, nextBefore: 'u1' });
    // 另一页里重复出现同 id 的项（游标错位 / 重放）
    const again = mergeHistory(tl, { items: [u('u0', 0), u('u1', 1), a('msg_1', 2), t('toolu_1', 3)], hasMore: false });
    expect(keys(again)).toEqual(['user:u0@0', 'user:u1@0', 'assistant:msg_1@0', 'tool:toolu_1@0']);
  });

  test('幂等：同一页应用两次结果相同，第二次原样返回同一引用', () => {
    const page = { items: [u('u1', 1), a('msg_1', 2)], hasMore: true, nextBefore: 'u1' };
    const once = mergeHistory(emptyTimeline(), page);
    const twice = mergeHistory(once, page);
    expect(twice).toBe(once);
    expect(once.history).toEqual({ hasMore: true, cursor: 'u1' });
  });

  test('前插顺序：更早一页插到已有历史块之前，实时条目保持在后且顺序不变', () => {
    let tl = emptyTimeline();
    tl = applyEvent(tl, ev({ type: 'user.message', messageId: 'live-u', text: 'hi' }, 1, 1_000));
    tl = applyEvent(tl, ev({ type: 'assistant.done', messageId: 'live-a', text: 'yo' }, 2, 1_001));
    tl = mergeHistory(tl, { items: [u('u5', 500), a('msg_5', 501)], hasMore: true, nextBefore: 'u5' });
    tl = mergeHistory(tl, { items: [u('u3', 300), a('msg_3', 301)], hasMore: false });
    expect(keys(tl)).toEqual([
      'user:u3@0',
      'assistant:msg_3@0',
      'user:u5@0',
      'assistant:msg_5@0',
      'user:live-u@1',
      'assistant:live-a@2',
    ]);
    expect(tl.history).toEqual({ hasMore: false });
    expect(tl.lastAppliedSeq).toBe(2);
  });

  test('没有新条目但翻页状态变了：更新 history（整页都被 cutoff 滤掉时游标仍前进）', () => {
    let tl = applyEvent(emptyTimeline(), ev({ type: 'assistant.done', messageId: 'm', text: 'x' }, 1, 10));
    tl = mergeHistory(tl, { items: [u('late', 20)], hasMore: true, nextBefore: 'late' });
    expect(tl.entries).toHaveLength(1);
    expect(tl.history).toEqual({ hasMore: true, cursor: 'late' });
  });

  test('hasMore=false 时不记游标', () => {
    expect(mergeHistory(emptyTimeline(), { items: [], hasMore: false, nextBefore: 'x' }).history).toEqual({ hasMore: false });
  });

  test('之后的实时事件照常追加、不受历史条目影响', () => {
    let tl = mergeHistory(emptyTimeline(), { items: [a('msg_1', 1)], hasMore: false });
    // 实时 assistant.done 用同一个 messageId（极端：历史最后一条正是正在跑的）→ 原地更新，不重复
    tl = applyEvent(tl, ev({ type: 'assistant.done', messageId: 'msg_1', text: 'final' }, 3, 5));
    expect(tl.entries).toHaveLength(1);
    expect(tl.entries[0]).toMatchObject({ text: 'final' });
  });

  test('session.history.response 经 applyEvent 只推进游标、不进时间线', () => {
    const tl = applyEvent(
      emptyTimeline(),
      ev({ type: 'session.history.response', reqId: 'r', items: [u('u1', 1)], hasMore: false }, 4, 9),
    );
    expect(tl.entries).toEqual([]);
    expect(tl.lastAppliedSeq).toBe(4);
    expect(tl.history).toBeUndefined();
  });
});

describe('agentSupportsHistory / shouldAutoLoadHistory', () => {
  test('版本判据：≥ 0.3.0（0.2.0 是 session-list-v2 的阈值，不含历史）；未知/解析不了 → 不支持', () => {
    expect(agentSupportsHistory('0.3.0')).toBe(true);
    expect(agentSupportsHistory('0.2.0')).toBe(false);
    expect(agentSupportsHistory('0.10.1')).toBe(true);
    expect(agentSupportsHistory('1.0.0')).toBe(true);
    expect(agentSupportsHistory('v0.3.1-beta')).toBe(true);
    expect(agentSupportsHistory('0.1.9')).toBe(false);
    expect(agentSupportsHistory('unknown')).toBe(false);
    expect(agentSupportsHistory(undefined)).toBe(false);
  });

  test('在线 + 支持 + 同步结束 + 尚未拉过 才自动拉', () => {
    const info = { name: 'm', platform: 'darwin', osVersion: '1', agentVersion: '0.3.0', claudeVersion: 'x', activeSessionCount: 0 };
    const machine = { ...emptyMachine('mbp'), online: true, info };
    const timeline = emptyTimeline();
    expect(shouldAutoLoadHistory({ timeline, syncing: undefined, machine })).toBe(true);
    expect(shouldAutoLoadHistory({ timeline, syncing: 'normal', machine })).toBe(false);
    expect(shouldAutoLoadHistory({ timeline, syncing: undefined, machine: { ...machine, online: false } })).toBe(false);
    expect(shouldAutoLoadHistory({ timeline, syncing: undefined, machine: { ...machine, info: null } })).toBe(false);
    expect(shouldAutoLoadHistory({ timeline, syncing: undefined, machine: { ...machine, info: { ...info, agentVersion: '0.1.0' } } })).toBe(false);
    expect(shouldAutoLoadHistory({ timeline: { ...timeline, history: { hasMore: false } }, syncing: undefined, machine })).toBe(false);
    expect(shouldAutoLoadHistory({ timeline, syncing: undefined, machine: undefined })).toBe(false);
  });
});

describe('落盘：history 字段与裁剪回退游标', () => {
  test('history 随时间线落盘、加载回来；旧文档没有该字段 → undefined', async () => {
    const docs = new MemoryDocStore();
    const tl = mergeHistory(emptyTimeline(), { items: [u('u1', 1)], hasMore: true, nextBefore: 'u1' });
    await saveTimeline(docs, 'mbp/s1', tl);
    expect((await loadTimeline(docs, 'mbp/s1'))?.history).toEqual({ hasMore: true, cursor: 'u1' });
    await docs.set('timeline:mbp/old', { v: 1, lastAppliedSeq: 0, entries: [] });
    const old = await loadTimeline(docs, 'mbp/old');
    expect(old).not.toBeNull();
    expect(old?.history).toBeUndefined();
  });

  test('裁掉了历史条目：游标回退到剩下最旧的历史条目，hasMore 置真', () => {
    const items = Array.from({ length: TIMELINE_MAX_ENTRIES + 3 }, (_, i) => u(`u${i}`, i));
    const tl = mergeHistory(emptyTimeline(), { items, hasMore: false });
    const trimmed = trimTimelineForSave(tl);
    expect(trimmed.entries).toHaveLength(TIMELINE_MAX_ENTRIES);
    expect(trimmed.entries[0]!.id).toBe('u3');
    expect(trimmed.history).toEqual({ hasMore: true, cursor: 'u3' });
  });

  test('历史条目被裁光：清游标（从最新一页重拉，去重兜底）', () => {
    let tl = mergeHistory(emptyTimeline(), { items: [u('h1', 0)], hasMore: false });
    for (let i = 1; i <= TIMELINE_MAX_ENTRIES; i++) {
      tl = applyEvent(tl, ev({ type: 'assistant.done', messageId: `m${i}`, text: 'x' }, i, 100 + i));
    }
    expect(trimTimelineForSave(tl).history).toEqual({ hasMore: true });
  });

  test('没裁到历史条目 / 没拉过历史：history 原样', () => {
    const small = mergeHistory(emptyTimeline(), { items: [u('h1', 0)], hasMore: true, nextBefore: 'h1' });
    expect(trimTimelineForSave(small).history).toEqual({ hasMore: true, cursor: 'h1' });
    let big = emptyTimeline();
    for (let i = 1; i <= TIMELINE_MAX_ENTRIES + 2; i++) {
      big = applyEvent(big, ev({ type: 'assistant.done', messageId: `m${i}`, text: 'x' }, i, i));
    }
    expect(trimTimelineForSave(big).history).toBeUndefined();
  });
});

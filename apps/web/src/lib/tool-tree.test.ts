/**
 * 子 agent 工具树（subagent-view）：reducer 挂载 / 乱序暂存 / 嵌套 / 历史与回看合并 /
 * 落盘往返。事件用 a2c 形状直接构造。
 */
import { describe, expect, test } from 'bun:test';
import type { AgentToClientEvent } from '@trine/core';
import { MemoryDocStore } from './adapters.ts';
import { loadTimeline, saveTimeline, TIMELINE_MAX_ENTRIES, trimTimelineForSave } from './storage.ts';
import {
  agentSupportsSubagentHistory,
  applyEvent,
  emptyTimeline,
  mergeHistory,
  mergeSubagentHistory,
  type Timeline,
  type ToolEntry,
} from './reducer.ts';
import { currentChild, findTool, MAX_PENDING_PARENTS, MAX_TOOL_CHILDREN, childTotal } from './tool-tree.ts';

type Body = { [K in AgentToClientEvent['type']]: Omit<Extract<AgentToClientEvent, { type: K }>, 'ts' | 'seq' | 'dir'> }[AgentToClientEvent['type']];
let seqCounter = 0;
function ev(body: Body): AgentToClientEvent {
  const s = ++seqCounter;
  return { ...body, ts: 1_000 + s, seq: s, dir: 'a2c' } as AgentToClientEvent;
}
const S = { sessionId: 's1' } as const;
const apply = (tl: Timeline, ...events: AgentToClientEvent[]): Timeline => events.reduce((acc, e) => applyEvent(acc, e), tl);

const start = (id: string, toolName: string, argSummary: string, parent?: string) =>
  ev({ type: 'tool.start', ...S, toolUseId: id, toolName, argSummary, ...(parent === undefined ? {} : { parentToolUseId: parent }) });
const end = (id: string, resultSummary: string, parent?: string) =>
  ev({ type: 'tool.end', ...S, toolUseId: id, status: 'ok', durationMs: 5, resultSummary, ...(parent === undefined ? {} : { parentToolUseId: parent }) });

const tool = (tl: Timeline, id: string): ToolEntry => {
  const t = findTool(tl.entries, id);
  if (t === undefined) throw new Error(`没有工具条目 ${id}`);
  return t;
};

describe('tool tree · 挂载', () => {
  test('带 parentToolUseId 的 tool 帧不进顶层，挂到父条目 children，按 id 原地更新', () => {
    const tl = apply(
      emptyTimeline(),
      start('P', 'Agent', 'Run echo'),
      start('c1', 'Bash', 'echo SUB1', 'P'),
      end('c1', '✓ SUB1', 'P'),
      start('c2', 'Write', 'sub.txt', 'P'),
    );
    expect(tl.entries.map((e) => e.id)).toEqual(['P']);
    const p = tool(tl, 'P');
    expect(p.children?.map((c) => [c.id, c.status ?? 'running'])).toEqual([
      ['c1', 'ok'],
      ['c2', 'running'],
    ]);
    expect(childTotal(p)).toBe(2);
    expect(currentChild(p)?.id).toBe('c2');
    expect(tl.pendingChildren).toBeUndefined();
    // 父收尾不动 children
    const done = apply(tl, end('P', '✓ 2 次工具调用 · 1.0s'));
    expect(tool(done, 'P')).toMatchObject({ status: 'ok', resultSummary: '✓ 2 次工具调用 · 1.0s' });
    expect(tool(done, 'P').children).toHaveLength(2);
    // 重发同一帧幂等
    expect(tool(apply(done, start('c1', 'Bash', 'echo SUB1', 'P')), 'P').children).toHaveLength(2);
  });

  test('嵌套：孙工具挂到子 agent 里那次 Agent 调用下', () => {
    const tl = apply(
      emptyTimeline(),
      start('P', 'Agent', 'outer'),
      start('I', 'Agent', 'inner', 'P'),
      start('g1', 'Read', '/a', 'I'),
      end('g1', '✓ 1 行', 'I'),
    );
    expect(tool(tl, 'P').children?.map((c) => c.id)).toEqual(['I']);
    expect(tool(tl, 'I').children?.map((c) => [c.id, c.status])).toEqual([['g1', 'ok']]);
  });

  test('乱序：子工具先到 → 暂存；父出现时并入（含先到 end 后到 start 的子条目）', () => {
    let tl = apply(emptyTimeline(), end('c1', '✓ SUB1', 'P'), start('c1', 'Bash', 'echo SUB1', 'P'), start('c2', 'Write', 'x', 'P'));
    expect(tl.entries).toHaveLength(0);
    expect(tl.pendingChildren?.['P']?.map((c) => [c.id, c.toolName, c.status ?? 'running'])).toEqual([
      ['c1', 'Bash', 'ok'],
      ['c2', 'Write', 'running'],
    ]);
    tl = apply(tl, start('P', 'Agent', 'Run echo'));
    expect(tool(tl, 'P').children?.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(tl.pendingChildren).toBeUndefined();
  });

  test('乱序嵌套：孙先到、子 Agent 再到（挂在暂存里）、父最后到——整棵并入', () => {
    const tl = apply(emptyTimeline(), start('g1', 'Read', '/a', 'I'), start('I', 'Agent', 'inner', 'P'), start('P', 'Agent', 'outer'));
    expect(tool(tl, 'P').children?.map((c) => c.id)).toEqual(['I']);
    expect(tool(tl, 'I').children?.map((c) => c.id)).toEqual(['g1']);
    expect(tl.pendingChildren).toBeUndefined();
  });

  test('父在更早的历史页：历史合并带进父条目时并入暂存的子条目', () => {
    let tl = apply(emptyTimeline(), start('c1', 'Bash', 'echo', 'P'));
    // 让 cutoff 晚于历史项：顶层有一条实时条目
    tl = apply(tl, start('main', 'Bash', 'ls'));
    tl = mergeHistory(tl, { items: [{ kind: 'tool', id: 'P', toolName: 'Agent', argSummary: 'Run echo', status: 'ok', ts: 10 }], hasMore: false });
    expect(tool(tl, 'P').children?.map((c) => c.id)).toEqual(['c1']);
    expect(tl.pendingChildren).toBeUndefined();
  });

  test('封顶：子条目超 MAX_TOOL_CHILDREN 丢最旧的已完成项，childCount 仍是总数；暂存组数封顶', () => {
    let tl = apply(emptyTimeline(), start('P', 'Agent', 'many'));
    for (let i = 0; i < MAX_TOOL_CHILDREN + 5; i++) tl = apply(tl, start(`c${i}`, 'Bash', `n${i}`, 'P'), end(`c${i}`, '✓', 'P'));
    const p = tool(tl, 'P');
    expect(p.children).toHaveLength(MAX_TOOL_CHILDREN);
    expect(p.children?.[0]?.id).toBe('c5');
    expect(childTotal(p)).toBe(MAX_TOOL_CHILDREN + 5);

    let orphan = emptyTimeline();
    for (let i = 0; i < MAX_PENDING_PARENTS + 3; i++) orphan = apply(orphan, start(`x${i}`, 'Bash', 'x', `P${i}`));
    expect(Object.keys(orphan.pendingChildren ?? {})).toHaveLength(MAX_PENDING_PARENTS);
    expect(orphan.pendingChildren?.['P0']).toBeUndefined();
  });

  test('permission.request 带 parentToolUseId 进条目', () => {
    const tl = apply(
      emptyTimeline(),
      ev({ type: 'permission.request', ...S, requestId: 'r1', toolName: 'Write', input: {}, requestedAt: 1, parentToolUseId: 'P' }),
    );
    expect(tl.entries[0]).toMatchObject({ kind: 'permission', parentToolUseId: 'P' });
  });
});

describe('tool tree · 子 agent 回看（mergeSubagentHistory）', () => {
  // ts 与实时帧同一时基（代理机时钟）：实时 c1 的 ts 由 ev() 给（1_000 + seq），回看项更晚
  const items = [
    { kind: 'tool' as const, id: 'c1', toolName: 'Bash', argSummary: 'echo SUB1', status: 'ok' as const, durationMs: 3, resultSummary: '✓ SUB1', ts: 1 },
    { kind: 'tool' as const, id: 'c2', toolName: 'Write', argSummary: 'sub.txt', status: 'ok' as const, resultSummary: '✓ 已写入', ts: 1_000_000 },
    { kind: 'assistant' as const, id: 'm', text: '报告', ts: 1_000_001 },
  ];

  test('挂到父条目下（只收工具项）、置 childrenLoaded；已有子条目以实时为主合并；幂等', () => {
    let tl = mergeHistory(emptyTimeline(), { items: [{ kind: 'tool', id: 'P', toolName: 'Agent', argSummary: 'd', status: 'ok', ts: 0 }], hasMore: false });
    tl = apply(tl, start('c1', 'Bash', 'echo SUB1 (live)', 'P'));
    tl = mergeSubagentHistory(tl, 'P', items);
    const p = tool(tl, 'P');
    expect(p.childrenLoaded).toBe(true);
    expect(p.children?.map((c) => [c.id, c.argSummary, c.status])).toEqual([
      ['c1', 'echo SUB1 (live)', 'ok'],
      ['c2', 'sub.txt', 'ok'],
    ]);
    const again = mergeSubagentHistory(tl, 'P', items);
    expect(tool(again, 'P').children).toHaveLength(2);
  });

  test('空结果也置 childrenLoaded；父不在时间线上原样返回', () => {
    const tl = apply(emptyTimeline(), start('P', 'Agent', 'd'), end('P', '✓'));
    expect(tool(mergeSubagentHistory(tl, 'P', []), 'P')).toMatchObject({ childrenLoaded: true });
    expect(mergeSubagentHistory(tl, 'ghost', items)).toBe(tl);
  });

  test('嵌套回看：子 Agent 条目的回看挂到它自己下面', () => {
    let tl = apply(emptyTimeline(), start('P', 'Agent', 'outer'), end('P', '✓'));
    tl = mergeSubagentHistory(tl, 'P', [{ kind: 'tool', id: 'I', toolName: 'Agent', argSummary: 'inner', status: 'ok', ts: 1 }]);
    tl = mergeSubagentHistory(tl, 'I', [{ kind: 'tool', id: 'g', toolName: 'Read', argSummary: '/a', status: 'ok', ts: 2 }]);
    expect(tool(tl, 'I')).toMatchObject({ childrenLoaded: true, children: [{ id: 'g' }] });
  });
});

describe('tool tree · 部分实时子条目 + 回看（评审 M3）', () => {
  test('实时只收到尾巴，回看补全后按 ts 排序、按 id 去重，总数取并集', () => {
    let tl = apply(emptyTimeline(), start('P', 'Agent', 'd'));
    tl = apply(tl, ev({ type: 'tool.start', ...S, toolUseId: 'c5', toolName: 'Bash', argSummary: 'five', parentToolUseId: 'P' }));
    const liveTs = tool(tl, 'c5').ts;
    tl = apply(tl, end('c5', '✓', 'P'), end('P', '✓ 6 次工具调用 · 9s'));
    const items = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id, i) => ({
      kind: 'tool' as const,
      id,
      toolName: 'Bash',
      argSummary: id,
      status: 'ok' as const,
      ts: id === 'c5' ? liveTs : id === 'c6' ? liveTs + 10 : liveTs - 100 + i,
    }));
    tl = mergeSubagentHistory(tl, 'P', items);
    const p = tool(tl, 'P');
    expect(p.children?.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    expect(childTotal(p)).toBe(6);
    expect(p.children?.find((c) => c.id === 'c5')?.argSummary).toBe('five');
  });
});

test('回看与实时重叠的条目按转录时间排序（实时帧 ts 与转录 ts 不同源也不错位，评审 M3 / 探针 R1）', () => {
  let tl = apply(emptyTimeline(), start('P', 'Agent', 'd'), start('c5', 'Bash', 'five', 'P'), end('c5', '✓', 'P'), end('P', '✓'));
  const items = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id, i) => ({ kind: 'tool' as const, id, toolName: 'Bash', argSummary: id, status: 'ok' as const, ts: 100 + i }));
  tl = mergeSubagentHistory(tl, 'P', items);
  expect(tool(tl, 'P').children?.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
});

describe('tool tree · 父条目被裁掉（评审 m2）', () => {
  function withTrimmedParent(): Timeline {
    let tl = apply(emptyTimeline(), start('P', 'Agent', 'old'), start('o', 'Bash', 'x', 'Q'), end('P', '✓'));
    for (let i = 0; i < TIMELINE_MAX_ENTRIES + 5; i++) tl = apply(tl, start(`t${i}`, 'Bash', 'x'), end(`t${i}`, '✓'));
    return tl;
  }

  test('裁剪记下被裁的 Agent id；之后迟到的子帧直接丢，不进暂存区', () => {
    const tl = withTrimmedParent();
    const trimmed = { ...tl, ...trimTimelineForSave(tl) };
    expect(findTool(trimmed.entries, 'P')).toBeUndefined();
    expect(trimmed.trimmedToolIds).toEqual(['P']);
    const after = apply(trimmed, start('late', 'Bash', 'late child', 'P'));
    expect(after.pendingChildren?.['P']).toBeUndefined();
    // 与父无关的暂存组保留
    expect(after.pendingChildren?.['Q']).toHaveLength(1);
  });

  test('已在暂存区等被裁父的组随裁剪丢掉；trimmedToolIds 随时间线往返', async () => {
    let tl = withTrimmedParent();
    // 手工造一组在等 P 的暂存（如：落盘前父被裁、同批里子帧先进了暂存）
    tl = { ...tl, pendingChildren: { ...tl.pendingChildren, P: [{ kind: 'tool', id: 'z', toolName: 'Bash', argSummary: '', seq: 1, ts: 1 }] } };
    const trimmed = trimTimelineForSave(tl);
    expect(trimmed.pendingChildren?.['P']).toBeUndefined();
    const docs = new MemoryDocStore();
    await saveTimeline(docs, 'mbp/s1', tl);
    const loaded = await loadTimeline(docs, 'mbp/s1');
    expect(loaded?.trimmedToolIds).toEqual(['P']);
    expect(loaded?.pendingChildren?.['P']).toBeUndefined();
    expect(apply(loaded!, start('late', 'Bash', 'x', 'P')).pendingChildren?.['P']).toBeUndefined();
  });
});

describe('tool tree · 落盘', () => {
  test('children（递归）与暂存区随时间线往返', async () => {
    const tl = apply(
      emptyTimeline(),
      start('P', 'Agent', 'outer'),
      start('I', 'Agent', 'inner', 'P'),
      start('g', 'Read', '/a', 'I'),
      start('o', 'Bash', 'x', 'ghost'),
    );
    const docs = new MemoryDocStore();
    await saveTimeline(docs, 'mbp/s1', tl);
    const loaded = await loadTimeline(docs, 'mbp/s1');
    expect(loaded?.entries).toEqual(tl.entries);
    expect(loaded?.pendingChildren).toEqual(tl.pendingChildren!);
  });
});

test('agentSupportsSubagentHistory：≥ 0.8.0', () => {
  expect(agentSupportsSubagentHistory('0.8.0')).toBe(true);
  expect(agentSupportsSubagentHistory('0.7.9')).toBe(false);
  expect(agentSupportsSubagentHistory(undefined)).toBe(false);
});

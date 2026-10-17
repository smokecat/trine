import { describe, expect, test } from 'bun:test';
import type { SessionMeta } from '@trine/core';
import { MemoryDocStore, MemoryKv } from './adapters.ts';
import { emptyTimeline, type TimelineEntry } from './reducer.ts';
import {
  KV_IDENTITY,
  KV_PEER,
  TIMELINE_MAX_ENTRIES,
  listTimelineKeys,
  loadIdentity,
  loadMachineDoc,
  saveMachineDoc,
  loadPeer,
  KNOWN_MODELS_SEED,
  loadPrefs,
  savePrefs,
  loadTimeline,
  mergeSeqMaps,
  persistPeer,
  saveTimeline,
  type PeerState,
} from './storage.ts';

function peer(over: Partial<PeerState['machines'][string]> = {}): PeerState {
  return {
    v: 1,
    serverUrl: 'http://localhost:5173',
    machines: {
      mbp: { agentBoxPubKey: 'k', pairedAt: 1, outSeq: {}, inCursors: {}, sessions: {}, ...over },
    },
  };
}

describe('storage · peer 落盘取 max', () => {
  test('outSeq / inCursors 逐 scope 与存储现值取 max，其余字段以传入为准', () => {
    const kv = new MemoryKv();
    persistPeer(kv, peer({ outSeq: { '': 5, s1: 9 }, inCursors: { s1: 40 } }));
    // 另一个（旧主）标签页的内存态落后：不能把 9 / 40 拉回去
    const merged = persistPeer(kv, peer({ outSeq: { '': 7, s1: 3 }, inCursors: { s1: 12, s2: 2 }, name: 'MBP' }));
    expect(merged.machines['mbp']!.outSeq).toEqual({ '': 7, s1: 9 });
    expect(merged.machines['mbp']!.inCursors).toEqual({ s1: 40, s2: 2 });
    expect(merged.machines['mbp']!.name).toBe('MBP');
    expect(loadPeer(kv)).toEqual(merged);
  });

  test('serverUrl 变了（重新配对到别的服务端）不合并旧值', () => {
    const kv = new MemoryKv();
    persistPeer(kv, peer({ outSeq: { '': 99 } }));
    const merged = persistPeer(kv, { ...peer({ outSeq: { '': 1 } }), serverUrl: 'https://other.example' });
    expect(merged.machines['mbp']!.outSeq).toEqual({ '': 1 });
  });

  test('mergeSeqMaps 是对称的 max', () => {
    expect(mergeSeqMaps({ a: 1, b: 5 }, { b: 2, c: 3 })).toEqual({ a: 1, b: 5, c: 3 });
  });

  test('坏掉的 peer 当作不存在；坏掉的 identity 抛错（不能静默重建）', () => {
    const kv = new MemoryKv();
    kv.set(KV_PEER, '{not json');
    expect(loadPeer(kv)).toBeNull();
    kv.set(KV_IDENTITY, JSON.stringify({ v: 1, deviceId: 'x' }));
    expect(() => loadIdentity(kv)).toThrow(/损坏/);
  });

  test('prefs 缺省带默认模型列表', () => {
    const prefs = loadPrefs(new MemoryKv());
    expect(prefs.knownModels).toContain('claude-fable-5-1');
    expect(prefs.knownModels).toContain('claude-opus-5-5');
    expect(prefs.knownModelsSeed).toBe(KNOWN_MODELS_SEED);
  });

  test('老 prefs（无 seed 字段）加载时补进新增默认模型，且只补一次', () => {
    const kv = new MemoryKv();
    kv.set('trine.prefs', JSON.stringify({ v: 1, theme: 'dark', promptSnippets: [], knownModels: ['claude-opus-5', 'my-model'] }));
    const first = loadPrefs(kv);
    expect(first.knownModels).toEqual(['claude-opus-5', 'my-model', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    expect(first.knownModelsSeed).toBe(KNOWN_MODELS_SEED);
    expect(first.theme).toBe('dark');
    // 用户删掉一个默认模型后再加载，不会被复活
    savePrefs(kv, { ...first, knownModels: first.knownModels.filter((m) => m !== 'claude-sonnet-5') });
    expect(loadPrefs(kv).knownModels).not.toContain('claude-sonnet-5');
  });

  test('listGroupBy：老 prefs 缺字段落默认 workspace，且不重置其它字段（M7）', () => {
    const kv = new MemoryKv();
    kv.set(
      'trine.prefs',
      JSON.stringify({ v: 1, theme: 'dark', promptSnippets: ['继续'], knownModels: ['x'], knownModelsSeed: KNOWN_MODELS_SEED }),
    );
    const prefs = loadPrefs(kv);
    expect(prefs.listGroupBy).toBe('workspace');
    expect(prefs.theme).toBe('dark');
    expect(prefs.promptSnippets).toEqual(['继续']);
    expect(loadPrefs(new MemoryKv()).listGroupBy).toBe('workspace');
  });

  test('listGroupBy：未知枚举值（新版本写入后回滚）落默认，不炸整份 prefs', () => {
    const kv = new MemoryKv();
    kv.set(
      'trine.prefs',
      JSON.stringify({ v: 1, theme: 'light', promptSnippets: [], knownModels: [], knownModelsSeed: KNOWN_MODELS_SEED, listGroupBy: 'machine' }),
    );
    const prefs = loadPrefs(kv);
    expect(prefs.listGroupBy).toBe('workspace');
    expect(prefs.theme).toBe('light');
    savePrefs(kv, { ...prefs, listGroupBy: 'none' });
    expect(loadPrefs(kv).listGroupBy).toBe('none');
  });
});

describe('storage · timeline', () => {
  test('往返保真，超过上限只留最后 500 条，heartbeat 不落盘', async () => {
    const docs = new MemoryDocStore();
    const entries: TimelineEntry[] = [];
    for (let i = 1; i <= TIMELINE_MAX_ENTRIES + 10; i++) {
      entries.push({ kind: 'run_state', id: `run.state:${i}`, state: 'idle', seq: i, ts: i });
    }
    const tl = { ...emptyTimeline(), entries, lastAppliedSeq: 510, heartbeat: { at: 1, runElapsedMs: 1, silentMs: 0, phase: 'run' as const } };
    await saveTimeline(docs, 'mbp/s1', tl);
    const loaded = await loadTimeline(docs, 'mbp/s1');
    expect(loaded?.entries).toHaveLength(TIMELINE_MAX_ENTRIES);
    expect(loaded?.entries[0]?.seq).toBe(11);
    expect(loaded?.lastAppliedSeq).toBe(510);
    expect(loaded?.heartbeat).toBeNull();
    expect(await listTimelineKeys(docs)).toEqual(['mbp/s1']);
  });

  test('不存在 / 坏数据 → null', async () => {
    const docs = new MemoryDocStore();
    expect(await loadTimeline(docs, 'mbp/none')).toBeNull();
    await docs.set('timeline:mbp/bad', { v: 1, entries: 'nope' });
    expect(await loadTimeline(docs, 'mbp/bad')).toBeNull();
  });
});

describe('MachineDoc：一条坏会话行不该丢掉整份快照（N7）', () => {
  const info = {
    name: 'MBP',
    platform: 'darwin',
    osVersion: '25.5.0',
    agentVersion: '0.1.0',
    claudeVersion: '2.0.1',
    activeSessionCount: 1,
  };
  const cwd = { favorites: ['/a'], defaultCwd: '/a' };
  const meta = (sessionId: string): SessionMeta => ({
    sessionId,
    title: sessionId,
    state: 'idle',
    lastActivityAt: 1_700_000_000_000,
    cwd: '/a',
    model: 'test-model',
    permissionMode: 'default',
    costUsd: 0,
  });

  /** 直接往 DocStore 塞一份「其中一行 schema 不认」的快照 */
  async function seed(docs: MemoryDocStore, bad: unknown): Promise<void> {
    await docs.set('machine:mbp', {
      v: 1,
      info,
      cwd,
      sessions: { good: meta('good'), bad },
    });
  }

  test('坏行被丢弃，info / cwd / 好行全部保留', async () => {
    const docs = new MemoryDocStore();
    // 将来 SessionMeta 加了必填字段、或 agent 发出本构建不认的 meta 变体，
    // 形状就是这样：字段少了一半
    await seed(docs, { sessionId: 'bad', title: 'x' });

    const dropped: number[] = [];
    const doc = await loadMachineDoc(docs, 'mbp', (n) => dropped.push(n));

    // 修复前这里整份返回 null：机器卡回到「agent 未知 · claude 未知」、列表 0 行
    expect(doc).not.toBeNull();
    expect(doc!.info).toEqual(info);
    expect(doc!.cwd).toEqual(cwd);
    expect(Object.keys(doc!.sessions)).toEqual(['good']);
    expect(dropped).toEqual([1]);
  });

  test.each([null, 'not an object', 42, [], { sessionId: '' }])(
    '各种坏行形状都只丢自己：%p',
    async (bad) => {
      const docs = new MemoryDocStore();
      await seed(docs, bad);
      const doc = await loadMachineDoc(docs, 'mbp');
      expect(doc?.info).toEqual(info);
      expect(Object.keys(doc?.sessions ?? {})).toEqual(['good']);
    },
  );

  test('骨架本身坏了才整份返回 null', async () => {
    const docs = new MemoryDocStore();
    await docs.set('machine:mbp', { v: 2, info, cwd, sessions: {} });
    expect(await loadMachineDoc(docs, 'mbp')).toBeNull();
    await docs.set('machine:mbp', 'garbage');
    expect(await loadMachineDoc(docs, 'mbp')).toBeNull();
  });

  test('没有坏行时不调 onDropped', async () => {
    const docs = new MemoryDocStore();
    await saveMachineDoc(docs, 'mbp', { info, cwd, sessions: { a: meta('a') } });
    const dropped: number[] = [];
    const doc = await loadMachineDoc(docs, 'mbp', (n) => dropped.push(n));
    expect(Object.keys(doc!.sessions)).toEqual(['a']);
    expect(dropped).toEqual([]);
  });
});

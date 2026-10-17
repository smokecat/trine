import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from '../bridge/emitter.ts';
import { SeqCursors } from '../net/envelope.ts';
import { AgentState, RESTART_GAP } from './state.ts';

let dir: string;
let path: string;
let logs: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trine-state-'));
  path = join(dir, 'state.json');
  logs = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const load = (machineId = 'mbp', debounceMs = 20) =>
  AgentState.load({ path, machineId, log: (l) => logs.push(l), debounceMs });

async function readJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

describe('AgentState · 落盘', () => {
  test('debounce 合并：窗口内多次改动只落一次，内容是最后的值', async () => {
    const state = await load();
    state.noteOutSeq('s1', 1);
    state.noteOutSeq('s1', 2);
    state.noteOutSeq(null, 7);
    expect(state.dirty).toBe(true);
    // 窗口未到，文件还不存在
    await expect(stat(path)).rejects.toThrow();
    await Bun.sleep(60);
    expect(state.dirty).toBe(false);
    expect((await readJson())['outSeq']).toEqual({ s1: 2, '': 7 });
  });

  test('flush 立即写；无改动时不写', async () => {
    const state = await load();
    await state.flush();
    await expect(stat(path)).rejects.toThrow();
    state.rememberSession('s1', { cwd: '/p', model: 'm', permissionMode: 'default' });
    await state.flush();
    expect(state.dirty).toBe(false);
    expect((await readJson())['sessions']).toEqual({
      s1: { cwd: '/p', model: 'm', permissionMode: 'default' },
    });
  });

  test('文件权限 0600', async () => {
    const state = await load();
    state.noteOutSeq('s1', 1);
    await state.flush();
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('outSeq 只进不退', async () => {
    const state = await load();
    state.noteOutSeq('s1', 5);
    state.noteOutSeq('s1', 3);
    await state.flush();
    expect((await readJson())['outSeq']).toEqual({ s1: 5 });
  });
});

describe('AgentState · 恢复', () => {
  test('往返：outSeq 恢复到 last+1+GAP 并能喂给 emitter；inCursors 原样', async () => {
    const first = await load();
    first.noteOutSeq('s1', 40);
    first.noteOutSeq(null, 3);
    const cursors = new SeqCursors();
    cursors.accept('phone', 's1', 9);
    first.setInCursors(cursors.snapshot());
    await first.flush();

    const second = await load();
    expect(second.outSeqForRestore()).toEqual({
      s1: 40 + 1 + RESTART_GAP,
      '': 3 + 1 + RESTART_GAP,
    });
    const emitter = new EventEmitter({ sink: () => {} });
    emitter.restore(second.outSeqForRestore());
    expect(emitter.emit({ type: 'run.state', state: 'idle' }, 's1').event.seq).toBe(141);

    const restored = new SeqCursors();
    restored.restore(second.inCursorsForRestore());
    expect(restored.lastSeen('phone', 's1')).toBe(9);
  });

  test('machineId 不匹配 → 当作空 + warn', async () => {
    const first = await load('mbp');
    first.noteOutSeq('s1', 40);
    await first.flush();
    const other = await load('another');
    expect(other.outSeqForRestore()).toEqual({});
    expect(logs.some((l) => l.includes('另一台机器'))).toBe(true);
  });

  test('文件损坏 → 当作空 + warn，且不阻止后续落盘', async () => {
    await writeFile(path, '{ not json');
    const state = await load();
    expect(state.outSeqForRestore()).toEqual({});
    expect(logs.some((l) => l.includes('损坏'))).toBe(true);
    state.noteOutSeq('s1', 1);
    await state.flush();
    expect((await readJson())['v']).toBe(1);
  });

  test('schema 不符（负数 seq）→ 当作空', async () => {
    await writeFile(
      path,
      JSON.stringify({ v: 1, machineId: 'mbp', outSeq: { s1: -1 }, inCursors: {}, sessions: {} }),
    );
    const state = await load();
    expect(state.outSeqForRestore()).toEqual({});
  });

  test('sessions：remember 去重、updateSession 只改给定字段', async () => {
    const state = await load();
    state.rememberSession('s1', { cwd: '/a', model: 'm1', permissionMode: 'default' });
    await state.flush();
    state.rememberSession('s1', { cwd: '/a', model: 'm1', permissionMode: 'default' });
    expect(state.dirty).toBe(false);
    state.updateSession('s1', { model: 'm2' });
    expect(state.sessionParams('s1')).toEqual({ cwd: '/a', model: 'm2', permissionMode: 'default' });
    // 不存在的会话 update 是空操作
    state.updateSession('nope', { model: 'x' });
    expect(state.sessionParams('nope')).toBeUndefined();
  });
});

describe('AgentState · forgetSession', () => {
  test('删除会话参数并落盘；outSeq 保留；不存在的 sid 不置脏', async () => {
    const state = await load();
    state.rememberSession('s1', { cwd: '/r', model: 'm', permissionMode: 'default', started: false });
    state.noteOutSeq('s1', 9);
    await state.flush();
    state.forgetSession('nope');
    expect(state.dirty).toBe(false);
    state.forgetSession('s1');
    expect(state.sessionParams('s1')).toBeUndefined();
    await state.flush();
    const file = await readJson();
    expect(file.sessions).toEqual({});
    expect((file.outSeq as Record<string, number>).s1).toBe(9);
  });
});

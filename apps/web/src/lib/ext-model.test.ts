import { describe, expect, test } from 'bun:test';
import type { ExtPlan, ExtRecord } from '@trine/core';
import {
  applyLocalEffects,
  ExtCatalogCache,
  extensionsFor,
  isNewer,
  mergeRecords,
  placeRecords,
  readKey,
  recordText,
  responseKey,
  runTokenAction,
  supportsExtensions,
  supportsExtRecords,
  type ExtActionDeps,
  type ExtActionPlanEvent,
  type ExtActionResult,
  type ExtReadResponse,
} from './ext-model.ts';

const base = { ts: 1, seq: 1, dir: 'a2c' as const };
const plan: ExtPlan = {
  ext: 'tasks',
  extName: 'Tasks',
  extVersion: '1',
  actionLabel: '接续',
  steps: [{ type: 'prompt.send', targetSessionId: 's1', sessionTitle: 'x', cwd: '/r', permissionMode: 'default', busy: false, text: 'go' }],
};
const planEvent = (planId: string): ExtActionPlanEvent => ({ type: 'ext.action.plan', ...base, reqId: 'r', invocationId: 'i', planId, plan, expiresAt: 9 });
const result = (patch: Partial<ExtActionResult> = {}): ExtActionResult => ({ type: 'ext.action.result', ...base, reqId: 'r', invocationId: 'i', ok: true, ...patch });

function deps(overrides: Partial<ExtActionDeps> = {}): ExtActionDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    uuid: () => 'inv',
    newSessionDefaults: () => ({ model: 'opus', permissionMode: 'default' }),
    prepare: async (token, invocationId, ns) => {
      calls.push(`prepare:${token}:${invocationId}:${ns.model}`);
      return result();
    },
    commit: async (planId) => {
      calls.push(`commit:${planId}`);
      return result();
    },
    cancel: (planId) => calls.push(`cancel:${planId}`),
    confirm: async () => {
      calls.push('confirm');
      return true;
    },
    ...overrides,
  };
}

describe('runTokenAction', () => {
  test('不需要确认：prepare 直接返回结果，带上新会话默认值', async () => {
    const d = deps();
    const out = await runTokenAction('t1', d);
    expect(out).toMatchObject({ kind: 'done' });
    expect(d.calls).toEqual(['prepare:t1:inv:opus']);
  });

  test('需要确认：展示计划 → commit；invoke 的第二阶段计划同样要确认', async () => {
    let commits = 0;
    const d = deps({
      prepare: async () => planEvent('p1'),
      commit: async (planId) => {
        commits++;
        return (commits === 1 ? planEvent('p2') : result({ message: '完成' })) as ExtActionResult;
      },
    });
    const out = await runTokenAction('t', d);
    expect(out).toMatchObject({ kind: 'done', result: { message: '完成' } });
    expect(d.calls.filter((c) => c === 'confirm')).toHaveLength(2);
  });

  test('用户取消：发 cancel，不 commit', async () => {
    const d = deps({ prepare: async () => planEvent('p1'), confirm: async () => false });
    const out = await runTokenAction('t', d);
    expect(out).toEqual({ kind: 'cancelled' });
    expect(d.calls).toEqual(['cancel:p1']);
  });

  test('agent 拒绝 → failed 带原因；请求超时 → failed（结果未知）', async () => {
    const denied = await runTokenAction('t', deps({ prepare: async () => result({ ok: false, error: { code: 'stale', message: '已过期' } }) }));
    expect(denied).toEqual({ kind: 'failed', message: '已过期', code: 'stale' });
    const timeout = await runTokenAction(
      't',
      deps({
        prepare: async () => {
          throw new Error('超时');
        },
      }),
    );
    expect(timeout).toMatchObject({ kind: 'failed', code: 'unknown_outcome' });
  });
});

describe('applyLocalEffects', () => {
  test('按顺序执行插入、复制、刷新', async () => {
    const calls: string[] = [];
    await applyLocalEffects(
      [
        { type: 'prompt.insert', text: 'a' },
        { type: 'copy', text: 'b' },
        { type: 'refresh' },
      ],
      {
        insert: (t) => calls.push(`insert:${t}`),
        copy: async (t) => {
          calls.push(`copy:${t}`);
          return true;
        },
        refresh: () => calls.push('refresh'),
      },
    );
    expect(calls).toEqual(['insert:a', 'copy:b', 'refresh']);
  });
});

describe('目录与读取', () => {
  test('supportsExtensions 看 machine.info.extensions，不看版本号', () => {
    const info = { name: 'm', platform: 'linux', osVersion: '', agentVersion: '9.9.9', claudeVersion: '', activeSessionCount: 0 };
    expect(supportsExtensions(info)).toBe(false);
    expect(supportsExtensions({ ...info, extensions: { api: 1, rev: 'r', count: 0 } })).toBe(true);
  });

  test('ExtCatalogCache：rev 不变不重拉，并发复用；坏条目跳过', async () => {
    let fetches = 0;
    const cache = new ExtCatalogCache(async () => {
      fetches++;
      return {
        rev: 'r1',
        items: [
          { id: 'tasks', name: 'A', version: '1', apiVersion: 1, contributes: { sessionPanel: { title: 'T' } }, capabilities: [], enabled: true, policy: { trust: 'custom', capabilities: {} }, status: 'ok' },
          { id: 'other', capabilities: ['future.thing'] },
        ],
      };
    });
    const [a, b] = await Promise.all([cache.ensure('m', 'r1'), cache.ensure('m', 'r1')]);
    expect(a).toBe(b);
    await cache.ensure('m', 'r1');
    expect(fetches).toBe(1);
    expect(a.items.map((i) => i.id)).toEqual(['tasks']);
    expect(extensionsFor(a.items, 'sessionPanel').map((i) => i.id)).toEqual(['tasks']);
    expect(extensionsFor(a.items, 'linkPicker')).toEqual([]);
    await cache.ensure('m', 'r2');
    expect(fetches).toBe(2);
  });

  test('推送与请求落到同一个键；rev 小的晚到结果不覆盖', () => {
    const res = { type: 'ext.read.response', ...base, ext: 'a', op: 'view', point: 'sessionPanel', targetSessionId: 's1', cwd: '/r', rev: 5, ok: true } as ExtReadResponse;
    expect(responseKey('m', res)).toBe(readKey({ machineId: 'm', ext: 'a', op: 'view', point: 'sessionPanel', targetSessionId: 's1' }));
    expect(isNewer(undefined, res)).toBe(true);
    expect(isNewer(res, { rev: 4 })).toBe(false);
    expect(isNewer(res, { rev: 6 })).toBe(true);
  });
});

describe('时间线记录卡', () => {
  const rec = (id: string, at: number, patch: Partial<ExtRecord> = {}): ExtRecord => ({
    id,
    at,
    ext: 'tasks',
    extName: 'Tasks',
    kind: 'linked',
    label: id,
    ...patch,
  });

  test('supportsExtRecords 只认摘要里的 records: true', () => {
    expect(supportsExtRecords(null)).toBe(false);
    expect(supportsExtRecords({ extensions: { api: 1, rev: 'r', count: 0 } } as never)).toBe(false);
    expect(supportsExtRecords({ extensions: { api: 1, rev: 'r', count: 0, records: true } } as never)).toBe(true);
  });

  test('mergeRecords：按 id 去重、按时间排序（推送先于拉取到达也不重复）', () => {
    const live = mergeRecords(undefined, [rec('b', 20)]);
    expect(mergeRecords(live, [rec('a', 10), rec('b', 20)]).map((r) => r.id)).toEqual(['a', 'b']);
  });

  test('placeRecords：排在第一条更晚的条目前；都更晚的放末尾；hideOlder 时藏掉早于首条的', () => {
    const entries = [{ ts: 10 }, { ts: 20 }, { ts: 30 }];
    const records = [rec('r0', 5), rec('r1', 15), rec('r2', 20), rec('r3', 40)];
    const shown = placeRecords(entries, records, false);
    expect([...shown.before.entries()].map(([i, rs]) => [i, rs.map((r) => r.id)])).toEqual([
      [0, ['r0']],
      [1, ['r1']],
      [2, ['r2']],
    ]);
    expect(shown.tail.map((r) => r.id)).toEqual(['r3']);
    expect(placeRecords(entries, records, true).before.get(0)).toBeUndefined();
    expect(placeRecords([], records, true).tail).toHaveLength(4);
  });

  test('recordText：关联 / 取消关联 / 动作；未知种类按通用样式', () => {
    expect(recordText(rec('x', 1, { label: 'Task A' }))).toBe('已关联 Task A');
    expect(recordText(rec('x', 1, { kind: 'unlinked', label: 'Task A' }))).toBe('已取消关联 Task A');
    expect(recordText(rec('x', 1, { kind: 'action', label: '归档', subject: 'Task A', message: '已归档' }))).toBe('归档 · Task A：已归档');
    expect(recordText(rec('x', 1, { kind: 'future', label: '做了点什么' }))).toBe('做了点什么');
  });
});

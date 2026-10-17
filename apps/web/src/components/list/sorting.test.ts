import { describe, expect, test } from 'bun:test';
import type { SessionMeta, SessionState } from '@trine/core';
import {
  compareSessions,
  countActiveSessions,
  displayModel,
  shortModel,
  lastEventPrefix,
  selectMachineFilterItems,
  selectSessionRows,
  sessionTitle,
  shortCwd,
} from './sorting.ts';

function meta(over: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  return {
    title: '',
    state: 'idle' as SessionState,
    lastActivityAt: 0,
    cwd: '/home/me/repo',
    model: 'claude-opus-5',
    permissionMode: 'default',
    costUsd: 0,
    ...over,
  };
}

describe('compareSessions / selectSessionRows', () => {
  test('等待批准置顶，其次运行中，其余按最后活动时间', () => {
    const sessions = {
      m1: {
        a: meta({ sessionId: 'a', state: 'idle', lastActivityAt: 900 }),
        b: meta({ sessionId: 'b', state: 'running', lastActivityAt: 100 }),
        c: meta({ sessionId: 'c', state: 'waiting_permission', lastActivityAt: 1 }),
        d: meta({ sessionId: 'd', state: 'idle', lastActivityAt: 1000 }),
      },
    };
    expect(selectSessionRows(sessions, null).map((r) => r.meta.sessionId)).toEqual(['c', 'b', 'd', 'a']);
  });

  test('error / stopped 与 idle 同档，只按活动时间排', () => {
    const sessions = {
      m1: {
        a: meta({ sessionId: 'a', state: 'error', lastActivityAt: 10 }),
        b: meta({ sessionId: 'b', state: 'stopped', lastActivityAt: 30 }),
        c: meta({ sessionId: 'c', state: 'idle', lastActivityAt: 20 }),
      },
    };
    expect(selectSessionRows(sessions, null).map((r) => r.meta.sessionId)).toEqual(['b', 'c', 'a']);
  });

  test('完全等值时按 sessionId 全序，不依赖 Object.values 顺序', () => {
    const x = { machineId: 'm', meta: meta({ sessionId: 'x', lastActivityAt: 5 }) };
    const y = { machineId: 'm', meta: meta({ sessionId: 'y', lastActivityAt: 5 }) };
    expect(compareSessions(x, y)).toBeLessThan(0);
    expect(compareSessions(y, x)).toBeGreaterThan(0);
  });

  test('跨机器摊平；filter 只留该机器', () => {
    const sessions = {
      m1: { a: meta({ sessionId: 'a', lastActivityAt: 1 }) },
      m2: { b: meta({ sessionId: 'b', lastActivityAt: 2 }) },
    };
    expect(selectSessionRows(sessions, null)).toHaveLength(2);
    expect(selectSessionRows(sessions, 'm2').map((r) => r.meta.sessionId)).toEqual(['b']);
    expect(selectSessionRows(sessions, 'nope')).toEqual([]);
  });
});

describe('lastEventPrefix', () => {
  test('等待批准 ✋ / 运行中 🔧 / 出错 🛑 / 其余无前缀', () => {
    expect(lastEventPrefix('waiting_permission')).toBe('✋');
    expect(lastEventPrefix('running')).toBe('🔧');
    expect(lastEventPrefix('error')).toBe('🛑');
    expect(lastEventPrefix('idle')).toBe('');
    expect(lastEventPrefix('stopped')).toBe('');
  });
});

describe('sessionTitle / shortCwd / displayModel', () => {
  test('标题为空（含纯空白）退回 sessionId 前 8 位', () => {
    expect(sessionTitle(meta({ sessionId: 'abcdefghijkl' }))).toBe('abcdefgh');
    expect(sessionTitle(meta({ sessionId: 'abcdefghijkl', title: '   ' }))).toBe('abcdefgh');
    expect(sessionTitle(meta({ sessionId: 'abcdefghijkl', title: '修复 bug' }))).toBe('修复 bug');
  });

  test('cwd 只留尾部两段', () => {
    expect(shortCwd('/Users/me/workspace/repo/trine')).toBe('…/repo/trine');
    expect(shortCwd('/Users/me/workspace/repo/trine/')).toBe('…/repo/trine');
    expect(shortCwd('~/repo')).toBe('~/repo');
    expect(shortCwd('/repo')).toBe('/repo');
    expect(shortCwd('')).toBe('');
  });

  test('空 model 显示「默认」', () => {
    expect(displayModel('')).toBe('默认');
    expect(displayModel('  ')).toBe('默认');
    expect(displayModel('claude-opus-5')).toBe('claude-opus-5');
  });

  test('shortModel 带版本号，opus 5 与 5.5 分得开', () => {
    expect(shortModel('')).toBe('默认');
    expect(shortModel('claude-opus-5-5')).toBe('opus 5.5');
    expect(shortModel('claude-opus-5')).toBe('opus 5');
    expect(shortModel('claude-fable-5-1')).toBe('fable 5.1');
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku 4.5');
    expect(shortModel('claude-sonnet-4-5-20250929')).toBe('sonnet 4.5');
    expect(shortModel('opus')).toBe('opus');
    expect(shortModel('my-custom-model')).toBe('my-custom-model');
  });
});

describe('selectMachineFilterItems / countActiveSessions', () => {
  const sessions = {
    m1: {
      a: meta({ sessionId: 'a', state: 'running' }),
      b: meta({ sessionId: 'b', state: 'waiting_permission' }),
      c: meta({ sessionId: 'c', state: 'idle' }),
    },
    m2: { d: meta({ sessionId: 'd', state: 'stopped' }) },
  };

  test('活跃 = running + waiting_permission', () => {
    expect(countActiveSessions(sessions.m1)).toBe(2);
    expect(countActiveSessions(sessions.m2)).toBe(0);
    expect(countActiveSessions(undefined)).toBe(0);
  });

  test('在线机器排前，同档按名字；带活跃数与排队数', () => {
    const machines = {
      m1: { machineId: 'm1', name: 'zeta', online: false, parkedCount: 3 },
      m2: { machineId: 'm2', name: 'beta', online: true, parkedCount: 0 },
      m3: { machineId: 'm3', name: 'alpha', online: true, parkedCount: 0 },
      m4: { machineId: 'm4', name: 'unknown', online: null, parkedCount: 0 },
    };
    const items = selectMachineFilterItems(machines, sessions);
    expect(items.map((i) => i.name)).toEqual(['alpha', 'beta', 'unknown', 'zeta']);
    expect(items.find((i) => i.machineId === 'm1')).toMatchObject({ parkedCount: 3, activeCount: 2 });
  });
});

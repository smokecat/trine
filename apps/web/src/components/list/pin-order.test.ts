import { describe, expect, test } from 'bun:test';
import { DEFAULT_LIST_QUERY, filterSessions, groupKey, type ListQuery } from './filtering.ts';
import { effectivePinOrder, pinDropTarget, pinMoveTarget, supportsPinOrder } from './pin-order.ts';
import type { SessionMeta } from '@trine/core';

describe('effectivePinOrder', () => {
  test('有 pinOrder 按它；没有按置顶时间倒序；规范化去尾 / 并去重', () => {
    expect(effectivePinOrder({ pinned: { '/a': 1, '/b': 2 }, pinOrder: ['/a', '/b'] })).toEqual(['/a', '/b']);
    expect(effectivePinOrder({ pinned: { '/a': 1, '/b': 2 } })).toEqual(['/b', '/a']);
    expect(effectivePinOrder({ pinned: { '/a/': 1, '/a': 2 } })).toEqual(['/a']);
    expect(effectivePinOrder(null)).toEqual([]);
  });
});

describe('pinMoveTarget / pinDropTarget', () => {
  const order = ['/a', '/b', '/c'];
  test('上移 / 下移 / 移到本机最前', () => {
    expect(pinMoveTarget(order, '/b', 'up')).toBe('/a');
    expect(pinMoveTarget(order, '/a', 'up')).toBeUndefined();
    expect(pinMoveTarget(order, '/a', 'down')).toBe('/c');
    expect(pinMoveTarget(order, '/b', 'down')).toBeNull();
    expect(pinMoveTarget(order, '/c', 'down')).toBeUndefined();
    expect(pinMoveTarget(order, '/c', 'top')).toBe('/a');
    expect(pinMoveTarget(order, '/a', 'top')).toBeUndefined();
    expect(pinMoveTarget(order, '/x', 'up')).toBeUndefined();
  });

  test('拖放：往上落在目标之前，往下落在目标之后', () => {
    expect(pinDropTarget(order, '/c', '/a')).toBe('/a');
    expect(pinDropTarget(order, '/a', '/b')).toBe('/c');
    expect(pinDropTarget(order, '/a', '/c')).toBeNull();
    expect(pinDropTarget(order, '/a', '/a')).toBeUndefined();
  });

  test('能力位', () => {
    expect(supportsPinOrder({ cwd: { pinOrder: true } } as never)).toBe(true);
    expect(supportsPinOrder({ agentVersion: '0.25.0' } as never)).toBe(false);
    expect(supportsPinOrder(null)).toBe(false);
  });
});

describe('置顶区排序（plan §1）', () => {
  const meta = (sessionId: string, cwd: string, createdAt: number): SessionMeta => ({
    sessionId,
    title: '',
    state: 'idle',
    lastActivityAt: createdAt,
    createdAt,
    cwd,
    model: '',
    permissionMode: 'default',
    costUsd: 0,
  });
  const ws: ListQuery = { ...DEFAULT_LIST_QUERY, groupBy: 'workspace' };
  const sessions = {
    m1: { a: meta('a', '/a', 1), b: meta('b', '/b', 2), u: meta('u', '/u', 99) },
    m2: { c: meta('c', '/c', 3) },
  };
  const pinned = { m1: { '/a': 10, '/b': 20 }, m2: { '/c': 30, '/d': 5 } };
  const keys = (r: ReturnType<typeof filterSessions>) => r.groups!.map((g) => g.key);

  test('全部机器：置顶区按稳定机器顺序分段，段内按 pinOrder；非置顶在后', () => {
    const r = filterSessions(sessions, ws, {}, pinned, {
      machineOrder: ['m2', 'm1'],
      pinOrder: { m1: ['/a', '/b'], m2: ['/d', '/c'] },
    });
    expect(keys(r)).toEqual([groupKey('m2', '/d'), groupKey('m2', '/c'), groupKey('m1', '/a'), groupKey('m1', '/b'), groupKey('m1', '/u')]);
  });

  test('没有 pinOrder 的机器（旧 agent）段内按置顶时间倒序', () => {
    const r = filterSessions(sessions, ws, {}, pinned, { machineOrder: ['m1', 'm2'], pinOrder: { m1: ['/a', '/b'] } });
    expect(keys(r)).toEqual([groupKey('m1', '/a'), groupKey('m1', '/b'), groupKey('m2', '/c'), groupKey('m2', '/d'), groupKey('m1', '/u')]);
  });

  test('单机视图：只看这台的顺序', () => {
    const r = filterSessions(sessions, { ...ws, machine: 'm1' }, {}, pinned, { pinOrder: { m1: ['/b', '/a'] } });
    expect(keys(r)).toEqual([groupKey('m1', '/b'), groupKey('m1', '/a'), groupKey('m1', '/u')]);
  });
});

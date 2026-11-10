import { describe, expect, test } from 'bun:test';
import { AgentToClientEventSchema, ClientToAgentEventSchema, movePinOrder, normalizePinOrder } from './index.ts';
import { MachineInfoSchema } from '../types/index.ts';

const ts = 1;
const c2a = { ts, seq: 1, dir: 'c2a' } as const;
const a2c = { ts, seq: 1, dir: 'a2c' } as const;

describe('pin-order 协议帧', () => {
  test('cwd.pin.move：before 可为 null；空路径拒绝', () => {
    expect(ClientToAgentEventSchema.parse({ type: 'cwd.pin.move', ...c2a, reqId: 'r', path: '/a', before: null }).type).toBe('cwd.pin.move');
    expect(ClientToAgentEventSchema.safeParse({ type: 'cwd.pin.move', ...c2a, reqId: 'r', path: '/a' }).success).toBe(false);
    expect(ClientToAgentEventSchema.safeParse({ type: 'cwd.pin.move', ...c2a, reqId: 'r', path: '', before: null }).success).toBe(false);
  });

  test('cwd.pin.move.response 与带 pinOrder 的 cwd 快照', () => {
    const res = { type: 'cwd.pin.move.response', ...a2c, reqId: 'r', ok: false, error: { code: 'not_pinned', message: 'x' } };
    expect(AgentToClientEventSchema.parse(res).type).toBe('cwd.pin.move.response');
    const updated = AgentToClientEventSchema.parse({
      type: 'cwd.updated',
      ...a2c,
      favorites: [],
      defaultCwd: '/',
      pinned: { '/a': 1 },
      pinOrder: ['/a'],
    });
    expect(updated.type === 'cwd.updated' && updated.pinOrder).toEqual(['/a']);
    // 旧 agent 不带 pinOrder 照样合法
    expect(AgentToClientEventSchema.safeParse({ type: 'cwd.list.response', ...a2c, reqId: 'q', favorites: [], defaultCwd: '/' }).success).toBe(true);
  });

  test('machine.info 的 cwd.pinOrder 能力位可选', () => {
    const base = { name: 'n', platform: 'linux', osVersion: '1', agentVersion: '0', claudeVersion: '0', activeSessionCount: 0 };
    expect(MachineInfoSchema.parse(base).cwd).toBeUndefined();
    expect(MachineInfoSchema.parse({ ...base, cwd: { pinOrder: true } }).cwd?.pinOrder).toBe(true);
  });
});

describe('normalizePinOrder / movePinOrder', () => {
  test('规范化：去重、剔除非置顶与非字符串，缺的按时间倒序补到末尾；非数组退回时间序', () => {
    const pinned = { '/a': 1, '/b': 2, '/c': 3 };
    expect(normalizePinOrder(['/a', '/a', 5, '/x'], pinned)).toEqual(['/a', '/c', '/b']);
    expect(normalizePinOrder('bad', pinned)).toEqual(['/c', '/b', '/a']);
    expect(normalizePinOrder(undefined, {})).toEqual([]);
  });

  test('移动：之前 / 末尾 / 错误', () => {
    const order = ['/a', '/b', '/c'];
    expect(movePinOrder(order, '/c', '/a')).toEqual(['/c', '/a', '/b']);
    expect(movePinOrder(order, '/a', null)).toEqual(['/b', '/c', '/a']);
    expect(movePinOrder(order, '/a', '/b')).toEqual(['/a', '/b', '/c']);
    expect(movePinOrder(order, '/x', null)).toBe('not_pinned');
    expect(movePinOrder(order, '/a', '/x')).toBe('before_not_pinned');
    expect(movePinOrder(order, '/a', '/a')).toBe('invalid');
    expect(order).toEqual(['/a', '/b', '/c']);
  });
});

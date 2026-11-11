/**
 * 扩展的特性协商与 files.open 效果：有效集 = 请求声明 ∩ 支持 ∩ 贡献点；路径限长、拒绝 NUL；
 * 请求里的 features 可选（旧 web 不带、旧 agent strip）。
 */
import { describe, expect, test } from 'bun:test';
import { ClientToAgentEventSchema } from '../protocol/events.ts';
import {
  actionAllowedBy,
  effectsAllowedBy,
  EXT_FEATURES,
  EXT_LIMITS,
  ExtLocalEffectSchema,
  ExtRawActionSchema,
  negotiateExtFeatures,
} from './ext.ts';

describe('negotiateExtFeatures', () => {
  test('矩阵：旧 web / 旧 agent / 贡献点', () => {
    // 新 web + 新 agent + 会话面板
    expect(negotiateExtFeatures(['files.open'], EXT_FEATURES, 'sessionPanel')).toEqual(['files.open']);
    // 旧 web：不声明
    expect(negotiateExtFeatures(undefined, EXT_FEATURES, 'sessionPanel')).toEqual([]);
    expect(negotiateExtFeatures([], EXT_FEATURES, 'sessionPanel')).toEqual([]);
    // agent 不支持
    expect(negotiateExtFeatures(['files.open'], [], 'sessionPanel')).toEqual([]);
    // 贡献点不能执行
    for (const point of ['workspacePanel', 'composerAction', 'newSession', 'linkPicker', 'sessionBadge'] as const) {
      expect(negotiateExtFeatures(['files.open'], EXT_FEATURES, point)).toEqual([]);
    }
    // 未知特性忽略、重复去重
    expect(negotiateExtFeatures(['x.y', 'files.open', 'files.open'], EXT_FEATURES, 'sessionPanel')).toEqual(['files.open']);
  });

  test('effectsAllowedBy：只有需要协商的效果受限', () => {
    expect(effectsAllowedBy([{ type: 'prompt.insert' }, { type: 'copy' }], [])).toBe(true);
    expect(effectsAllowedBy([{ type: 'prompt.insert' }, { type: 'files.open' }], [])).toBe(false);
    expect(effectsAllowedBy([{ type: 'files.open' }], ['files.open'])).toBe(true);
  });

  test('actionAllowedBy：invoke.requires 事先声明的特性也要在有效集里', () => {
    expect(actionAllowedBy({ invoke: {} }, [])).toBe(true);
    expect(actionAllowedBy({ invoke: { requires: ['files.open'] } }, [])).toBe(false);
    expect(actionAllowedBy({ invoke: { requires: ['files.open'] } }, ['files.open'])).toBe(true);
    expect(actionAllowedBy({ effects: [{ type: 'files.open' }] }, [])).toBe(false);
    expect(ExtRawActionSchema.safeParse({ id: 'a', label: 'A', invoke: { requires: ['files.open'] } }).success).toBe(true);
  });
});

describe('files.open 效果', () => {
  test('文件 / 目录都可以；dir 可选', () => {
    expect(ExtLocalEffectSchema.safeParse({ type: 'files.open', path: '/w/a.md' }).success).toBe(true);
    expect(ExtLocalEffectSchema.safeParse({ type: 'files.open', path: '/w/t', dir: true }).success).toBe(true);
  });

  test('拒绝空路径、NUL、超长', () => {
    expect(ExtLocalEffectSchema.safeParse({ type: 'files.open', path: '' }).success).toBe(false);
    expect(ExtLocalEffectSchema.safeParse({ type: 'files.open', path: '/w/a\0.md' }).success).toBe(false);
    expect(ExtLocalEffectSchema.safeParse({ type: 'files.open', path: `/${'a'.repeat(EXT_LIMITS.path)}` }).success).toBe(false);
    expect(ExtLocalEffectSchema.safeParse({ type: 'files.open', path: `/${'a'.repeat(EXT_LIMITS.path - 1)}` }).success).toBe(true);
  });
});

describe('请求里的 features', () => {
  const base = { ts: 1, seq: 1, dir: 'c2a', reqId: 'r' } as const;

  test('ext.read / ext.action.prepare 可带可不带', () => {
    const read = { ...base, type: 'ext.read', ext: 'tasks', op: 'view', point: 'sessionPanel', targetSessionId: 's1' };
    expect(ClientToAgentEventSchema.safeParse(read).success).toBe(true);
    const parsed = ClientToAgentEventSchema.safeParse({ ...read, features: ['files.open', 'later.feature'] });
    expect(parsed.success && parsed.data.type === 'ext.read' && parsed.data.features).toEqual(['files.open', 'later.feature']);
    const prepare = { ...base, type: 'ext.action.prepare', invocationId: 'i', token: 't' };
    expect(ClientToAgentEventSchema.safeParse(prepare).success).toBe(true);
    expect(ClientToAgentEventSchema.safeParse({ ...prepare, features: ['files.open'] }).success).toBe(true);
  });

  test('client（页面实例）可选、限长', () => {
    const read = { ...base, type: 'ext.read', ext: 'tasks', op: 'view', point: 'sessionPanel' };
    expect(ClientToAgentEventSchema.safeParse({ ...read, client: 'tab-1' }).success).toBe(true);
    expect(ClientToAgentEventSchema.safeParse({ ...read, client: 'x'.repeat(65) }).success).toBe(false);
  });

  test('声明有上限', () => {
    const read = { ...base, type: 'ext.read', ext: 'tasks', op: 'view', point: 'sessionPanel' };
    expect(ClientToAgentEventSchema.safeParse({ ...read, features: Array.from({ length: 17 }, (_, i) => `f${i}`) }).success).toBe(false);
  });
});

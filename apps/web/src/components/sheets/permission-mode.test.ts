import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  BYPASS_WARNING,
  clickMode,
  initialModeState,
  isPermissionMode,
  OFFLINE_HINT,
  PERMISSION_MODE_OPTIONS,
  pendingWarning,
  WARNING_PREFIX,
} from './permission-mode.ts';

describe('权限模式两击确认', () => {
  test('四档齐全，只有 bypass 需要确认', () => {
    expect(PERMISSION_MODE_OPTIONS.map((o) => o.value)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
    ]);
    const needing = PERMISSION_MODE_OPTIONS.filter((o) => o.confirmWarning !== '');
    expect(needing.map((o) => o.value)).toEqual(['bypassPermissions']);
  });

  test('警告文案陈述等价的 CLI 参数与后果', () => {
    expect(BYPASS_WARNING).toContain('bypassPermissions');
    expect(BYPASS_WARNING).toContain('不再询问');
  });

  test('普通档位一击生效', () => {
    const s = clickMode(initialModeState(), 'plan');
    expect(s).toEqual({ value: 'plan', pending: null });
  });

  test('bypass 首击不生效，只进入待确认', () => {
    const s = clickMode(initialModeState('default'), 'bypassPermissions');
    expect(s.value).toBe('default');
    expect(s.pending).toBe('bypassPermissions');
    // 前缀由 pendingWarning 统一加，两个 sheet 原样渲染（评审 N12）
    expect(pendingWarning(s)).toBe(`${WARNING_PREFIX}${BYPASS_WARNING}`);
  });

  test('bypass 再击才生效', () => {
    let s = initialModeState('default');
    s = clickMode(s, 'bypassPermissions');
    s = clickMode(s, 'bypassPermissions');
    expect(s).toEqual({ value: 'bypassPermissions', pending: null });
    expect(pendingWarning(s)).toBe('');
  });

  test('待确认期间点别的档位：该档位生效且待确认清空', () => {
    let s = clickMode(initialModeState('default'), 'bypassPermissions');
    s = clickMode(s, 'acceptEdits');
    expect(s).toEqual({ value: 'acceptEdits', pending: null });
  });

  test('待确认后改点别处再回来，仍需两击', () => {
    let s = clickMode(initialModeState('default'), 'bypassPermissions');
    s = clickMode(s, 'plan');
    s = clickMode(s, 'bypassPermissions');
    expect(s.value).toBe('plan');
    expect(s.pending).toBe('bypassPermissions');
  });

  test('已经是 bypass 时再点它不要求确认，也不改值', () => {
    const s = clickMode(initialModeState('bypassPermissions'), 'bypassPermissions');
    expect(s).toEqual({ value: 'bypassPermissions', pending: null });
  });

  test('无待确认项时没有警告文案', () => {
    expect(pendingWarning(initialModeState())).toBe('');
  });

  test('isPermissionMode 与档位清单同源', () => {
    for (const o of PERMISSION_MODE_OPTIONS) expect(isPermissionMode(o.value)).toBe(true);
    expect(isPermissionMode('bypass')).toBe(false); // 是 label 不是 value
    expect(isPermissionMode('')).toBe(false);
    expect(isPermissionMode('YOLO')).toBe(false);
  });
});

describe('两个 sheet 的 bypass 交互同源（M8）', () => {
  // 早先 SessionSettingsSheet 自带一份 BYPASS_WARNING（措辞不同）与一个
  // 布尔 pendingBypass 状态机，「已是 bypass 再点」「待确认时点别档」这些
  // 边界全无覆盖——而 `/permission bypassPermissions` 走的正是那个 sheet。
  const settings = readFileSync(new URL('./SessionSettingsSheet.tsx', import.meta.url), 'utf8');
  const newSession = readFileSync(new URL('./NewSessionSheet.tsx', import.meta.url), 'utf8');

  test('两个 sheet 都不再自带档位清单/文案/状态机', () => {
    for (const [name, src] of [['SessionSettingsSheet', settings], ['NewSessionSheet', newSession]] as const) {
      expect(`${name}:${src.includes('const BYPASS_WARNING')}`).toBe(`${name}:false`);
      expect(`${name}:${src.includes('pendingBypass')}`).toBe(`${name}:false`);
      expect(`${name}:${src.includes("'acceptEdits',")}`).toBe(`${name}:false`);
    }
  });

  test('⚠ 前缀只有一处来源：两个 sheet 都不自己拼（评审 N12）', () => {
    // 早先 NewSessionSheet 渲染 `⚠ {warning}`、SessionSettingsSheet 直接
    // `{warning}`，同一句话两副样子。现在前缀并进 pendingWarning 的返回值。
    expect(pendingWarning({ value: 'default', pending: 'bypassPermissions' })).toStartWith(WARNING_PREFIX);
    for (const [name, src] of [['SessionSettingsSheet', settings], ['NewSessionSheet', newSession]] as const) {
      expect(`${name}:${src.includes(WARNING_PREFIX.trim())}`).toBe(`${name}:false`);
    }
  });

  test('两个 sheet 都从 permission-mode.ts 取 clickMode 与选项', () => {
    for (const src of [settings, newSession]) {
      expect(src).toContain("from './permission-mode.ts'");
      expect(src).toContain('clickMode');
      expect(src).toContain('PERMISSION_MODE_OPTIONS');
    }
  });
});

describe('离线机器文案（M3）', () => {
  test('说「无法新建」，不说「排队等上线后创建」', () => {
    expect(OFFLINE_HINT).toContain('无法新建');
    // 口径与 client.request() 一致：离线是立即失败，不是排队创建
    expect(OFFLINE_HINT).not.toContain('上线后才真正创建');
  });

  test('新建 sheet 离线时禁用提交并渲染该文案', () => {
    const src = readFileSync(new URL('./NewSessionSheet.tsx', import.meta.url), 'utf8');
    // 提交按钮的 disabled 条件里含 offline
    expect(src).toMatch(/data-testid="ns-create"[\s\S]{0,160}disabled=\{offline/);
    expect(src).toContain('{OFFLINE_HINT}');
    // create() 自身也挡一道（按钮禁用是 UI，逻辑不能只靠 UI）
    expect(src).toMatch(/if \(!client \|\| offline/);
  });
});

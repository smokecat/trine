import { describe, expect, test } from 'bun:test';
import {
  clampSidebarWidth,
  contentMaxWidth,
  dragSidebar,
  effectiveContentWidth,
  setContentWidthOverride,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './layout-prefs.ts';
import { defaultPrefs, PrefsSchema } from './storage.ts';

describe('content width', () => {
  test('a session follows the global width unless it has its own', () => {
    const overrides = { 'm1/s1': 'full' as const };
    expect(effectiveContentWidth('standard', overrides, 'm1/s1')).toBe('full');
    expect(effectiveContentWidth('wide', overrides, 'm1/s2')).toBe('wide');
  });

  test('following global removes the override instead of storing it', () => {
    const set = setContentWidthOverride({}, 'm1/s1', 'wide');
    expect(set).toEqual({ 'm1/s1': 'wide' });
    expect(setContentWidthOverride(set, 'm1/s1', null)).toEqual({});
  });

  test('maps presets to CSS max widths', () => {
    expect(contentMaxWidth('standard')).toBe('960px');
    expect(contentMaxWidth('wide')).toBe('1200px');
    expect(contentMaxWidth('full')).toBe('100%');
  });
});

describe('sidebar width', () => {
  test('clamps to the allowed range and keeps room for the main area', () => {
    expect(clampSidebarWidth(100, 1600)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(900, 1600)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(450, 900)).toBe(420);
    expect(clampSidebarWidth(450, 600)).toBe(SIDEBAR_MIN_WIDTH);
  });

  test('dragging far past the minimum collapses on release', () => {
    expect(dragSidebar(300, 40, 1600)).toEqual({ width: 340, collapse: false });
    expect(dragSidebar(300, -100, 1600)).toEqual({ width: SIDEBAR_MIN_WIDTH, collapse: false });
    expect(dragSidebar(300, -200, 1600)).toEqual({ width: SIDEBAR_MIN_WIDTH, collapse: true });
  });
});

describe('layout prefs schema', () => {
  test('old prefs without layout fields get the defaults', () => {
    const { sidebarWidth: _w, sidebarCollapsed: _c, contentWidth: _cw, sessionContentWidth: _s, ...old } = defaultPrefs();
    const parsed = PrefsSchema.parse(old);
    expect(parsed.sidebarWidth).toBeNull();
    expect(parsed.sidebarCollapsed).toBe(false);
    expect(parsed.contentWidth).toBe('standard');
    expect(parsed.sessionContentWidth).toEqual({});
  });

  test('bad values fall back instead of resetting all prefs', () => {
    const parsed = PrefsSchema.parse({
      ...defaultPrefs(),
      sidebarWidth: 9999,
      contentWidth: 'huge',
      sessionContentWidth: { 'm1/s1': 'huge' },
      sendKey: 'mod-enter',
    });
    expect(parsed.sidebarWidth).toBeNull();
    expect(parsed.contentWidth).toBe('standard');
    expect(parsed.sessionContentWidth).toEqual({});
    expect(parsed.sendKey).toBe('mod-enter');
  });
});

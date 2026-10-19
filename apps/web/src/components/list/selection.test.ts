import { describe, expect, test } from 'bun:test';
import { applyClick, EMPTY_SELECTION, isSelectionClick, selectionKey, toggleKey } from './selection.ts';

const order = ['a', 'b', 'c', 'd', 'e'];
const none = { toggle: false, range: false };
const ctrl = { toggle: true, range: false };
const shift = { toggle: false, range: true };

describe('多选', () => {
  test('selectionKey：机器 + 会话，不同机器同 id 不撞', () => {
    expect(selectionKey('m1', 's')).not.toBe(selectionKey('m2', 's'));
  });

  test('isSelectionClick：无选择时普通点击照常导航；有选择或带修饰键归多选', () => {
    expect(isSelectionClick(none, 0)).toBe(false);
    expect(isSelectionClick(none, 1)).toBe(true);
    expect(isSelectionClick(ctrl, 0)).toBe(true);
    expect(isSelectionClick(shift, 0)).toBe(true);
  });

  test('切换并记锚点', () => {
    const s1 = applyClick(EMPTY_SELECTION, 'b', ctrl, order);
    expect([...s1.keys]).toEqual(['b']);
    expect(s1.anchor).toBe('b');
    const s2 = toggleKey(s1, 'b');
    expect(s2.keys.size).toBe(0);
  });

  test('Shift：从锚点到目标整段加入（两个方向），锚点不动', () => {
    const s1 = applyClick(EMPTY_SELECTION, 'b', ctrl, order);
    const s2 = applyClick(s1, 'd', shift, order);
    expect([...s2.keys].sort()).toEqual(['b', 'c', 'd']);
    expect(s2.anchor).toBe('b');
    const s3 = applyClick(applyClick(EMPTY_SELECTION, 'd', ctrl, order), 'a', shift, order);
    expect([...s3.keys].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  test('Shift 没有锚点 / 锚点已不可见 → 等同切换', () => {
    expect([...applyClick(EMPTY_SELECTION, 'c', shift, order).keys]).toEqual(['c']);
    const stale = { keys: new Set(['z']), anchor: 'z' };
    expect([...applyClick(stale, 'c', shift, order).keys].sort()).toEqual(['c', 'z']);
  });
});

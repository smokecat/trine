/**
 * Enter 换行 / 发送判定的单测。
 */
import { describe, expect, test } from 'bun:test';
import { isSendKey, sendKeyLabel, type EnterKeyEvent } from './composer-keys.ts';

function key(over: Partial<EnterKeyEvent> = {}): EnterKeyEvent {
  return {
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 13,
    ...over,
  };
}

describe('isSendKey', () => {
  test('PC 默认：Enter 发送，Shift+Enter 换行', () => {
    expect(isSendKey(key(), 'enter', false)).toBe(true);
    expect(isSendKey(key({ shiftKey: true }), 'enter', false)).toBe(false);
  });

  test('PC mod-enter：Enter 换行，Cmd/Ctrl+Enter 发送', () => {
    expect(isSendKey(key(), 'mod-enter', false)).toBe(false);
    expect(isSendKey(key({ metaKey: true }), 'mod-enter', false)).toBe(true);
    expect(isSendKey(key({ ctrlKey: true }), 'mod-enter', false)).toBe(true);
  });

  test('两种模式下 Cmd/Ctrl+Enter 都发送', () => {
    expect(isSendKey(key({ metaKey: true }), 'enter', false)).toBe(true);
    expect(isSendKey(key({ ctrlKey: true }), 'enter', false)).toBe(true);
  });

  test('触屏：回车永远换行，与设置无关；外接键盘 Cmd+Enter 仍发送', () => {
    expect(isSendKey(key(), 'enter', true)).toBe(false);
    expect(isSendKey(key(), 'mod-enter', true)).toBe(false);
    expect(isSendKey(key({ metaKey: true }), 'enter', true)).toBe(true);
  });

  test('输入法组合中的 Enter 不发送（含 Safari 的 keyCode 229）', () => {
    expect(isSendKey(key({ isComposing: true }), 'enter', false)).toBe(false);
    expect(isSendKey(key({ keyCode: 229 }), 'enter', false)).toBe(false);
    expect(isSendKey(key({ isComposing: true, metaKey: true }), 'mod-enter', false)).toBe(false);
  });

  test('Shift / Alt 修饰时不发送，其他键不发送', () => {
    expect(isSendKey(key({ shiftKey: true, metaKey: true }), 'enter', false)).toBe(false);
    expect(isSendKey(key({ altKey: true }), 'enter', false)).toBe(false);
    expect(isSendKey(key({ key: 'a' }), 'enter', false)).toBe(false);
  });
});

describe('sendKeyLabel', () => {
  test('触屏不给提示，PC 按平台写修饰键', () => {
    expect(sendKeyLabel('enter', true, true)).toBeNull();
    expect(sendKeyLabel('enter', false, true)).toBe('Enter 发送，Shift+Enter 换行');
    expect(sendKeyLabel('mod-enter', false, true)).toBe('⌘+Enter 发送，Enter 换行');
    expect(sendKeyLabel('mod-enter', false, false)).toBe('Ctrl+Enter 发送，Enter 换行');
  });
});

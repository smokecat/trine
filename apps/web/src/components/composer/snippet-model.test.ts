import { describe, expect, test } from 'bun:test';
import { insertSnippet } from './snippet-model.ts';

describe('insertSnippet', () => {
  test('空输入框直接填入', () => {
    expect(insertSnippet('', null, '跑测试')).toEqual({ text: '跑测试', caret: 3 });
  });

  test('没记到光标按末尾处理；句尾非空白先换行', () => {
    expect(insertSnippet('先看看', null, '跑测试')).toEqual({ text: '先看看\n跑测试', caret: 7 });
  });

  test('末尾已是空白不再加换行', () => {
    expect(insertSnippet('先看看\n', { start: 4, end: 4 }, '跑测试')).toEqual({ text: '先看看\n跑测试', caret: 7 });
  });

  test('光标在中间原样插入', () => {
    expect(insertSnippet('ab', { start: 1, end: 1 }, 'X')).toEqual({ text: 'aXb', caret: 2 });
  });

  test('有选区替换选区', () => {
    expect(insertSnippet('a123b', { start: 1, end: 4 }, 'X')).toEqual({ text: 'aXb', caret: 2 });
  });

  test('越界的光标收回到文本范围内', () => {
    expect(insertSnippet('ab', { start: 9, end: 12 }, 'X')).toEqual({ text: 'ab\nX', caret: 4 });
  });
});

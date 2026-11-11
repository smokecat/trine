/**
 * 源码标题行识别（渲染 ↔ 源码按标题序号对应）。
 */
import { describe, expect, test } from 'bun:test';
import { headingOrdinalAtLine, lastAtOrAbove, markdownHeadingLines } from './reading-position.ts';

describe('markdownHeadingLines', () => {
  test('ATX、Setext、单行 raw HTML；代码围栏里的不算；分隔线不算', () => {
    const md = ['# 一', '正文', '', '二', '===', '', '```md', '# 围栏里', '```', '<h3 id="x">三</h3>', '', '---', '', '#不是标题', '## 四'].join('\n');
    expect(markdownHeadingLines(md)).toEqual([0, 3, 9, 14]);
  });

  test('~~~ 围栏与更长的关闭标记', () => {
    expect(markdownHeadingLines(['~~~~', '# x', '~~~', '# y', '~~~~', '# z'].join('\n'))).toEqual([5]);
  });
});

describe('headingOrdinalAtLine / lastAtOrAbove', () => {
  test('某行之前最后一个标题；第一个之前是 -1', () => {
    expect(headingOrdinalAtLine([2, 10, 20], 1)).toBe(-1);
    expect(headingOrdinalAtLine([2, 10, 20], 10)).toBe(1);
    expect(headingOrdinalAtLine([2, 10, 20], 99)).toBe(2);
  });

  test('二分找 top(i) <= y 的最大 i', () => {
    const top = (i: number): number => i * 10;
    expect(lastAtOrAbove(100, top, 255)).toBe(25);
    expect(lastAtOrAbove(100, top, -5)).toBe(0);
    expect(lastAtOrAbove(100, top, 99999)).toBe(99);
  });
});

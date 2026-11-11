import { describe, expect, test } from 'bun:test';
import { splitFrontMatter } from './front-matter.ts';

describe('splitFrontMatter', () => {
  test('简单 key: value；正文开头换成等量空行（行号不变）', () => {
    const text = '---\nstatus: active\nupdated: 2026-11-01\nresult:\n---\n# 标题\n正文';
    const fm = splitFrontMatter(text)!;
    expect(fm.entries).toEqual([
      { key: 'status', value: 'active' },
      { key: 'updated', value: '2026-11-01' },
      { key: 'result', value: '' },
    ]);
    expect(fm.body.split('\n').length).toBe(text.split('\n').length);
    expect(fm.body.split('\n')[5]).toBe('# 标题');
  });

  test('`...` 结束；CRLF；外层引号去掉', () => {
    const fm = splitFrontMatter("---\r\ntitle: 'A: b'\r\n...\r\n正文")!;
    expect(fm.entries).toEqual([{ key: 'title', value: 'A: b' }]);
  });

  test('多行值 / 列表 / 缩进：认不出来，entries 为 null，原文保留', () => {
    const fm = splitFrontMatter('---\ntags:\n  - a\n---\nx')!;
    expect(fm.entries).toBeNull();
    expect(fm.raw).toBe('tags:\n  - a');
  });

  test('不是 front matter：首行不是 ---、没有结束行、开头空行', () => {
    expect(splitFrontMatter('# 标题\n---\n')).toBeUndefined();
    expect(splitFrontMatter('---\nstatus: active\n正文没有结束')).toBeUndefined();
    expect(splitFrontMatter('\n---\na: b\n---\n')).toBeUndefined();
  });

  test('空的 front matter', () => {
    expect(splitFrontMatter('---\n---\n# x')!.entries).toEqual([]);
  });
});

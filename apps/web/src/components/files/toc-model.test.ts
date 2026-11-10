/**
 * 标题 slug、锚点匹配、目录筛选、当前节的纯逻辑。
 */
import { describe, expect, test } from 'bun:test';
import { activeIndex, createSlugger, matchFragment, slugify, splitHref, tocItems } from './toc-model.ts';

describe('slugify / createSlugger', () => {
  test('GitHub 风格：小写、去标点、空格变 -，中文保留', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('安装步骤')).toBe('安装步骤');
    expect(slugify('第 2 节：配置（可选）')).toBe('第-2-节配置可选');
    expect(slugify('API_v2 -- notes')).toBe('api_v2----notes');
  });

  test('重复标题依次加后缀，不与已有的 x-1 相撞；空标题叫 section', () => {
    const s = createSlugger();
    expect(['用法', '用法', 'a', 'a-1', 'a', '!!!'].map(s)).toEqual(['用法', '用法-1', 'a', 'a-1', 'a-2', 'section']);
  });

  test('每个 slugger 独立计数', () => {
    expect(createSlugger()('x')).toBe('x');
    expect(createSlugger()('x')).toBe('x');
  });
});

describe('matchFragment', () => {
  const slugs = ['安装步骤', 'hello-world', '用法-1', 'faq'];
  test('原文、百分号编码、大小写与空格、user-content 前缀都能对上', () => {
    expect(matchFragment('安装步骤', slugs)).toBe('安装步骤');
    expect(matchFragment('%E5%AE%89%E8%A3%85%E6%AD%A5%E9%AA%A4', slugs)).toBe('安装步骤');
    expect(matchFragment('#Hello World', slugs)).toBe('hello-world');
    expect(matchFragment('Hello, World!', slugs)).toBe('hello-world');
    expect(matchFragment('user-content-faq', slugs)).toBe('faq');
    expect(matchFragment('用法-1', slugs)).toBe('用法-1');
  });

  test('对不上、空锚点、坏编码：undefined', () => {
    expect(matchFragment('不存在', slugs)).toBeUndefined();
    expect(matchFragment('', slugs)).toBeUndefined();
    expect(matchFragment('#', slugs)).toBeUndefined();
    expect(matchFragment('%E5%AE', slugs)).toBeUndefined();
  });
});

describe('splitHref', () => {
  test('路径解码、锚点单独取出并解码；%23 是文件名的一部分', () => {
    expect(splitHref('../b.md#%E9%83%A8%E7%BD%B2')).toEqual({ path: '../b.md', fragment: '部署' });
    expect(splitHref('a%23b.md')).toEqual({ path: 'a#b.md', fragment: undefined });
    expect(splitHref('a.md?x=1#top')).toEqual({ path: 'a.md', fragment: 'top' });
    expect(splitHref('a.md#')).toEqual({ path: 'a.md', fragment: undefined });
  });
});

describe('tocItems / activeIndex', () => {
  test('只要 h1–h4，少于 3 个不显示', () => {
    const h = (level: number, slug: string) => ({ level, slug, text: slug });
    expect(tocItems([h(1, 'a'), h(5, 'b'), h(2, 'c')])).toEqual([]);
    expect(tocItems([h(1, 'a'), h(5, 'b'), h(2, 'c'), h(4, 'd')]).map((i) => i.slug)).toEqual(['a', 'c', 'd']);
  });

  test('越过阅读线的最后一个；都没越过取第一个', () => {
    expect(activeIndex([10, 200, 400], 96)).toBe(0);
    expect(activeIndex([-300, -20, 90, 400], 96)).toBe(2);
    expect(activeIndex([150, 300], 96)).toBe(0);
  });
});

/**
 * 主题标题清洗：模型输出常带引号/句号/换行，必须清成一行短标题。
 * 网络路径不测（要真端点）；生成失败的行为由调用方兜底。
 */
import { describe, expect, test } from 'bun:test';
import { cleanTitle } from './auto-title.ts';

describe('cleanTitle', () => {
  test('去引号、去尾句号、压空白', () => {
    expect(cleanTitle('“Trine 会话标题修正”。')).toBe('Trine 会话标题修正');
    expect(cleanTitle('  「DeepSeek  用量看板」  ')).toBe('DeepSeek 用量看板');
  });

  test('空输出 / 只有标点 → undefined', () => {
    expect(cleanTitle('')).toBeUndefined();
    expect(cleanTitle('  。  ')).toBeUndefined();
  });

  test('过长标题按字符截断（中文按字算）', () => {
    const long = '一'.repeat(40);
    expect([...(cleanTitle(long) ?? '')].length).toBe(24);
  });

  test('保留标题内部标点', () => {
    expect(cleanTitle('QQ 缓存目录：在哪')).toBe('QQ 缓存目录：在哪');
  });
});

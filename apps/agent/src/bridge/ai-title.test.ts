/**
 * CC 自动标题（ai-title 记录）的解析与标题优先级。
 * 纯函数覆盖：截断行、多条取最后一条、空标题忽略、编码规则。
 */
import { describe, expect, test } from 'bun:test';
import { encodeProjectDir, lastAiTitle } from './ai-title.ts';
import { titleFromInfo } from './manager.ts';

const line = (title: string): string => JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: 's' });

describe('lastAiTitle', () => {
  test('取最后一条 ai-title', () => {
    const text = [line('第一次标题'), '{"type":"user"}', line('后来的标题')].join('\n');
    expect(lastAiTitle(text)).toBe('后来的标题');
  });

  test('没有记录 / 空标题 → undefined', () => {
    expect(lastAiTitle('{"type":"user"}\n')).toBeUndefined();
    expect(lastAiTitle(line('   '))).toBeUndefined();
  });

  test('文件尾被截断的坏行跳过，不影响前面的记录', () => {
    const text = `${line('完整标题')}\n{"type":"ai-title","aiTi`;
    expect(lastAiTitle(text)).toBe('完整标题');
  });
});

describe('encodeProjectDir', () => {
  test('与 ~/.claude/projects 的目录名一致', () => {
    expect(encodeProjectDir('E:\\agent-cluster\\carl')).toBe('E--agent-cluster-carl');
    expect(encodeProjectDir('/home/carl/proj')).toBe('-home-carl-proj');
  });
});

describe('titleFromInfo 优先级', () => {
  const base = { sessionId: 's', summary: '最后一条用户消息', firstPrompt: '首条输入', lastModified: 1 } as never;

  test('用户改名最优先', () => {
    expect(titleFromInfo({ ...(base as object), customTitle: '我的名字', summary: 'x' } as never, 'AI 标题')).toBe('我的名字');
  });

  test('CC 自动标题排在 summary（最后一条用户消息）之前', () => {
    expect(titleFromInfo(base, 'AI 标题')).toBe('AI 标题');
  });

  test('首条是斜杠命令时不拿它当标题', () => {
    const info = { sessionId: 's', summary: '明天就摊牌去', firstPrompt: '/bujia', lastModified: 1 } as never;
    expect(titleFromInfo(info)).toBe('明天就摊牌去');
  });

  test('没有 aiTitle 时回退首条输入，而不是 summary（最后一条用户消息）', () => {
    expect(titleFromInfo(base)).toBe('首条输入');
    expect(titleFromInfo({ sessionId: 's', summary: '最后一条', firstPrompt: '', lastModified: 1 } as never)).toBe(
      '最后一条',
    );
  });
});

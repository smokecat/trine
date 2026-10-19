import { describe, expect, test } from 'bun:test';
import type { RewindPreviewResult, RewindResult } from '@/lib/client.ts';
import { defaultRewindMode, filesSummary, rewindChoices, rewindDoneMessage, rewindTouchesFiles } from './rewind-model.ts';

const base = { type: 'session.rewind.preview.response', ts: 1, seq: 1, dir: 'a2c', sessionId: 's1', reqId: 'r', ok: true } as const;
const preview = (over: Partial<RewindPreviewResult>): RewindPreviewResult => ({ ...base, ...over }) as RewindPreviewResult;

describe('rewind-model', () => {
  test('两部分都可用：三个选项全可选，默认「代码和对话」', () => {
    const choices = rewindChoices(
      preview({ conversation: { available: true }, files: { available: true, filesChanged: ['a'], insertions: 1, deletions: 0 } }),
    );
    expect(choices.map((c) => [c.mode, c.available])).toEqual([
      ['both', true],
      ['conversation', true],
      ['code', true],
    ]);
    expect(defaultRewindMode(choices)).toBe('both');
  });

  test('第一条消息：对话不可回退 → both / conversation 不可选并带原因，默认只还原代码', () => {
    const choices = rewindChoices(
      preview({ conversation: { available: false, reason: '第一条' }, files: { available: true, filesChanged: [], insertions: 0, deletions: 0 } }),
    );
    expect(choices.find((c) => c.mode === 'both')).toMatchObject({ available: false, reason: '第一条' });
    expect(choices.find((c) => c.mode === 'conversation')).toMatchObject({ available: false, reason: '第一条' });
    expect(defaultRewindMode(choices)).toBe('code');
  });

  test('没有快照：只能回退对话；都不行时没有默认', () => {
    const noFiles = rewindChoices(preview({ conversation: { available: true }, files: { available: false, reason: '没有快照' } }));
    expect(noFiles.find((c) => c.mode === 'both')).toMatchObject({ available: false, reason: '没有快照' });
    expect(defaultRewindMode(noFiles)).toBe('conversation');
    const none = rewindChoices(preview({}));
    expect(defaultRewindMode(none)).toBeUndefined();
  });

  test('文案：文件概述、成功提示、警示色判据', () => {
    expect(filesSummary({ available: true, filesChanged: ['a', 'b'], insertions: 3, deletions: 1 })).toBe('将还原 2 个文件（+3 −1）');
    expect(filesSummary({ available: true, filesChanged: [] })).toBe('这条消息之后没有记录到文件改动');
    expect(filesSummary({ available: false })).toBeUndefined();

    const result = { files: { filesChanged: ['a'], insertions: 0, deletions: 1, skippedLinks: 1 } } as RewindResult;
    expect(rewindDoneMessage(result, 'both', true)).toBe('已还原 1 个文件；1 个文件因符号链接等原因未还原；对话已回退，原消息已填回输入框');
    expect(rewindDoneMessage({} as RewindResult, 'conversation', false)).toBe('对话已回退');
    expect(rewindDoneMessage({} as RewindResult, 'code', false)).toBe('没有需要还原的文件');
    expect(rewindTouchesFiles('conversation')).toBe(false);
    expect(rewindTouchesFiles('both')).toBe(true);
  });
});

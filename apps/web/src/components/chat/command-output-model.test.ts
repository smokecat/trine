import { describe, expect, test } from 'bun:test';
import { parseUsageReport, usageWindowLabel } from './command-output-model.ts';

/** 合成的 /usage 输出（形状照 Claude Code 2.1.304，数据是假的） */
const USAGE = `You are currently using your subscription to power your Claude Code usage

Current session: 69% used · resets Oct 20, 2:39pm (Asia/Singapore)
Current week (all models): 16% used · resets Oct 26, 3:59am (Asia/Singapore)
Current week (Opus): 0% used · resets Oct 26, 4am (Asia/Singapore)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine.

Last 24h · 120 requests · 3 sessions
  80% of your usage was at >150k context
  Top skills: /demo-skill 4%

Last 7d · 900 requests · 20 sessions
  50% of your usage came from subagent-heavy sessions`;

describe('parseUsageReport', () => {
  test('说明、用量窗口、分组', () => {
    const report = parseUsageReport(USAGE);
    expect(report?.intro).toEqual(['You are currently using your subscription to power your Claude Code usage']);
    expect(report?.windows).toEqual([
      { label: '5 小时窗口', percent: 69, resets: 'Oct 20, 2:39pm', resetsFull: 'Oct 20, 2:39pm (Asia/Singapore)' },
      { label: '本周 · 全部模型', percent: 16, resets: 'Oct 26, 3:59am', resetsFull: 'Oct 26, 3:59am (Asia/Singapore)' },
      { label: '本周 · Opus', percent: 0, resets: 'Oct 26, 4am', resetsFull: 'Oct 26, 4am (Asia/Singapore)' },
    ]);
    expect(report?.sections).toEqual([
      { title: "What's contributing to your limits usage?", notes: ['Approximate, based on local sessions on this machine.'], items: [] },
      {
        title: 'Last 24h · 120 requests · 3 sessions',
        notes: [],
        items: ['80% of your usage was at >150k context', 'Top skills: /demo-skill 4%'],
      },
      { title: 'Last 7d · 900 requests · 20 sessions', notes: [], items: ['50% of your usage came from subagent-heavy sessions'] },
    ]);
  });

  test('没有重置时间的窗口、没有说明行也能认', () => {
    expect(parseUsageReport('Current session: 12.5% used')).toEqual({
      intro: [],
      windows: [{ label: '5 小时窗口', percent: 12.5 }],
      sections: [],
    });
  });

  test('认不出任何用量窗口返回 null（API key 账号 / 形状变了）', () => {
    expect(parseUsageReport('Total cost: $0.12\nTotal duration: 3m')).toBeNull();
    expect(parseUsageReport('')).toBeNull();
  });

  test('窗口名本地化，不认识的原样', () => {
    expect(usageWindowLabel('Current week')).toBe('本周');
    expect(usageWindowLabel('Extra usage')).toBe('Extra usage');
  });
});

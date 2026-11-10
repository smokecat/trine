import { describe, expect, test } from 'bun:test';
import type { BgTask } from '@trine/core';
import type { ToolEntry } from './reducer.ts';
import {
  bgTasksByToolUseId,
  claudeSubagentView,
  codexSubagentLine,
  subagentArgSummary,
  subagentStateLabel,
  subagentTicking,
  subagentTitle,
  SUBAGENT_STATE_LABEL,
} from './subagent-view.ts';

const agent = (over: Partial<ToolEntry> = {}): ToolEntry => ({ kind: 'tool', id: 'P', toolName: 'Agent', argSummary: 'probe', seq: 1, ts: 1, ...over });
const task = (over: Partial<BgTask> = {}): BgTask => ({
  taskId: 'task-1',
  kind: 'agent',
  description: 'probe',
  status: 'running',
  startedAt: 1_000,
  toolUseId: 'P',
  ...over,
});
const launched = { status: 'ok' as const, resultSummary: '✓ 后台子 agent 已启动' };

describe('claudeSubagentView', () => {
  test('前台：跟随工具状态；启动中背景未知', () => {
    expect(claudeSubagentView(agent(), undefined, false)).toEqual({ background: undefined, state: 'running' });
    expect(claudeSubagentView(agent({ status: 'ok', resultSummary: '✓ 3 次' }), undefined, false)).toEqual({ background: false, state: 'completed' });
    expect(claudeSubagentView(agent({ status: 'error' }), undefined, false)?.state).toBe('failed');
    expect(claudeSubagentView({ ...agent(), toolName: 'Bash' }, undefined, false)).toBeUndefined();
  });

  test('后台运行中：从快照派生，带计时起点与进度；快照陈旧时状态未知', () => {
    const entry = agent({ ...launched, subagent: { background: true } });
    expect(claudeSubagentView(entry, task({ lastToolName: 'Read', toolUses: 2 }), false)).toEqual({
      background: true,
      state: 'running',
      startedAt: 1_000,
      progress: '最近 Read · 共 2 次工具调用',
    });
    expect(claudeSubagentView(entry, task(), true)?.state).toBe('unknown');
  });

  test('前台转后台：没有 subagent 字段，但快照里有它 → 后台', () => {
    expect(claudeSubagentView(agent({ status: 'ok', resultSummary: 'moved' }), task(), false)).toMatchObject({ background: true, state: 'running' });
  });

  test('最终状态：agent 的收尾优先于快照；快照结束了也认；都没有 → 状态未知', () => {
    const done = agent({ status: 'ok', resultSummary: '✓ 3 次工具调用', subagent: { background: true, state: 'completed' } });
    expect(claudeSubagentView(done, task(), false)?.state).toBe('completed');
    expect(claudeSubagentView(agent({ ...launched, subagent: { background: true } }), task({ status: 'stopped' }), false)?.state).toBe('stopped');
    expect(claudeSubagentView(agent({ ...launched, subagent: { background: true } }), undefined, false)?.state).toBe('unknown');
    // 历史回填的 unknown 不压过实时快照的 running（会话还在跑）
    expect(claudeSubagentView(agent({ ...launched, subagent: { background: true, state: 'unknown' } }), task(), false)?.state).toBe('running');
  });

  test('旧 agent 的条目（无 subagent 字段）：按文案认出后台；已收尾的按工具状态', () => {
    expect(claudeSubagentView(agent(launched), undefined, false)).toEqual({ background: true, state: 'unknown' });
    expect(claudeSubagentView(agent({ argSummary: '后台 · probe', status: 'ok', resultSummary: '✓ 2 次工具调用' }), undefined, false)).toEqual({
      background: true,
      state: 'completed',
    });
    expect(claudeSubagentView(agent({ argSummary: '后台 · probe', status: 'warn', resultSummary: '⏹ 子 agent 已停止' }), undefined, false)?.state).toBe('stopped');
  });
});

describe('标题 / 摘要 / 计时', () => {
  test('标题：工具名 · 类型 · 前台/后台；后台前缀不重复', () => {
    const entry = agent({ argSummary: '后台 · probe', ...launched, subagent: { agentType: 'Explore', background: true } });
    const view = claudeSubagentView(entry, undefined, false);
    expect(subagentTitle(entry, view)).toBe('Agent · Explore · 后台');
    expect(subagentArgSummary(entry, view)).toBe('probe');
    const fg = agent({ status: 'ok', subagent: { agentType: 'Plan' } });
    expect(subagentTitle(fg, claudeSubagentView(fg, undefined, false))).toBe('Agent · Plan · 前台');
    expect(subagentTitle(agent(), claudeSubagentView(agent(), undefined, false))).toBe('Agent');
  });

  test('subagentTicking：前台在跑、后台运行中才走秒', () => {
    const bg = agent({ ...launched, subagent: { background: true } });
    expect(subagentTicking(claudeSubagentView(bg, task(), false), bg)).toBe(true);
    expect(subagentTicking(claudeSubagentView(bg, task(), true), bg)).toBe(false);
    expect(subagentTicking(claudeSubagentView(agent(), undefined, false), agent())).toBe(true);
    expect(subagentTicking(undefined, agent())).toBe(false);
  });

  test('bgTasksByToolUseId 只收子 agent 类任务', () => {
    const map = bgTasksByToolUseId([task(), task({ taskId: 'b', kind: 'bash', toolUseId: 'B' }), task({ taskId: 'n', toolUseId: undefined })]);
    expect([...map.keys()]).toEqual(['P']);
    expect(bgTasksByToolUseId(undefined).size).toBe(0);
  });
});

describe('Codex 子 agent 行', () => {
  test('昵称（角色）· 中文状态 · 模型；缺昵称用角色，再缺用短 id', () => {
    const sub = (subagent: ToolEntry['subagent']): ToolEntry => ({ ...agent(), toolName: 'SubAgent', subagent });
    expect(codexSubagentLine(sub({ nickname: 'Meitner', agentType: 'worker', state: 'running', model: 'm-1' }))).toBe('子 agent：Meitner（worker） · 运行中 · m-1');
    expect(codexSubagentLine(sub({ agentId: '01a1c716-197d-77f0-a152-e00184b612ce', state: 'not_found' }))).toBe('子 agent：84b612ce · 找不到');
    expect(codexSubagentLine(sub({ agentType: 'explorer' }))).toBe('子 agent：explorer');
    expect(codexSubagentLine(sub(undefined))).toBeNull();
    expect(codexSubagentLine(agent({ subagent: { state: 'running' } }))).toBeNull();
  });

  test('全部状态都有中文；未知值原样', () => {
    for (const label of Object.values(SUBAGENT_STATE_LABEL)) expect(label).toMatch(/[一-龥]/);
    expect(subagentStateLabel('pending')).toBe('等待启动');
    expect(subagentStateLabel('brandNew')).toBe('brandNew');
  });
});

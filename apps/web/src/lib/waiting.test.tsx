/**
 * 等待态文案：toolName / waitingFor → 文案的唯一出口，以及它在心跳 footer、
 * 状态 pill 上的落点。
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatePill } from '@/components/shell/StatusDot.tsx';
import { heartbeatView } from '@/components/chat/heartbeat-model.ts';
import { waitingForOfTool, waitingLabel } from './waiting.ts';

describe('waitingLabel / waitingForOfTool', () => {
  test('三类文案；缺省（旧 agent 不带 waitingFor）按普通权限', () => {
    expect(waitingLabel('permission')).toBe('等待批准');
    expect(waitingLabel('question')).toBe('等待回答');
    expect(waitingLabel('plan')).toBe('等待批准计划');
    expect(waitingLabel(undefined)).toBe('等待批准');
  });

  test('toolName → 类型：AskUserQuestion / ExitPlanMode / 其余 / 无条目', () => {
    expect(waitingForOfTool('AskUserQuestion')).toBe('question');
    expect(waitingForOfTool('ExitPlanMode')).toBe('plan');
    expect(waitingForOfTool('Bash')).toBe('permission');
    expect(waitingForOfTool(undefined)).toBe('permission');
  });
});

describe('落点', () => {
  const snapshot = { at: 0, runElapsedMs: 0, silentMs: 0, phase: 'wait' as const };

  test('heartbeatView 带出等待文案', () => {
    expect(heartbeatView(snapshot, 0, 0, 0).waitingLabel).toBe('等待批准');
    expect(heartbeatView(snapshot, 0, 0, 0, 'question').waitingLabel).toBe('等待回答');
    expect(heartbeatView(snapshot, 0, 0, 0, 'plan').waitingLabel).toBe('等待批准计划');
  });

  test('StatePill：等待态按 waitingFor 分文案，其余状态不受影响', () => {
    expect(renderToStaticMarkup(<StatePill state="waiting_permission" />)).toContain('等待批准');
    expect(renderToStaticMarkup(<StatePill state="waiting_permission" waitingFor="question" />)).toContain('等待回答');
    expect(renderToStaticMarkup(<StatePill state="waiting_permission" waitingFor="plan" />)).toContain('等待批准计划');
    expect(renderToStaticMarkup(<StatePill state="running" waitingFor="plan" />)).toContain('运行中');
  });
});

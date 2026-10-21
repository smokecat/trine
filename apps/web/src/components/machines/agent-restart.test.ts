/** 「重启 agent」纯逻辑：能力探测、版本状态、进度文案、应答结论 */
import { describe, expect, test } from 'bun:test';
import type { AgentRestartResult } from '@/lib/client.ts';
import {
  describePending,
  describeRevision,
  summarizeAgentRestart,
  summarizeAgentRestartError,
  supportsAgentRestart,
} from './agent-restart.ts';

function res(over: Partial<AgentRestartResult>): AgentRestartResult {
  return { type: 'machine.agent.restart.response', ts: 1, seq: 1, dir: 'a2c', reqId: 'q', ok: true, ...over };
}

describe('agent-restart', () => {
  test('按 machine.info.restart 有无探测', () => {
    expect(supportsAgentRestart(undefined)).toBe(false);
    expect(supportsAgentRestart({})).toBe(false);
    expect(supportsAgentRestart({ restart: { available: false } })).toBe(true);
  });

  test('版本：工作区领先时提示重启后生效', () => {
    expect(describeRevision({ available: true })).toBeNull();
    expect(describeRevision({ available: true, revision: 'abc1234', workspaceRevision: 'abc1234' })).toEqual({
      text: '运行中 abc1234',
      outdated: false,
    });
    expect(describeRevision({ available: true, revision: 'abc1234', workspaceRevision: 'def5678' })).toEqual({
      text: '运行中 abc1234，工作区已是 def5678：重启后生效',
      outdated: true,
    });
  });

  test('进度文案', () => {
    expect(describePending(undefined)).toBeNull();
    expect(describePending({ phase: 'checking', requestedAt: 1, busySessions: 0 })).toContain('预检');
    expect(describePending({ phase: 'draining', requestedAt: 1, busySessions: 0 })).toContain('马上重启');
    const deadline = new Date(2026, 9, 21, 14, 5).getTime();
    expect(describePending({ phase: 'draining', requestedAt: 1, busySessions: 2, deadline })).toBe(
      '已排期：等待 2 个会话空闲后重启，14:05 前仍未空闲则取消',
    );
  });

  test('应答结论', () => {
    expect(summarizeAgentRestart(res({ phase: 'draining', toVersion: '0.19.0' }))).toEqual({
      tone: 'success',
      title: '预检通过（新版本 0.19.0），会话空闲后重启',
      output: '',
    });
    expect(summarizeAgentRestart(res({ phase: 'restarting' })).title).toBe('预检通过，agent 正在重启');
    expect(summarizeAgentRestart(res({ phase: 'cancelled' })).tone).toBe('info');
    expect(
      summarizeAgentRestart(
        res({ ok: false, error: { code: 'check_failed', message: 'bun install 失败', output: 'lockfile' } }),
      ),
    ).toEqual({ tone: 'error', title: '预检未通过，没有重启：bun install 失败', output: 'lockfile' });
    expect(summarizeAgentRestart(res({ ok: false, error: { code: 'unavailable', message: '没有 supervisor' } })).title).toBe(
      '没有重启：没有 supervisor',
    );
    expect(summarizeAgentRestartError(new Error('离线')).title).toBe('重启失败：离线');
  });
});

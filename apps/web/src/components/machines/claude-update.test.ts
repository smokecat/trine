import { describe, expect, test } from 'bun:test';
import type { ClaudeUpdateResult } from '@/lib/client.ts';
import {
  RUNNING_SESSIONS_NOTE,
  shortClaudeVersion,
  summarizeClaudeUpdate,
  summarizeClaudeUpdateError,
  supportsClaudeUpdate,
} from './claude-update.ts';

function res(over: Partial<ClaudeUpdateResult> = {}): ClaudeUpdateResult {
  return {
    type: 'machine.claude.update.response',
    ts: 1,
    seq: 1,
    dir: 'a2c',
    reqId: 'q',
    ok: true,
    fromVersion: '2.1.251 (Claude Code)',
    toVersion: '2.1.282 (Claude Code)',
    output: 'Successfully updated',
    ...over,
  };
}

describe('supportsClaudeUpdate', () => {
  test('agent >= 0.4.0 才支持；没有 info / 版本解析不了一律不支持', () => {
    expect(supportsClaudeUpdate({ agentVersion: '0.4.0' })).toBe(true);
    expect(supportsClaudeUpdate({ agentVersion: '0.10.1' })).toBe(true);
    expect(supportsClaudeUpdate({ agentVersion: '0.3.9' })).toBe(false);
    expect(supportsClaudeUpdate({ agentVersion: '0.4.0-rc.1' })).toBe(false);
    expect(supportsClaudeUpdate({ agentVersion: 'dev' })).toBe(false);
    expect(supportsClaudeUpdate(null)).toBe(false);
    expect(supportsClaudeUpdate(undefined)).toBe(false);
  });
});

describe('summarizeClaudeUpdate', () => {
  test('版本变了：旧 → 新，并说明运行中的会话仍是旧版', () => {
    expect(summarizeClaudeUpdate(res())).toEqual({
      tone: 'success',
      title: 'Claude 已更新：2.1.251 → 2.1.282',
      detail: RUNNING_SESSIONS_NOTE,
      output: 'Successfully updated',
      outputTruncated: false,
    });
  });

  test('版本不变：已是最新', () => {
    const s = summarizeClaudeUpdate(res({ fromVersion: '2.1.282 (Claude Code)', output: 'Claude Code is up to date' }));
    expect(s.tone).toBe('info');
    expect(s.title).toBe('Claude 已是最新（2.1.282）');
  });

  test('失败：agent 的原因原样展示，输出尾部与截断标记透传', () => {
    const s = summarizeClaudeUpdate(
      res({ ok: false, output: 'EACCES', outputTruncated: true, error: { code: 'failed', message: 'claude update 退出码 1' } }),
    );
    expect(s).toEqual({ tone: 'error', title: '更新失败：claude update 退出码 1', output: 'EACCES', outputTruncated: true });
  });

  test('请求本身失败（离线 / 超时）', () => {
    expect(summarizeClaudeUpdateError(new Error('机器 MBP 离线，请求未发送'))).toMatchObject({
      tone: 'error',
      title: '更新失败：机器 MBP 离线，请求未发送',
      output: '',
    });
  });

  test('shortClaudeVersion 只去掉 (Claude Code) 后缀', () => {
    expect(shortClaudeVersion('2.1.282 (Claude Code)')).toBe('2.1.282');
    expect(shortClaudeVersion('2.1.251 (SDK 内置)')).toBe('2.1.251 (SDK 内置)');
    expect(shortClaudeVersion('unknown')).toBe('unknown');
  });
});

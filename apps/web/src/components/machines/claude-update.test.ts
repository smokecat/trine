import { describe, expect, test } from 'bun:test';
import type { ClaudeCheckResult, ClaudeUpdateResult } from '@/lib/client.ts';
import {
  claudeLatestView,
  claudeUpdateHint,
  claudeVersionNumber,
  summarizeClaudeCheck,
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

describe('最新版本（claude-latest）', () => {
  test('claudeVersionNumber：取开头的版本号', () => {
    expect(claudeVersionNumber('2.1.282 (Claude Code)')).toBe('2.1.282');
    expect(claudeVersionNumber('2.1.251 (SDK 内置)')).toBe('2.1.251');
    expect(claudeVersionNumber('unknown')).toBeNull();
    expect(claudeVersionNumber(undefined)).toBeNull();
  });

  test('claudeLatestView：没有 claudeLatest = 不支持；比较当前与最新', () => {
    expect(claudeLatestView(null)).toBeNull();
    expect(claudeLatestView({ claudeVersion: '2.1.282 (Claude Code)' })).toBeNull();
    expect(
      claudeLatestView({
        claudeVersion: '2.1.282 (Claude Code)',
        claudeLatest: { channel: 'latest', version: '2.1.308', checkedAt: 5 },
      }),
    ).toEqual({
      current: '2.1.282',
      latest: '2.1.308',
      channel: 'latest',
      checkedAt: 5,
      error: null,
      updateAvailable: true,
    });
    // stable 渠道可能比已装的旧：不算有新版本
    expect(
      claudeLatestView({ claudeVersion: '2.1.308 (Claude Code)', claudeLatest: { channel: 'stable', version: '2.1.300' } })
        ?.updateAvailable,
    ).toBe(false);
    // 还没查到 / 当前版本未知：无从判断
    expect(claudeLatestView({ claudeVersion: '2.1.308', claudeLatest: { channel: 'latest' } })?.updateAvailable).toBeNull();
    expect(
      claudeLatestView({ claudeVersion: 'unknown', claudeLatest: { channel: 'latest', version: '2.1.308' } })?.updateAvailable,
    ).toBeNull();
  });

  test('claudeUpdateHint：只在有新版本时给', () => {
    expect(
      claudeUpdateHint({ claudeVersion: '2.1.282 (Claude Code)', claudeLatest: { channel: 'latest', version: '2.1.308' } }),
    ).toBe('claude 可更新 → 2.1.308');
    expect(claudeUpdateHint({ claudeVersion: '2.1.308 (Claude Code)', claudeLatest: { channel: 'latest', version: '2.1.308' } })).toBe('');
    expect(claudeUpdateHint({ claudeVersion: '2.1.282 (Claude Code)' })).toBe('');
  });

  test('summarizeClaudeCheck', () => {
    const base: ClaudeCheckResult = {
      type: 'machine.claude.check.response',
      ts: 1,
      seq: 1,
      dir: 'a2c',
      reqId: 'c',
      ok: true,
      currentVersion: '2.1.282 (Claude Code)',
      latest: { version: '2.1.308', channel: 'latest' },
    };
    expect(summarizeClaudeCheck(base)).toEqual({ tone: 'success', title: 'Claude 有新版本：2.1.282 → 2.1.308' });
    expect(summarizeClaudeCheck({ ...base, currentVersion: '2.1.308 (Claude Code)' })).toEqual({
      tone: 'info',
      title: 'Claude 已是最新（2.1.308）',
    });
    expect(summarizeClaudeCheck({ ...base, currentVersion: 'unknown' }).title).toBe('Claude 最新版本是 2.1.308');
    expect(
      summarizeClaudeCheck({ ...base, ok: false, latest: undefined, error: { code: 'failed', message: '检查失败：x' } }),
    ).toEqual({ tone: 'error', title: '检查失败：x' });
  });
});

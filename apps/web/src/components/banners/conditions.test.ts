import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ConnectionSnapshot, LeaderSnapshot, Notice } from '@/store/types.ts';
import {
  connectionBanner,
  leaderBannerVisible,
  noticeView,
  reconnectText,
  composerOfflineHint,
} from './conditions.ts';

const NOW = 1_700_000_000_000;

function conn(over: Partial<ConnectionSnapshot>): ConnectionSnapshot {
  return { status: 'open', attempt: 0, nextRetryAt: null, lastCloseCode: null, lastError: null, ...over };
}


describe('断连横幅', () => {
  test('未配对一律不显示（配对页自己讲状态）', () => {
    expect(connectionBanner(conn({ status: 'backoff' }), false, NOW).kind).toBe('none');
    expect(connectionBanner(conn({ status: 'needs_upgrade' }), false, NOW).kind).toBe('none');
  });

  test('open 不显示', () => {
    expect(connectionBanner(conn({ status: 'open' }), true, NOW).kind).toBe('none');
  });

  test('4006 → 需升级', () => {
    expect(connectionBanner(conn({ status: 'needs_upgrade' }), true, NOW).kind).toBe('upgrade');
  });

  test('backoff → 倒计时 + 第 N 次', () => {
    const b = connectionBanner(
      conn({ status: 'backoff', attempt: 2, nextRetryAt: NOW + 2_600 }),
      true,
      NOW,
    );
    expect(b).toEqual({ kind: 'reconnect', attempt: 2, secondsLeft: 3 });
    expect(reconnectText(2, 3)).toBe('连接中断 · 3s 后重连（第 2 次）');
  });

  test('倒计时已过期夹到 0，不显示负数', () => {
    const b = connectionBanner(conn({ status: 'backoff', attempt: 5, nextRetryAt: NOW - 9_000 }), true, NOW);
    expect(b).toMatchObject({ kind: 'reconnect', secondsLeft: 0 });
  });

  test('nextRetryAt 缺失当作「马上」', () => {
    const b = connectionBanner(conn({ status: 'backoff', attempt: 1, nextRetryAt: null }), true, NOW);
    expect(b).toMatchObject({ secondsLeft: 0 });
  });

  test('connecting / authenticating 只告知', () => {
    expect(connectionBanner(conn({ status: 'connecting' }), true, NOW)).toMatchObject({ kind: 'connecting' });
    expect(connectionBanner(conn({ status: 'authenticating' }), true, NOW)).toMatchObject({
      kind: 'connecting',
    });
  });

  test('stopped / idle → 给立即重连', () => {
    expect(connectionBanner(conn({ status: 'stopped' }), true, NOW).kind).toBe('stopped');
    expect(connectionBanner(conn({ status: 'idle' }), true, NOW).kind).toBe('stopped');
  });
});

describe('主从横幅', () => {
  const leader = (state: LeaderSnapshot['state']): LeaderSnapshot => ({
    state,
    instanceId: 'i',
    mode: 'locks',
  });

  test('leader / follower 都不出条（follower 走整页遮罩）', () => {
    expect(leaderBannerVisible(leader('leader'), NOW - 60_000, NOW)).toBe(false);
    expect(leaderBannerVisible(leader('follower'), NOW - 60_000, NOW)).toBe(false);
  });

  test('idle 短暂闪过不出条，超过阈值才出', () => {
    expect(leaderBannerVisible(leader('idle'), NOW - 500, NOW)).toBe(false);
    expect(leaderBannerVisible(leader('idle'), NOW - 3_000, NOW)).toBe(true);
    expect(leaderBannerVisible(leader('idle'), null, NOW)).toBe(false);
  });
});

describe('notice → 展示形态', () => {
  const name = (id: string): string => (id === 'm1' ? 'mbp' : id);
  const wrap = (notice: Notice['notice']): Notice => ({ id: 'x', notice, at: NOW });

  test('游标倒退与 scope fatal 走常驻横幅，且有一键恢复', () => {
    const cursor = noticeView(wrap({ kind: 'cursor_regression', machineId: 'm1', scope: '' }), name);
    expect(cursor.placement).toBe('bar');
    expect(cursor.actionLabel).toContain('重置');
    expect(cursor.text).toContain('mbp');

    const fatal = noticeView(
      wrap({ kind: 'scope_fatal', machineId: 'm1', scope: 's1', detail: '出站计数器失效' }),
      name,
    );
    expect(fatal.placement).toBe('bar');
    expect(fatal.actionLabel).toContain('重置');
  });

  test('会话级游标倒退带上会话短码，机器级不带', () => {
    const perSession = noticeView(
      wrap({ kind: 'cursor_regression', machineId: 'm1', scope: 'abcdefghij' }),
      name,
    );
    expect(perSession.text).toContain('abcdefgh');
    const machineLevel = noticeView(wrap({ kind: 'cursor_regression', machineId: 'm1', scope: '' }), name);
    expect(machineLevel.text).not.toContain('会话');
  });

  test('自愈放弃与机器级错误走 toast，没有一键动作', () => {
    const gaveUp = noticeView(
      wrap({ kind: 'outbox_gave_up', machineId: 'm1', scope: '', detail: '连撞 3 次' }),
      name,
    );
    expect(gaveUp.placement).toBe('toast');
    expect(gaveUp.actionLabel).toBeNull();

    const err = noticeView(
      wrap({ kind: 'machine_error', machineId: 'm1', error: { kind: 'quota', message: '额度用尽', at: NOW } }),
      name,
    );
    expect(err.placement).toBe('toast');
    expect(err.text).toContain('额度用尽');
  });
});

describe('会话页离线提示只一处（m6）', () => {
  test('composer 那条把排队数并了进来', () => {
    expect(composerOfflineHint({ name: 'MBP', parkedCount: 0 })).toBe(
      'MBP 离线，发出的消息会排队，等它上线后送达',
    );
    expect(composerOfflineHint({ name: 'MBP', parkedCount: 3 })).toContain('已排队 3 条');
  });

  test('机器信息缺失时不渲染 undefined', () => {
    expect(composerOfflineHint(undefined)).toBe('机器 离线，发出的消息会排队，等它上线后送达');
  });

  // 早先这里有一条「OfflineBanner 在会话页不再渲染」——它断的是**源码字符串**
  // （`src.toContain('if (match !== null) return null;')`），测不出「这个组件
  // 在任何路由都不渲染了」这个事实（评审 C-3、learnings「不要写只断源码字符串
  // 的假测试」）。组件已删，测试随之删掉。
});

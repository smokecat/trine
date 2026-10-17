import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  invalidateFetched,
  LIST_TTL_MS,
  markFetched,
  pickMachinesToFetch,
  resetFetchedForTest,
} from './list-refresh-policy.ts';

beforeEach(() => resetFetchedForTest());

const T0 = 1_700_000_000_000;

describe('session.list 拉取判据（M5：去重 + TTL）', () => {
  test('首次一律放行', () => {
    expect(pickMachinesToFetch(['a', 'b'], T0, 1)).toEqual(['a', 'b']);
  });

  test('TTL 内不再拉——列表 → 机器页 → 返回列表不该又是一次全量 listSessions', () => {
    const due = pickMachinesToFetch(['a'], T0, 1);
    markFetched(due, T0, 1);
    // 视图卸载重挂（模块级状态不随之丢失）
    expect(pickMachinesToFetch(['a'], T0 + 1_000, 1)).toEqual([]);
    expect(pickMachinesToFetch(['a'], T0 + LIST_TTL_MS - 1, 1)).toEqual([]);
  });

  test('过了 TTL 再放行', () => {
    markFetched(['a'], T0, 1);
    expect(pickMachinesToFetch(['a'], T0 + LIST_TTL_MS, 1)).toEqual(['a']);
  });

  test('换连接代际立刻放行——断线期间 agent 可能建了新会话', () => {
    markFetched(['a'], T0, 1);
    expect(pickMachinesToFetch(['a'], T0 + 1_000, 1)).toEqual([]);
    expect(pickMachinesToFetch(['a'], T0 + 1_000, 2)).toEqual(['a']);
  });

  test('机器下线再上线要重拉（agent 可能重启过）', () => {
    markFetched(['a'], T0, 1);
    // a 下线：全量清单里没有它，记账被清
    expect(pickMachinesToFetch(['b'], T0 + 1_000, 1)).toEqual(['b']);
    markFetched(['b'], T0 + 1_000, 1);
    // a 回来：即便还在 TTL 内也该拉
    expect(pickMachinesToFetch(['a', 'b'], T0 + 2_000, 1)).toEqual(['a']);
  });

  test('多机互不影响：一台到期不会连累另一台', () => {
    markFetched(['a'], T0, 1);
    markFetched(['b'], T0 + LIST_TTL_MS, 1);
    expect(pickMachinesToFetch(['a', 'b'], T0 + LIST_TTL_MS + 1, 1)).toEqual(['a']);
  });

  test('prune:false（单机问询）不抹掉其它机器的记账', () => {
    markFetched(['a', 'b'], T0, 1);
    // 聊天页只问 b，不能把 a 当成「已下线」
    expect(pickMachinesToFetch(['b'], T0 + 1_000, 1, LIST_TTL_MS, { prune: false })).toEqual([]);
    expect(pickMachinesToFetch(['a', 'b'], T0 + 2_000, 1)).toEqual([]);
  });

  test('手动刷新绕过 TTL', () => {
    markFetched(['a'], T0, 1);
    expect(pickMachinesToFetch(['a'], T0 + 1_000, 1)).toEqual([]);
    invalidateFetched(['a']);
    expect(pickMachinesToFetch(['a'], T0 + 1_000, 1)).toEqual(['a']);
  });

  test('没有在线机器时什么也不拉', () => {
    expect(pickMachinesToFetch([], T0, 1)).toEqual([]);
  });
});

describe('自动拉取挂载位置（M1）', () => {
  // PC（≥900px）布局的 `/` 渲染 EmptyMain 而不是 SessionListView，
  // 自动拉取挂在视图里 PC 上就永远不会发，侧栏永远空。
  const layout = readFileSync(new URL('../../app/Layout.tsx', import.meta.url), 'utf8');
  const sidebar = readFileSync(new URL('../shell/Sidebar.tsx', import.meta.url), 'utf8');

  test('自动拉取挂在 Layout（两套布局共享），不在某个视图里', () => {
    expect(layout).toContain('useSessionListAutoRefresh()');
  });

  test('侧栏有手动刷新入口——PC 上列表页从不挂载', () => {
    expect(sidebar).toContain('useSessionRefresh()');
    expect(sidebar).toContain('data-testid="sidebar-refresh"');
  });
});

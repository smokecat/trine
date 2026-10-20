import { describe, expect, test } from 'bun:test';
import type { SessionMeta, SessionState } from '@trine/core';
import {
  countArchived,
  DEFAULT_LIST_QUERY,
  emptyText,
  filterSessions,
  groupKey,
  groupLabel,
  groupRows,
  isGroupExpanded,
  isTempCwd,
  isTempSession,
  matchesStatus,
  normalizeCwd,
  type ListQuery,
} from './filtering.ts';
import { countActiveSessions } from './sorting.ts';

function meta(over: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  return {
    title: '',
    state: 'idle' as SessionState,
    lastActivityAt: 0,
    cwd: '/home/me/repo',
    model: 'claude-opus-5',
    permissionMode: 'default',
    costUsd: 0,
    ...over,
  };
}

function q(over: Partial<ListQuery> = {}): ListQuery {
  return { ...DEFAULT_LIST_QUERY, groupBy: 'none', ...over };
}

function ids(rows: { meta: SessionMeta }[]): string[] {
  return rows.map((r) => r.meta.sessionId);
}

const ALL_STATES: SessionState[] = ['idle', 'running', 'waiting_permission', 'error', 'stopped'];

describe('matchesStatus', () => {
  test('「进行中」与 countActiveSessions 同一口径', () => {
    for (const state of ALL_STATES) {
      const counted = countActiveSessions({ s: meta({ sessionId: 's', state }) }) === 1;
      expect(matchesStatus(state, 'active')).toBe(counted);
    }
  });

  test('其余 chip 的判据', () => {
    expect(ALL_STATES.filter((s) => matchesStatus(s, 'waiting'))).toEqual(['waiting_permission']);
    expect(ALL_STATES.filter((s) => matchesStatus(s, 'idle'))).toEqual(['idle']);
    expect(ALL_STATES.filter((s) => matchesStatus(s, 'ended'))).toEqual(['error', 'stopped']);
    expect(ALL_STATES.every((s) => matchesStatus(s, 'all'))).toBe(true);
  });
});

describe('filterSessions 管线', () => {
  const sessions = {
    m1: {
      a: meta({ sessionId: 'a', title: 'Fix login', lastActivityAt: 10 }),
      b: meta({ sessionId: 'b', state: 'running', lastActivityAt: 5, gitBranch: 'feature/x' }),
      c: meta({ sessionId: 'c', archived: true, archivedAt: 3, lastActivityAt: 30 }),
    },
    m2: {
      d: meta({ sessionId: 'd', state: 'waiting_permission', cwd: '/srv/app', lastActivityAt: 1 }),
      e: meta({ sessionId: 'e', firstPrompt: '帮我重构 Parser', lastActivityAt: 20 }),
    },
  };
  const names = { m1: 'MacBook', m2: 'vps-sgp' };

  test('默认视图过滤掉已归档，并数出机器范围内的归档数', () => {
    const r = filterSessions(sessions, q(), names);
    expect(ids(r.rows)).toEqual(['d', 'b', 'e', 'a']);
    expect(r.archivedCount).toBe(1);
    expect(r.groups).toBeNull();
    expect(r.empty).toBeNull();
  });

  test('countArchived 与管线的 archivedCount 一致', () => {
    expect(countArchived(sessions, null)).toBe(filterSessions(sessions, q()).archivedCount);
    expect(countArchived(sessions, 'm2')).toBe(0);
  });

  test('归档视图只看 archived===true', () => {
    expect(ids(filterSessions(sessions, q({ archived: true }), names).rows)).toEqual(['c']);
  });

  test('机器过滤在最前：archivedCount 只算该机器', () => {
    const r = filterSessions(sessions, q({ machine: 'm2' }), names);
    expect(ids(r.rows)).toEqual(['d', 'e']);
    expect(r.archivedCount).toBe(0);
  });

  test('状态 chip', () => {
    expect(ids(filterSessions(sessions, q({ status: 'active' }), names).rows)).toEqual(['d', 'b']);
    expect(ids(filterSessions(sessions, q({ status: 'waiting' }), names).rows)).toEqual(['d']);
  });

  test('搜索字段：title / firstPrompt / lastEvent / cwd / gitBranch，不分大小写', () => {
    const s = (search: string) => ids(filterSessions(sessions, q({ search }), names).rows);
    expect(s('LOGIN')).toEqual(['a']);
    expect(s('parser')).toEqual(['e']);
    expect(s('feature/')).toEqual(['b']);
    expect(s('/srv')).toEqual(['d']);
    expect(s('  login  ')).toEqual(['a']);
  });

  test('lastEvent 参与搜索；空标题时 sessionId 短码也可搜', () => {
    const one = { m: { x: meta({ sessionId: 'abcdef1234', lastEvent: 'Bash: bun test' }) } };
    expect(ids(filterSessions(one, q({ search: 'bun test' })).rows)).toEqual(['abcdef1234']);
    expect(ids(filterSessions(one, q({ search: 'abcdef12' })).rows)).toEqual(['abcdef1234']);
  });

  test('机器名只在「全部机器」视图下参与搜索', () => {
    expect(ids(filterSessions(sessions, q({ search: 'vps' }), names).rows)).toEqual(['d', 'e']);
    expect(filterSessions(sessions, q({ machine: 'm2', search: 'vps' }), names).rows).toEqual([]);
  });

  test('搜索不会把归档会话带回默认视图', () => {
    expect(filterSessions(sessions, q({ search: 'repo' }), names).rows.map((r) => r.meta.archived)).not.toContain(
      true,
    );
  });
});

describe('空态原因', () => {
  test('一个会话都没有 / 选中机器为空', () => {
    expect(filterSessions({}, q()).empty).toBe('no-sessions');
    expect(filterSessions({ m1: { a: meta({ sessionId: 'a' }) } }, q({ machine: 'm2' })).empty).toBe(
      'machine-empty',
    );
  });

  test('全部已归档 → all-archived，带数量', () => {
    const s = { m: { a: meta({ sessionId: 'a', archived: true }), b: meta({ sessionId: 'b', archived: true }) } };
    const r = filterSessions(s, q());
    expect(r.empty).toBe('all-archived');
    expect(emptyText(r.empty!, { compact: false, archivedCount: r.archivedCount, search: '' })).toContain(
      '有 2 个已归档会话',
    );
  });

  test('归档视图为空', () => {
    expect(filterSessions({ m: { a: meta({ sessionId: 'a' }) } }, q({ archived: true })).empty).toBe(
      'archived-empty',
    );
  });

  test('被状态筛空优先于搜索', () => {
    const s = { m: { a: meta({ sessionId: 'a', title: 'x' }) } };
    expect(filterSessions(s, q({ status: 'waiting', search: 'zzz' })).empty).toBe('status');
    expect(filterSessions(s, q({ search: 'zzz' })).empty).toBe('search');
  });

  test('文案按原因区分，搜索词回显', () => {
    const opts = { compact: false, archivedCount: 0, search: ' foo ' };
    expect(emptyText('search', opts)).toBe('没有匹配「foo」的会话。');
    expect(emptyText('status', opts)).toContain('筛选');
    expect(emptyText('no-sessions', { ...opts, compact: true })).toContain('新建');
    expect(emptyText('no-sessions', { ...opts, compact: true })).not.toContain('右下角');
    expect(emptyText('no-sessions', opts)).toContain('右下角');
    // 按机器过滤时两种布局同一句
    expect(emptyText('machine-empty', { ...opts, compact: true })).toBe(emptyText('machine-empty', opts));
  });
});

describe('工作空间分组', () => {
  test('key = machineId + 去尾 / 的 cwd；根目录保留 /', () => {
    expect(normalizeCwd('/a/b/')).toBe('/a/b');
    expect(normalizeCwd('/')).toBe('/');
    expect(normalizeCwd('')).toBe('');
    expect(groupKey('m', '/a/b/')).toBe(groupKey('m', '/a/b'));
    expect(groupKey('m1', '/a')).not.toBe(groupKey('m2', '/a'));
  });

  test('cwd 为空串显示「未知目录」', () => {
    expect(groupLabel('')).toBe('未知目录');
    expect(groupLabel('/x')).toBe('/x');
  });

  test('组序按工作区创建时间倒序，不随组内状态 / 最后活动跳', () => {
    const rows = [
      { machineId: 'm', meta: meta({ sessionId: 'new1', cwd: '/new', createdAt: 300, lastActivityAt: 300 }) },
      { machineId: 'm', meta: meta({ sessionId: 'old1', cwd: '/old', createdAt: 10, lastActivityAt: 10 }) },
      {
        machineId: 'm',
        meta: meta({ sessionId: 'old2', cwd: '/old/', state: 'waiting_permission', createdAt: 400, lastActivityAt: 999 }),
      },
      // 没有 createdAt 的退回 lastActivityAt
      { machineId: 'm', meta: meta({ sessionId: 'mid', cwd: '/mid', state: 'running', lastActivityAt: 200 }) },
    ];
    const groups = groupRows(rows);
    expect(groups.map((g) => g.cwd)).toEqual(['/new', '/mid', '/old']);
    // 组内 compareSessions：待批准在上
    expect(ids(groups[2]!.rows)).toEqual(['old2', 'old1']);
    expect(groups[2]).toMatchObject({ waitingCount: 1, runningCount: 0, rank: 0, lastActivityAt: 999, createdAt: 10 });
  });

  test('置顶的工作区在最前，越晚置顶越靠上；置顶按规范化 cwd 匹配', () => {
    const rows = [
      { machineId: 'm', meta: meta({ sessionId: 'a', cwd: '/a', createdAt: 1 }) },
      { machineId: 'm', meta: meta({ sessionId: 'b', cwd: '/b', createdAt: 2 }) },
      { machineId: 'm', meta: meta({ sessionId: 'c', cwd: '/c', createdAt: 3 }) },
      { machineId: 'n', meta: meta({ sessionId: 'd', cwd: '/a', createdAt: 4 }) },
    ];
    const groups = groupRows(rows, { pinned: { m: { '/a/': 50, '/b': 60 } } });
    expect(groups.map((g) => g.key)).toEqual([groupKey('m', '/b'), groupKey('m', '/a'), groupKey('n', '/a'), groupKey('m', '/c')]);
    expect(groups[0]!.pinnedAt).toBe(60);
    expect(groups[2]!.pinnedAt).toBeUndefined();
  });

  test('filterSessions：工作区创建时间取全量会话（含归档、被筛掉的），组位置不随筛选变', () => {
    const s = {
      m: {
        // /x 最早的会话已归档，但工作区仍按它的时间算
        x0: meta({ sessionId: 'x0', cwd: '/x', createdAt: 1, archived: true }),
        x1: meta({ sessionId: 'x1', cwd: '/x', createdAt: 500, state: 'running' }),
        y1: meta({ sessionId: 'y1', cwd: '/y', createdAt: 100 }),
      },
    };
    expect(filterSessions(s, q({ groupBy: 'workspace' })).groups?.map((g) => g.cwd)).toEqual(['/y', '/x']);
    const pinned = filterSessions(s, q({ groupBy: 'workspace' }), {}, { m: { '/x': 1 } });
    expect(pinned.groups?.map((g) => g.cwd)).toEqual(['/x', '/y']);
  });

  test('filterSessions 在 groupBy=workspace 时给出分组，且扁平行仍有序', () => {
    const s = {
      m: {
        a: meta({ sessionId: 'a', cwd: '/x', lastActivityAt: 1 }),
        b: meta({ sessionId: 'b', cwd: '', lastActivityAt: 2 }),
      },
    };
    const r = filterSessions(s, q({ groupBy: 'workspace' }));
    expect(r.groups?.map((g) => g.cwd)).toEqual(['', '/x']);
    expect(ids(r.rows)).toEqual(['b', 'a']);
  });

  test('有待批准的组强制展开，即便被折叠过', () => {
    const [g] = groupRows([
      { machineId: 'm', meta: meta({ sessionId: 'a', state: 'waiting_permission' }) },
    ]);
    const [h] = groupRows([{ machineId: 'm', meta: meta({ sessionId: 'b', state: 'running' }) }]);
    expect(isGroupExpanded(g!, new Set([g!.key]))).toBe(true);
    expect(isGroupExpanded(h!, new Set([h!.key]))).toBe(false);
    expect(isGroupExpanded(h!, new Set())).toBe(true);
  });

  test('搜索非空 / 状态不是全部 → 一律展开（只看渲染，不动折叠集合）', () => {
    const [h] = groupRows([{ machineId: 'm', meta: meta({ sessionId: 'b', state: 'running' }) }]);
    const collapsed = new Set([h!.key]);
    expect(isGroupExpanded(h!, collapsed, { search: '', status: 'all' })).toBe(false);
    expect(isGroupExpanded(h!, collapsed, { search: '  ', status: 'all' })).toBe(false);
    expect(isGroupExpanded(h!, collapsed, { search: 'x', status: 'all' })).toBe(true);
    expect(isGroupExpanded(h!, collapsed, { search: '', status: 'active' })).toBe(true);
    expect(collapsed.has(h!.key)).toBe(true);
  });
});

describe('临时会话', () => {
  test('isTempCwd：系统临时目录按路径段判', () => {
    for (const cwd of ['/tmp', '/tmp/', '/tmp/x/y', '/private/tmp/a', '/var/tmp/a', '/var/folders/ab/xyz/T/run', '/private/var/folders/ab/T']) {
      expect(isTempCwd(cwd)).toBe(true);
    }
    for (const cwd of ['', '/', '/tmpfoo', '/home/me/tmp', '/home/me/.local/tmp/x', '/var/foldersx', '/var/log']) {
      expect(isTempCwd(cwd)).toBe(false);
    }
  });

  test('isTempSession：临时目录 ∪ 非交互（headless）', () => {
    expect(isTempSession({ cwd: '/home/me/repo' })).toBe(false);
    expect(isTempSession({ cwd: '/home/me/repo', headless: true })).toBe(true);
    expect(isTempSession({ cwd: '/home/me/repo', headless: false })).toBe(false);
    expect(isTempSession({ cwd: '/tmp/x' })).toBe(true);
  });

  const sessions = {
    m: {
      a: meta({ sessionId: 'a', lastActivityAt: 3 }),
      t: meta({ sessionId: 't', cwd: '/tmp/scratch', lastActivityAt: 2 }),
      h: meta({ sessionId: 'h', headless: true, lastActivityAt: 1 }),
      x: meta({ sessionId: 'x', headless: true, archived: true }),
    },
  };

  test('默认隐藏并计数；showTemp 时全显示、计数为 0', () => {
    const hidden = filterSessions(sessions, q());
    expect(ids(hidden.rows)).toEqual(['a']);
    expect(hidden.tempHidden).toBe(2);
    const shown = filterSessions(sessions, q({ showTemp: true }));
    expect(ids(shown.rows)).toEqual(['a', 't', 'h']);
    expect(shown.tempHidden).toBe(0);
    expect(shown.tempShown).toBe(2);
  });

  test('计数只看当前视图（归档视图数归档里的），不受状态 / 搜索影响', () => {
    expect(filterSessions(sessions, q({ archived: true })).tempHidden).toBe(1);
    expect(filterSessions(sessions, q({ search: 'zzz' })).tempHidden).toBe(2);
  });

  test('只剩临时会话 → all-temp 空态', () => {
    const only = { m: { t: sessions.m.t, h: sessions.m.h } };
    const result = filterSessions(only, q());
    expect(result.empty).toBe('all-temp');
    expect(emptyText('all-temp', { compact: true, archivedCount: 0, tempHidden: 2, search: '' })).toContain('2 个');
  });
});

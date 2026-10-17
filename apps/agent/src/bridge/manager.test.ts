/**
 * 会话管理：互斥、并发上限、空闲回收、列表合并。
 *
 * 用假的 ClaudeSession 工厂注入，避免起真子进程——这些逻辑本身与 SDK 无关。
 */
import { describe, expect, test } from 'bun:test';
import type { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { EventEmitter } from './emitter.ts';
import {
  ConcurrencyLimitError,
  SessionManager,
  type CreateSessionArgs,
  type SessionFlags,
} from './manager.ts';
import type { ClaudeSession } from './session.ts';
import type { OutboundEvent } from './types.ts';

/** 假会话：只实现 manager 会碰到的那几个成员 */
interface FakeSession {
  sessionId: string;
  state: string;
  costUsd: number;
  lastActivityAt: number;
  queueLength: number;
  bgRunningCount?: number;
  closed: boolean;
  closeReason?: string;
  args: CreateSessionArgs;
  close(reason?: string, drainTimeoutMs?: number): Promise<void>;
}

function makeHarness(options?: {
  maxConcurrent?: number;
  idleTimeoutMs?: number;
  now?: () => number;
  sessions?: Awaited<ReturnType<typeof listSessions>>;
  /** 观察 close 收到的参数 */
  onClose?: (reason: string | undefined, drainTimeoutMs: number | undefined) => void;
  flags?: SessionFlags;
  onRunEnd?: (sessionId: string) => void;
  claudeExecutable?: string;
}) {
  const events: OutboundEvent[] = [];
  const created: FakeSession[] = [];
  const now = options?.now ?? (() => 0);
  const emitter = new EventEmitter({ sink: (out) => events.push(out), now });

  const manager = new SessionManager({
    emitter,
    now,
    ...(options?.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
    ...(options?.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    listSessionsFn: (async () => options?.sessions ?? []) as typeof listSessions,
    // 默认实现会去读真 ~/.claude：测试一律注入
    getSessionInfoFn: (async (sid: string) =>
      options?.sessions?.find((s) => s.sessionId === sid)) as never,
    renameSessionFn: (async () => {}) as never,
    deleteSessionFn: (async () => {}) as never,
    ...(options?.flags === undefined ? {} : { flags: options.flags }),
    ...(options?.onRunEnd === undefined ? {} : { onRunEnd: options.onRunEnd }),
    ...(options?.claudeExecutable === undefined ? {} : { claudeExecutable: options.claudeExecutable }),
    createSession: (args: CreateSessionArgs) => {
      const fake: FakeSession = {
        args,
        sessionId: args.sessionId,
        state: 'idle',
        costUsd: 0,
        lastActivityAt: now(),
        queueLength: 0,
        closed: false,
        close(reason?: string, drainTimeoutMs?: number) {
          this.closed = true;
          this.closeReason = reason;
          options?.onClose?.(reason, drainTimeoutMs);
          return Promise.resolve();
        },
      };
      created.push(fake);
      return fake as unknown as ClaudeSession;
    },
  });

  return { manager, events, created };
}

const base = { cwd: '/tmp', model: 'claude-opus-4', permissionMode: 'default' as const };

describe('SessionManager · 互斥', () => {
  test('同 sessionId 重复 acquire 返回同一实例（不起第二个进程）', () => {
    const { manager, created } = makeHarness();

    const first = manager.acquire({ sessionId: 's1', ...base });
    const second = manager.acquire({ sessionId: 's1', ...base });

    expect(second.session).toBe(first.session);
    expect(created).toHaveLength(1);
    expect(manager.activeCount).toBe(1);
  });

  test('复用已有会话时 reused=true（调用方知情，不静默吞掉）', () => {
    const { manager } = makeHarness();

    expect(manager.acquire({ sessionId: 's1', ...base }).reused).toBe(false);
    // 换了 cwd/model 也只是复用——这些参数不会被套用到已有会话上，
    // 否则另一台设备打开同一会话会意外改掉别人的会话设置
    const again = manager.acquire({
      sessionId: 's1',
      cwd: '/other',
      model: 'other-model',
      permissionMode: 'plan',
    });
    expect(again.reused).toBe(true);
    expect(manager.metaOf('s1')).toMatchObject({ cwd: '/tmp', model: 'claude-opus-4' });
  });

  test('不同 sessionId 各自一个实例', () => {
    const { manager, created } = makeHarness();
    manager.acquire({ sessionId: 's1', ...base });
    manager.acquire({ sessionId: 's2', ...base });

    expect(created).toHaveLength(2);
    expect(manager.activeSessionIds).toEqual(['s1', 's2']);
  });

  test('has/get 反映互斥表', () => {
    const { manager } = makeHarness();
    expect(manager.has('s1')).toBe(false);
    expect(manager.get('s1')).toBeUndefined();

    manager.acquire({ sessionId: 's1', ...base });
    expect(manager.has('s1')).toBe(true);
    expect(manager.get('s1')).toBeDefined();
  });

  test('release 后名额归还，可再次 acquire', async () => {
    const { manager, created } = makeHarness({ maxConcurrent: 1 });
    manager.acquire({ sessionId: 's1', ...base });

    await manager.release('s1');
    expect(manager.activeCount).toBe(0);
    expect(created[0]!.closed).toBe(true);

    expect(() => manager.acquire({ sessionId: 's2', ...base })).not.toThrow();
  });
});

describe('SessionManager · claude 可执行文件', () => {
  test('claudeExecutable 透传为每个会话的 pathToClaudeCodeExecutable；不给则不带', () => {
    const withPath = makeHarness({ claudeExecutable: '/home/u/.local/bin/claude' });
    withPath.manager.acquire({ sessionId: 's1', ...base });
    expect(withPath.created[0]!.args.pathToClaudeCodeExecutable).toBe('/home/u/.local/bin/claude');

    const without = makeHarness();
    without.manager.acquire({ sessionId: 's1', ...base });
    expect('pathToClaudeCodeExecutable' in without.created[0]!.args).toBe(false);
  });
});

describe('SessionManager · session.created 广播', () => {
  test('新建会话广播 session.created（机器级帧）', () => {
    const { manager, events } = makeHarness({ now: () => 7_000 });
    manager.acquire({ sessionId: 's1', ...base });

    const created = events.filter((e) => e.event.type === 'session.created');
    expect(created).toHaveLength(1);
    // 会话列表是机器维度的视图 → 机器级帧（sessionId 省略）
    expect(created[0]!.scope).toBeNull();
    expect(created[0]!.event).toMatchObject({
      type: 'session.created',
      session: { sessionId: 's1', cwd: '/tmp', state: 'idle', costUsd: 0 },
    });
  });

  test('复用已有会话不重复广播', () => {
    const { manager, events } = makeHarness();
    manager.acquire({ sessionId: 's1', ...base });
    manager.acquire({ sessionId: 's1', ...base });

    expect(events.filter((e) => e.event.type === 'session.created')).toHaveLength(1);
  });

  test('resume 已有会话不算新建，不广播', () => {
    const { manager, events } = makeHarness();
    manager.acquire({ sessionId: 'hist', ...base, resume: true });

    expect(events.filter((e) => e.event.type === 'session.created')).toHaveLength(0);
  });
});

describe('SessionManager · 并发上限', () => {
  test('超出上限抛 ConcurrencyLimitError', () => {
    const { manager } = makeHarness({ maxConcurrent: 2 });
    manager.acquire({ sessionId: 's1', ...base });
    manager.acquire({ sessionId: 's2', ...base });

    expect(() => manager.acquire({ sessionId: 's3', ...base })).toThrow(ConcurrencyLimitError);
  });

  test('已存在的会话不受上限限制（取实例不是新建）', () => {
    const { manager } = makeHarness({ maxConcurrent: 1 });
    manager.acquire({ sessionId: 's1', ...base });

    expect(() => manager.acquire({ sessionId: 's1', ...base })).not.toThrow();
  });
});

describe('SessionManager · 空闲回收', () => {
  test('空闲超时的会话被回收', async () => {
    let clock = 0;
    const { manager, created } = makeHarness({ idleTimeoutMs: 1_000, now: () => clock });
    manager.acquire({ sessionId: 's1', ...base });

    clock = 500;
    expect(await manager.reapIdle()).toEqual([]);

    clock = 1_500;
    expect(await manager.reapIdle()).toEqual(['s1']);
    expect(created[0]!.closed).toBe(true);
    expect(manager.activeCount).toBe(0);
  });

  test('运行中的会话不回收，哪怕 lastActivityAt 很旧', async () => {
    let clock = 0;
    const { manager, created } = makeHarness({ idleTimeoutMs: 1_000, now: () => clock });
    manager.acquire({ sessionId: 's1', ...base });
    created[0]!.state = 'running';

    clock = 999_999;
    expect(await manager.reapIdle()).toEqual([]);
    expect(manager.activeCount).toBe(1);
  });

  test('等待权限的会话不回收（人可能正在路上）', async () => {
    let clock = 0;
    const { manager, created } = makeHarness({ idleTimeoutMs: 1_000, now: () => clock });
    manager.acquire({ sessionId: 's1', ...base });
    created[0]!.state = 'waiting_permission';

    clock = 999_999;
    expect(await manager.reapIdle()).toEqual([]);
  });

  test('队列非空的会话不回收', async () => {
    let clock = 0;
    const { manager, created } = makeHarness({ idleTimeoutMs: 1_000, now: () => clock });
    manager.acquire({ sessionId: 's1', ...base });
    created[0]!.queueLength = 2;

    clock = 999_999;
    expect(await manager.reapIdle()).toEqual([]);
  });

  test('有后台任务在跑的空闲会话不回收（回收会杀掉子进程，后台任务跟着死）', async () => {
    let clock = 0;
    const { manager, created } = makeHarness({ idleTimeoutMs: 1_000, now: () => clock });
    manager.acquire({ sessionId: 's1', ...base });
    manager.acquire({ sessionId: 's2', ...base });
    created[0]!.bgRunningCount = 1;
    created[1]!.bgRunningCount = 0;

    clock = 999_999;
    expect(await manager.reapIdle()).toEqual(['s2']);
    // 后台任务结束后即可回收
    created[0]!.bgRunningCount = 0;
    expect(await manager.reapIdle()).toEqual(['s1']);
  });

  test('bgRunning 经 onMeta 进入 session.updated，归零后从 meta 里去掉', () => {
    const { manager, created, events } = makeHarness();
    manager.acquire({ sessionId: 's1', ...base });
    const runtime = {
      sessionId: 's1',
      state: 'idle' as const,
      costUsd: 0,
      lastActivityAt: 0,
      cwd: '/p',
      model: 'm',
      permissionMode: 'default' as const,
    };
    created[0]!.args.onMeta?.({ ...runtime, bgRunning: 2 });
    let updated = events.filter((e) => e.event.type === 'session.updated').at(-1)!.event as { session: { bgRunning?: number } };
    expect(updated.session.bgRunning).toBe(2);
    expect(manager.metaOf('s1')?.bgRunning).toBe(2);

    created[0]!.args.onMeta?.({ ...runtime, bgRunning: 0 });
    updated = events.filter((e) => e.event.type === 'session.updated').at(-1)!.event as { session: { bgRunning?: number } };
    expect('bgRunning' in updated.session).toBe(false);
    expect(manager.metaOf('s1')).not.toHaveProperty('bgRunning');
  });

  test('回收不销毁 seq 序列——同会话恢复后 seq 继续单调', async () => {
    let clock = 0;
    const events: OutboundEvent[] = [];
    const emitter = new EventEmitter({ sink: (out) => events.push(out), now: () => clock });
    // 捕获 manager 注入给会话的 emit 口，模拟会话发帧
    const emits = new Map<string, (body: { type: 'run.state'; state: 'idle' }) => void>();
    const manager = new SessionManager({
      emitter,
      now: () => clock,
      idleTimeoutMs: 1_000,
      listSessionsFn: (async () => []) as typeof listSessions,
      createSession: (args: CreateSessionArgs) => {
        emits.set(args.sessionId, args.emit as never);
        return {
          sessionId: args.sessionId,
          state: 'idle',
          costUsd: 0,
          lastActivityAt: clock,
          queueLength: 0,
          close: () => Promise.resolve(),
        } as unknown as ClaudeSession;
      },
    });

    manager.acquire({ sessionId: 's1', ...base });
    emits.get('s1')!({ type: 'run.state', state: 'idle' });
    emits.get('s1')!({ type: 'run.state', state: 'idle' });

    clock = 2_000;
    await manager.reapIdle();

    // 恢复同一会话后继续发帧：seq 必须接着 2 往下，而不是从 0 重来
    manager.acquire({ sessionId: 's1', ...base });
    emits.get('s1')!({ type: 'run.state', state: 'idle' });

    const seqs = events.filter((e) => e.scope === 's1').map((e) => e.event.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });
});

describe('SessionManager · 列表', () => {
  test('合并 SDK 历史会话与运行时状态', async () => {
    const { manager } = makeHarness({
      now: () => 5_000,
      sessions: [
        {
          sessionId: 'hist-1',
          summary: '历史会话',
          lastModified: 1_000,
          cwd: '/repo',
        },
      ] as Awaited<ReturnType<typeof listSessions>>,
    });

    const list = await manager.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      sessionId: 'hist-1',
      title: '历史会话',
      cwd: '/repo',
      state: 'idle',
    });
  });

  test('本进程新建但未落盘的会话也进列表', async () => {
    const { manager } = makeHarness({ now: () => 5_000, sessions: [] });
    manager.acquire({ sessionId: 'fresh', ...base });

    const list = await manager.list();
    expect(list.map((s) => s.sessionId)).toEqual(['fresh']);
  });

  test('按最近活动时间倒序', async () => {
    const { manager } = makeHarness({
      now: () => 0,
      sessions: [
        { sessionId: 'old', summary: '', lastModified: 100 },
        { sessionId: 'new', summary: '', lastModified: 900 },
      ] as Awaited<ReturnType<typeof listSessions>>,
    });

    const list = await manager.list();
    expect(list.map((s) => s.sessionId)).toEqual(['new', 'old']);
  });
});

describe('SessionManager · closeAll', () => {
  test('全部关闭并带理由', async () => {
    const { manager, created } = makeHarness();
    manager.acquire({ sessionId: 's1', ...base });
    manager.acquire({ sessionId: 's2', ...base });

    await manager.closeAll('agent 正在退出');

    expect(manager.activeCount).toBe(0);
    expect(created.every((s) => s.closed)).toBe(true);
    expect(created[0]!.closeReason).toBe('agent 正在退出');
  });

  test('drainTimeoutMs 透传到每个会话的 close（退出总时限由调用方掌控）', async () => {
    const seen: Array<number | undefined> = [];
    const { manager } = makeHarness({
      onClose: (_reason, drainTimeoutMs) => seen.push(drainTimeoutMs),
    });
    manager.acquire({ sessionId: 's1', ...base });
    manager.acquire({ sessionId: 's2', ...base });
    await manager.closeAll('退出', 1500);
    expect(seen).toEqual([1500, 1500]);
  });
});

// ---------------------------------------------------------------------------
// session-list-v2：meta 出口统一（评审 B3）、标记合并、自动取消归档（M1）
// ---------------------------------------------------------------------------

/** 内存版 SessionFlags */
function fakeFlags() {
  const archived = new Map<string, number>();
  const pending = new Map<string, string>();
  const deleted = new Set<string>();
  const flags: SessionFlags = {
    archivedAt: (sid) => archived.get(sid),
    pendingTitle: (sid) => pending.get(sid),
    isDeleted: (sid) => deleted.has(sid),
    unarchiveNow: (sid) => {
      archived.delete(sid);
    },
  };
  return { flags, archived, pending, deleted };
}

/** 让假会话像真 ClaudeSession 一样回调 onMeta（状态迁移时） */
function transition(fake: FakeSession, state: string): void {
  fake.state = state;
  fake.args.onMeta?.({
    sessionId: fake.sessionId,
    state: state as never,
    costUsd: fake.costUsd,
    lastActivityAt: fake.lastActivityAt,
    cwd: fake.args.cwd,
    model: fake.args.model,
    permissionMode: fake.args.permissionMode,
  });
}

const updatedOf = (events: OutboundEvent[]) =>
  events
    .filter((e) => e.event.type === 'session.updated')
    .map((e) => (e.event as { session: Record<string, unknown> }).session);

const sdkInfo = (over: Record<string, unknown>) =>
  ({ sessionId: 'h1', summary: 'auto', lastModified: 1, ...over }) as unknown as Awaited<
    ReturnType<typeof listSessions>
  >[number];

describe('SessionManager · meta 出口统一（B3）', () => {
  test('#onMeta 增量合并：title / firstPrompt / gitBranch / createdAt / lastEvent 不丢，归档标记随广播', () => {
    const f = fakeFlags();
    const { manager, events, created } = makeHarness({ flags: f.flags });
    manager.acquire({
      sessionId: 's1',
      ...base,
      resume: true,
      seed: { title: '部署脚本', firstPrompt: 'hi', gitBranch: 'main', createdAt: 5 },
    });
    f.archived.set('s1', 42);
    transition(created[0]!, 'stopped');
    const last = updatedOf(events).at(-1)!;
    expect(last).toMatchObject({
      sessionId: 's1',
      title: '部署脚本',
      firstPrompt: 'hi',
      gitBranch: 'main',
      createdAt: 5,
      state: 'stopped',
      archived: true,
      archivedAt: 42,
    });
    expect(manager.metaOf('s1')).toMatchObject({ title: '部署脚本', archived: true });
  });

  test('回归：resume 历史会话后第一次状态迁移不再把标题广播成空', () => {
    const { manager, events, created } = makeHarness();
    manager.acquire({ sessionId: 's1', ...base, resume: true, seed: { title: '已改名' } });
    transition(created[0]!, 'running');
    expect(updatedOf(events).at(-1)!.title).toBe('已改名');
  });

  test('acquire 没给 seed：保留已有 meta 的非运行时字段（release 后再 resume）', async () => {
    const { manager } = makeHarness();
    manager.acquire({ sessionId: 's1', ...base, resume: true, seed: { title: 'T', firstPrompt: 'p' } });
    await manager.release('s1');
    manager.acquire({ sessionId: 's1', ...base, resume: true });
    expect(manager.metaOf('s1')).toMatchObject({ title: 'T', firstPrompt: 'p' });
    // seed 的空标题不覆盖已有值
    await manager.release('s1');
    manager.acquire({ sessionId: 's1', ...base, resume: true, seed: { title: '' } });
    expect(manager.metaOf('s1')!.title).toBe('T');
  });

  test('decorate：archived 只认 flags（入参里的丢弃），pendingTitle 覆盖 title', () => {
    const f = fakeFlags();
    const { manager } = makeHarness({ flags: f.flags });
    const meta = {
      sessionId: 'x',
      title: 'firstPrompt 摘要',
      state: 'idle' as const,
      lastActivityAt: 1,
      cwd: '/',
      model: '',
      permissionMode: 'default' as const,
      costUsd: 0,
      archived: true,
      archivedAt: 1,
    };
    const plain = manager.decorate(meta);
    expect(plain.archived).toBeUndefined();
    expect(plain.archivedAt).toBeUndefined();
    f.pending.set('x', '用户起的名');
    f.archived.set('x', 9);
    expect(manager.decorate(meta)).toMatchObject({ title: '用户起的名', archived: true, archivedAt: 9 });
  });

  test('session.created 广播也经 decorate', () => {
    const f = fakeFlags();
    const { manager, events } = makeHarness({ flags: f.flags });
    f.pending.set('s1', 'pre');
    manager.acquire({ sessionId: 's1', ...base });
    const created = events.find((e) => e.event.type === 'session.created')!.event as {
      session: { title: string };
    };
    expect(created.session.title).toBe('pre');
  });

  test('list：映射 createdAt / gitBranch / firstPrompt，lastEvent 语义不变；合并归档；过滤墓碑', async () => {
    const f = fakeFlags();
    const { manager } = makeHarness({
      flags: f.flags,
      sessions: [
        sdkInfo({ sessionId: 'h1', firstPrompt: 'fp', gitBranch: 'dev', createdAt: 3, customTitle: 'C' }),
        sdkInfo({ sessionId: 'gone', lastModified: 2 }),
      ],
    });
    manager.acquire({ sessionId: 'fresh', ...base });
    f.archived.set('h1', 7);
    f.deleted.add('gone');
    const list = await manager.list();
    expect(list.map((s) => s.sessionId).sort()).toEqual(['fresh', 'h1']);
    expect(list.find((s) => s.sessionId === 'h1')).toMatchObject({
      title: 'C',
      firstPrompt: 'fp',
      lastEvent: 'fp',
      gitBranch: 'dev',
      createdAt: 3,
      archived: true,
      archivedAt: 7,
    });
    // 墓碑同样挡住 #meta 里的残留（第二个循环）
    f.deleted.add('fresh');
    expect((await manager.list()).map((s) => s.sessionId)).toEqual(['h1']);
  });

  test('updateMeta 只改已有条目；forget 有活跃实例时拒绝', async () => {
    const { manager } = makeHarness();
    expect(manager.updateMeta('nope', { title: 'x' })).toBeUndefined();
    expect(manager.metaOf('nope')).toBeUndefined();
    manager.acquire({ sessionId: 's1', ...base });
    expect(manager.updateMeta('s1', { title: '新名' })!.title).toBe('新名');
    expect(() => manager.forget('s1')).toThrow();
    await manager.release('s1');
    manager.forget('s1');
    expect(manager.metaOf('s1')).toBeUndefined();
    expect(await manager.list()).toEqual([]);
  });

  test('snapshot：缓存优先，否则走 getSessionInfo 映射', async () => {
    const { manager } = makeHarness({ sessions: [sdkInfo({ sessionId: 'h1', customTitle: 'X', cwd: '/p' })] });
    expect(await manager.snapshot('h1')).toMatchObject({ sessionId: 'h1', title: 'X', cwd: '/p', state: 'idle' });
    expect(await manager.snapshot('none')).toBeUndefined();
  });

  test('已删除会话的迟到 onMeta 不写回缓存、不广播', async () => {
    const f = fakeFlags();
    const { manager, events, created } = makeHarness({ flags: f.flags });
    manager.acquire({ sessionId: 's1', ...base });
    await manager.release('s1');
    manager.forget('s1');
    f.deleted.add('s1');
    const before = events.length;
    transition(created[0]!, 'stopped');
    expect(events.length).toBe(before);
    expect(manager.metaOf('s1')).toBeUndefined();
  });
});

describe('SessionManager · 自动取消归档（M1）与 onRunEnd', () => {
  test('进入 running 时清归档标记，并在同一次 updated 里体现；其他状态迁移不清', () => {
    const f = fakeFlags();
    const { manager, events, created } = makeHarness({ flags: f.flags });
    manager.acquire({ sessionId: 's1', ...base, resume: true });
    f.archived.set('s1', 1);
    transition(created[0]!, 'stopped');
    expect(f.archived.has('s1')).toBe(true);
    expect(updatedOf(events).at(-1)!.archived).toBe(true);
    transition(created[0]!, 'running');
    expect(f.archived.has('s1')).toBe(false);
    expect(updatedOf(events).at(-1)!.archived).toBeUndefined();
  });

  test('onRunEnd：running / waiting_permission → 其他状态时触发一次', () => {
    const ended: string[] = [];
    const { manager, created } = makeHarness({ onRunEnd: (sid) => ended.push(sid) });
    manager.acquire({ sessionId: 's1', ...base });
    const s = created[0]!;
    transition(s, 'running');
    transition(s, 'waiting_permission');
    expect(ended).toEqual([]);
    transition(s, 'idle');
    expect(ended).toEqual(['s1']);
    transition(s, 'stopped');
    expect(ended).toEqual(['s1']);
  });
});

describe('SessionManager · waitingFor 与权限模式变化（exit-plan-mode）', () => {
  /** 带任意运行时字段回调 onMeta（模拟真会话的 meta()） */
  function emitMeta(fake: FakeSession, over: Record<string, unknown>): void {
    fake.args.onMeta?.({
      sessionId: fake.sessionId,
      state: 'running',
      costUsd: 0,
      lastActivityAt: 0,
      cwd: fake.args.cwd,
      model: fake.args.model,
      permissionMode: fake.args.permissionMode,
      ...over,
    } as never);
  }

  test('等待态广播带 waitingFor；离开等待态后缓存与广播都不再带', () => {
    const { manager, events, created } = makeHarness();
    manager.acquire({ sessionId: 's1', ...base });
    emitMeta(created[0]!, { state: 'waiting_permission', waitingFor: 'plan' });
    expect(updatedOf(events).at(-1)).toMatchObject({ state: 'waiting_permission', waitingFor: 'plan' });
    expect(manager.metaOf('s1')!.waitingFor).toBe('plan');

    emitMeta(created[0]!, { state: 'running' });
    expect(updatedOf(events).at(-1)).not.toHaveProperty('waitingFor');
    expect(manager.metaOf('s1')).not.toHaveProperty('waitingFor');
  });

  test('list 出口也带等待态的 waitingFor', async () => {
    const { manager, created } = makeHarness({ sessions: [sdkInfo({ sessionId: 's1', cwd: '/w' })] });
    manager.acquire({ sessionId: 's1', ...base, resume: true });
    created[0]!.state = 'waiting_permission';
    emitMeta(created[0]!, { state: 'waiting_permission', waitingFor: 'question' });
    const [row] = await manager.list();
    expect(row).toMatchObject({ sessionId: 's1', state: 'waiting_permission', waitingFor: 'question' });
  });

  test('权限模式变化回调 onPermissionModeChange（同值不回调）', () => {
    const changes: Array<[string, string]> = [];
    const events: OutboundEvent[] = [];
    const emitter = new EventEmitter({ sink: (out) => events.push(out), now: () => 0 });
    const fakes: FakeSession[] = [];
    const manager = new SessionManager({
      emitter,
      now: () => 0,
      listSessionsFn: (async () => []) as never,
      getSessionInfoFn: (async () => undefined) as never,
      renameSessionFn: (async () => {}) as never,
      deleteSessionFn: (async () => {}) as never,
      onPermissionModeChange: (sid, mode) => changes.push([sid, mode]),
      createSession: (args: CreateSessionArgs) => {
        const fake = { args, sessionId: args.sessionId, state: 'idle', close: () => Promise.resolve() };
        fakes.push(fake as unknown as FakeSession);
        return fake as unknown as ClaudeSession;
      },
    });
    manager.acquire({ sessionId: 's1', ...base, permissionMode: 'plan' });
    emitMeta(fakes[0]!, { permissionMode: 'plan' });
    expect(changes).toEqual([]);
    emitMeta(fakes[0]!, { permissionMode: 'default' });
    expect(changes).toEqual([['s1', 'default']]);
    expect(updatedOf(events).at(-1)!.permissionMode).toBe('default');
  });
});

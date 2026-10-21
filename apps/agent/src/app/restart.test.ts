/**
 * restart：协调器（预检 → 排空 → 退出）、标记文件、预检命令、git HEAD 读取。
 * 定时器与子进程一律注入假实现——绝不在测试里真跑 bun install / 真退出进程。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnedProcess, SpawnFn } from './claude-cli.ts';
import {
  findUp,
  readGitHead,
  restartAvailability,
  RESTART_MARKER_MAX_AGE_MS,
  RestartCoordinator,
  runPrecheck,
  SELFCHECK_PREFIX,
  takeRestartMarker,
  writeRestartMarker,
  type PrecheckResult,
  type RestartCoordinatorOptions,
  type RestartMarker,
  type RestartNotice,
} from './restart.ts';

/** 手动推进的假定时器 */
class FakeTimers {
  #next = 1;
  readonly pending = new Map<number, { fn: () => void; at: number }>();
  now = 1_000_000;

  set = (fn: () => void, ms: number): unknown => {
    const id = this.#next++;
    this.pending.set(id, { fn, at: this.now + ms });
    return id;
  };
  clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };
  /** 前进 ms，按时间顺序触发到期的定时器（含触发过程中新挂的） */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let due: [number, { fn: () => void; at: number }] | undefined;
      for (const entry of this.pending) {
        if (entry[1].at <= target && (due === undefined || entry[1].at < due[1].at)) due = entry;
      }
      if (due === undefined) break;
      this.pending.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].fn();
    }
    this.now = target;
  }
}

function setup(overrides: Partial<RestartCoordinatorOptions> = {}) {
  const timers = new FakeTimers();
  let busy = 0;
  const exits: RestartMarker[] = [];
  const cancelled: { notices: readonly RestartNotice[]; reason: string }[] = [];
  let changes = 0;
  let precheck: () => Promise<PrecheckResult> = async () => ({ ok: true, version: '9.9.9' });
  const coordinator = new RestartCoordinator({
    availability: { available: true },
    precheck: () => precheck(),
    busySessions: () => busy,
    exit: (marker) => {
      exits.push(marker);
    },
    onChange: () => {
      changes++;
    },
    onCancelled: (notices, reason) => cancelled.push({ notices, reason }),
    fromVersion: '0.18.0',
    fromRevision: 'abc1234',
    now: () => timers.now,
    setTimer: timers.set,
    clearTimer: timers.clear,
    pollMs: 1_000,
    drainTimeoutMs: 60_000,
    ...overrides,
  });
  return {
    coordinator,
    timers,
    exits,
    cancelled,
    changes: () => changes,
    setBusy: (n: number) => {
      busy = n;
    },
    setPrecheck: (fn: () => Promise<PrecheckResult>) => {
      precheck = fn;
    },
  };
}

/** 让 #exit 里的 await 走完 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('RestartCoordinator', () => {
  test('没有 supervisor：拒绝，不预检', async () => {
    let checked = false;
    const { coordinator } = setup({
      availability: { available: false, reason: '没人拉起' },
      precheck: async () => {
        checked = true;
        return { ok: true, version: 'x' };
      },
    });
    expect(await coordinator.request({ mode: 'when_idle' })).toEqual({ ok: false, code: 'unavailable', message: '没人拉起' });
    expect(checked).toBe(false);
    expect(coordinator.pending()).toBeUndefined();
  });

  test('预检不通过：不重启，回到空闲，带输出尾部', async () => {
    const t = setup();
    t.setPrecheck(async () => ({ ok: false, message: 'bun install 失败', output: 'lockfile mismatch' }));
    const outcome = await t.coordinator.request({ mode: 'when_idle' });
    expect(outcome).toEqual({ ok: false, code: 'check_failed', message: 'bun install 失败', output: 'lockfile mismatch' });
    expect(t.coordinator.pending()).toBeUndefined();
    t.timers.advance(10_000);
    expect(t.exits).toHaveLength(0);
  });

  test('排空：发起会话本轮结束（忙碌归零）后才退出，标记带通知', async () => {
    const t = setup();
    t.setBusy(2);
    const notice = { sessionId: 's1', continuePrompt: '核实一下' };
    const outcome = await t.coordinator.request({ mode: 'when_idle', notice });
    expect(outcome).toEqual({ ok: true, phase: 'draining', toVersion: '9.9.9' });
    expect(t.coordinator.pending()).toMatchObject({ phase: 'draining', busySessions: 2, deadline: t.timers.now + 60_000 });

    t.timers.advance(5_000);
    expect(t.exits).toHaveLength(0);
    t.setBusy(1);
    t.timers.advance(1_000);
    expect(t.coordinator.pending()?.busySessions).toBe(1);
    t.setBusy(0);
    t.timers.advance(1_000);
    await flush();
    expect(t.exits).toEqual([
      { v: 1, requestedAt: 1_000_000, fromVersion: '0.18.0', fromRevision: 'abc1234', notices: [notice] },
    ]);
    // 退出中：不再算「进行中的重启」；再来的请求（通知存不进标记了）明确拒绝
    expect(t.coordinator.pending()).toBeUndefined();
    expect(t.coordinator.exiting).toBe(true);
    expect(await t.coordinator.request({ mode: 'when_idle', notice: { sessionId: 's2' } })).toMatchObject({
      ok: false,
      code: 'busy',
    });
  });

  test('全都空闲也不同步退出：应答要先发出去', async () => {
    const t = setup();
    await t.coordinator.request({ mode: 'when_idle' });
    expect(t.exits).toHaveLength(0);
    t.timers.advance(0);
    await flush();
    expect(t.exits).toHaveLength(1);
  });

  test('now：预检通过即退出，不等忙碌会话', async () => {
    const t = setup();
    t.setBusy(3);
    expect(await t.coordinator.request({ mode: 'now' })).toEqual({ ok: true, phase: 'restarting', toVersion: '9.9.9' });
    t.timers.advance(0);
    await flush();
    expect(t.exits).toHaveLength(1);
  });

  test('排空中再来 now：立即退出；再来 when_idle：合并通知', async () => {
    const t = setup();
    t.setBusy(1);
    await t.coordinator.request({ mode: 'when_idle', notice: { sessionId: 'a' } });
    expect(await t.coordinator.request({ mode: 'when_idle', notice: { sessionId: 'b', note: 'n' } })).toMatchObject({
      ok: true,
      phase: 'draining',
    });
    expect(await t.coordinator.request({ mode: 'now', notice: { sessionId: 'a', note: '新的' } })).toMatchObject({
      ok: true,
      phase: 'restarting',
    });
    t.timers.advance(0);
    await flush();
    expect(t.exits[0]!.notices).toEqual([
      { sessionId: 'a', note: '新的' },
      { sessionId: 'b', note: 'n' },
    ]);
  });

  test('预检中被拒的 now 不改变原请求：预检后照常排空', async () => {
    const t = setup();
    let release!: (r: PrecheckResult) => void;
    t.setPrecheck(() => new Promise((r) => (release = r)));
    t.setBusy(1);
    const first = t.coordinator.request({ mode: 'when_idle' });
    expect(await t.coordinator.request({ mode: 'now' })).toMatchObject({ ok: false, code: 'busy' });
    release({ ok: true, version: '1' });
    expect(await first).toMatchObject({ ok: true, phase: 'draining' });
    t.timers.advance(5_000);
    await flush();
    expect(t.exits).toHaveLength(0);
  });

  test('预检中再来请求：busy，不起第二次预检；预检中取消：预检后不重启', async () => {
    const t = setup();
    let release!: (r: PrecheckResult) => void;
    let calls = 0;
    t.setPrecheck(() => {
      calls++;
      return new Promise((r) => (release = r));
    });
    const first = t.coordinator.request({ mode: 'when_idle' });
    expect(t.coordinator.pending()).toMatchObject({ phase: 'checking' });
    expect(await t.coordinator.request({ mode: 'when_idle' })).toMatchObject({ ok: false, code: 'busy' });
    expect(calls).toBe(1);
    // 被拒的 now 不能悄悄把上一次请求升级成立即重启
    expect(await t.coordinator.request({ mode: 'now' })).toMatchObject({ ok: false, code: 'busy' });
    expect(t.coordinator.cancel()).toEqual({ ok: true, phase: 'cancelled' });
    release({ ok: true, version: '1' });
    expect(await first).toEqual({ ok: true, phase: 'cancelled' });
    expect(t.coordinator.pending()).toBeUndefined();
    t.timers.advance(10_000);
    expect(t.exits).toHaveLength(0);
  });

  test('排空中取消：通知等着的会话，不退出', async () => {
    const t = setup();
    t.setBusy(1);
    await t.coordinator.request({ mode: 'when_idle', notice: { sessionId: 's1' } });
    expect(t.coordinator.cancel('用户取消')).toEqual({ ok: true, phase: 'cancelled' });
    expect(t.cancelled).toEqual([{ notices: [{ sessionId: 's1' }], reason: '用户取消' }]);
    t.setBusy(0);
    t.timers.advance(10_000);
    expect(t.exits).toHaveLength(0);
    expect(t.coordinator.cancel()).toMatchObject({ ok: false, code: 'not_pending' });
  });

  test('排空超时：自动取消', async () => {
    const t = setup();
    t.setBusy(1);
    await t.coordinator.request({ mode: 'when_idle', notice: { sessionId: 's1' } });
    t.timers.advance(61_000);
    expect(t.exits).toHaveLength(0);
    expect(t.cancelled).toHaveLength(1);
    expect(t.cancelled[0]!.reason).toContain('超过 1 分钟');
    expect(t.coordinator.pending()).toBeUndefined();
  });

  test('退出失败：回到空闲并通知', async () => {
    const t = setup({
      exit: () => {
        throw new Error('写不了标记');
      },
    });
    await t.coordinator.request({ mode: 'when_idle', notice: { sessionId: 's1' } });
    t.timers.advance(0);
    await flush();
    expect(t.cancelled).toEqual([{ notices: [{ sessionId: 's1' }], reason: '退出失败：写不了标记' }]);
    expect(t.coordinator.pending()).toBeUndefined();
  });

  test('状态变化都会通知（广播 machine.info 用）', async () => {
    const t = setup();
    t.setBusy(1);
    await t.coordinator.request({ mode: 'when_idle' });
    // checking + draining
    expect(t.changes()).toBe(2);
    t.coordinator.cancel();
    expect(t.changes()).toBe(3);
  });
});

describe('restartAvailability', () => {
  test('systemd（INVOCATION_ID）或 TRINE_SUPERVISED=1 才可用', () => {
    expect(restartAvailability({ INVOCATION_ID: 'abc' })).toEqual({ available: true });
    expect(restartAvailability({ TRINE_SUPERVISED: '1' })).toEqual({ available: true });
    expect(restartAvailability({ INVOCATION_ID: 'abc', TRINE_SUPERVISED: '0' }).available).toBe(false);
    expect(restartAvailability({}).available).toBe(false);
    expect(restartAvailability({}).reason).toContain('supervisor');
  });
});

describe('标记文件', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trine-restart-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const marker: RestartMarker = { v: 1, requestedAt: 5_000, fromVersion: '0.18.0', notices: [{ sessionId: 's1' }] };

  test('写入 0600，读出后删除', async () => {
    const path = join(dir, 'restart.json');
    await writeRestartMarker(path, marker);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await takeRestartMarker(path, 6_000)).toEqual(marker);
    expect(await takeRestartMarker(path, 6_000)).toBeUndefined();
  });

  test('过期 / 坏文件：忽略并删除', async () => {
    const path = join(dir, 'restart.json');
    await writeRestartMarker(path, marker);
    expect(await takeRestartMarker(path, 5_000 + RESTART_MARKER_MAX_AGE_MS + 1)).toBeUndefined();
    writeFileSync(path, '{not json');
    expect(await takeRestartMarker(path, 6_000)).toBeUndefined();
    expect(() => statSync(path)).toThrow();
  });
});

describe('runPrecheck', () => {
  function proc(code: number, out: string): SpawnedProcess {
    return {
      stdout: new Response(out).body!,
      stderr: new Response('').body!,
      exited: Promise.resolve(code),
      kill: () => {},
    };
  }

  test('install → selfcheck，取新版本号', async () => {
    const calls: { cmd: string[]; cwd: string | undefined }[] = [];
    const spawn: SpawnFn = (cmd, { cwd }) => {
      calls.push({ cmd, cwd });
      return cmd.includes('selfcheck') ? proc(0, `${SELFCHECK_PREFIX}0.19.0\n`) : proc(0, 'ok');
    };
    const result = await runPrecheck({ entry: '/repo/apps/agent/src/cli.ts', execPath: '/bin/bun', repoRoot: '/repo', spawn, env: {} });
    expect(result).toEqual({ ok: true, version: '0.19.0' });
    expect(calls).toEqual([
      { cmd: ['/bin/bun', 'install', '--frozen-lockfile'], cwd: '/repo' },
      { cmd: ['/bin/bun', 'run', '/repo/apps/agent/src/cli.ts', 'selfcheck'], cwd: '/repo/apps/agent' },
    ]);
  });

  test('install 失败就停，不跑 selfcheck', async () => {
    let selfcheck = false;
    const spawn: SpawnFn = (cmd) => {
      if (cmd.includes('selfcheck')) selfcheck = true;
      return proc(1, 'error: lockfile had changes');
    };
    const result = await runPrecheck({ entry: '/r/a/src/cli.ts', execPath: 'bun', repoRoot: '/r', spawn, env: {} });
    expect(result).toMatchObject({ ok: false, message: 'bun install --frozen-lockfile 失败（退出码 1）' });
    expect(result.ok === false && result.output).toContain('lockfile had changes');
    expect(selfcheck).toBe(false);
  });

  test('没有仓库根：跳过 install；selfcheck 加载失败报错', async () => {
    const cmds: string[][] = [];
    const spawn: SpawnFn = (cmd) => {
      cmds.push(cmd);
      return proc(1, "SyntaxError: Export named 'x' not found");
    };
    const result = await runPrecheck({ entry: '/a/src/cli.ts', execPath: 'bun', spawn, env: {} });
    expect(cmds).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, message: '工作区代码加载（selfcheck） 失败（退出码 1）' });
  });

  test('selfcheck 没报版本（旧代码不认识这个子命令）', async () => {
    const spawn: SpawnFn = () => proc(0, 'something else');
    expect(await runPrecheck({ entry: '/a/src/cli.ts', execPath: 'bun', spawn, env: {} })).toMatchObject({ ok: false });
  });
});

describe('readGitHead', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trine-git-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const sha = 'f46648e0123456789abcdef0123456789abcdef0';
  const sha2 = '0537b88aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  test('loose ref / packed-refs / detached', () => {
    mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), `${sha}\n`);
    expect(readGitHead(dir)).toBe('f46648e');

    rmSync(join(dir, '.git', 'refs', 'heads', 'main'));
    writeFileSync(join(dir, '.git', 'packed-refs'), `# pack-refs with: peeled\n${sha2} refs/heads/main\n`);
    expect(readGitHead(dir)).toBe('0537b88');

    writeFileSync(join(dir, '.git', 'HEAD'), `${sha}\n`);
    expect(readGitHead(dir)).toBe('f46648e');
  });

  test('worktree：.git 是文件，分支 ref 在主仓库（commondir）', () => {
    const main = join(dir, 'main');
    const wt = join(dir, 'wt');
    const gitdir = join(main, '.git', 'worktrees', 'wt');
    mkdirSync(join(main, '.git', 'refs', 'heads'), { recursive: true });
    mkdirSync(gitdir, { recursive: true });
    mkdirSync(wt);
    writeFileSync(join(main, '.git', 'refs', 'heads', 'feat'), `${sha2}\n`);
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/feat\n');
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`);
    expect(readGitHead(wt)).toBe('0537b88');
  });

  test('不是 git 工作区 / 坏的 HEAD → undefined', () => {
    expect(readGitHead(dir)).toBeUndefined();
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), 'garbage');
    expect(readGitHead(dir)).toBeUndefined();
  });

  test('findUp', () => {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(join(dir, 'bun.lock'), '');
    expect(findUp(join(dir, 'a', 'b'), 'bun.lock')).toBe(dir);
    expect(readFileSync(join(dir, 'bun.lock'), 'utf8')).toBe('');
  });
});

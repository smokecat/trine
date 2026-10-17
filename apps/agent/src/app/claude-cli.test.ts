/**
 * claude-cli：可执行文件解析、版本探测、输出整理、`claude update` 执行器。
 * 子进程一律注入假实现——绝不在测试里跑真 `claude update`。
 */
import { describe, expect, test } from 'bun:test';
import { CLAUDE_UPDATE_OUTPUT_MAX } from '@trine/core';
import {
  ClaudeExecutableError,
  ClaudeUpdater,
  detectClaudeVersion,
  resolveClaudeExecutable,
  sdkBundledVersion,
  tailOutput,
  type SpawnedProcess,
  type SpawnFn,
} from './claude-cli.ts';

/** 可控的假子进程：stdout/stderr 手动写，exit() 结束 */
class FakeProc implements SpawnedProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly kills: (number | string | undefined)[] = [];
  #out!: ReadableStreamDefaultController<Uint8Array>;
  #err!: ReadableStreamDefaultController<Uint8Array>;
  #resolve!: (code: number) => void;
  /** 收到 SIGTERM 就以 143 退出（模拟正常进程）；false 则装死等 SIGKILL */
  exitOnTerm = true;

  constructor() {
    this.stdout = new ReadableStream({ start: (c) => void (this.#out = c) });
    this.stderr = new ReadableStream({ start: (c) => void (this.#err = c) });
    this.exited = new Promise((r) => (this.#resolve = r));
  }
  out(text: string): void {
    this.#out.enqueue(new TextEncoder().encode(text));
  }
  err(text: string): void {
    this.#err.enqueue(new TextEncoder().encode(text));
  }
  exit(code: number): void {
    try {
      this.#out.close();
      this.#err.close();
    } catch {
      // 已关
    }
    this.#resolve(code);
  }
  kill(signal?: number | NodeJS.Signals): void {
    this.kills.push(signal);
    if (signal === 'SIGKILL' || this.exitOnTerm) this.exit(143);
  }
}

/** 按命令分派的假 spawn：`--version` 回 versions 队列的下一个，`update` 交给 onUpdate */
function fakeSpawn(options: {
  versions: string[];
  onUpdate?: (proc: FakeProc) => void;
  throwOnUpdate?: boolean;
}) {
  const calls: { cmd: string[]; env: Record<string, string | undefined> }[] = [];
  const updates: FakeProc[] = [];
  const spawn: SpawnFn = (cmd, { env }) => {
    calls.push({ cmd, env });
    const proc = new FakeProc();
    if (cmd[1] === '--version') {
      const v = options.versions.shift() ?? '';
      queueMicrotask(() => {
        proc.out(`${v}\n`);
        proc.exit(v === '' ? 1 : 0);
      });
    } else {
      if (options.throwOnUpdate) throw new Error('ENOENT');
      updates.push(proc);
      options.onUpdate?.(proc);
    }
    return proc;
  };
  return { spawn, calls, updates };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await Bun.sleep(1);
  }
};

describe('resolveClaudeExecutable', () => {
  test('显式覆盖 > PATH > SDK 内置', () => {
    const which = (cmd: string) => (cmd === 'claude' ? '/usr/bin/claude' : cmd === '/opt/claude' ? '/opt/claude' : null);
    expect(resolveClaudeExecutable('/opt/claude', which)).toEqual({ path: '/opt/claude', source: 'override' });
    expect(resolveClaudeExecutable(undefined, which)).toEqual({ path: '/usr/bin/claude', source: 'path' });
    expect(resolveClaudeExecutable(undefined, () => null)).toEqual({ path: undefined, source: 'sdk' });
  });

  test('显式覆盖指向不可执行的文件 → 抛错（不静默回退）', () => {
    expect(() => resolveClaudeExecutable('/nope/claude', () => null)).toThrow(ClaudeExecutableError);
  });

  test('不做 realpath：原样保留 which 给的软链路径', () => {
    // 原生安装的 ~/.local/bin/claude 是软链，update 换目标；解析成真实路径会钉死旧版
    expect(resolveClaudeExecutable(undefined, () => '/home/u/.local/bin/claude').path).toBe(
      '/home/u/.local/bin/claude',
    );
  });
});

describe('detectClaudeVersion', () => {
  test('探测给定路径，取首行', async () => {
    const { spawn, calls } = fakeSpawn({ versions: ['2.1.282 (Claude Code)'] });
    expect(await detectClaudeVersion('/x/claude', { spawn })).toBe('2.1.282 (Claude Code)');
    expect(calls[0]!.cmd).toEqual(['/x/claude', '--version']);
  });

  test('非零退出 / 起不来 → unknown', async () => {
    expect(await detectClaudeVersion('/x/claude', { spawn: fakeSpawn({ versions: [''] }).spawn })).toBe('unknown');
    const throwing: SpawnFn = () => {
      throw new Error('ENOENT');
    };
    expect(await detectClaudeVersion('/x/claude', { spawn: throwing })).toBe('unknown');
  });

  test('路径为 undefined（SDK 内置）→ 报 SDK 自带的版本，不去 spawn', async () => {
    const { spawn, calls } = fakeSpawn({ versions: [] });
    const v = await detectClaudeVersion(undefined, { spawn });
    expect(calls).toHaveLength(0);
    expect(v).toBe(sdkBundledVersion() ?? 'unknown');
    // 仓库里装着 SDK，manifest 读得到
    expect(v).toMatch(/^\d+\.\d+\.\d+ \(SDK 内置\)$/);
  });
});

describe('tailOutput', () => {
  test('去 ANSI、\\r 重绘只留最后一段、CRLF 当普通换行', () => {
    const raw = '\x1b[32mChecking\x1b[0m for updates\r\nDownloading 10%\rDownloading 55%\rDownloading 100%\n\x1b]0;title\x07Done\n';
    expect(tailOutput(raw)).toEqual({ text: 'Checking for updates\nDownloading 100%\nDone', truncated: false });
  });

  test('超长截尾部', () => {
    const raw = `${'a'.repeat(10)}${'b'.repeat(CLAUDE_UPDATE_OUTPUT_MAX)}`;
    const { text, truncated } = tailOutput(raw);
    expect(truncated).toBe(true);
    expect(text).toBe('b'.repeat(CLAUDE_UPDATE_OUTPUT_MAX));
  });
});

describe('ClaudeUpdater', () => {
  test('成功：spawn [path, update]、继承 env、合并 stdout+stderr、跑完重新探测并回调 onVersion', async () => {
    const { spawn, calls } = fakeSpawn({
      versions: ['2.1.251 (Claude Code)', '2.1.282 (Claude Code)'],
      onUpdate: (proc) => {
        queueMicrotask(async () => {
          proc.out('Current version: 2.1.251\n');
          await Bun.sleep(2);
          proc.err('warn: something\n');
          await Bun.sleep(2);
          proc.out('Successfully updated to 2.1.282\n');
          proc.exit(0);
        });
      },
    });
    const seen: string[] = [];
    const updater = new ClaudeUpdater({
      executable: '/x/claude',
      currentVersion: () => '2.1.251 (Claude Code)',
      onVersion: (v) => seen.push(v),
      spawn,
      env: { https_proxy: 'http://127.0.0.1:10808' },
    });
    const outcome = await updater.run();
    expect(outcome).toEqual({
      ok: true,
      fromVersion: '2.1.251 (Claude Code)',
      toVersion: '2.1.282 (Claude Code)',
      output: 'Current version: 2.1.251\nwarn: something\nSuccessfully updated to 2.1.282',
      outputTruncated: false,
    });
    expect(calls.map((c) => c.cmd)).toEqual([
      ['/x/claude', '--version'],
      ['/x/claude', 'update'],
      ['/x/claude', '--version'],
    ]);
    expect(calls[1]!.env['https_proxy']).toBe('http://127.0.0.1:10808');
    expect(seen).toEqual(['2.1.282 (Claude Code)']);
    expect(updater.running).toBe(false);
  });

  test('默认 env 就是 process.env（代理变量随之继承）', async () => {
    const { spawn, calls } = fakeSpawn({
      versions: ['1', '1'],
      onUpdate: (proc) => queueMicrotask(() => proc.exit(0)),
    });
    await new ClaudeUpdater({ executable: '/x/claude', currentVersion: () => '1', spawn }).run();
    expect(calls[1]!.env).toBe(process.env);
  });

  test('单飞：进行中再来 → 立刻回 busy，不起第二个进程', async () => {
    const { spawn, updates } = fakeSpawn({ versions: ['1.0', '1.1'] });
    const updater = new ClaudeUpdater({ executable: '/x/claude', currentVersion: () => '1.0', spawn });
    const first = updater.run();
    // 同一宏任务内的第二个请求也必须看到进行中
    const second = await updater.run();
    expect(second).toMatchObject({ ok: false, error: { code: 'busy' }, fromVersion: '1.0', toVersion: '1.0' });
    await waitFor(() => updates.length === 1);
    updates[0]!.exit(0);
    expect((await first).ok).toBe(true);
    expect(updates).toHaveLength(1);
    // 结束后可以再来
    expect(updater.running).toBe(false);
  });

  test('没有全局 claude → not_found，不 spawn、不回调', async () => {
    const { spawn, calls } = fakeSpawn({ versions: [] });
    let called = false;
    const outcome = await new ClaudeUpdater({
      executable: undefined,
      currentVersion: () => '2.1.251 (SDK 内置)',
      onVersion: () => (called = true),
      spawn,
    }).run();
    expect(outcome).toMatchObject({
      ok: false,
      fromVersion: '2.1.251 (SDK 内置)',
      toVersion: '2.1.251 (SDK 内置)',
      error: { code: 'not_found' },
    });
    expect(calls).toHaveLength(0);
    expect(called).toBe(false);
  });

  test('非零退出 → failed，附输出尾部；仍重新探测版本', async () => {
    const seen: string[] = [];
    const { spawn } = fakeSpawn({
      versions: ['1.0', '1.0'],
      onUpdate: (proc) =>
        queueMicrotask(() => {
          proc.err('\x1b[31mError: EACCES\x1b[0m\n');
          proc.exit(1);
        }),
    });
    const outcome = await new ClaudeUpdater({
      executable: '/x/claude',
      currentVersion: () => '1.0',
      onVersion: (v) => seen.push(v),
      spawn,
    }).run();
    expect(outcome).toMatchObject({ ok: false, output: 'Error: EACCES', error: { code: 'failed' } });
    expect(outcome.error!.message).toContain('退出码 1');
    expect(seen).toEqual(['1.0']);
  });

  test('起不来 → failed', async () => {
    const { spawn } = fakeSpawn({ versions: ['1.0', '1.0'], throwOnUpdate: true });
    const outcome = await new ClaudeUpdater({ executable: '/x/claude', currentVersion: () => '1.0', spawn }).run();
    expect(outcome).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(outcome.error!.message).toContain('ENOENT');
  });

  test('超时 → SIGTERM 结束，回 timeout（保留已有输出）', async () => {
    const { spawn, updates } = fakeSpawn({
      versions: ['1.0', '1.0'],
      onUpdate: (proc) => queueMicrotask(() => proc.out('Downloading...\n')),
    });
    const outcome = await new ClaudeUpdater({
      executable: '/x/claude',
      currentVersion: () => '1.0',
      spawn,
      timeoutMs: 20,
    }).run();
    expect(updates[0]!.kills).toEqual(['SIGTERM']);
    expect(outcome).toMatchObject({ ok: false, output: 'Downloading...', error: { code: 'timeout' } });
  });

  test('输出超过上限 → 尾部截断并标 outputTruncated', async () => {
    const { spawn } = fakeSpawn({
      versions: ['1.0', '1.1'],
      onUpdate: (proc) =>
        queueMicrotask(() => {
          proc.out(`${'x'.repeat(CLAUDE_UPDATE_OUTPUT_MAX)}\nlast line\n`);
          proc.exit(0);
        }),
    });
    const outcome = await new ClaudeUpdater({ executable: '/x/claude', currentVersion: () => '1.0', spawn }).run();
    expect(outcome.outputTruncated).toBe(true);
    expect(outcome.output).toHaveLength(CLAUDE_UPDATE_OUTPUT_MAX);
    expect(outcome.output.endsWith('\nlast line')).toBe(true);
  });

  test('dispose：杀掉进行中的更新，且不再回调 onVersion', async () => {
    let called = false;
    const { spawn, updates } = fakeSpawn({ versions: ['1.0', '1.0'] });
    const updater = new ClaudeUpdater({
      executable: '/x/claude',
      currentVersion: () => '1.0',
      onVersion: () => (called = true),
      spawn,
    });
    const running = updater.run();
    await waitFor(() => updates.length === 1);
    updater.dispose();
    await running;
    expect(updates[0]!.kills).toEqual(['SIGTERM']);
    expect(called).toBe(false);
  });
});

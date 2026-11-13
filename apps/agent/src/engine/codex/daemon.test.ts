import { describe, expect, test } from 'bun:test';
import type { SpawnFn, SpawnedProcess } from '../../app/claude-cli.ts';
import { lastStatus, restartCodexDaemon } from './daemon.ts';

function stream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

type Reply = { code: number; stdout?: string; stderr?: string } | 'hang' | 'throw';

/** 按子命令回放；记下调用。绝不起真的 codex */
function fakeSpawn(replies: Record<string, Reply>): { spawn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: SpawnFn = (cmd) => {
    calls.push(cmd);
    const reply = replies[cmd.at(-1)!] ?? { code: 2, stderr: 'unknown subcommand' };
    if (reply === 'throw') throw new Error('ENOENT');
    if (reply === 'hang') {
      let resolve!: (code: number) => void;
      const exited = new Promise<number>((r) => (resolve = r));
      let closeOut!: () => void;
      const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (closeOut = () => c.close()) });
      const proc: SpawnedProcess = {
        stdout,
        stderr: stream(''),
        exited,
        kill: () => {
          closeOut();
          resolve(143);
        },
      };
      return proc;
    }
    return { stdout: stream(reply.stdout ?? ''), stderr: stream(reply.stderr ?? ''), exited: Promise.resolve(reply.code), kill: () => {} };
  };
  return { spawn, calls };
}

const RUNNING = '{"status":"running","backend":"pid"}\n';
const RESTARTED = '{"event":"process_spawned"}\n{"stage":"pid_write","outcome":"succeeded"}\n{"status":"restarted","pid":42}\n';

describe('lastStatus', () => {
  test('取最后一个带 status 的 JSON 行；非 JSON 行跳过', () => {
    expect(lastStatus(RESTARTED)).toBe('restarted');
    expect(lastStatus('note\n{"status":"running"}\n{oops\n')).toBe('running');
    expect(lastStatus('plain text')).toBeUndefined();
  });
});

describe('restartCodexDaemon', () => {
  test('在跑就重启', async () => {
    const { spawn, calls } = fakeSpawn({ version: { code: 0, stdout: RUNNING }, restart: { code: 0, stdout: RESTARTED } });
    expect(await restartCodexDaemon('/synthetic/codex', { spawn })).toEqual({ status: 'restarted' });
    expect(calls).toEqual([
      ['/synthetic/codex', 'app-server', 'daemon', 'version'],
      ['/synthetic/codex', 'app-server', 'daemon', 'restart'],
    ]);
  });

  test('没在跑、旧版没有 daemon 子命令、起不来：都不重启', async () => {
    for (const version of [{ code: 0, stdout: '{"status":"stopped"}' }, { code: 2, stderr: 'unrecognized subcommand' }, 'throw'] as const) {
      const { spawn, calls } = fakeSpawn({ version });
      const result = await restartCodexDaemon('/synthetic/codex', { spawn });
      // 起不来按出错处理，其余按没在跑
      expect(result.status).toBe(version === 'throw' ? 'failed' : 'not_running');
      expect(calls.some((c) => c.at(-1) === 'restart')).toBe(false);
    }
  });

  test('重启失败带上 stderr 末行；超时如实说', async () => {
    const failed = fakeSpawn({ version: { code: 0, stdout: RUNNING }, restart: { code: 1, stderr: 'line 1\nlock busy\n' } });
    expect(await restartCodexDaemon('/synthetic/codex', { spawn: failed.spawn })).toEqual({
      status: 'failed',
      message: 'daemon 重启失败（退出码 1）：lock busy',
    });
    const hang = fakeSpawn({ version: { code: 0, stdout: RUNNING }, restart: 'hang' });
    expect(await restartCodexDaemon('/synthetic/codex', { spawn: hang.spawn, restartTimeoutMs: 10 })).toEqual({
      status: 'failed',
      message: 'daemon 重启超时',
    });
  });
});

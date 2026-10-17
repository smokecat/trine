/**
 * 斜杠命令探测：options 对齐、缓存 TTL、同 cwd 单飞、超时、失败不缓存、
 * 成败都关进程。假 queryFn，不起真子进程（真 claude 探测见任务记录的一次性脚本）。
 */
import { describe, expect, test } from 'bun:test';
import type { Options, query, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { CommandsProbe, idleInput } from './commands-probe.ts';

interface FakeCall {
  cwd: string | undefined;
  options: Options;
  prompt: unknown;
  closed: boolean;
  resolve: (commands: SlashCommand[]) => void;
  reject: (err: Error) => void;
}

const cmd = (name: string, description = ''): SlashCommand => ({ name, description, argumentHint: '' });

function makeFakeQuery(auto?: (cwd: string) => SlashCommand[] | Error) {
  const calls: FakeCall[] = [];
  const queryFn = ((params: { prompt: unknown; options?: Options }) => {
    let resolve!: (commands: SlashCommand[]) => void;
    let reject!: (err: Error) => void;
    const pending = new Promise<SlashCommand[]>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const call: FakeCall = {
      cwd: params.options?.cwd,
      options: params.options ?? {},
      prompt: params.prompt,
      closed: false,
      resolve,
      reject,
    };
    calls.push(call);
    if (auto !== undefined) {
      const out = auto(call.cwd ?? '');
      queueMicrotask(() => (out instanceof Error ? reject(out) : resolve(out)));
    }
    return {
      supportedCommands: () => pending,
      close: () => {
        call.closed = true;
      },
    };
  }) as unknown as typeof query;
  return { calls, queryFn };
}

describe('CommandsProbe', () => {
  test('options 与会话对齐：preset 系统提示、三级 settings、cwd、本机 claude、不持久化', async () => {
    const { calls, queryFn } = makeFakeQuery(() => [cmd('babysit-pr', 'Monitor a PR')]);
    const probe = new CommandsProbe({ queryFn, pathToClaudeCodeExecutable: '/usr/local/bin/claude' });
    const out = await probe.commands('/repo');
    expect(out).toEqual([cmd('babysit-pr', 'Monitor a PR')]);
    expect(calls).toHaveLength(1);
    const o = calls[0]!.options;
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(o.settingSources).toEqual(['user', 'project', 'local']);
    expect(o.cwd).toBe('/repo');
    expect(o.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude');
    expect(o.persistSession).toBe(false);
    // 不发任何消息：prompt 是流式输入而非字符串
    expect(typeof calls[0]!.prompt).not.toBe('string');
  });

  test('未指定 claude 路径时不传 pathToClaudeCodeExecutable', async () => {
    const { calls, queryFn } = makeFakeQuery(() => []);
    await new CommandsProbe({ queryFn }).commands('/repo');
    expect('pathToClaudeCodeExecutable' in calls[0]!.options).toBe(false);
  });

  test('成功后关进程：close 被调、abort 触发、输入流结束且一条消息也没 yield', async () => {
    const { calls, queryFn } = makeFakeQuery(() => [cmd('a')]);
    await new CommandsProbe({ queryFn }).commands('/repo');
    const call = calls[0]!;
    expect(call.closed).toBe(true);
    expect(call.options.abortController?.signal.aborted).toBe(true);
    const it = (call.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  test('缓存：TTL 内同 cwd 不再探测，过期重探；不同 cwd 各自探测', async () => {
    let clock = 0;
    const { calls, queryFn } = makeFakeQuery((cwd) => [cmd(cwd)]);
    const probe = new CommandsProbe({ queryFn, ttlMs: 1_000, now: () => clock });
    await probe.commands('/a');
    clock = 999;
    expect(await probe.commands('/a')).toEqual([cmd('/a')]);
    expect(calls).toHaveLength(1);
    await probe.commands('/b');
    expect(calls).toHaveLength(2);
    clock = 1_000;
    await probe.commands('/a');
    expect(calls).toHaveLength(3);
  });

  test('单飞：同 cwd 并发请求共用一个 promise、只起一个 query', async () => {
    const { calls, queryFn } = makeFakeQuery();
    const probe = new CommandsProbe({ queryFn });
    const p1 = probe.commands('/repo');
    const p2 = probe.commands('/repo');
    expect(p1).toBe(p2);
    expect(calls).toHaveLength(1);
    calls[0]!.resolve([cmd('x')]);
    expect(await p1).toEqual([cmd('x')]);
    expect(await p2).toEqual([cmd('x')]);
  });

  test('失败不缓存、也关进程；下次请求重新探测', async () => {
    let fail = true;
    const { calls, queryFn } = makeFakeQuery(() => (fail ? new Error('boom') : [cmd('ok')]));
    const logs: string[] = [];
    const probe = new CommandsProbe({ queryFn, log: (l) => logs.push(l) });
    await expect(probe.commands('/repo')).rejects.toThrow('boom');
    expect(calls[0]!.closed).toBe(true);
    expect(calls[0]!.options.abortController?.signal.aborted).toBe(true);
    expect(logs.some((l) => l.includes('boom'))).toBe(true);
    fail = false;
    expect(await probe.commands('/repo')).toEqual([cmd('ok')]);
    expect(calls).toHaveLength(2);
  });

  test('超时：reject、关进程、不缓存', async () => {
    const { calls, queryFn } = makeFakeQuery();
    const probe = new CommandsProbe({ queryFn, timeoutMs: 20 });
    await expect(probe.commands('/repo')).rejects.toThrow('超时');
    expect(calls[0]!.closed).toBe(true);
    expect(calls[0]!.options.abortController?.signal.aborted).toBe(true);
    // 迟到的结果不影响：下次仍重探
    calls[0]!.resolve([cmd('late')]);
    const next = probe.commands('/repo');
    expect(calls).toHaveLength(2);
    calls[1]!.resolve([cmd('fresh')]);
    expect(await next).toEqual([cmd('fresh')]);
  });

  test('dispose：abort 在跑的探测', async () => {
    const { calls, queryFn } = makeFakeQuery();
    const probe = new CommandsProbe({ queryFn });
    const p = probe.commands('/repo');
    probe.dispose();
    expect(calls[0]!.options.abortController?.signal.aborted).toBe(true);
    calls[0]!.reject(new Error('aborted'));
    await expect(p).rejects.toThrow('aborted');
    expect(calls[0]!.closed).toBe(true);
  });
});

describe('idleInput', () => {
  test('abort 前 next() 一直挂起，abort 后正常结束', async () => {
    const abort = new AbortController();
    const it = idleInput(abort.signal)[Symbol.asyncIterator]();
    let settled = false;
    const next = it.next().then((r) => {
      settled = true;
      return r;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    abort.abort();
    expect(await next).toEqual({ value: undefined, done: true });
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });
});

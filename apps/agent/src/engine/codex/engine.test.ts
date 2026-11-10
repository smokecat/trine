import { describe, expect, test } from 'bun:test';
import { HistoryItemSchema, MachineInfoSchema, SessionMetaSchema } from '@trine/core';
import { buildMachineInfo } from '../../app/machine-info.ts';
import { AppServerClient, AppServerError } from './app-server.ts';
import { CodexEngine, modelFromList, rateWindows, threadToMeta } from './engine.ts';
import { FakeAppServer, fakeThread, rpcError } from './fake-app-server.ts';
import { codexItemsToHistory, codexItemToHistory, collabAgentState, unwrapShellCommand } from './history.ts';

function engine(routes: ConstructorParameters<typeof FakeAppServer>[0], now: () => number = () => 1_000_000) {
  const server = new FakeAppServer(routes);
  let changes = 0;
  const codex = new CodexEngine({
    spawn: server.spawn,
    clientOptions: { idleMs: 60_000 },
    now,
    onChange: () => (changes += 1),
  });
  return { server, codex, changes: () => changes };
}

describe('AppServerClient', () => {
  test('惰性启动：第一次 call 才握手，只握手一次', async () => {
    const server = new FakeAppServer({ ping: () => 'pong' });
    const client = new AppServerClient({ spawn: server.spawn, clientVersion: '1.2.3', idleMs: 60_000 });
    expect(server.spawnCount).toBe(0);
    expect(await client.call('ping', {})).toBe('pong');
    expect(await client.call('ping', {})).toBe('pong');
    expect(server.spawnCount).toBe(1);
    expect(server.calls.filter((c) => c.method === 'initialize')).toHaveLength(1);
    expect(server.sent).toContainEqual({ method: 'initialized' });
    expect(client.userAgent).toContain('9.9.9');
    client.dispose();
  });

  test('不开 experimentalApi：只用稳定接口', async () => {
    const server = new FakeAppServer({});
    const client = new AppServerClient({ spawn: server.spawn, clientVersion: '0', idleMs: 60_000 });
    await client.call('x', {}).catch(() => {});
    const init = server.calls.find((c) => c.method === 'initialize')!.params as Record<string, unknown>;
    expect(init['capabilities']).toBeUndefined();
    client.dispose();
  });

  test('JSON-RPC 错误带错误码', async () => {
    const server = new FakeAppServer({
      bad: () => {
        throw rpcError(-32600, 'nope');
      },
    });
    const client = new AppServerClient({ spawn: server.spawn, clientVersion: '0', idleMs: 60_000 });
    const err = await client.call('bad', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppServerError);
    expect((err as AppServerError).code).toBe(-32600);
    client.dispose();
  });

  test('进程退出：挂起的请求被拒绝，下次 call 重新拉起', async () => {
    const server = new FakeAppServer({ ping: () => 'pong' });
    const client = new AppServerClient({ spawn: server.spawn, clientVersion: '0', idleMs: 60_000 });
    await client.call('ping', {});
    server.routes['hang'] = () => {
      throw rpcError(0, 'unused');
    };
    server.handlers!.onExit();
    expect(client.running).toBe(false);
    expect(await client.call('ping', {})).toBe('pong');
    expect(server.spawnCount).toBe(2);
    client.dispose();
  });

  test('启动失败后一段时间内不重试', async () => {
    let clock = 0;
    let spawns = 0;
    const client = new AppServerClient({
      spawn: () => {
        spawns += 1;
        throw new Error('boom');
      },
      clientVersion: '0',
      now: () => clock,
      startRetryMs: 1000,
    });
    await expect(client.call('x', {})).rejects.toThrow('boom');
    await expect(client.call('x', {})).rejects.toThrow('boom');
    expect(spawns).toBe(1);
    clock = 1000;
    await expect(client.call('x', {})).rejects.toThrow('boom');
    expect(spawns).toBe(2);
    client.dispose();
  });

  test('服务端发来的请求没人处理：明确拒绝，不让对端干等', async () => {
    const server = new FakeAppServer({ ping: () => 'pong' });
    const client = new AppServerClient({ spawn: server.spawn, clientVersion: '0', idleMs: 60_000 });
    await client.call('ping', {});
    server.handlers!.onLine(JSON.stringify({ id: 99, method: 'item/commandExecution/requestApproval', params: {} }));
    expect(server.sent).toContainEqual({ id: 99, error: { code: -32601, message: 'not supported by this client' } });
    client.dispose();
  });

  test('畸形行被忽略，不影响后续请求', async () => {
    const server = new FakeAppServer({ ping: () => 'pong' });
    const client = new AppServerClient({ spawn: server.spawn, clientVersion: '0', idleMs: 60_000 });
    await client.call('ping', {});
    server.handlers!.onLine('not json');
    expect(await client.call('ping', {})).toBe('pong');
    client.dispose();
  });

  test('空闲退出后下次 call 重新拉起', async () => {
    const server = new FakeAppServer({ ping: () => 'pong' });
    const client = new AppServerClient({ spawn: server.spawn, clientVersion: '0', idleMs: 5 });
    await client.call('ping', {});
    await Bun.sleep(20);
    expect(client.running).toBe(false);
    expect(server.killed).toBe(1);
    await client.call('ping', {});
    expect(server.spawnCount).toBe(2);
    client.dispose();
  });
});

describe('threadToMeta', () => {
  test('映射字段并过 schema；秒转毫秒', () => {
    const meta = threadToMeta(fakeThread('t1', { name: '名字', recencyAt: 3000 }))!;
    expect(SessionMetaSchema.parse(meta)).toBeDefined();
    expect(meta).toMatchObject({
      sessionId: 't1',
      title: '名字',
      engine: 'codex',
      cwd: '/synthetic/project',
      model: 'synthetic-model',
      gitBranch: 'main',
      createdAt: 1_000_000,
      lastActivityAt: 3_000_000,
      firstPrompt: 'prompt t1',
    });
  });

  test('没有名字用 preview；exec 来源是 headless，其余不是', () => {
    expect(threadToMeta(fakeThread('t'))!.title).toBe('prompt t');
    expect(threadToMeta(fakeThread('t', { source: 'exec' }))!.headless).toBe(true);
    expect(threadToMeta(fakeThread('t'))!.headless).toBeUndefined();
  });

  test('形状不对返回 undefined，不抛', () => {
    expect(threadToMeta(null)).toBeUndefined();
    expect(threadToMeta({ preview: 'x' })).toBeUndefined();
  });
});

describe('rateWindows', () => {
  test('只有周窗口的账号：不假设固定两个窗口', () => {
    const out = rateWindows({
      rateLimits: {},
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 2000 },
          secondary: null,
        },
      },
    });
    expect(out).toEqual([{ id: 'codex:primary', percent: 5, durationMins: 10080, resetsAt: 2_000_000 }]);
  });

  test('多桶才标桶名', () => {
    const out = rateWindows({
      rateLimitsByLimitId: {
        a: { limitName: 'A', primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null } },
        b: { limitName: null, secondary: { usedPercent: 2, windowDurationMins: null, resetsAt: null } },
      },
    });
    expect(out).toEqual([
      { id: 'a:primary', percent: 1, bucket: 'A', durationMins: 300 },
      { id: 'b:secondary', percent: 2, bucket: 'b' },
    ]);
  });

  test('没有按桶视图时用单桶字段；形状不对返回空', () => {
    expect(rateWindows({ rateLimits: { primary: { usedPercent: 9 } } })).toEqual([{ id: 'default:primary', percent: 9 }]);
    expect(rateWindows(null)).toEqual([]);
    expect(rateWindows({ rateLimits: { primary: { usedPercent: 'x' } } })).toEqual([]);
  });
});

describe('codexItemToHistory', () => {
  const ok = (item: unknown) => HistoryItemSchema.parse(codexItemToHistory(item, 5));

  test('用户消息：文本与图片占位', () => {
    expect(
      ok({
        type: 'userMessage',
        id: 'u',
        startedAtMs: 7,
        content: [{ type: 'text', text: 'hi' }, { type: 'localImage', path: '/x.png' }],
      }),
    ).toEqual({ kind: 'user', id: 'u', text: 'hi\n[图片]', ts: 7 });
  });

  test('assistant；时间戳缺失用兜底', () => {
    expect(ok({ type: 'agentMessage', id: 'a', text: 'yo' })).toEqual({ kind: 'assistant', id: 'a', text: 'yo', ts: 5 });
  });

  test('命令：退出码非 0 是 error', () => {
    const item = ok({ type: 'commandExecution', id: 'c', command: 'false', status: 'completed', exitCode: 1, durationMs: 1500, commandActions: [] });
    expect(item).toMatchObject({ kind: 'tool', toolName: 'Shell', status: 'error', durationMs: 1500 });
  });

  test('单条读文件的命令显示成 Read，带路径', () => {
    const item = ok({
      type: 'commandExecution',
      id: 'c',
      command: 'cat /a/b.txt',
      status: 'completed',
      exitCode: 0,
      commandActions: [{ type: 'read', command: 'cat', name: 'b.txt', path: '/a/b.txt' }],
      aggregatedOutput: 'text',
    });
    expect(item).toMatchObject({ toolName: 'Read', filePath: '/a/b.txt', status: 'ok', outputPreview: 'text' });
  });

  test('改文件：单文件带路径，统计增删', () => {
    const item = ok({
      type: 'fileChange',
      id: 'f',
      status: 'completed',
      changes: [{ path: '/a.txt', kind: { type: 'update' }, diff: '--- a\n+++ b\n+x\n+y\n-z\n' }],
    });
    expect(item).toMatchObject({ toolName: 'Edit', filePath: '/a.txt', resultSummary: '+2 −1', status: 'ok' });
  });

  test('改多个文件：不带路径；被拒绝是 error', () => {
    const item = ok({
      type: 'fileChange',
      id: 'f',
      status: 'declined',
      changes: [
        { path: '/a', diff: '' },
        { path: '/b', diff: '' },
      ],
    });
    expect(item).toMatchObject({ argSummary: '2 个文件', status: 'error' });
    expect((item as { filePath?: string }).filePath).toBeUndefined();
  });

  test('MCP 用 mcp__ 前缀；进行中没有状态', () => {
    const item = ok({ type: 'mcpToolCall', id: 'm', server: 's', tool: 't', status: 'inProgress', arguments: { a: 1 } });
    expect(item).toMatchObject({ toolName: 'mcp__s__t', argSummary: '{"a":1}' });
    expect((item as { status?: string }).status).toBeUndefined();
  });

  test('搜索', () => {
    expect(ok({ type: 'webSearch', id: 'w', query: 'q' })).toMatchObject({ toolName: 'WebSearch', argSummary: 'q' });
  });

  test('长消息截断，否则会突破历史分页的体积上限', () => {
    const long = 'x'.repeat(20 * 1024);
    const assistant = ok({ type: 'agentMessage', id: 'a', text: long }) as { text: string };
    const user = ok({ type: 'userMessage', id: 'u', content: [{ type: 'text', text: long }] }) as { text: string };
    expect(assistant.text.length).toBeLessThan(9 * 1024);
    expect(user.text.length).toBeLessThan(9 * 1024);
  });

  test('不认识的条目与形状不对的条目跳过', () => {
    expect(codexItemToHistory({ type: 'reasoning', id: 'r' }, 0)).toBeUndefined();
    expect(codexItemToHistory({ type: 'somethingNew', id: 'x' }, 0)).toBeUndefined();
    expect(codexItemToHistory({ type: 'agentMessage' }, 0)).toBeUndefined();
    expect(codexItemToHistory('nope', 0)).toBeUndefined();
  });
});

describe('unwrapShellCommand', () => {
  test('去掉 shell 外壳', () => {
    expect(unwrapShellCommand('/usr/bin/zsh -lc "ls -la"')).toBe('ls -la');
    expect(unwrapShellCommand("bash -lc 'echo hi'")).toBe('echo hi');
    expect(unwrapShellCommand('/bin/sh -c "git status"')).toBe('git status');
  });

  test('还原转义的引号', () => {
    expect(unwrapShellCommand('zsh -lc "rg \\"foo\\" src"')).toBe('rg "foo" src');
    expect(unwrapShellCommand("bash -lc 'echo '\\''x'\\'''")).toBe("echo 'x'");
  });

  test('不是外壳形式的原样返回', () => {
    expect(unwrapShellCommand('ls -la')).toBe('ls -la');
    expect(unwrapShellCommand('zsh script.sh')).toBe('zsh script.sh');
    expect(unwrapShellCommand('bash -lc "a" && rm x')).toBe('bash -lc "a" && rm x');
    expect(unwrapShellCommand('bash -lc "a" && echo "b"')).toBe('bash -lc "a" && echo "b"');
  });
});

describe('CodexEngine', () => {
  test('列表翻页，且只读 state DB、不写', async () => {
    const pages: Record<string, unknown> = {
      first: { data: [fakeThread('a')], nextCursor: 'c2' },
      c2: { data: [fakeThread('b')], nextCursor: null },
    };
    const { codex, server } = engine({
      'thread/list': (p) => pages[(p as { cursor?: string }).cursor ?? 'first'],
      'account/read': () => ({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true }),
      'account/rateLimits/read': () => ({}),
    });
    const list = await codex.listSessions();
    expect(list.map((m) => m.sessionId)).toEqual(['a', 'b']);
    const params = server.calls.find((c) => c.method === 'thread/list')!.params as Record<string, unknown>;
    expect(params['useStateDbOnly']).toBe(true);
    expect(params['sourceKinds']).toEqual(['cli', 'vscode', 'exec', 'appServer']);
    // 列会话不加载 thread，也不写 Codex 的状态
    const forbidden = ['thread/start', 'thread/resume', 'turn/start', 'thread/archive', 'thread/delete', 'thread/name/set'];
    expect(server.calls.filter((c) => forbidden.includes(c.method))).toEqual([]);
    codex.dispose();
  });

  test('owns：列表里有的不问；thread/read 能查到的记住；查无此 thread 短期缓存', async () => {
    let clock = 0;
    let reads = 0;
    const { codex } = engine(
      {
        'thread/list': () => ({ data: [fakeThread('listed')], nextCursor: null }),
        'thread/read': (p) => {
          reads += 1;
          const id = (p as { threadId: string }).threadId;
          if (id === 'found') return { thread: fakeThread('found') };
          throw rpcError(-32600, `thread not loaded: ${id}`);
        },
        'account/read': () => ({ account: { type: 'chatgpt' } }),
        'account/rateLimits/read': () => ({}),
      },
      () => clock,
    );
    await codex.listSessions();
    expect(await codex.owns('listed')).toBe(true);
    expect(reads).toBe(0);
    expect(await codex.owns('found')).toBe(true);
    expect(codex.metaOf('found')?.cwd).toBe('/synthetic/project');
    expect(await codex.owns('claude-id')).toBe(false);
    const after = reads;
    expect(await codex.owns('claude-id')).toBe(false);
    expect(reads).toBe(after);
    clock = 60_000;
    expect(await codex.owns('claude-id')).toBe(false);
    expect(reads).toBe(after + 1);
    codex.dispose();
  });

  test('owns：内部错误不算「不存在」，否则 GC 会误清标记', async () => {
    const { codex } = engine({
      'thread/read': () => {
        throw rpcError(-32603, 'internal error');
      },
    });
    await expect(codex.owns('x')).rejects.toThrow('internal error');
    codex.dispose();
  });

  test('列表有等待上限：卡住时退回缓存，跑完后缓存更新', async () => {
    let release: (value: unknown) => void = () => {};
    let hang = false;
    const client = {
      userAgent: undefined,
      dispose: () => {},
      call: (method: string) => {
        if (method !== 'thread/list') return Promise.resolve({ account: { type: 'chatgpt' } });
        if (hang) return new Promise((resolve) => (release = resolve));
        return Promise.resolve({ data: [fakeThread('a')], nextCursor: null });
      },
    };
    const codex = new CodexEngine({ client });
    expect((await codex.listSessionsBounded(50)).map((m) => m.sessionId)).toEqual(['a']);
    hang = true;
    const started = Date.now();
    expect((await codex.listSessionsBounded(10)).map((m) => m.sessionId)).toEqual(['a']);
    expect(Date.now() - started).toBeLessThan(1000);
    release({ data: [fakeThread('b')], nextCursor: null });
    await Bun.sleep(5);
    expect(codex.cachedSessions().map((m) => m.sessionId)).toEqual(['b']);
  });

  test('列表失败：退回缓存，不抛', async () => {
    const client = {
      userAgent: undefined,
      dispose: () => {},
      call: async () => {
        throw new AppServerError('down');
      },
    };
    const codex = new CodexEngine({ client });
    expect(await codex.listSessionsBounded(50)).toEqual([]);
  });

  test('owns：app-server 起不来时抛错，而不是说「不是」', async () => {
    const client = new AppServerClient({
      spawn: () => {
        throw new Error('no binary');
      },
      clientVersion: '0',
    });
    const codex = new CodexEngine({ client });
    await expect(codex.owns('x')).rejects.toThrow('no binary');
    codex.dispose();
  });

  test('历史：元素是 {item, startedAtMs}，翻页，认不出的跳过', async () => {
    const { codex } = engine({
      'thread/items/list': (p) =>
        (p as { cursor?: string }).cursor === undefined
          ? {
              data: [
                { turnId: 't', startedAtMs: 100, item: { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'q' }] } },
                { turnId: 't', startedAtMs: 110, item: { type: 'reasoning', id: 'r' } },
              ],
              nextCursor: 'n',
            }
          : { data: [{ turnId: 't', startedAtMs: 120, item: { type: 'agentMessage', id: 'a', text: 'ans' } }], nextCursor: null },
    });
    expect(await codex.history('t1')).toEqual([
      { kind: 'user', id: 'u', text: 'q', ts: 100 },
      { kind: 'assistant', id: 'a', text: 'ans', ts: 120 },
    ]);
    codex.dispose();
  });

  test('历史：没有分页接口的 thread 退回 thread/read，时间单调不回退', async () => {
    const { codex } = engine({
      'thread/items/list': () => {
        throw rpcError(-32601, 'not supported yet');
      },
      'thread/read': () => ({
        thread: {
          turns: [
            {
              items: [
                { type: 'userMessage', id: 'u', startedAtMs: 50, content: [{ type: 'text', text: 'q' }] },
                { type: 'agentMessage', id: 'a', text: 'ans' },
              ],
            },
          ],
        },
      }),
    });
    expect(await codex.history('t1')).toEqual([
      { kind: 'user', id: 'u', text: 'q', ts: 50 },
      { kind: 'assistant', id: 'a', text: 'ans', ts: 50 },
    ]);
    codex.dispose();
  });

  test('summary：版本从 userAgent 取；模型目录去掉隐藏的；限额进 summary 且过 schema；有变化才回调', async () => {
    const h = engine({
      'account/read': () => ({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true }),
      'account/rateLimits/read': () => ({
        rateLimitsByLimitId: { codex: { primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 2000 } } },
      }),
      'model/list': () => ({
        data: [
          { id: 'm1', displayName: 'Model 1', hidden: false },
          { id: 'hidden', displayName: 'H', hidden: true },
        ],
      }),
    });
    expect(h.codex.summary().capabilities.interactive).toBe(true);
    expect(h.codex.summary().modes?.find((m) => m.default)?.id).toBe('full');
    await h.codex.refresh();
    const summary = h.codex.summary();
    expect(summary).toMatchObject({ id: 'codex', version: '9.9.9', available: true });
    expect(summary.rateLimits?.windows[0]?.percent).toBe(5);
    expect(summary.models).toEqual([{ id: 'm1', label: 'Model 1' }]);
    expect(h.changes()).toBe(1);
    await h.codex.refresh();
    const info = buildMachineInfo({ name: 'm', claudeVersion: '', activeSessionCount: 0, maxSessions: 1, engines: [summary] });
    expect(MachineInfoSchema.parse(info).engines?.[0]?.id).toBe('codex');
    h.codex.dispose();
  });

  test('未登录：不可用，给出办法，不读限额', async () => {
    const h = engine({ 'account/read': () => ({ account: null, requiresOpenaiAuth: true }) });
    await h.codex.refresh();
    expect(h.codex.summary().available).toBe(false);
    expect(h.codex.summary().unavailableReason).toContain('codex login');
    expect(h.server.calls.some((c) => c.method === 'account/rateLimits/read')).toBe(false);
    h.codex.dispose();
  });

  test('API key 账号读限额报错：仍可用，没有限额', async () => {
    const h = engine({
      'account/read': () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }),
      'account/rateLimits/read': () => {
        throw rpcError(-32600, 'no limits');
      },
    });
    await h.codex.refresh();
    expect(h.codex.summary().available).toBe(true);
    expect(h.codex.summary().rateLimits).toBeUndefined();
    h.codex.dispose();
  });

  test('app-server 不可用：summary 写原因，refresh 不抛；列表退回缓存', async () => {
    let fail = false;
    const client = {
      userAgent: undefined,
      dispose: () => {},
      call: async (method: string) => {
        if (fail) throw new AppServerError('down');
        if (method === 'thread/list') return { data: [fakeThread('a')], nextCursor: null };
        return { account: { type: 'chatgpt' } };
      },
    };
    const codex = new CodexEngine({ client });
    await codex.listSessions();
    await codex.refresh();
    fail = true;
    await codex.refresh();
    expect(codex.summary().available).toBe(false);
    await expect(codex.listSessions()).rejects.toThrow('down');
    expect(codex.cachedSessions().map((m) => m.sessionId)).toEqual(['a']);
  });
});

describe('CodexEngine · 写操作', () => {
  test('startThread：模式带上，审批路由给用户，default 模型不传', async () => {
    const h = engine({ 'thread/start': () => ({ thread: { id: 'new' }, model: 'resolved' }) });
    const out = await h.codex.startThread({ cwd: '/a', model: 'default', engineMode: 'workspace' });
    expect(out).toEqual({ threadId: 'new', model: 'resolved', engineMode: 'workspace', permissionMode: 'default' });
    const params = h.server.calls.find((c) => c.method === 'thread/start')!.params;
    expect(params).toEqual({ cwd: '/a', approvalsReviewer: 'user', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    h.codex.dispose();
  });

  test('startThread：不认识的模式退回默认（完全访问是用户选的默认）', async () => {
    const h = engine({ 'thread/start': () => ({ thread: { id: 'new' } }) });
    const out = await h.codex.startThread({ cwd: '/a', model: 'm', engineMode: 'nope' });
    expect(out.engineMode).toBe('full');
    h.codex.dispose();
  });

  test('rename：更新缓存；thread 没落盘时转成 not found', async () => {
    const h = engine({
      'thread/list': () => ({ data: [fakeThread('a')], nextCursor: null }),
      'thread/name/set': (p) => {
        if ((p as { threadId: string }).threadId === 'b') throw rpcError(-32600, 'thread not loaded: b');
        return {};
      },
      'account/read': () => ({ account: { type: 'chatgpt' } }),
      'account/rateLimits/read': () => ({}),
    });
    await h.codex.listSessions();
    await h.codex.rename('a', '新名字');
    expect(h.codex.metaOf('a')?.title).toBe('新名字');
    await expect(h.codex.rename('b', 'x')).rejects.toThrow('not found');
    h.codex.dispose();
  });

  test('delete：调 thread/delete，缓存删掉', async () => {
    const h = engine({
      'thread/list': () => ({ data: [fakeThread('a')], nextCursor: null }),
      'thread/delete': () => ({}),
      'account/read': () => ({ account: { type: 'chatgpt' } }),
      'account/rateLimits/read': () => ({}),
    });
    await h.codex.listSessions();
    await h.codex.delete('a');
    expect(h.server.calls.some((c) => c.method === 'thread/delete')).toBe(true);
    expect(h.codex.metaOf('a')).toBeUndefined();
    h.codex.dispose();
  });

  test('限额更新是稀疏的：只替换带来的窗口，没带的保留', async () => {
    const h = engine({
      'account/read': () => ({ account: { type: 'chatgpt' } }),
      'account/rateLimits/read': () => ({
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 5, windowDurationMins: 300 },
            secondary: { usedPercent: 9, windowDurationMins: 10080 },
          },
        },
      }),
    });
    await h.codex.refresh();
    h.server.handlers!.onLine(
      JSON.stringify({
        method: 'account/rateLimits/updated',
        params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 6, windowDurationMins: 300 }, secondary: null } },
      }),
    );
    const windows = h.codex.summary().rateLimits!.windows;
    expect(windows.find((w) => w.id === 'codex:primary')?.percent).toBe(6);
    expect(windows.find((w) => w.id === 'codex:secondary')?.percent).toBe(9);
    h.codex.dispose();
  });

  test('持有活跃会话时 app-server 不空闲退出；释放后才退', async () => {
    const server = new FakeAppServer({ ping: () => 'pong' });
    const client = new AppServerClient({ spawn: server.spawn, clientVersion: '0', idleMs: 5 });
    client.hold();
    await client.call('ping', {});
    await Bun.sleep(20);
    expect(client.running).toBe(true);
    client.release();
    await Bun.sleep(20);
    expect(client.running).toBe(false);
    client.dispose();
  });
});


describe('M4：目录、斜杠菜单、子 agent 卡', () => {
  test('模型目录带推理强度；取值开放，隐藏模型不要', () => {
    expect(
      modelFromList({ id: 'm', displayName: 'M', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] }),
    ).toEqual({ id: 'm', label: 'M', efforts: ['low', 'ultra'], defaultEffort: 'low', isDefault: true });
    expect(modelFromList({ id: 'h', hidden: true })).toBeUndefined();
    expect(modelFromList({ id: 'bare' })).toEqual({ id: 'bare', label: 'bare' });
    expect(MachineInfoSchema.safeParse({ name: 'n', platform: 'p', osVersion: 'o', agentVersion: '1', claudeVersion: '1', activeSessionCount: 0, engines: [{ id: 'codex', displayName: 'Codex', available: true, capabilities: { effort: true, update: true, rewind: ['conversation'] }, models: [modelFromList({ id: 'm', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] })], latest: { version: '1.2.3', checkedAt: 1 } }] }).success).toBe(true);
  });

  test('斜杠菜单：压缩在前，只列启用的 skill；skills 读不到也有压缩', async () => {
    const { codex } = engine({
      'skills/list': () => ({ data: [{ cwd: '/x', errors: [], skills: [
        { name: 'a', description: 'long', shortDescription: 'short', path: '/x/a', scope: 'repo', enabled: true },
        { name: 'b', description: 'b', path: '/x/b', scope: 'user', enabled: false },
      ] }] }),
    });
    expect(await codex.slashCommands('/x')).toEqual([
      { name: 'compact', description: '压缩对话上下文', source: 'user' },
      { name: 'a', description: 'short', source: 'skill' },
    ]);
    const { codex: broken } = engine({});
    expect((await broken.slashCommands('/x')).map((c) => c.name)).toEqual(['compact']);
  });

  test('子 agent 操作显示成卡；字段缺失也不报错', () => {
    const spawn = codexItemToHistory({ type: 'collabAgentToolCall', id: 'c1', tool: 'spawnAgent', status: 'completed', prompt: '查一下', agentsStates: { x: { status: 'completed', message: '查完了' } } }, 5);
    // 调用状态与子 agent 状态分开、都中文化（wait 调用完成 ≠ 子 agent 完成）
    expect(spawn).toMatchObject({
      kind: 'tool',
      toolName: 'SubAgent',
      argSummary: '查一下',
      status: 'ok',
      resultSummary: '调用完成 · 子 agent 已完成 1',
      outputPreview: '查完了',
      subagent: { agentId: 'x', state: 'completed' },
    });
    const wait = codexItemToHistory({ type: 'collabAgentToolCall', id: 'c2', tool: 'wait', status: 'completed', prompt: null, agentsStates: { x: { status: 'errored', message: null } } }, 5);
    expect(wait).toMatchObject({ toolName: 'SubAgent', argSummary: '等待子 agent', status: 'error', resultSummary: '调用完成 · 子 agent 失败 1', subagent: { state: 'failed' } });
    expect(codexItemToHistory({ type: 'collabAgentToolCall', id: 'c3', status: 'interrupted' }, 5)).toMatchObject({ status: 'warn', resultSummary: '调用已中断' });
    expect(codexItemToHistory({ type: 'subAgentActivity', id: 's1', kind: 'completed', agentPath: 'root/a', agentThreadId: 't' }, 5)).toMatchObject({ toolName: 'SubAgent', argSummary: '子 agent 已完成 · root/a', status: 'ok' });
    // v2 的派生（spike S2）：subAgentActivity started 就是派生卡
    const started = codexItemToHistory({ type: 'subAgentActivity', id: 'call_1', kind: 'started', agentPath: '/root/probe', agentThreadId: 'thr-c', model: 'm-1' }, 5);
    expect(started).toMatchObject({ argSummary: '派生子 agent · probe', resultSummary: '已派生', subagent: { agentId: 'thr-c', model: 'm-1', state: 'running' } });
    expect(HistoryItemSchema.safeParse(spawn).success).toBe(true);
    expect(HistoryItemSchema.safeParse(started).success).toBe(true);
  });

  test('全部 CollabAgentStatus 都有对应状态；不认识的不给', () => {
    const all = ['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound'];
    expect(all.map(collabAgentState)).toEqual(['pending', 'running', 'interrupted', 'completed', 'failed', 'shutdown', 'not_found']);
    expect(collabAgentState('later')).toBeUndefined();
  });

  test('历史：子 agent 的后续动态并进派生卡；没有结束证据的标状态未知；昵称从子 thread 读', async () => {
    const raw = [
      { type: 'subAgentActivity', id: 'call_a', kind: 'started', agentThreadId: 'thr-a', agentPath: '/root/a', model: 'm-1', startedAtMs: 10 },
      { type: 'collabAgentToolCall', id: 'w1', tool: 'wait', status: 'completed', receiverThreadIds: [], agentsStates: {}, startedAtMs: 11 },
      { type: 'subAgentActivity', id: 'done-a', kind: 'completed', agentThreadId: 'thr-a', agentPath: '/root/a', startedAtMs: 12 },
      { type: 'subAgentActivity', id: 'call_b', kind: 'started', agentThreadId: 'thr-b', agentPath: '/root/b', startedAtMs: 13 },
      // 对不上派生卡的动态照常成卡
      { type: 'subAgentActivity', id: 'odd', kind: 'interrupted', agentThreadId: 'thr-x', agentPath: '/root/x', startedAtMs: 14 },
    ];
    const items = codexItemsToHistory(raw, 0);
    expect(items.map((i) => i.id)).toEqual(['call_a', 'w1', 'call_b', 'odd']);
    expect(items[0]).toMatchObject({ subagent: { agentId: 'thr-a', state: 'completed', model: 'm-1' } });
    expect(items[2]).toMatchObject({ subagent: { agentId: 'thr-b', state: 'unknown' } });

    const server = new FakeAppServer({
      'thread/items/list': () => ({ data: raw.map((item) => ({ item, startedAtMs: item.startedAtMs })), nextCursor: null }),
      'thread/read': (params) => {
        const id = (params as { threadId: string }).threadId;
        if (id === 'thr-a') return { thread: fakeThread('thr-a', { agentNickname: 'Meitner', agentRole: 'worker', model: 'other' }) };
        throw rpcError(-32600, 'thread not loaded');
      },
    });
    const engine = new CodexEngine({ spawn: server.spawn });
    const history = await engine.history('parent');
    // 模型以 subAgentActivity 给的为准，昵称 / 角色从子 thread 读
    expect(history[0]).toMatchObject({ subagent: { nickname: 'Meitner', agentType: 'worker', model: 'm-1', state: 'completed' } });
    expect(history[2]).toMatchObject({ subagent: { agentId: 'thr-b' } });
    expect((history[2] as { subagent?: { nickname?: string } }).subagent?.nickname).toBeUndefined();
    for (const item of history) expect(HistoryItemSchema.safeParse(item).success).toBe(true);
    engine.dispose();
  });

  test('压缩显示成卡；skill 消息不把名字写两遍', () => {
    expect(codexItemToHistory({ type: 'contextCompaction', id: 'k' }, 5)).toMatchObject({ kind: 'tool', toolName: 'Compact', status: 'ok' });
    expect(codexItemToHistory({ type: 'userMessage', id: 'u', content: [{ type: 'text', text: '$a hi' }, { type: 'skill', name: 'a', path: '/a' }] }, 5)).toMatchObject({ text: '$a hi' });
    expect(codexItemToHistory({ type: 'userMessage', id: 'u', content: [{ type: 'skill', name: 'a', path: '/a' }] }, 5)).toMatchObject({ text: '$a' });
  });

  test('更新后显示磁盘上的新版本，空闲时换掉进程；有 thread 在用时不动', async () => {
    const server = new FakeAppServer({
      'account/read': () => ({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true }),
      'model/list': () => ({ data: [] }),
      'account/rateLimits/read': () => ({}),
      'thread/start': () => ({ thread: { id: 'th' }, model: 'm' }),
    });
    const codex = new CodexEngine({ spawn: server.spawn, clientOptions: { idleMs: 60_000 } });
    await codex.refresh();
    expect(codex.summary().version).toBe('9.9.9');
    const session = codex.createSession({ sessionId: 'th', cwd: '/x', model: 'm', permissionMode: 'default', emit: () => {} });
    codex.noteUpdated('10.0.0');
    expect(codex.summary().version).toBe('10.0.0');
    expect(server.killed).toBe(0);
    await session.close();
    codex.noteUpdated('10.0.0');
    expect(server.killed).toBe(1);
    codex.noteUpdated('unknown');
    expect(codex.summary().version).toBe('10.0.0');
    codex.dispose();
  });
});

import { describe, expect, test } from 'bun:test';
import { AgentToClientEventSchema } from '@trine/core';
import type { EventBody } from '../../bridge/types.ts';
import { CodexEngine } from './engine.ts';
import { FakeAppServer, type FakeRoute } from './fake-app-server.ts';
import { toUserInput, type CodexSession } from './session.ts';

const THREAD = 'thread-1';

function harness(options: { routes?: Record<string, FakeRoute>; resume?: boolean; engineMode?: string; model?: string } = {}) {
  const server: FakeAppServer = new FakeAppServer({
    'turn/start': () => ({ turn: { id: `turn-${server.calls.filter((c) => c.method === 'turn/start').length}` } }),
    'turn/interrupt': () => ({}),
    'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
    'thread/resume': () => ({ approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' }, model: 'resumed-model' }),
    ...options.routes,
  });
  const engine = new CodexEngine({ spawn: server.spawn, clientOptions: { idleMs: 60_000 }, now: () => 1000 });
  const events: EventBody[] = [];
  const metas: ReturnType<CodexSession['meta']>[] = [];
  let idles = 0;
  const session = engine.createSession({
    sessionId: THREAD,
    cwd: '/synthetic',
    model: options.model ?? 'gpt-x',
    permissionMode: 'default',
    ...(options.engineMode === undefined ? {} : { engineMode: options.engineMode }),
    resume: options.resume === true,
    emit: (body) => events.push(body),
    onMeta: (meta) => metas.push(meta),
    onIdle: () => (idles += 1),
  });
  const flush = () => Bun.sleep(5);
  const notify = (method: string, params: Record<string, unknown> = {}) =>
    server.handlers!.onLine(JSON.stringify({ method, params: { threadId: THREAD, ...params } }));
  const request = (id: number, method: string, params: Record<string, unknown> = {}) =>
    server.handlers!.onLine(JSON.stringify({ id, method, params: { threadId: THREAD, ...params } }));
  const types = () => events.map((e) => e.type);
  const of = <T extends EventBody['type']>(type: T) => events.filter((e) => e.type === type) as Extract<EventBody, { type: T }>[];
  const replyTo = (id: number) => server.sent.find((m) => (m as { id?: number; method?: string }).id === id && (m as { method?: string }).method === undefined);
  const callsOf = (method: string) => server.calls.filter((c) => c.method === method);
  const finish = async (turnId = 'turn-1', status = 'completed', error: unknown = null) => {
    notify('turn/completed', { turn: { id: turnId, status, error } });
    await flush();
  };
  return { server, engine, session, events, metas, flush, notify, request, types, of, replyTo, callsOf, finish, idles: () => idles };
}

describe('CodexSession · 一轮', () => {
  test('帧序列对齐 Claude：回显 → running → 文本与工具 → run.done → idle', async () => {
    const h = harness();
    h.session.send('c1', 'hello');
    await h.flush();
    expect(h.session.state).toBe('running');
    h.notify('item/agentMessage/delta', { itemId: 'm1', delta: 'hi ' });
    h.notify('item/started', { item: { type: 'commandExecution', id: 't1', command: "zsh -lc 'ls'", status: 'inProgress', commandActions: [] } });
    h.notify('item/completed', { item: { type: 'commandExecution', id: 't1', command: "zsh -lc 'ls'", status: 'completed', exitCode: 0, durationMs: 12, aggregatedOutput: 'a.txt', commandActions: [] } });
    h.notify('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'hi there' } });
    await h.finish();
    expect(h.types().filter((t) => t !== 'run.heartbeat')).toEqual([
      'user.message',
      'run.state',
      'assistant.delta',
      'tool.start',
      'tool.end',
      'assistant.done',
      'run.done',
      'run.state',
    ]);
    expect(h.of('tool.start')[0]).toMatchObject({ toolUseId: 't1', toolName: 'Shell', argSummary: 'ls' });
    expect(h.of('tool.end')[0]).toMatchObject({ status: 'ok', durationMs: 12, outputPreview: 'a.txt' });
    expect(h.of('run.done')[0]).toMatchObject({ toolCount: 1, permissionCount: 0, costUsd: 0 });
    expect(h.session.state).toBe('idle');
    expect(h.idles()).toBe(1);
    h.engine.dispose();
  });

  test('每一帧都过协议 schema', async () => {
    const h = harness();
    h.session.send('c1', 'hello');
    await h.flush();
    h.notify('item/agentMessage/delta', { itemId: 'm1', delta: 'x' });
    h.request(1, 'item/commandExecution/requestApproval', { command: 'ls', itemId: 't', availableDecisions: ['accept', 'decline'] });
    h.session.respondPermission({ requestId: h.of('permission.request')[0]!.requestId, verdict: 'allow' });
    await h.finish();
    for (const body of h.events) {
      const parsed = AgentToClientEventSchema.safeParse({ ...body, ts: 1, seq: 1, dir: 'a2c', sessionId: THREAD });
      expect(parsed.success).toBe(true);
    }
    h.engine.dispose();
  });

  test('turn/start 带 clientUserMessageId（历史去重）与当前模型、模式、目录', async () => {
    const h = harness({ engineMode: 'workspace' });
    h.session.send('c1', 'hello');
    await h.flush();
    const params = h.callsOf('turn/start')[0]!.params as Record<string, unknown>;
    expect(params).toMatchObject({
      threadId: THREAD,
      clientUserMessageId: 'c1',
      cwd: '/synthetic',
      model: 'gpt-x',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    });
    expect((params['sandboxPolicy'] as { type: string }).type).toBe('workspaceWrite');
    h.engine.dispose();
  });

  test('default 模型不传；没指定模式不传覆盖', async () => {
    const h = harness({ model: 'default' });
    h.session.send('c1', 'hello');
    await h.flush();
    const params = h.callsOf('turn/start')[0]!.params as Record<string, unknown>;
    expect(params['model']).toBeUndefined();
    expect(params['approvalPolicy']).toBeUndefined();
    expect(params['sandboxPolicy']).toBeUndefined();
    expect(params['approvalsReviewer']).toBe('user');
    h.engine.dispose();
  });

  test('上一轮的迟到通知不算这一轮结束', async () => {
    const h = harness();
    h.session.send('c1', 'hello');
    await h.flush();
    h.notify('turn/started', { turn: { id: 'turn-1' } });
    h.notify('turn/completed', { turn: { id: 'old', status: 'completed' } });
    await h.flush();
    expect(h.session.state).toBe('running');
    h.engine.dispose();
  });

  test('别的 thread 的通知不进这个会话', async () => {
    const h = harness();
    h.session.send('c1', 'hello');
    await h.flush();
    h.server.handlers!.onLine(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'other', itemId: 'm', delta: 'x' } }));
    expect(h.of('assistant.delta')).toEqual([]);
    h.engine.dispose();
  });

  test('context 用量取 last，不取累计', async () => {
    const h = harness();
    h.session.send('c1', 'hello');
    await h.flush();
    h.notify('thread/tokenUsage/updated', {
      tokenUsage: { last: { totalTokens: 100 }, total: { totalTokens: 9999 }, modelContextWindow: 1000 },
    });
    await h.finish();
    expect(h.session.meta().context).toMatchObject({ usedTokens: 100, maxTokens: 1000, percent: 10 });
    h.engine.dispose();
  });

  test('首条输入进 meta，给新会话当标题', async () => {
    const h = harness();
    h.session.send('c1', '第一句\n第二行');
    await h.flush();
    expect(h.session.meta().firstPrompt).toBe('第一句 第二行');
    h.engine.dispose();
  });
});

describe('CodexSession · 排队', () => {
  test('运行中的消息排队，上一轮结束才执行；回显在出队时发', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    h.session.send('c2', 'b');
    expect(h.of('input.queued').map((e) => e.clientMsgId)).toEqual(['c2']);
    expect(h.of('user.message').map((e) => e.clientMsgId)).toEqual(['c1']);
    expect(h.callsOf('turn/start')).toHaveLength(1);
    await h.finish();
    expect(h.of('user.message').map((e) => e.clientMsgId)).toEqual(['c1', 'c2']);
    expect(h.callsOf('turn/start')).toHaveLength(2);
    h.engine.dispose();
  });

  test('撤回排队中的消息', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    h.session.send('c2', 'b');
    expect(h.session.recall('c2')).toBe(true);
    expect(h.of('input.cancelled')[0]).toMatchObject({ clientMsgId: 'c2', reason: 'recalled' });
    await h.finish();
    expect(h.callsOf('turn/start')).toHaveLength(1);
    expect(h.session.recall('c1')).toBe(false);
    h.engine.dispose();
  });

  test('重复投递不重复执行，但仍回执', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    expect(h.session.send('c1', 'a').duplicate).toBe(true);
    expect(h.callsOf('turn/start')).toHaveLength(1);
    expect(h.of('input.queued')).toHaveLength(1);
    h.engine.dispose();
  });
});

describe('CodexSession · 审批', () => {
  async function asked(h: ReturnType<typeof harness>, id = 7) {
    h.session.send('c1', 'a');
    await h.flush();
    h.notify('item/started', { item: { type: 'commandExecution', id: 't1', command: 'touch x', status: 'inProgress', commandActions: [] } });
    h.request(id, 'item/commandExecution/requestApproval', {
      itemId: 't1',
      command: "/usr/bin/zsh -lc 'touch x'",
      cwd: '/synthetic',
      availableDecisions: ['accept', 'acceptForSession', { acceptWithExecpolicyAmendment: {} }, 'decline', 'cancel'],
    });
    return h.of('permission.request')[0]!;
  }

  test('命令审批：转成 permission.request，命令去壳，只给认识的选项', async () => {
    const h = harness();
    const req = await asked(h);
    expect(req).toMatchObject({ toolName: 'Shell', input: { command: 'touch x', cwd: '/synthetic' } });
    expect(req.options?.map((o) => o.id)).toEqual(['accept', 'acceptForSession', 'decline']);
    expect(h.session.state).toBe('waiting_permission');
    expect(h.session.meta().waitingFor).toBe('permission');
    expect(h.session.permissions.snapshot()[0]?.options).toHaveLength(3);
    h.engine.dispose();
  });

  test('批准：回 accept，发 resolved，状态回 running', async () => {
    const h = harness();
    const req = await asked(h);
    expect(h.session.respondPermission({ requestId: req.requestId, verdict: 'allow', resolvedBy: 'phone' })).toBe(true);
    expect(h.replyTo(7)).toEqual({ id: 7, result: { decision: 'accept' } });
    expect(h.of('permission.resolved')[0]).toMatchObject({ verdict: 'allow', resolvedBy: 'phone' });
    expect(h.session.state).toBe('running');
    h.engine.dispose();
  });

  test('本会话都批准', async () => {
    const h = harness();
    const req = await asked(h);
    h.session.respondPermission({ requestId: req.requestId, verdict: 'allow', optionId: 'acceptForSession' });
    expect(h.replyTo(7)).toEqual({ id: 7, result: { decision: 'acceptForSession' } });
    h.engine.dispose();
  });

  test('拒绝：回 decline；optionId 不能把拒绝变成批准', async () => {
    const h = harness();
    const req = await asked(h);
    h.session.respondPermission({ requestId: req.requestId, verdict: 'deny', optionId: 'acceptForSession' });
    expect(h.replyTo(7)).toEqual({ id: 7, result: { decision: 'decline' } });
    h.engine.dispose();
  });

  test('不认识的 optionId 按单次批准，绝不放宽', async () => {
    const h = harness();
    const req = await asked(h);
    h.session.respondPermission({ requestId: req.requestId, verdict: 'allow', optionId: 'acceptForever' });
    expect(h.replyTo(7)).toEqual({ id: 7, result: { decision: 'accept' } });
    h.engine.dispose();
  });

  test('Codex 没给「本会话」选项时，optionId 也放不宽', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    h.request(8, 'item/commandExecution/requestApproval', { command: 'ls', availableDecisions: ['accept', 'decline'] });
    const req = h.of('permission.request')[0]!;
    h.session.respondPermission({ requestId: req.requestId, verdict: 'allow', optionId: 'acceptForSession' });
    expect(h.replyTo(8)).toEqual({ id: 8, result: { decision: 'accept' } });
    h.engine.dispose();
  });

  test('重复应答不命中，也不回第二次', async () => {
    const h = harness();
    const req = await asked(h);
    h.session.respondPermission({ requestId: req.requestId, verdict: 'allow' });
    expect(h.session.respondPermission({ requestId: req.requestId, verdict: 'deny' })).toBe(false);
    expect(h.server.sent.filter((m) => (m as { id?: number; method?: string }).id === 7)).toHaveLength(1);
    h.engine.dispose();
  });

  test('改文件审批：diff 来自 item/started', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    h.notify('item/started', { item: { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: '/a.txt', diff: '+x' }] } });
    h.request(9, 'item/fileChange/requestApproval', { itemId: 'f1' });
    expect(h.of('permission.request')[0]).toMatchObject({ toolName: 'Edit', input: { file_path: '/a.txt', new_string: '+x' } });
    h.engine.dispose();
  });

  test('权限提升：批准给请求的范围，拒绝给空', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    h.request(10, 'item/permissions/requestApproval', { permissions: { network: { enabled: true }, fileSystem: null } });
    h.request(11, 'item/permissions/requestApproval', { permissions: { network: { enabled: true }, fileSystem: null } });
    const [a, b] = h.of('permission.request');
    h.session.respondPermission({ requestId: a!.requestId, verdict: 'allow' });
    h.session.respondPermission({ requestId: b!.requestId, verdict: 'deny' });
    expect(h.replyTo(10)).toEqual({ id: 10, result: { permissions: { network: { enabled: true } }, scope: 'turn' } });
    expect(h.replyTo(11)).toEqual({ id: 11, result: { permissions: {}, scope: 'turn' } });
    h.engine.dispose();
  });

  test('MCP elicitation：拒绝并说明，不让这一轮卡住', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    h.request(12, 'mcpServer/elicitation/request', { serverName: 's', mode: 'form' });
    expect(h.replyTo(12)).toEqual({ id: 12, result: { action: 'decline', content: null, _meta: null } });
    expect(h.of('error.transient')).toHaveLength(1);
    h.engine.dispose();
  });

  test('不认识的服务端请求：回错误', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    h.request(13, 'item/tool/call', {});
    expect(h.server.sent).toContainEqual({ id: 13, error: { code: -32601, message: 'not supported by this client' } });
    h.engine.dispose();
  });

  test('Codex 不再等了：作废卡片', async () => {
    const h = harness();
    await asked(h);
    h.notify('serverRequest/resolved', { requestId: 7 });
    expect(h.of('permission.invalidated')).toHaveLength(1);
    expect(h.session.state).toBe('running');
    h.engine.dispose();
  });

  test('一轮结束时还挂着的审批作废', async () => {
    const h = harness();
    await asked(h);
    await h.finish();
    expect(h.of('permission.invalidated')).toHaveLength(1);
    expect(h.session.permissions.snapshot()).toEqual([]);
    h.engine.dispose();
  });
});

describe('CodexSession · 停止与失败', () => {
  test('停止：丢弃排队、拒绝挂起审批、turn/interrupt；状态 stopped，不发 run.done', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    h.notify('turn/started', { turn: { id: 'turn-1' } });
    h.session.send('c2', 'b');
    h.request(7, 'item/commandExecution/requestApproval', { command: 'ls' });
    h.notify('item/started', { item: { type: 'commandExecution', id: 't1', command: 'sleep 9', status: 'inProgress', commandActions: [] } });
    await h.session.stop();
    expect(h.of('input.cancelled')[0]).toMatchObject({ clientMsgId: 'c2', reason: 'stopped' });
    expect(h.replyTo(7)).toEqual({ id: 7, result: { decision: 'decline' } });
    expect(h.callsOf('turn/interrupt')[0]!.params).toEqual({ threadId: THREAD, turnId: 'turn-1' });
    await h.finish('turn-1', 'interrupted');
    expect(h.session.state).toBe('stopped');
    expect(h.of('run.done')).toEqual([]);
    // 没跑完的工具卡要收口，否则一直转圈
    expect(h.of('tool.end')[0]).toMatchObject({ toolUseId: 't1', status: 'warn', resultSummary: '已中断' });
    h.engine.dispose();
  });

  test('停止后再发消息：正常开新一轮', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    await h.session.stop();
    await h.finish('turn-1', 'interrupted');
    h.session.send('c2', 'b');
    await h.flush();
    expect(h.callsOf('turn/start')).toHaveLength(2);
    expect(h.session.state).toBe('running');
    h.engine.dispose();
  });

  test('失败的轮：error.fatal 按错误类型分类，状态 error，不发 run.done', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    await h.finish('turn-1', 'failed', { message: '额度用完了', codexErrorInfo: 'usageLimitExceeded' });
    expect(h.of('error.fatal')[0]).toMatchObject({ kind: 'quota', message: '额度用完了' });
    expect(h.session.state).toBe('error');
    expect(h.of('run.done')).toEqual([]);
    h.engine.dispose();
  });

  test('失败的轮之后排队的消息继续跑', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    h.session.send('c2', 'b');
    await h.finish('turn-1', 'failed', { message: 'x' });
    expect(h.callsOf('turn/start')).toHaveLength(2);
    h.engine.dispose();
  });

  test('会重试的错误是 transient，不结束这一轮', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    h.notify('error', { willRetry: true, error: { message: '连接断了' } });
    h.notify('error', { willRetry: false, error: { message: '不重试的由 turn/completed 报' } });
    expect(h.of('error.transient')).toHaveLength(1);
    expect(h.of('error.fatal')).toEqual([]);
    expect(h.session.state).toBe('running');
    h.engine.dispose();
  });

  test('turn/start 被拒：报错，能继续发下一条', async () => {
    const server = { fail: true };
    const h = harness({
      routes: {
        'turn/start': () => {
          if (server.fail) throw Object.assign(new Error('rejected'), { code: -32600 });
          return { turn: { id: 'turn-2' } };
        },
      },
    });
    h.session.send('c1', 'a');
    await h.flush();
    expect(h.of('error.fatal')[0]).toMatchObject({ kind: 'other', message: 'rejected' });
    expect(h.session.state).toBe('error');
    server.fail = false;
    h.session.send('c2', 'b');
    await h.flush();
    expect(h.session.state).toBe('running');
    h.engine.dispose();
  });

  test('app-server 退出：这一轮失败；下一条消息重新拉起并 resume', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    h.server.handlers!.onExit();
    await h.flush();
    expect(h.of('error.fatal')[0]?.message).toContain('退出');
    expect(h.session.hasProcess).toBe(false);
    h.session.send('c2', 'b');
    await h.flush();
    expect(h.server.spawnCount).toBe(2);
    expect(h.callsOf('thread/resume')).toHaveLength(1);
    expect(h.callsOf('turn/start')).toHaveLength(2);
    h.engine.dispose();
  });
});

describe('CodexSession · 续接与设置', () => {
  test('续接：先 thread/resume，再 turn/start', async () => {
    const h = harness({ resume: true, engineMode: 'read-only' });
    expect(h.session.hasProcess).toBe(false);
    h.session.send('c1', 'a');
    await h.flush();
    expect(h.server.calls.map((c) => c.method).filter((m) => m === 'thread/resume' || m === 'turn/start')).toEqual([
      'thread/resume',
      'turn/start',
    ]);
    expect(h.callsOf('thread/resume')[0]!.params).toMatchObject({ approvalsReviewer: 'user', approvalPolicy: 'on-request', sandbox: 'read-only' });
    expect(h.session.hasProcess).toBe(true);
    h.engine.dispose();
  });

  test('续接外部 thread：不覆盖它自己的沙箱设置，如实回报', async () => {
    const h = harness({ resume: true });
    h.session.send('c1', 'a');
    await h.flush();
    const params = h.callsOf('thread/resume')[0]!.params as Record<string, unknown>;
    expect(params['approvalPolicy']).toBeUndefined();
    expect(params['sandbox']).toBeUndefined();
    expect(params['approvalsReviewer']).toBe('user');
    expect(h.session.meta()).toMatchObject({ engineMode: 'workspace', permissionMode: 'default', model: 'resumed-model' });
    h.engine.dispose();
  });

  test('续接失败：报错，不发 turn/start', async () => {
    const h = harness({
      resume: true,
      routes: {
        'thread/resume': () => {
          throw Object.assign(new Error('no rollout found'), { code: -32600 });
        },
      },
    });
    h.session.send('c1', 'a');
    await h.flush();
    expect(h.of('error.fatal')[0]?.message).toContain('no rollout');
    expect(h.callsOf('turn/start')).toEqual([]);
    h.engine.dispose();
  });

  test('切模式：engineMode 优先，下一轮生效', async () => {
    const h = harness({ engineMode: 'full' });
    await h.session.setPermissionMode('default', 'read-only');
    expect(h.session.meta()).toMatchObject({ engineMode: 'read-only', permissionMode: 'plan' });
    h.session.send('c1', 'a');
    await h.flush();
    expect(h.callsOf('turn/start')[0]!.params).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } });
    h.engine.dispose();
  });

  test('旧 client 只发枚举：按表映射；acceptEdits 不会变成完全访问', async () => {
    const h = harness();
    await h.session.setPermissionMode('acceptEdits');
    expect(h.session.meta().engineMode).toBe('workspace');
    await h.session.setPermissionMode('bypassPermissions');
    expect(h.session.meta().engineMode).toBe('full');
    h.engine.dispose();
  });

  test('不认识的 engineMode 按枚举映射，不会放宽', async () => {
    const h = harness();
    await h.session.setPermissionMode('plan', 'super-full');
    expect(h.session.meta().engineMode).toBe('read-only');
    h.engine.dispose();
  });

  test('切模型、切目录：下一轮生效', async () => {
    const h = harness();
    await h.session.setModel('gpt-y');
    h.session.setCwd('/other');
    h.session.send('c1', 'a');
    await h.flush();
    expect(h.callsOf('turn/start')[0]!.params).toMatchObject({ model: 'gpt-y', cwd: '/other' });
    h.engine.dispose();
  });

  test('关闭：丢弃排队，拒绝审批，卸载 thread；之后不再收通知', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    h.notify('turn/started', { turn: { id: 'turn-1' } });
    h.session.send('c2', 'b');
    h.request(7, 'item/commandExecution/requestApproval', { command: 'ls' });
    await h.session.close('test');
    expect(h.of('input.cancelled')[0]).toMatchObject({ clientMsgId: 'c2', reason: 'closed' });
    expect(h.replyTo(7)).toEqual({ id: 7, result: { decision: 'decline' } });
    expect(h.callsOf('thread/unsubscribe')).toHaveLength(1);
    const before = h.events.length;
    h.notify('item/agentMessage/delta', { itemId: 'm', delta: 'x' });
    expect(h.events.length).toBe(before);
    h.engine.dispose();
  });
});

describe('CodexSession · 权限边界（评审回归）', () => {
  test('旧网页改参数后批准：按拒绝处理，绝不放行原命令', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    h.request(7, 'item/commandExecution/requestApproval', { command: 'rm -rf x' });
    const req = h.of('permission.request')[0]!;
    h.session.respondPermission({ requestId: req.requestId, verdict: 'allow', updatedInput: { command: 'ls' } });
    expect(h.replyTo(7)).toEqual({ id: 7, result: { decision: 'decline' } });
    expect(h.of('permission.resolved')[0]).toMatchObject({ verdict: 'deny' });
    expect(h.of('error.transient')[0]?.reason).toContain('改参数');
    h.engine.dispose();
  });

  test('审批 id 不复用：会话重建后旧应答命中不了新请求', async () => {
    const a = harness();
    a.session.send('c1', 'a');
    await a.flush();
    a.request(7, 'item/commandExecution/requestApproval', { command: 'ls' });
    const b = harness();
    b.session.send('c1', 'a');
    await b.flush();
    b.request(7, 'item/commandExecution/requestApproval', { command: 'rm -rf x' });
    const oldId = a.of('permission.request')[0]!.requestId;
    expect(b.of('permission.request')[0]!.requestId).not.toBe(oldId);
    expect(b.session.respondPermission({ requestId: oldId, verdict: 'allow' })).toBe(false);
    a.engine.dispose();
    b.engine.dispose();
  });

  test('续接外部 thread：显示它的档位，但 turn/start 不带覆盖（否则会放宽它的沙箱）', async () => {
    const h = harness({ resume: true });
    h.session.send('c1', 'a');
    await h.flush();
    expect(h.session.meta().engineMode).toBe('workspace');
    const params = h.callsOf('turn/start')[0]!.params as Record<string, unknown>;
    expect(params['approvalPolicy']).toBeUndefined();
    expect(params['sandboxPolicy']).toBeUndefined();
    h.engine.dispose();
  });

  test('自定义过的工作区沙箱不算「工作区」档', async () => {
    const h = harness({
      resume: true,
      routes: {
        'thread/resume': () => ({
          approvalPolicy: 'on-request',
          sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: false },
        }),
      },
    });
    h.session.send('c1', 'a');
    await h.flush();
    expect(h.session.meta().engineMode).toBeUndefined();
    h.engine.dispose();
  });

  test('用户明确切模式后才带覆盖', async () => {
    const h = harness({ resume: true });
    await h.session.setPermissionMode('default', 'read-only');
    h.session.send('c1', 'a');
    await h.flush();
    expect(h.callsOf('turn/start')[0]!.params).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } });
    h.engine.dispose();
  });
});

describe('CodexSession · 竞态（评审回归）', () => {
  /** 卡住某个方法，直到手动放行 */
  function gated(method: string) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { gate, release: () => release(), method };
  }

  function harnessWithGate(method: string, result: unknown, options: { resume?: boolean } = {}) {
    const g = gated(method);
    const server: FakeAppServer = new FakeAppServer({
      'turn/start': () => ({ turn: { id: 'turn-1' } }),
      'turn/interrupt': () => ({}),
      'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
      'thread/resume': () => ({ approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } }),
    });
    const spawn: typeof server.spawn = (handlers) => {
      const inner = server.spawn(handlers);
      return {
        kill: inner.kill,
        send: (line) => {
          const message = JSON.parse(line) as { id?: number; method?: string };
          if (message.method !== method) {
            inner.send(line);
            return;
          }
          server.calls.push({ method, params: message });
          void g.gate.then(() => handlers.onLine(JSON.stringify({ id: message.id, result })));
        },
      };
    };
    const engine = new CodexEngine({ spawn, clientOptions: { idleMs: 60_000 } });
    const events: EventBody[] = [];
    const session = engine.createSession({
      sessionId: THREAD,
      cwd: '/s',
      model: 'm',
      permissionMode: 'default',
      resume: options.resume === true,
      emit: (body) => events.push(body),
    });
    const count = (m: string) => server.calls.filter((c) => c.method === m).length;
    return { g, server, engine, session, events, count };
  }

  test('等待续接时关闭：不再发 turn/start', async () => {
    const h = harnessWithGate('thread/resume', { approvalPolicy: 'never' }, { resume: true });
    h.session.send('c1', 'a');
    await Bun.sleep(5);
    await h.session.close('reap');
    h.g.release();
    await Bun.sleep(5);
    expect(h.count('turn/start')).toBe(0);
    h.engine.dispose();
  });

  test('进程退出后的迟到异常不会算到新一轮头上', async () => {
    const h = harnessWithGate('turn/start', { turn: { id: 't' } });
    h.session.send('c1', 'a');
    await Bun.sleep(5);
    h.server.handlers!.onExit();
    await Bun.sleep(5);
    const fatals = h.events.filter((e) => e.type === 'error.fatal');
    expect(fatals).toHaveLength(1);
    h.engine.dispose();
  });

  test('turn id 没到时停止，紧接着发消息：不撤销停止，到手后补一次中断', async () => {
    const h = harnessWithGate('turn/start', { turn: { id: 'turn-1' } });
    h.session.send('c1', 'a');
    await Bun.sleep(5);
    await h.session.stop();
    h.session.send('c2', 'b');
    expect(h.count('turn/interrupt')).toBe(0);
    h.g.release();
    await Bun.sleep(5);
    expect(h.count('turn/interrupt')).toBe(1);
    h.engine.dispose();
  });

  test('新实例接管后，旧实例关闭不解绑、不卸载', async () => {
    const h = harness();
    const next = h.engine.createSession({
      sessionId: THREAD,
      cwd: '/s',
      model: 'm',
      permissionMode: 'default',
      resume: true,
      emit: (body) => h.events.push(body),
    });
    await h.session.close('reap');
    expect(h.callsOf('thread/unsubscribe')).toEqual([]);
    next.send('c1', 'a');
    await h.flush();
    h.notify('item/agentMessage/delta', { itemId: 'm', delta: 'still routed' });
    expect(h.of('assistant.delta')[0]?.text).toBe('still routed');
    h.engine.dispose();
  });

  test('重复的完成通知不会结束新一轮', async () => {
    const h = harness();
    h.session.send('c1', 'a');
    await h.flush();
    h.notify('turn/started', { turn: { id: 'turn-1' } });
    h.session.send('c2', 'b');
    await h.finish('turn-1');
    expect(h.session.state).toBe('running');
    const doneBefore = h.of('run.done').length;
    // 第二轮的 turn id 假装还没到（清掉）：重复通知仍要被认出来
    h.notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    await h.flush();
    expect(h.of('run.done').length).toBe(doneBefore);
    expect(h.session.state).toBe('running');
    h.engine.dispose();
  });
});

describe('toUserInput', () => {
  test('纯文本', () => {
    expect(toUserInput('hi', undefined)).toEqual([{ type: 'text', text: 'hi', text_elements: [] }]);
  });

  test('内容块：文本与内联图片；文件路径已在文本块里', () => {
    const out = toUserInput('hi', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'hi\n<attached-files>/a.pdf</attached-files>' },
    ] as never);
    expect(out).toEqual([
      { type: 'image', url: 'data:image/png;base64,AAAA' },
      { type: 'text', text: 'hi\n<attached-files>/a.pdf</attached-files>', text_elements: [] },
    ]);
  });

  test('认不出的块跳过；全认不出时退回文本', () => {
    expect(toUserInput('hi', [{ type: 'mystery' }] as never)).toEqual([{ type: 'text', text: 'hi', text_elements: [] }]);
  });
});


describe('CodexSession · 压缩', () => {
  test('/compact 走 thread/compact/start，不发 turn/start；一轮结束后正常收尾', async () => {
    const h = harness({ routes: { 'thread/compact/start': () => ({}) } });
    h.session.send('c1', '/compact ');
    await h.flush();
    expect(h.callsOf('thread/compact/start')).toHaveLength(1);
    expect(h.callsOf('turn/start')).toHaveLength(0);
    expect(h.of('user.message')[0]).toMatchObject({ messageId: 'c1', text: '/compact ' });
    h.notify('turn/started', { turn: { id: 'compact-turn' } });
    h.notify('item/started', { item: { type: 'contextCompaction', id: 'k1' } });
    h.notify('item/completed', { item: { type: 'contextCompaction', id: 'k1' } });
    await h.finish('compact-turn');
    expect(h.of('tool.start')[0]).toMatchObject({ toolName: 'Compact' });
    expect(h.of('tool.end')[0]).toMatchObject({ toolUseId: 'k1', status: 'ok' });
    expect(h.of('run.done')).toHaveLength(1);
    expect(h.session.state).toBe('idle');
    // 命令不能当标题
    expect(h.session.meta().firstPrompt).toBeUndefined();
  });

  test('压缩进行中发的消息排队，压缩结束才 turn/start（Codex 会拒绝并行）', async () => {
    const h = harness({ routes: { 'thread/compact/start': () => ({}) } });
    h.session.send('c1', '/compact');
    await h.flush();
    h.session.send('c2', 'next');
    await h.flush();
    expect(h.callsOf('turn/start')).toHaveLength(0);
    h.notify('turn/started', { turn: { id: 'compact-turn' } });
    await h.finish('compact-turn');
    expect(h.callsOf('turn/start')).toHaveLength(1);
  });

  test('压缩中可以停止：turn id 来自 turn/started', async () => {
    const h = harness({ routes: { 'thread/compact/start': () => ({}) } });
    h.session.send('c1', '/compact');
    await h.flush();
    h.notify('turn/started', { turn: { id: 'compact-turn' } });
    await h.session.stop();
    expect(h.callsOf('turn/interrupt')[0]?.params).toMatchObject({ turnId: 'compact-turn' });
  });

  test('turn/started 之前点的停止：等 id 到了补发中断', async () => {
    const h = harness({ routes: { 'thread/compact/start': () => ({}) } });
    h.session.send('c1', '/compact');
    await h.flush();
    await h.session.stop();
    expect(h.callsOf('turn/interrupt')).toHaveLength(0);
    h.notify('turn/started', { turn: { id: 'compact-turn' } });
    await h.flush();
    expect(h.callsOf('turn/interrupt')[0]?.params).toMatchObject({ turnId: 'compact-turn' });
  });

  test('带参数或附件的不是压缩命令', async () => {
    const h = harness({ routes: { 'thread/compact/start': () => ({}) } });
    h.session.send('c1', '/compact 只保留结论');
    await h.flush();
    expect(h.callsOf('thread/compact/start')).toHaveLength(0);
    expect(h.callsOf('turn/start')).toHaveLength(1);
    const withFile = harness({ routes: { 'thread/compact/start': () => ({}) } });
    withFile.session.send('c1', '/compact', {
      content: '/compact\n\n附件：/synthetic/a.txt',
      attachments: [{ blobId: 'b', name: 'a.txt', mimeType: 'text/plain', size: 1 }],
    } as never);
    await withFile.flush();
    expect(withFile.callsOf('thread/compact/start')).toHaveLength(0);
    expect(withFile.callsOf('turn/start')).toHaveLength(1);
  });

  test('压缩失败按这一轮失败处理，不会卡在运行中', async () => {
    const h = harness({
      routes: {
        'thread/compact/start': () => {
          throw new Error('compact boom');
        },
      },
    });
    h.session.send('c1', '/compact');
    await h.flush();
    expect(h.of('error.fatal')[0]).toMatchObject({ message: expect.stringContaining('compact boom') });
    expect(h.session.state).toBe('error');
  });
});

describe('CodexSession · skills', () => {
  const routes = {
    'skills/list': () => ({
      data: [
        {
          cwd: '/synthetic',
          errors: [],
          skills: [
            { name: 'review', description: 'd', path: '/synthetic/.agents/skills/review/SKILL.md', scope: 'repo', enabled: true },
            { name: 'off', description: 'd', path: '/synthetic/off/SKILL.md', scope: 'repo', enabled: false },
          ],
        },
      ],
    }),
  };
  const inputOf = (h: ReturnType<typeof harness>) => (h.callsOf('turn/start')[0]?.params as { input: unknown[] }).input;

  test('/name 和 $name 都按 Codex 的形式调用', async () => {
    for (const text of ['/review 看看这个', '$review 看看这个']) {
      const h = harness({ routes });
      h.session.send('c1', text);
      await h.flush();
      expect(inputOf(h)).toEqual([
        { type: 'text', text: '$review 看看这个', text_elements: [] },
        { type: 'skill', name: 'review', path: '/synthetic/.agents/skills/review/SKILL.md' },
      ]);
    }
  });

  test('不是 skill、已禁用、路径、列表读不到：都原样发', async () => {
    for (const text of ['/nope hi', '/off hi', '/tmp/review hi', 'review hi']) {
      const h = harness({ routes });
      h.session.send('c1', text);
      await h.flush();
      expect(inputOf(h)).toEqual([{ type: 'text', text, text_elements: [] }]);
    }
    const broken = harness({
      routes: {
        'skills/list': () => {
          throw new Error('boom');
        },
      },
    });
    broken.session.send('c1', '/review hi');
    await broken.flush();
    expect(inputOf(broken)).toEqual([{ type: 'text', text: '/review hi', text_elements: [] }]);
  });

  test('普通消息不查 skill 列表', async () => {
    const h = harness({ routes });
    h.session.send('c1', 'hello');
    await h.flush();
    expect(h.callsOf('skills/list')).toHaveLength(0);
  });
});

describe('CodexSession · 推理强度', () => {
  const models = {
    'account/read': () => ({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true }),
    'model/list': () => ({
      data: [
        { id: 'gpt-x', displayName: 'X', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'ultra' }] },
        { id: 'gpt-y', displayName: 'Y', hidden: false, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
      ],
    }),
  };

  test('没选过就不传；选了之后每轮都带', async () => {
    const h = harness({ routes: models });
    await h.engine.refresh();
    h.session.send('c1', 'one');
    await h.flush();
    expect(h.callsOf('turn/start')[0]?.params).not.toHaveProperty('effort');
    await h.finish();
    await h.session.setEffort('ultra');
    expect(h.session.meta().effort).toBe('ultra');
    h.session.send('c2', 'two');
    await h.flush();
    expect(h.callsOf('turn/start')[1]?.params).toMatchObject({ effort: 'ultra' });
  });

  test('「默认」写成模型默认值：不传撤销不了之前的选择', async () => {
    const h = harness({ routes: models });
    await h.engine.refresh();
    await h.session.setEffort('ultra');
    await h.session.setEffort(undefined);
    expect(h.session.meta().effort).toBe('medium');
  });

  test('模型不支持的强度不采用；换到不支持当前强度的模型回到它的默认值', async () => {
    const h = harness({ routes: models });
    await h.engine.refresh();
    await h.session.setEffort('low');
    await h.session.setEffort('nonsense');
    expect(h.session.meta().effort).toBe('low');
    await h.session.setEffort('ultra');
    await h.session.setModel('gpt-y');
    expect(h.session.meta().effort).toBe('low');
  });

  test('续接时如实显示 thread 自己的强度，但不拿它覆盖', async () => {
    const h = harness({
      resume: true,
      routes: { 'thread/resume': () => ({ approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' }, model: 'm', reasoningEffort: 'xhigh' }) },
    });
    h.session.send('c1', 'hi');
    await h.flush();
    expect(h.session.meta().effort).toBe('xhigh');
    expect(h.session.effort).toBeUndefined();
    expect(h.callsOf('turn/start')[0]?.params).not.toHaveProperty('effort');
  });
});

describe('CodexSession · 回退', () => {
  const items = [
    { turnId: 't1', item: { type: 'userMessage', id: 'u1', clientId: 'c1', content: [{ type: 'text', text: '第一条' }] } },
    { turnId: 't1', item: { type: 'agentMessage', id: 'a1', text: 'ok' } },
    { turnId: 't2', item: { type: 'userMessage', id: 'u2', clientId: 'c2', content: [{ type: 'text', text: '第二条' }] } },
    { turnId: 't2', item: { type: 'userMessage', id: 'u3', content: [{ type: 'text', text: '追加' }] } },
  ];
  const routes = { 'thread/items/list': () => ({ data: items, nextCursor: null }), 'thread/revert': () => ({ thread: {} }) };

  test('预览不加载 thread、不改东西；文件部分明确不可用', async () => {
    const h = harness({ resume: true, routes });
    const preview = await h.session.previewThreadRewind('c2');
    expect(preview).toMatchObject({ ok: true, text: '第二条', conversation: { available: true }, files: { available: false } });
    expect(h.callsOf('thread/resume')).toHaveLength(0);
    expect(h.callsOf('thread/revert')).toHaveLength(0);
  });

  test('按 clientId 或 item id 都能定位；回退前先加载 thread，广播全部 id', async () => {
    const h = harness({ resume: true, routes });
    const done = await h.session.rewindThread('c2', 'conversation');
    expect(h.callsOf('thread/resume')).toHaveLength(1);
    expect(h.callsOf('thread/revert')[0]?.params).toEqual({ threadId: THREAD, beforeTurnId: 't2' });
    expect(done).toMatchObject({ ok: true, text: '第二条', rewound: { mode: 'conversation', targetMessageIds: ['c2', 'u2'] } });
    const byItemId = harness({ routes });
    expect(await byItemId.session.rewindThread('u1', 'conversation')).toMatchObject({ ok: true, rewound: { targetMessageIds: ['u1', 'c1'] } });
    expect(byItemId.callsOf('thread/revert')[0]?.params).toMatchObject({ beforeTurnId: 't1' });
  });

  test('还原文件的模式一律拒绝，绝不调 revert（旧标签页）', async () => {
    const h = harness({ routes });
    for (const mode of ['both', 'code'] as const) {
      expect(await h.session.rewindThread('c2', mode)).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    }
    expect(h.callsOf('thread/revert')).toHaveLength(0);
  });

  test('一轮中追加的消息不能作为回退点：整轮都会被撤掉', async () => {
    const h = harness({ routes });
    expect(await h.session.rewindThread('u3', 'conversation')).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(h.callsOf('thread/revert')).toHaveLength(0);
  });

  test('找不到、运行中、有排队：拒绝', async () => {
    const h = harness({ routes });
    expect(await h.session.rewindThread('nope', 'conversation')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    h.session.send('c9', 'run');
    await h.flush();
    expect(await h.session.rewindThread('c1', 'conversation')).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(await h.session.previewThreadRewind('c1')).toMatchObject({ ok: false, error: { code: 'busy' } });
    h.session.send('c10', 'queued');
    await h.finish();
    await h.flush();
    expect(h.callsOf('thread/revert')).toHaveLength(0);
  });

  test('等待期间实例被回收：不再加载、不再回退', async () => {
    const h = harness({ resume: true, routes });
    const pending = h.session.rewindThread('c1', 'conversation');
    await h.session.close();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(h.callsOf('thread/resume')).toHaveLength(0);
    expect(h.callsOf('thread/revert')).toHaveLength(0);
  });

  test('legacy thread（-32601）说明不支持；revert 失败把原因带回来', async () => {
    const legacy = harness({
      routes: {
        'thread/items/list': () => {
          throw Object.assign(new Error('not supported yet'), { code: -32601 });
        },
      },
    });
    expect(await legacy.session.previewThreadRewind('c1')).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    const writer = harness({
      routes: {
        ...routes,
        'thread/revert': () => {
          throw new Error('already has an active writer');
        },
      },
    });
    expect(await writer.session.rewindThread('c1', 'conversation')).toMatchObject({
      ok: false,
      error: { code: 'io', message: expect.stringContaining('active writer') },
    });
  });
});

describe('CodexSession · 子 agent thread（spike S2）', () => {
  const CHILD = 'thread-child-1';
  /** thread/read：子 thread 有昵称与父级；陌生 thread 查不到 */
  const threadRoutes = (extra: Record<string, Record<string, unknown>> = {}): Record<string, FakeRoute> => ({
    'thread/read': (params) => {
      const id = (params as { threadId: string }).threadId;
      if (id === CHILD) return { thread: { id: CHILD, parentThreadId: THREAD, agentNickname: 'Meitner', agentRole: null, model: 'other-model' } };
      const found = extra[id];
      if (found !== undefined) return { thread: { id, ...found } };
      throw Object.assign(new Error('thread not loaded'), { code: -32600 });
    },
  });

  /** 起一轮并派生一个子 agent（v2：subAgentActivity started 就是派生） */
  async function spawned(extra: Record<string, Record<string, unknown>> = {}) {
    const h = harness({ routes: threadRoutes(extra) });
    h.session.send('c1', 'go');
    await h.flush();
    h.notify('turn/started', { turn: { id: 'turn-1', rootTurnId: 'turn-1', status: 'inProgress' } });
    const item = { type: 'subAgentActivity', id: 'call_spawn', kind: 'started', agentThreadId: CHILD, agentPath: '/root/probe', model: 'm-1' };
    h.notify('item/started', { turnId: 'turn-1', item });
    h.notify('item/completed', { turnId: 'turn-1', item });
    await h.flush();
    const child = (method: string, params: Record<string, unknown> = {}) => h.notify(method, { threadId: CHILD, ...params });
    const childRequest = (id: number, method: string, params: Record<string, unknown> = {}) => h.request(id, method, { threadId: CHILD, ...params });
    const card = () => h.of('tool.start').filter((e) => e.toolUseId === 'call_spawn').at(-1)!;
    return { ...h, child, childRequest, card };
  }

  test('派生卡：带子 thread / 模型 / 运行中；昵称从子 thread 读，模型以派生时给的为准', async () => {
    const h = await spawned();
    const starts = h.of('tool.start').filter((e) => e.toolUseId === 'call_spawn');
    expect(starts[0]).toMatchObject({ toolName: 'SubAgent', argSummary: '派生子 agent · probe', subagent: { agentId: CHILD, model: 'm-1', state: 'running' } });
    expect(h.of('tool.end').find((e) => e.toolUseId === 'call_spawn')).toMatchObject({ status: 'ok', resultSummary: '已派生' });
    expect(h.card().subagent).toMatchObject({ nickname: 'Meitner', model: 'm-1', state: 'running' });
    for (const body of h.events) {
      expect(AgentToClientEventSchema.safeParse({ ...body, ts: 1, seq: 1, dir: 'a2c', sessionId: THREAD }).success).toBe(true);
    }
    h.engine.dispose();
  });

  test('子 thread 的审批：卡挂本会话、标来源；回复带原请求 id；子 thread 的 turn/completed 不结束父轮', async () => {
    const h = await spawned();
    h.child('turn/started', { turn: { id: 'child-turn-1', rootTurnId: 'turn-1', status: 'inProgress' } });
    h.child('item/started', { item: { type: 'commandExecution', id: 'exec-1', command: "zsh -lc 'touch x'", status: 'inProgress', commandActions: [] } });
    h.childRequest(41, 'item/commandExecution/requestApproval', { turnId: 'child-turn-1', itemId: 'exec-1', command: "/usr/bin/zsh -lc 'touch x'", availableDecisions: ['accept', 'decline'] });
    await h.flush();
    const [req] = h.of('permission.request');
    expect(req).toMatchObject({ toolName: 'Shell', input: { command: 'touch x' }, parentToolUseId: 'call_spawn' });
    // 子 thread 的 item 不出卡（完整嵌套过程是后续）
    expect(h.of('tool.start').some((e) => e.toolUseId === 'exec-1')).toBe(false);
    expect(h.session.state).toBe('waiting_permission');
    // 同一请求重放：不出第二张卡
    h.childRequest(41, 'item/commandExecution/requestApproval', { turnId: 'child-turn-1', itemId: 'exec-1', command: 'x' });
    await h.flush();
    expect(h.of('permission.request')).toHaveLength(1);

    expect(h.session.respondPermission({ requestId: req!.requestId, verdict: 'allow' })).toBe(true);
    expect(h.replyTo(41)).toEqual({ id: 41, result: { decision: 'accept' } });
    expect(h.session.state).toBe('running');
    // 迟到 / 重复的回复：不再生效
    expect(h.session.respondPermission({ requestId: req!.requestId, verdict: 'deny' })).toBe(false);

    h.child('turn/completed', { turn: { id: 'child-turn-1', status: 'completed', error: null } });
    await h.flush();
    expect(h.of('run.done')).toHaveLength(0);
    expect(h.session.state).toBe('running');
    expect(h.card().subagent?.state).toBe('completed');
    // 父 thread 上的 completed 动态并进派生卡，不另出卡
    h.notify('item/started', { item: { type: 'subAgentActivity', id: 'done-1', kind: 'completed', agentThreadId: CHILD, agentPath: '/root/probe' } });
    h.notify('item/completed', { item: { type: 'subAgentActivity', id: 'done-1', kind: 'completed', agentThreadId: CHILD, agentPath: '/root/probe' } });
    await h.finish();
    expect(h.of('tool.start').some((e) => e.toolUseId === 'done-1')).toBe(false);
    expect(h.of('tool.end').some((e) => e.toolUseId === 'done-1')).toBe(false);
    expect(h.of('run.done')).toHaveLength(1);
    h.engine.dispose();
  });

  test('撤销按请求所属 thread：子 thread 的 serverRequest/resolved / turn/completed 只作废子请求；父轮结束不作废子请求', async () => {
    const h = await spawned();
    h.childRequest(5, 'item/commandExecution/requestApproval', { turnId: 'ct', command: 'a' });
    h.request(5, 'item/commandExecution/requestApproval', { turnId: 'turn-1', command: 'b' });
    await h.flush();
    const [childReq, ownReq] = h.of('permission.request');
    // 同一个请求 id、不同 thread：只撤子 thread 的
    h.child('serverRequest/resolved', { requestId: 5 });
    await h.flush();
    expect(h.of('permission.invalidated').map((e) => e.requestId)).toEqual([childReq!.requestId]);
    h.session.respondPermission({ requestId: ownReq!.requestId, verdict: 'allow' });

    h.childRequest(6, 'item/commandExecution/requestApproval', { turnId: 'ct2', command: 'c' });
    await h.flush();
    const late = h.of('permission.request').at(-1)!;
    await h.finish();
    // 父轮结束：子 agent 的请求还挂着，会话仍是等待批准
    expect(h.of('permission.invalidated').some((e) => e.requestId === late.requestId)).toBe(false);
    expect(h.session.state).toBe('waiting_permission');
    h.child('turn/completed', { turn: { id: 'ct2', status: 'completed', error: null } });
    await h.flush();
    expect(h.of('permission.invalidated').at(-1)).toMatchObject({ requestId: late.requestId, reason: '子 agent 的这一轮已结束' });
    expect(h.session.state).toBe('idle');
    h.engine.dispose();
  });

  test('子 thread 改文件审批：diff 取自子 thread 的 item/started', async () => {
    const h = await spawned();
    h.child('item/started', { item: { type: 'fileChange', id: 'fc-1', status: 'inProgress', changes: [{ path: '/w/a.txt', diff: '+x' }] } });
    h.childRequest(9, 'item/fileChange/requestApproval', { turnId: 'ct', itemId: 'fc-1' });
    await h.flush();
    expect(h.of('permission.request')[0]).toMatchObject({ toolName: 'Edit', input: { file_path: '/w/a.txt', new_string: '+x' }, parentToolUseId: 'call_spawn' });
    h.engine.dispose();
  });

  test('归属未知的 thread：rootTurnId 对上当前轮即认亲；否则限时 thread/read 上溯；都查不到回 -32601', async () => {
    const h = await spawned({ 'thread-grand': { parentThreadId: CHILD }, 'thread-stray': { parentThreadId: 'thread-elsewhere' } });
    // rootTurnId 认亲（不经派生 item）
    h.notify('turn/started', { threadId: 'thread-sib', turn: { id: 'sib-turn', rootTurnId: 'turn-1', status: 'inProgress' } });
    h.request(21, 'item/commandExecution/requestApproval', { threadId: 'thread-sib', turnId: 'sib-turn', command: 'a' });
    await h.flush();
    expect(h.of('permission.request')).toHaveLength(1);
    expect(h.of('permission.request')[0]!.parentToolUseId).toBeUndefined();
    // 孙辈：thread/read 上溯到子 thread，再到本会话；来源标到子 agent 的派生卡
    h.request(22, 'item/commandExecution/requestApproval', { threadId: 'thread-grand', turnId: 'g', command: 'b' });
    await h.flush();
    await h.flush();
    expect(h.of('permission.request')).toHaveLength(2);
    // 查不到活跃会话：不猜，回 -32601
    h.request(23, 'item/commandExecution/requestApproval', { threadId: 'thread-stray', command: 'c' });
    h.request(24, 'item/commandExecution/requestApproval', { threadId: 'thread-nobody', command: 'd' });
    await h.flush();
    await h.flush();
    expect(h.of('permission.request')).toHaveLength(2);
    expect(h.replyTo(23)).toMatchObject({ id: 23, error: { code: -32601 } });
    expect(h.replyTo(24)).toMatchObject({ id: 24, error: { code: -32601 } });
    h.engine.dispose();
  });

  test('会话关闭后子 thread 的通知与请求不再路由', async () => {
    const h = await spawned();
    await h.session.close();
    const before = h.events.length;
    h.child('turn/completed', { turn: { id: 'ct', status: 'completed' } });
    h.childRequest(31, 'item/commandExecution/requestApproval', { command: 'x' });
    await h.flush();
    expect(h.events.length).toBe(before);
    expect(h.replyTo(31)).toMatchObject({ error: { code: -32601 } });
    h.engine.dispose();
  });
});

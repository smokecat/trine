import { describe, expect, test } from 'bun:test';
import {
  AgentToClientEventSchema,
  assertEnvelopeBinding,
  CLAUDE_UPDATE_OUTPUT_MAX,
  ClientToAgentEventSchema,
  E2eEventSchema,
  EnvelopeBindingError,
  decodeTransportFrame,
  encodeTransportFrame,
  RelayFrameSchema,
  TransportFrameSchema,
  type E2eEvent,
} from './index.ts';
import { SessionMetaSchema } from '../types/index.ts';

const ts = Date.now();

/** 每帧通用绑定字段（见 events.ts 文件头「信封绑定」） */
const a2c = { ts, seq: 1, dir: 'a2c', sessionId: 's1' } as const;
const c2a = { ts, seq: 1, dir: 'c2a', sessionId: 's1' } as const;

describe('E2E 事件帧', () => {
  test('assistant.delta 合法帧通过并保留字段', () => {
    const frame = {
      type: 'assistant.delta',
      ...a2c,
      messageId: 'm1',
      text: 'hello',
    };
    const parsed = AgentToClientEventSchema.parse(frame);
    expect(parsed).toEqual(frame as never);
  });

  test('tool.end 校验 status 枚举', () => {
    const ok = {
      type: 'tool.end',
      ...a2c,
      toolUseId: 't1',
      status: 'ok',
      durationMs: 3500,
      resultSummary: '✓ +9 −2',
      outputPreview: 'tail...',
    };
    expect(AgentToClientEventSchema.parse(ok).type).toBe('tool.end');
    expect(() =>
      AgentToClientEventSchema.parse({ ...ok, status: 'fine' }),
    ).toThrow();
  });

  test('permission.respond：remember 只接受 session 作用域', () => {
    const respond = {
      type: 'permission.respond',
      ...c2a,
      requestId: 'r1',
      verdict: 'allow',
      remember: { scope: 'session', pattern: 'Bash(git *)' },
    };
    expect(ClientToAgentEventSchema.parse(respond).type).toBe(
      'permission.respond',
    );
    expect(() =>
      ClientToAgentEventSchema.parse({
        ...respond,
        remember: { scope: 'forever', pattern: '*' },
      }),
    ).toThrow();
  });

  test('permission.resolved：updatedInput 可选且向后兼容', () => {
    const base = { type: 'permission.resolved', ...a2c, requestId: 'r1', verdict: 'allow' };
    // 旧 agent：不发这个字段，照常解析
    expect(AgentToClientEventSchema.parse(base).type).toBe('permission.resolved');
    // 新 agent：带上实际批准的那份 input（任意 JSON 值都要能过——
    // 它就是 SDK 的工具入参，schema 不该替各工具定形状）
    for (const updatedInput of [
      { command: 'ls -la' },
      { file_path: '/a', content: 'x' },
      'string',
      42,
      null,
      [1, 2],
    ]) {
      const parsed = AgentToClientEventSchema.parse({ ...base, updatedInput });
      expect((parsed as { updatedInput?: unknown }).updatedInput).toEqual(updatedInput);
    }
  });

  test('run.heartbeat：currentTool 可省略，phase 枚举受限', () => {
    const hb = {
      type: 'run.heartbeat',
      ...a2c,
      runElapsedMs: 12000,
      silentMs: 1500,
      phase: 'run',
    };
    expect(AgentToClientEventSchema.parse(hb).type).toBe('run.heartbeat');
    expect(() =>
      AgentToClientEventSchema.parse({ ...hb, phase: 'sleep' }),
    ).toThrow();
  });

  test('req/resp 帧要求 reqId', () => {
    expect(() =>
      ClientToAgentEventSchema.parse({ type: 'session.status.request', ...c2a }),
    ).toThrow();
    const req = { type: 'session.status.request', ...c2a, reqId: 'q1' };
    expect(ClientToAgentEventSchema.parse(req).type).toBe(
      'session.status.request',
    );
  });

  test('session.history.request：limit 1..500、before 可选', () => {
    const req = { type: 'session.history.request', ...c2a, reqId: 'h1' };
    expect(ClientToAgentEventSchema.parse(req).type).toBe('session.history.request');
    expect(ClientToAgentEventSchema.parse({ ...req, before: 'msg_1', limit: 500 })).toMatchObject({
      before: 'msg_1',
      limit: 500,
    });
    expect(() => ClientToAgentEventSchema.parse({ ...req, limit: 0 })).toThrow();
    expect(() => ClientToAgentEventSchema.parse({ ...req, limit: 501 })).toThrow();
    expect(() => ClientToAgentEventSchema.parse({ ...req, limit: 1.5 })).toThrow();
    expect(() => ClientToAgentEventSchema.parse({ ...req, before: '' })).toThrow();
    // 方向钉死
    expect(() => AgentToClientEventSchema.parse({ ...req, dir: 'a2c' })).toThrow();
  });

  test('session.history.response：三种 HistoryItem 判别联合', () => {
    const res = {
      type: 'session.history.response',
      ...a2c,
      reqId: 'h1',
      hasMore: true,
      nextBefore: 'u1',
      items: [
        { kind: 'user', id: 'u1', text: 'hi', ts: 1 },
        { kind: 'assistant', id: 'msg_1', text: 'hello', ts: 2 },
        {
          kind: 'tool',
          id: 'toolu_1',
          toolName: 'Bash',
          argSummary: 'ls',
          status: 'error',
          durationMs: 12,
          resultSummary: '✗ boom',
          outputPreview: 'boom',
          ts: 3,
        },
        { kind: 'tool', id: 'toolu_2', toolName: 'Read', argSummary: 'a.ts', ts: 4 },
      ],
    };
    expect(AgentToClientEventSchema.parse(res)).toEqual(res as never);
    expect(AgentToClientEventSchema.parse({ ...res, hasMore: false, nextBefore: undefined }).type).toBe(
      'session.history.response',
    );
    const bad = (item: unknown) => ({ ...res, items: [item] });
    expect(() => AgentToClientEventSchema.parse(bad({ kind: 'thinking', id: 'x', text: '', ts: 1 }))).toThrow();
    expect(() => AgentToClientEventSchema.parse(bad({ kind: 'user', id: '', text: '', ts: 1 }))).toThrow();
    expect(() => AgentToClientEventSchema.parse(bad({ kind: 'user', id: 'u', text: '', ts: 1.5 }))).toThrow();
    expect(() =>
      AgentToClientEventSchema.parse(bad({ kind: 'tool', id: 't', toolName: 'X', argSummary: '', status: 'fine', ts: 1 })),
    ).toThrow();
    expect(() => AgentToClientEventSchema.parse({ ...res, hasMore: undefined })).toThrow();
    expect(() => ClientToAgentEventSchema.parse({ ...res, dir: 'c2a' })).toThrow();
  });

  test('session.commands.request/response：reqId 必填、方向钉死、source 枚举', () => {
    const req = { type: 'session.commands.request', ...c2a, reqId: 'c1' };
    expect(ClientToAgentEventSchema.parse(req)).toEqual(req as never);
    expect(() => ClientToAgentEventSchema.parse({ ...req, reqId: undefined })).toThrow();
    expect(() => AgentToClientEventSchema.parse({ ...req, dir: 'a2c' })).toThrow();

    const res = {
      type: 'session.commands.response',
      ...a2c,
      reqId: 'c1',
      slashCommands: [
        { name: 'babysit-pr', description: 'Monitor a PR', source: 'project' },
        { name: 'compact', source: 'project' },
      ],
    };
    expect(AgentToClientEventSchema.parse(res)).toEqual(res as never);
    expect(AgentToClientEventSchema.parse({ ...res, slashCommands: [] }).type).toBe(
      'session.commands.response',
    );
    expect(() =>
      AgentToClientEventSchema.parse({ ...res, slashCommands: [{ name: '', source: 'project' }] }),
    ).toThrow();
    expect(() =>
      AgentToClientEventSchema.parse({ ...res, slashCommands: [{ name: 'x', source: 'weird' }] }),
    ).toThrow();
    expect(() => AgentToClientEventSchema.parse({ ...res, slashCommands: undefined })).toThrow();
    expect(() => ClientToAgentEventSchema.parse({ ...res, dir: 'c2a' })).toThrow();
  });

  test('方向划分：input.send 属 client→agent，不属 agent→client', () => {
    const frame = {
      type: 'input.send',
      ...c2a,
      clientMsgId: 'c1',
      text: 'hi',
    };
    expect(ClientToAgentEventSchema.parse(frame).type).toBe('input.send');
    expect(() => AgentToClientEventSchema.parse(frame)).toThrow();
    // 合集入口两个方向都收
    expect(E2eEventSchema.parse(frame).type).toBe('input.send');
  });

  test('input.send：可以只带附件，但文本和附件不能都空', () => {
    const ref = {
      name: 'shot.png',
      mime: 'image/png',
      size: 1234,
      kind: 'image',
      blobId: 'b'.repeat(22),
      key: 'k'.repeat(43),
    };
    const base = { type: 'input.send', ...c2a, clientMsgId: 'c1' };
    expect(ClientToAgentEventSchema.parse({ ...base, text: '', attachments: [ref] }).type).toBe('input.send');
    expect(ClientToAgentEventSchema.parse({ ...base, text: 'hi', attachments: [ref] }).type).toBe('input.send');
    expect(() => ClientToAgentEventSchema.parse({ ...base, text: '' })).toThrow();
    expect(() => ClientToAgentEventSchema.parse({ ...base, text: '', attachments: [] })).toThrow();
    // 引用格式：blobId 只许 URL 安全字符（relay 拼路径用），key 必须是 32 字节 base64url
    expect(() =>
      ClientToAgentEventSchema.parse({ ...base, text: 'x', attachments: [{ ...ref, blobId: '../../etc/passwd' }] }),
    ).toThrow();
    expect(() =>
      ClientToAgentEventSchema.parse({ ...base, text: 'x', attachments: [{ ...ref, key: 'short' }] }),
    ).toThrow();
    expect(() =>
      ClientToAgentEventSchema.parse({ ...base, text: 'x', attachments: Array(33).fill(ref) }),
    ).toThrow();
  });

  test('attachment.fetch 请求与应答', () => {
    const req = { type: 'attachment.fetch.request', ...c2a, reqId: 'r1', messageId: 'u1', index: 0 };
    expect(ClientToAgentEventSchema.parse(req).type).toBe('attachment.fetch.request');
    expect(() => ClientToAgentEventSchema.parse({ ...req, index: -1 })).toThrow();
    const res = {
      type: 'attachment.fetch.response',
      ...a2c,
      reqId: 'r1',
      ok: false,
      error: { code: 'not_found', message: 'gone' },
    };
    expect(AgentToClientEventSchema.parse(res).type).toBe('attachment.fetch.response');
  });

  test('未知事件类型被拒绝', () => {
    expect(() => E2eEventSchema.parse({ type: 'nope.unknown', ...a2c })).toThrow();
  });

  test('session.create 校验 permissionMode 含 bypassPermissions（决策 9）', () => {
    const frame = {
      type: 'session.create',
      ...c2a,
      reqId: 'q2',
      cwd: '/home/u/proj',
      model: 'claude-sonnet-5',
      permissionMode: 'bypassPermissions',
    };
    expect(ClientToAgentEventSchema.parse(frame).type).toBe('session.create');
  });
});

describe('E2E 帧的信封绑定字段', () => {
  const delta = (over: Record<string, unknown> = {}) => ({
    type: 'assistant.delta',
    ...a2c,
    messageId: 'm1',
    text: 'hi',
    ...over,
  });

  test('seq 必带且非负——密文内 seq 是可信来源', () => {
    const { seq: _drop, ...noSeq } = delta();
    expect(() => AgentToClientEventSchema.parse(noSeq)).toThrow();
    expect(() => AgentToClientEventSchema.parse(delta({ seq: -1 }))).toThrow();
    expect(() => AgentToClientEventSchema.parse(delta({ seq: 1.5 }))).toThrow();
  });

  test('sessionId 可省略（机器级事件），但不接受空串', () => {
    const machineLevel = {
      type: 'machine.info',
      ts,
      seq: 3,
      dir: 'a2c',
      info: {
        name: 'mbp-m3',
        platform: 'darwin',
        osVersion: '25.5.0',
        agentVersion: '0.1.0',
        claudeVersion: '2.0.0',
        activeSessionCount: 1,
      },
    };
    expect(AgentToClientEventSchema.parse(machineLevel).type).toBe(
      'machine.info',
    );
    expect(() =>
      AgentToClientEventSchema.parse(delta({ sessionId: '' })),
    ).toThrow();
  });

  test('dir 由 schema 钉死：a2c 帧不接受 c2a，反之亦然', () => {
    expect(() => AgentToClientEventSchema.parse(delta({ dir: 'c2a' }))).toThrow();
    expect(() => AgentToClientEventSchema.parse(delta({ dir: 'x' }))).toThrow();
    const { dir: _drop, ...noDir } = delta();
    expect(() => AgentToClientEventSchema.parse(noDir)).toThrow();

    const send = {
      type: 'input.send',
      ...c2a,
      clientMsgId: 'c1',
      text: 'hi',
    };
    expect(() =>
      ClientToAgentEventSchema.parse({ ...send, dir: 'a2c' }),
    ).toThrow();
  });
});

describe('assertEnvelopeBinding', () => {
  const event = E2eEventSchema.parse({
    type: 'assistant.delta',
    ts,
    seq: 9,
    dir: 'a2c',
    sessionId: 's1',
    messageId: 'm1',
    text: 'hi',
  });
  const envelope = { sessionId: 's1', seq: 9 };

  test('一致时通过（client 期望 a2c）', () => {
    expect(() => assertEnvelopeBinding(event, envelope, 'a2c')).not.toThrow();
  });

  test('反射：本端期望 c2a 却收到 a2c 帧 → dir 失败', () => {
    let caught: unknown;
    try {
      assertEnvelopeBinding(event, envelope, 'c2a');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EnvelopeBindingError);
    expect((caught as EnvelopeBindingError).reason).toBe('dir');
  });

  test('跨会话拼接：信封 sessionId 与密文不符 → sessionId 失败', () => {
    let caught: unknown;
    try {
      assertEnvelopeBinding(event, { sessionId: 's2', seq: 9 }, 'a2c');
    } catch (e) {
      caught = e;
    }
    expect((caught as EnvelopeBindingError).reason).toBe('sessionId');
  });

  test('信封省略 sessionId 而密文带（或反之）也算不符', () => {
    expect(() => assertEnvelopeBinding(event, { seq: 9 }, 'a2c')).toThrow(
      EnvelopeBindingError,
    );
    const machineLevel = E2eEventSchema.parse({
      type: 'machine.unpair',
      ts,
      seq: 2,
      dir: 'c2a',
    });
    expect(() =>
      assertEnvelopeBinding(machineLevel, { seq: 2 }, 'c2a'),
    ).not.toThrow();
    expect(() =>
      assertEnvelopeBinding(machineLevel, { sessionId: 's1', seq: 2 }, 'c2a'),
    ).toThrow(EnvelopeBindingError);
  });

  test('重放：服务端改信封 seq → seq 失败（密文内的才作数）', () => {
    let caught: unknown;
    try {
      assertEnvelopeBinding(event, { sessionId: 's1', seq: 100 }, 'a2c');
    } catch (e) {
      caught = e;
    }
    expect((caught as EnvelopeBindingError).reason).toBe('seq');
  });

  test('校验顺序：dir 先于 sessionId 与 seq 归因', () => {
    let caught: unknown;
    try {
      assertEnvelopeBinding(event, { sessionId: 's9', seq: 99 }, 'c2a');
    } catch (e) {
      caught = e;
    }
    expect((caught as EnvelopeBindingError).reason).toBe('dir');
  });

  test('与 relay 信封串起来用：解密侧只取信封的路由字段', () => {
    const relay = RelayFrameSchema.parse({
      type: 'relay',
      machineId: 'mbp-m3',
      sessionId: 's1',
      seq: 9,
      nonce: 'bm9uY2U',
      ciphertext: 'Y2lwaGVy',
    });
    const decrypted: E2eEvent = event;
    expect(() =>
      assertEnvelopeBinding(
        decrypted,
        { sessionId: relay.sessionId, seq: relay.seq },
        'a2c',
      ),
    ).not.toThrow();
  });
});

describe('session.create 的 response 关联', () => {
  const session = {
    sessionId: 's-new',
    title: '新会话',
    state: 'idle',
    lastActivityAt: ts,
    cwd: '/home/u/proj',
    model: 'claude-sonnet-5',
    permissionMode: 'default',
    costUsd: 0,
  };

  test('response 以 reqId 关联发起端的 session.create', () => {
    const req = ClientToAgentEventSchema.parse({
      type: 'session.create',
      ...c2a,
      sessionId: undefined,
      reqId: 'q-create-1',
      cwd: '/home/u/proj',
      model: 'claude-sonnet-5',
      permissionMode: 'default',
    });
    const resp = AgentToClientEventSchema.parse({
      type: 'session.create.response',
      ts,
      seq: 2,
      dir: 'a2c',
      reqId: 'q-create-1',
      session,
    });
    expect(resp.type).toBe('session.create.response');
    if (req.type !== 'session.create' || resp.type !== 'session.create.response') {
      throw new Error('unreachable');
    }
    expect(resp.reqId).toBe(req.reqId);
    expect(resp.session.sessionId).toBe('s-new');
  });

  test('response 缺 reqId 被拒；且属 agent→client 方向', () => {
    const base = {
      type: 'session.create.response',
      ts,
      seq: 2,
      dir: 'a2c',
      session,
    };
    expect(() => AgentToClientEventSchema.parse(base)).toThrow();
    expect(() =>
      ClientToAgentEventSchema.parse({ ...base, reqId: 'q1', dir: 'c2a' }),
    ).toThrow();
  });

  test('session.created 广播不带 reqId，保持不变', () => {
    const created = AgentToClientEventSchema.parse({
      type: 'session.created',
      ts,
      seq: 3,
      dir: 'a2c',
      session,
    });
    expect(created.type).toBe('session.created');
    expect(created).not.toHaveProperty('reqId');
  });
});

describe('会话元数据命令（session-list-v2）', () => {
  const machineA2c = { ts, seq: 1, dir: 'a2c' } as const;

  test('SessionMeta 新增字段全部可选：旧形状照过，新字段保留', () => {
    const base = {
      sessionId: 's1',
      title: 't',
      state: 'idle',
      lastActivityAt: 1,
      cwd: '/r',
      model: 'm',
      permissionMode: 'default',
      costUsd: 0,
    };
    const old = { type: 'session.updated', ...machineA2c, session: base };
    expect(AgentToClientEventSchema.parse(old)).toEqual(old as never);
    const full = {
      ...old,
      session: {
        ...base,
        archived: true,
        archivedAt: 5,
        createdAt: 2,
        gitBranch: 'main',
        firstPrompt: 'hello',
      },
    };
    expect(AgentToClientEventSchema.parse(full)).toEqual(full as never);
    expect(() =>
      AgentToClientEventSchema.parse({ ...full, session: { ...full.session, archivedAt: -1 } }),
    ).toThrow();
  });

  test('rename / archive / delete：c2a、会话级（sessionId 必带）、要求 reqId', () => {
    const frames = [
      { type: 'session.rename', ...c2a, reqId: 'q1', title: '部署脚本' },
      { type: 'session.archive', ...c2a, reqId: 'q2', archived: true },
      { type: 'session.delete', ...c2a, reqId: 'q3' },
    ];
    for (const frame of frames) {
      expect(ClientToAgentEventSchema.parse(frame)).toEqual(frame as never);
      expect(E2eEventSchema.parse(frame).type as string).toBe(frame.type);
      // 方向钉死：不属 a2c
      expect(AgentToClientEventSchema.safeParse(frame).success).toBe(false);
      // reqId 必带
      const { reqId: _reqId, ...noReq } = frame;
      expect(ClientToAgentEventSchema.safeParse(noReq).success).toBe(false);
      // sessionId 必带（这些命令不能当机器级帧发）
      const { sessionId: _sid, ...noSid } = frame;
      expect(ClientToAgentEventSchema.safeParse(noSid).success).toBe(false);
    }
    // title 允许任意字符串（规范化与判空在 agent 侧做，拒绝走 invalid 应答）
    expect(
      ClientToAgentEventSchema.safeParse({ type: 'session.rename', ...c2a, reqId: 'q', title: '' }).success,
    ).toBe(true);
    expect(
      ClientToAgentEventSchema.safeParse({ type: 'session.archive', ...c2a, reqId: 'q', archived: 'yes' })
        .success,
    ).toBe(false);
  });

  test('session.mutate.response：机器级（无 sessionId）、目标会话在 targetSessionId、error.code 封闭枚举', () => {
    const ok = { type: 'session.mutate.response', ...machineA2c, reqId: 'q1', targetSessionId: 's1', ok: true };
    expect(AgentToClientEventSchema.parse(ok)).toEqual(ok as never);
    for (const code of ['busy', 'not_found', 'not_archived', 'invalid', 'io', 'deleted']) {
      const fail = { ...ok, ok: false, error: { code, message: 'x' } };
      expect(AgentToClientEventSchema.parse(fail)).toEqual(fail as never);
    }
    expect(
      AgentToClientEventSchema.safeParse({ ...ok, ok: false, error: { code: 'nope', message: 'x' } }).success,
    ).toBe(false);
    const { reqId: _r, ...noReq } = ok;
    expect(AgentToClientEventSchema.safeParse(noReq).success).toBe(false);
    const { targetSessionId: _t, ...noTarget } = ok;
    expect(AgentToClientEventSchema.safeParse(noTarget).success).toBe(false);
    expect(ClientToAgentEventSchema.safeParse({ ...ok, dir: 'c2a' }).success).toBe(false);
  });

  test('session.removed：机器级广播，带 targetSessionId', () => {
    const frame = { type: 'session.removed', ...machineA2c, targetSessionId: 's1' };
    expect(AgentToClientEventSchema.parse(frame)).toEqual(frame as never);
    expect(AgentToClientEventSchema.safeParse({ ...frame, targetSessionId: '' }).success).toBe(false);
    // 机器级帧与信封「都省略 sessionId」才通过绑定校验
    const parsed = E2eEventSchema.parse(frame);
    expect(() => assertEnvelopeBinding(parsed, { seq: 1 }, 'a2c')).not.toThrow();
  });
});

describe('后台任务（background-tasks）', () => {
  test('bgtask.snapshot：a2c、会话级、tasks 为 BgTask 数组（可空）', () => {
    const task = {
      taskId: 't1',
      kind: 'bash',
      description: 'sleep 25',
      status: 'running',
      startedAt: ts,
      toolUseId: 'toolu_1',
    };
    const frame = { type: 'bgtask.snapshot', ...a2c, tasks: [task] };
    expect(AgentToClientEventSchema.parse(frame)).toEqual(frame as never);
    expect(AgentToClientEventSchema.safeParse({ type: 'bgtask.snapshot', ...a2c, tasks: [] }).success).toBe(true);
    // 结束态可带 endedAt / summary / 进度字段
    const done = { ...task, status: 'completed', endedAt: ts + 1, summary: 'ok', lastToolName: 'Bash', toolUses: 2, durationMs: 10 };
    expect(AgentToClientEventSchema.safeParse({ type: 'bgtask.snapshot', ...a2c, tasks: [done] }).success).toBe(true);
    // kind / status 封闭枚举；summary 限长
    expect(AgentToClientEventSchema.safeParse({ type: 'bgtask.snapshot', ...a2c, tasks: [{ ...task, kind: 'shell' }] }).success).toBe(false);
    expect(AgentToClientEventSchema.safeParse({ type: 'bgtask.snapshot', ...a2c, tasks: [{ ...task, status: 'killed' }] }).success).toBe(false);
    expect(
      AgentToClientEventSchema.safeParse({ type: 'bgtask.snapshot', ...a2c, tasks: [{ ...task, summary: 'x'.repeat(201) }] }).success,
    ).toBe(false);
    // 方向钉死
    expect(ClientToAgentEventSchema.safeParse(frame).success).toBe(false);
  });

  test('bgtask.stop：c2a、要求 reqId 与 taskId', () => {
    const frame = { type: 'bgtask.stop', ...c2a, reqId: 'r1', taskId: 't1' };
    expect(ClientToAgentEventSchema.parse(frame)).toEqual(frame as never);
    expect(ClientToAgentEventSchema.safeParse({ type: 'bgtask.stop', ...c2a, taskId: 't1' }).success).toBe(false);
    expect(ClientToAgentEventSchema.safeParse({ type: 'bgtask.stop', ...c2a, reqId: 'r1', taskId: '' }).success).toBe(false);
    expect(AgentToClientEventSchema.safeParse(frame).success).toBe(false);
  });

  test('SessionMeta.bgRunning 可选、非负整数；run.state running 可带 detail', () => {
    const base = {
      sessionId: 's1',
      title: 't',
      state: 'idle',
      lastActivityAt: ts,
      cwd: '/x',
      model: 'm',
      permissionMode: 'default',
      costUsd: 0,
    };
    const ok = { type: 'session.updated', ...a2c, sessionId: undefined, session: { ...base, bgRunning: 2 } };
    expect(AgentToClientEventSchema.safeParse(ok).success).toBe(true);
    expect(AgentToClientEventSchema.safeParse({ ...ok, session: { ...base, bgRunning: -1 } }).success).toBe(false);
    expect(AgentToClientEventSchema.safeParse({ ...ok, session: base }).success).toBe(true);
    const running = { type: 'run.state', ...a2c, state: 'running', detail: '后台任务“x”已完成' };
    expect(AgentToClientEventSchema.parse(running)).toEqual(running as never);
  });
});

describe('子 agent 过程（subagent-view）', () => {
  test('tool.start / tool.end 可带 parentToolUseId（非空串），省略即主线程', () => {
    const start = { type: 'tool.start', ...a2c, toolUseId: 't2', toolName: 'Bash', argSummary: 'echo', parentToolUseId: 'toolu_parent' };
    expect(AgentToClientEventSchema.parse(start)).toEqual(start as never);
    const end = { type: 'tool.end', ...a2c, toolUseId: 't2', status: 'ok', durationMs: 5, resultSummary: '✓', parentToolUseId: 'toolu_parent' };
    expect(AgentToClientEventSchema.parse(end)).toEqual(end as never);
    expect(AgentToClientEventSchema.safeParse({ ...start, parentToolUseId: '' }).success).toBe(false);
    const { parentToolUseId: _p, ...plain } = start;
    expect(AgentToClientEventSchema.safeParse(plain).success).toBe(true);
  });

  test('permission.request 可带 parentToolUseId', () => {
    const frame = {
      type: 'permission.request',
      ...a2c,
      requestId: 'p1',
      toolName: 'Write',
      input: { file_path: '/x' },
      requestedAt: ts,
      parentToolUseId: 'toolu_parent',
    };
    expect(AgentToClientEventSchema.parse(frame)).toEqual(frame as never);
    expect(AgentToClientEventSchema.safeParse({ ...frame, parentToolUseId: '' }).success).toBe(false);
  });

  test('subagent.history.request：c2a、会话级、要求 reqId 与 toolUseId', () => {
    const frame = { type: 'subagent.history.request', ...c2a, reqId: 'r1', toolUseId: 'toolu_parent' };
    expect(ClientToAgentEventSchema.parse(frame)).toEqual(frame as never);
    expect(ClientToAgentEventSchema.safeParse({ ...frame, toolUseId: '' }).success).toBe(false);
    expect(ClientToAgentEventSchema.safeParse({ type: 'subagent.history.request', ...c2a, toolUseId: 'x' }).success).toBe(false);
    expect(AgentToClientEventSchema.safeParse(frame).success).toBe(false);
  });

  test('subagent.history.response：a2c、items 为 HistoryItem、truncated 可选', () => {
    const frame = {
      type: 'subagent.history.response',
      ...a2c,
      reqId: 'r1',
      toolUseId: 'toolu_parent',
      items: [
        { kind: 'tool', id: 'toolu_c1', toolName: 'Bash', argSummary: 'echo SUB1', status: 'ok', durationMs: 3, resultSummary: '✓ SUB1', ts },
        { kind: 'assistant', id: 'msg_1', text: 'done', ts },
      ],
    };
    expect(AgentToClientEventSchema.parse(frame)).toEqual(frame as never);
    expect(AgentToClientEventSchema.safeParse({ ...frame, items: [], truncated: true }).success).toBe(true);
    expect(ClientToAgentEventSchema.safeParse(frame).success).toBe(false);
  });
});

describe('排队消息出队（input.cancelled）', () => {
  test('a2c、要求 clientMsgId、reason 封闭枚举', () => {
    for (const reason of ['recalled', 'stopped', 'closed']) {
      const frame = { type: 'input.cancelled', ...a2c, clientMsgId: 'c1', reason };
      expect(AgentToClientEventSchema.parse(frame)).toEqual(frame as never);
      expect(ClientToAgentEventSchema.safeParse(frame).success).toBe(false);
    }
    const base = { type: 'input.cancelled', ...a2c, clientMsgId: 'c1' };
    expect(AgentToClientEventSchema.safeParse({ ...base, reason: 'expired' }).success).toBe(false);
    expect(AgentToClientEventSchema.safeParse({ ...base, clientMsgId: '', reason: 'recalled' }).success).toBe(false);
    expect(AgentToClientEventSchema.safeParse(base).success).toBe(false);
  });
});

describe('回退（rewind）', () => {
  test('user.message 可带 uuid（非空串），省略照过', () => {
    const frame = { type: 'user.message', ...a2c, messageId: 'c1', clientMsgId: 'c1', text: 'hi', uuid: 'u-1' };
    expect(AgentToClientEventSchema.parse(frame)).toEqual(frame as never);
    expect(AgentToClientEventSchema.safeParse({ ...frame, uuid: '' }).success).toBe(false);
    const { uuid: _u, ...plain } = frame;
    expect(AgentToClientEventSchema.safeParse(plain).success).toBe(true);
  });

  test('session.rewind.preview / session.rewind：c2a、要求 reqId 与 targetMessageId、mode 封闭枚举', () => {
    const preview = { type: 'session.rewind.preview', ...c2a, reqId: 'r1', targetMessageId: 'u-1' };
    expect(ClientToAgentEventSchema.parse(preview)).toEqual(preview as never);
    expect(ClientToAgentEventSchema.safeParse({ ...preview, targetMessageId: '' }).success).toBe(false);
    expect(AgentToClientEventSchema.safeParse(preview).success).toBe(false);

    for (const mode of ['both', 'conversation', 'code']) {
      const frame = { type: 'session.rewind', ...c2a, reqId: 'r2', targetMessageId: 'u-1', mode };
      expect(ClientToAgentEventSchema.parse(frame)).toEqual(frame as never);
    }
    expect(
      ClientToAgentEventSchema.safeParse({ type: 'session.rewind', ...c2a, reqId: 'r2', targetMessageId: 'u-1', mode: 'all' }).success,
    ).toBe(false);
    expect(ClientToAgentEventSchema.safeParse({ type: 'session.rewind', ...c2a, reqId: 'r2', targetMessageId: 'u-1' }).success).toBe(false);
  });

  test('session.rewind.preview.response：成功带两部分可用性，失败带 error', () => {
    const ok = {
      type: 'session.rewind.preview.response',
      ...a2c,
      reqId: 'r1',
      ok: true,
      text: '改一下 README',
      conversation: { available: true },
      files: { available: true, filesChanged: ['README.md'], insertions: 3, deletions: 1 },
    };
    expect(AgentToClientEventSchema.parse(ok)).toEqual(ok as never);
    const noFiles = { ...ok, conversation: { available: false, reason: '第一条消息' }, files: { available: false, reason: '没有快照' } };
    expect(AgentToClientEventSchema.parse(noFiles)).toEqual(noFiles as never);
    const failed = { type: 'session.rewind.preview.response', ...a2c, reqId: 'r1', ok: false, error: { code: 'busy', message: '运行中' } };
    expect(AgentToClientEventSchema.parse(failed)).toEqual(failed as never);
    expect(AgentToClientEventSchema.safeParse({ ...failed, error: { code: 'nope', message: 'x' } }).success).toBe(false);
    expect(ClientToAgentEventSchema.safeParse(ok).success).toBe(false);
  });

  test('session.rewind.response 与 session.rewound：a2c、会话级', () => {
    const res = {
      type: 'session.rewind.response',
      ...a2c,
      reqId: 'r2',
      ok: true,
      text: 'hi',
      files: { filesChanged: ['a.txt'], insertions: 0, deletions: 2, skippedLinks: 0 },
    };
    expect(AgentToClientEventSchema.parse(res)).toEqual(res as never);
    expect(AgentToClientEventSchema.safeParse({ ...res, files: { ...res.files, insertions: -1 } }).success).toBe(false);

    const rewound = { type: 'session.rewound', ...a2c, targetMessageIds: ['u-1', 'c1'], mode: 'both', filesChanged: 1 };
    expect(AgentToClientEventSchema.parse(rewound)).toEqual(rewound as never);
    expect(AgentToClientEventSchema.safeParse({ ...rewound, targetMessageIds: [] }).success).toBe(false);
    expect(ClientToAgentEventSchema.safeParse(rewound).success).toBe(false);
  });
});

describe('远程更新 claude（claude-update）', () => {
  const machineA2c = { ts, seq: 1, dir: 'a2c' } as const;
  const machineC2a = { ts, seq: 1, dir: 'c2a' } as const;

  test('machine.claude.update.request：c2a、机器级、要求 reqId', () => {
    const frame = { type: 'machine.claude.update.request', ...machineC2a, reqId: 'q1' };
    expect(ClientToAgentEventSchema.parse(frame)).toEqual(frame as never);
    expect(AgentToClientEventSchema.safeParse(frame).success).toBe(false);
    const { reqId: _r, ...noReq } = frame;
    expect(ClientToAgentEventSchema.safeParse(noReq).success).toBe(false);
    const parsed = E2eEventSchema.parse(frame);
    expect(() => assertEnvelopeBinding(parsed, { seq: 1 }, 'c2a')).not.toThrow();
  });

  test('machine.claude.update.response：成功 / 各失败码 / 输出长度上限', () => {
    const ok = {
      type: 'machine.claude.update.response',
      ...machineA2c,
      reqId: 'q1',
      ok: true,
      fromVersion: '2.1.251 (Claude Code)',
      toVersion: '2.1.282 (Claude Code)',
      output: 'Successfully updated',
    };
    expect(AgentToClientEventSchema.parse(ok)).toEqual(ok as never);
    const truncated = { ...ok, output: 'x'.repeat(CLAUDE_UPDATE_OUTPUT_MAX), outputTruncated: true };
    expect(AgentToClientEventSchema.parse(truncated)).toEqual(truncated as never);
    expect(
      AgentToClientEventSchema.safeParse({ ...ok, output: 'x'.repeat(CLAUDE_UPDATE_OUTPUT_MAX + 1) }).success,
    ).toBe(false);
    for (const code of ['busy', 'not_found', 'timeout', 'failed']) {
      const fail = { ...ok, ok: false, error: { code, message: 'x' } };
      expect(AgentToClientEventSchema.parse(fail)).toEqual(fail as never);
    }
    expect(
      AgentToClientEventSchema.safeParse({ ...ok, ok: false, error: { code: 'nope', message: 'x' } }).success,
    ).toBe(false);
    for (const field of ['reqId', 'fromVersion', 'toVersion', 'output'] as const) {
      const { [field]: _omit, ...rest } = ok;
      expect(AgentToClientEventSchema.safeParse(rest).success).toBe(false);
    }
    expect(ClientToAgentEventSchema.safeParse({ ...ok, dir: 'c2a' }).success).toBe(false);
  });
});

describe('用量展示（usage-display）', () => {
  const machineA2c = { ts, seq: 1, dir: 'a2c' } as const;
  const machineC2a = { ts, seq: 1, dir: 'c2a' } as const;
  const info = {
    name: 'mbp-m3',
    platform: 'darwin',
    osVersion: '25.5.0',
    agentVersion: '0.12.0',
    claudeVersion: '2.1.304 (Claude Code)',
    activeSessionCount: 1,
  };

  test('MachineInfo.rateLimits 可选；窗口的 resetsAt 可省略', () => {
    const rateLimits = {
      fiveHour: { percent: 62, resetsAt: 1_792_478_400_000 },
      sevenDay: { percent: 15 },
      updatedAt: 1_792_470_000_000,
    };
    const frame = { type: 'machine.info', ...machineA2c, info: { ...info, rateLimits } };
    expect(AgentToClientEventSchema.parse(frame)).toEqual(frame as never);
    expect(AgentToClientEventSchema.parse({ type: 'machine.info', ...machineA2c, info }).type).toBe('machine.info');
    const bad = { ...frame, info: { ...info, rateLimits: { ...rateLimits, fiveHour: { percent: -1 } } } };
    expect(AgentToClientEventSchema.safeParse(bad).success).toBe(false);
    const { updatedAt: _u, ...noUpdatedAt } = rateLimits;
    expect(AgentToClientEventSchema.safeParse({ ...frame, info: { ...info, rateLimits: noUpdatedAt } }).success).toBe(false);
  });

  test('SessionMeta.context 可选；超窗时百分比可 > 100，maxTokens 不能为 0', () => {
    const meta = {
      sessionId: 's1',
      title: 't',
      state: 'idle',
      lastActivityAt: 1,
      cwd: '/work/demo',
      model: 'sonnet',
      permissionMode: 'default',
      costUsd: 0,
    };
    const context = { usedTokens: 210_000, maxTokens: 200_000, percent: 105, at: 2 };
    expect(SessionMetaSchema.parse({ ...meta, context })).toEqual({ ...meta, context } as never);
    expect(SessionMetaSchema.parse(meta)).toEqual(meta as never);
    expect(SessionMetaSchema.safeParse({ ...meta, context: { ...context, maxTokens: 0 } }).success).toBe(false);
  });

  test('session.context.request / response：会话级、带 reqId；成功带 context，失败带错误码', () => {
    const req = { type: 'session.context.request', ...c2a, reqId: 'q1' };
    expect(ClientToAgentEventSchema.parse(req)).toEqual(req as never);
    expect(AgentToClientEventSchema.safeParse(req).success).toBe(false);
    const ok = {
      type: 'session.context.response',
      ...a2c,
      reqId: 'q1',
      ok: true,
      context: { usedTokens: 48_448, maxTokens: 1_000_000, percent: 4.8, at: 1 },
    };
    expect(AgentToClientEventSchema.parse(ok)).toEqual(ok as never);
    for (const code of ['not_found', 'failed']) {
      const fail = { type: 'session.context.response', ...machineA2c, reqId: 'q1', ok: false, error: { code, message: 'x' } };
      expect(AgentToClientEventSchema.parse(fail)).toEqual(fail as never);
    }
    expect(
      AgentToClientEventSchema.safeParse({ ...ok, ok: false, error: { code: 'busy', message: 'x' } }).success,
    ).toBe(false);
  });

  test('machine.usage.request / response：方向、reqId、失败码', () => {
    const req = { type: 'machine.usage.request', ...machineC2a, reqId: 'q1' };
    expect(ClientToAgentEventSchema.parse(req)).toEqual(req as never);
    expect(AgentToClientEventSchema.safeParse(req).success).toBe(false);
    expect(() => assertEnvelopeBinding(E2eEventSchema.parse(req), { seq: 1 }, 'c2a')).not.toThrow();

    const ok = { type: 'machine.usage.response', ...machineA2c, reqId: 'q1', ok: true };
    expect(AgentToClientEventSchema.parse(ok)).toEqual(ok as never);
    for (const code of ['unavailable', 'failed']) {
      const fail = { ...ok, ok: false, error: { code, message: 'x' } };
      expect(AgentToClientEventSchema.parse(fail)).toEqual(fail as never);
    }
    expect(AgentToClientEventSchema.safeParse({ ...ok, ok: false, error: { code: 'nope', message: 'x' } }).success).toBe(false);
    const { reqId: _r, ...noReq } = ok;
    expect(AgentToClientEventSchema.safeParse(noReq).success).toBe(false);
  });

  test('machine.stats.request / machine.stats：watch 范围、各块可选', () => {
    const req = { type: 'machine.stats.request', ...machineC2a, reqId: 'q1', watch: { intervalMs: 5000, ttlMs: 120_000 } };
    expect(ClientToAgentEventSchema.parse(req)).toEqual(req as never);
    expect(ClientToAgentEventSchema.parse({ ...req, watch: { intervalMs: 5000, ttlMs: 0 } })).toBeDefined();
    expect(ClientToAgentEventSchema.safeParse({ ...req, watch: { intervalMs: 500, ttlMs: 1000 } }).success).toBe(false);
    const { watch: _w, ...once } = req;
    expect(ClientToAgentEventSchema.parse(once)).toEqual(once as never);

    const stats = {
      at: 1,
      cpu: { percent: 12.5, cores: 8, load: [1, 2, 3] },
      memory: { totalBytes: 100, usedBytes: 40 },
      disks: [{ label: '/', totalBytes: 10, usedBytes: 5, availBytes: 4 }],
      network: { rxBytesPerSec: 1, txBytesPerSec: 2 },
      uptimeSec: 9,
      claude: { processes: 2, rssBytes: 3 },
    };
    const ev = { type: 'machine.stats', ...machineA2c, reqId: 'q1', stats };
    expect(AgentToClientEventSchema.parse(ev)).toEqual(ev as never);
    const push = { type: 'machine.stats', ...machineA2c, stats: { at: 2 } };
    expect(AgentToClientEventSchema.parse(push)).toEqual(push as never);
    expect(
      AgentToClientEventSchema.safeParse({ ...ev, stats: { ...stats, cpu: { percent: 120, cores: 8 } } }).success,
    ).toBe(false);
  });
});

describe('Transport 帧', () => {
  const relay = {
    type: 'relay',
    machineId: 'mbp-m3',
    sessionId: 's1',
    seq: 42,
    nonce: 'bm9uY2U',
    ciphertext: 'Y2lwaGVy',
    pushHint: 'permission_pending',
  } as const;

  test('relay 信封 encode/decode 往返', () => {
    const decoded = decodeTransportFrame(encodeTransportFrame(relay));
    expect(decoded).toEqual(relay as never);
  });

  test('relay：sessionId 可省略（机器级事件），seq 必带且非负', () => {
    const { sessionId: _omit, ...machineLevel } = relay;
    expect(RelayFrameSchema.parse(machineLevel).machineId).toBe('mbp-m3');
    expect(() => RelayFrameSchema.parse({ ...relay, seq: -1 })).toThrow();
    expect(() => {
      const { seq: _s, ...noSeq } = relay;
      return RelayFrameSchema.parse(noSeq);
    }).toThrow();
  });

  test('pushHint 只接受脱敏事件类型（决策 6）', () => {
    expect(() =>
      RelayFrameSchema.parse({ ...relay, pushHint: '会话名泄露' }),
    ).toThrow();
  });

  test('recipientDeviceId：a2c 每收件人一帧，c2a 省略', () => {
    // a2c：同一逻辑事件对 N 个收件人各一帧，seq 相同、收件人不同——
    // 没有这个字段，服务端的 (machine, session, dir, seq) 会把它们判成重复
    const forPhone = RelayFrameSchema.parse({
      ...relay,
      recipientDeviceId: 'phone',
    });
    const forTablet = RelayFrameSchema.parse({
      ...relay,
      recipientDeviceId: 'tablet',
      ciphertext: 'Y2lwaGVyLTI',
    });
    expect(forPhone.seq).toBe(forTablet.seq);
    expect(forPhone.recipientDeviceId).not.toBe(forTablet.recipientDeviceId);
    expect(decodeTransportFrame(encodeTransportFrame(forPhone))).toEqual(
      forPhone as never,
    );

    // c2a：收件人天然是该 machineId 的 agent，省略而非写冗余值
    expect(RelayFrameSchema.parse(relay).recipientDeviceId).toBeUndefined();
  });

  test('recipientDeviceId 与 deviceId 同长度上限（登记主键的口径）', () => {
    expect(() =>
      RelayFrameSchema.parse({ ...relay, recipientDeviceId: '' }),
    ).toThrow();
    expect(() =>
      RelayFrameSchema.parse({ ...relay, recipientDeviceId: 'x'.repeat(129) }),
    ).toThrow();
    expect(
      RelayFrameSchema.parse({ ...relay, recipientDeviceId: 'x'.repeat(128) })
        .recipientDeviceId,
    ).toHaveLength(128);
  });

  test('sync.request / parked.count / machine.status', () => {
    expect(
      TransportFrameSchema.parse({
        type: 'sync.request',
        machineId: 'mbp-m3',
        sessionId: 's1',
        sinceSeq: 41,
      }).type,
    ).toBe('sync.request');
    expect(
      TransportFrameSchema.parse({
        type: 'parked.count',
        machineId: 'mbp-m3',
        parkedCount: 3,
      }).type,
    ).toBe('parked.count');
    expect(
      TransportFrameSchema.parse({
        type: 'machine.status',
        machineId: 'mbp-m3',
        online: true,
        lastSeenAt: ts,
      }).type,
    ).toBe('machine.status');
  });

  test('sync.request：sessionId 可省略 = 补发机器级帧', () => {
    const parsed = TransportFrameSchema.parse({
      type: 'sync.request',
      machineId: 'mbp-m3',
      sinceSeq: 7,
    });
    expect(parsed.type).toBe('sync.request');
    if (parsed.type !== 'sync.request') throw new Error('unreachable');
    expect(parsed.sessionId).toBeUndefined();
  });

  test('park.recall：server 可读的排队撤回帧（按 seq 定位）', () => {
    const recall = {
      type: 'park.recall',
      machineId: 'mbp-m3',
      sessionId: 's1',
      seq: 42,
    };
    expect(TransportFrameSchema.parse(recall).type).toBe('park.recall');
    // 往返
    expect(decodeTransportFrame(encodeTransportFrame(recall as never))).toEqual(
      recall as never,
    );
    // seq 是定位依据，不可缺
    const { seq: _s, ...noSeq } = recall;
    expect(() => TransportFrameSchema.parse(noSeq)).toThrow();
    expect(() =>
      TransportFrameSchema.parse({ ...recall, seq: -1 }),
    ).toThrow();
    // 排队帧总是会话级的，sessionId 必带
    const { sessionId: _sid, ...noSession } = recall;
    expect(() => TransportFrameSchema.parse(noSession)).toThrow();
  });

  test('park.expired：排队帧再也送不出去的告知', () => {
    const expired = {
      type: 'park.expired',
      machineId: 'mbp-m3',
      sessionId: 's1',
      seq: 42,
    };
    expect(TransportFrameSchema.parse(expired).type).toBe('park.expired');
    expect(decodeTransportFrame(encodeTransportFrame(expired as never))).toEqual(
      expired as never,
    );
    // seq 是 client 关联本地暂存消息的依据，不可缺
    const { seq: _s, ...noSeq } = expired;
    expect(() => TransportFrameSchema.parse(noSeq)).toThrow();
    // 排队帧总是会话级的
    const { sessionId: _sid, ...noSession } = expired;
    expect(() => TransportFrameSchema.parse(noSession)).toThrow();
  });

  test('relay.reject：被拒帧回执，让消息不再静默蒸发', () => {
    const reject = {
      type: 'relay.reject',
      machineId: 'mbp-m3',
      sessionId: 's1',
      seq: 42,
      reason: 'seq_not_monotonic',
    };
    expect(TransportFrameSchema.parse(reject).type).toBe('relay.reject');
    expect(decodeTransportFrame(encodeTransportFrame(reject as never))).toEqual(
      reject as never,
    );
  });

  test('relay：sessionId 有长度上限（它是服务端存储主键的一部分）', () => {
    const base = {
      type: 'relay',
      machineId: 'mbp-m3',
      seq: 1,
      nonce: 'bm9uY2U',
      ciphertext: 'Y2lwaGVy',
    };
    expect(RelayFrameSchema.parse({ ...base, sessionId: 'a'.repeat(128) }).sessionId).toHaveLength(128);
    expect(() => RelayFrameSchema.parse({ ...base, sessionId: 'a'.repeat(129) })).toThrow();
  });

  test('relay.reject：expectedAfter 可带可不带（旧服务端不带，新服务端 seq 类拒绝带）', () => {
    const withHwm = {
      type: 'relay.reject',
      machineId: 'mbp-m3',
      sessionId: 's1',
      seq: 3,
      reason: 'seq_not_monotonic',
      expectedAfter: 17,
    };
    const parsed = TransportFrameSchema.parse(withHwm);
    if (parsed.type !== 'relay.reject') throw new Error('unreachable');
    expect(parsed.expectedAfter).toBe(17);
    // 往返序列化不丢字段——发送方自愈全靠它
    expect(decodeTransportFrame(encodeTransportFrame(withHwm as never))).toEqual(
      withHwm as never,
    );
    // 不带也合法（向后兼容）
    const { expectedAfter: _drop, ...without } = withHwm;
    const legacy = TransportFrameSchema.parse(without);
    if (legacy.type !== 'relay.reject') throw new Error('unreachable');
    expect(legacy.expectedAfter).toBeUndefined();
    // 带了就必须是合法 seq（非负整数）
    expect(() =>
      TransportFrameSchema.parse({ ...withHwm, expectedAfter: -1 }),
    ).toThrow();
    expect(() =>
      TransportFrameSchema.parse({ ...withHwm, expectedAfter: 1.5 }),
    ).toThrow();
  });

  test('relay.reject：recipientDeviceId 原样回带（a2c 子流自愈定位用），c2a 省略', () => {
    const a2c = {
      type: 'relay.reject',
      machineId: 'mbp-m3',
      sessionId: 's1',
      recipientDeviceId: 'phone',
      seq: 3,
      reason: 'seq_not_monotonic',
      expectedAfter: 17,
    };
    expect(decodeTransportFrame(encodeTransportFrame(a2c as never))).toEqual(a2c as never);
    const { recipientDeviceId: _drop, ...c2a } = a2c;
    const parsed = TransportFrameSchema.parse(c2a);
    if (parsed.type !== 'relay.reject') throw new Error('unreachable');
    expect(parsed.recipientDeviceId).toBeUndefined();
  });

  test('relay.reject：sessionId 可省略（机器级帧被拒）', () => {
    const parsed = TransportFrameSchema.parse({
      type: 'relay.reject',
      machineId: 'mbp-m3',
      seq: 7,
      reason: 'seq_below_first',
    });
    expect(parsed.type).toBe('relay.reject');
    if (parsed.type !== 'relay.reject') throw new Error('unreachable');
    expect(parsed.sessionId).toBeUndefined();
  });

  test('relay.reject：reason 是封闭枚举', () => {
    const base = {
      type: 'relay.reject',
      machineId: 'mbp-m3',
      seq: 7,
    };
    for (const reason of [
      'seq_not_monotonic',
      'seq_below_first',
      'seq_too_far_ahead',
      'parked_quota_exceeded',
    ]) {
      expect(TransportFrameSchema.parse({ ...base, reason }).type).toBe(
        'relay.reject',
      );
    }
    expect(() =>
      TransportFrameSchema.parse({ ...base, reason: 'because_i_said_so' }),
    ).toThrow();
    // reason 不可缺——没有原因的拒绝对发送方毫无用处
    expect(() => TransportFrameSchema.parse(base)).toThrow();
  });

  test('park.recall 与 input.parked 回执的 seq 对得上', () => {
    const parked = TransportFrameSchema.parse({
      type: 'input.parked',
      machineId: 'mbp-m3',
      sessionId: 's1',
      seq: 42,
      expiresAt: ts + 86_400_000,
    });
    if (parked.type !== 'input.parked') throw new Error('unreachable');
    const recall = TransportFrameSchema.parse({
      type: 'park.recall',
      machineId: parked.machineId,
      sessionId: parked.sessionId,
      seq: parked.seq,
    });
    if (recall.type !== 'park.recall') throw new Error('unreachable');
    expect(recall.seq).toBe(parked.seq);
  });

  test('pair.begin 不再携带 clientName（明文最小化）', () => {
    const begin = {
      type: 'pair.begin',
      pairingToken: 'tok',
      clientPubKey: 'cHVia2V5',
      clientSignPubKey: 'c2lnbnB1YmtleQ',
      clientDeviceId: 'phone-1',
    };
    const parsed = TransportFrameSchema.parse(begin);
    expect(parsed.type).toBe('pair.begin');
    // 多余字段被 zod 剥掉，不会随明文帧转发出去
    expect(
      TransportFrameSchema.parse({ ...begin, clientName: 'Luke 的 iPhone' }),
    ).not.toHaveProperty('clientName');
  });

  test('pair.begin 必带两把公钥与 deviceId（D8：配对是两套密钥的交汇点）', () => {
    const begin = {
      type: 'pair.begin',
      pairingToken: 'tok',
      clientPubKey: 'cHVia2V5',
      clientSignPubKey: 'c2lnbnB1YmtleQ',
      clientDeviceId: 'phone-1',
    };
    expect(decodeTransportFrame(encodeTransportFrame(begin as never))).toEqual(
      begin as never,
    );
    // 缺任一字段都不成立：少了签名公钥就没法登记，少了 deviceId 就没有登记主键
    for (const missing of [
      'clientPubKey',
      'clientSignPubKey',
      'clientDeviceId',
    ]) {
      const { [missing]: _drop, ...rest } = begin as Record<string, unknown>;
      expect(() => TransportFrameSchema.parse(rest)).toThrow();
    }
  });

  test('pair.confirm 必带 agent 复述的 client 身份（背书式登记）', () => {
    const confirm = {
      type: 'pair.confirm',
      pairingToken: 'tok',
      clientDeviceId: 'phone-1',
      clientSignPubKey: 'c2lnbnB1YmtleQ',
    };
    expect(decodeTransportFrame(encodeTransportFrame(confirm as never))).toEqual(
      confirm as never,
    );
    // 不带复述身份的 confirm 无从背书，服务端也就无从登记
    for (const missing of ['clientDeviceId', 'clientSignPubKey']) {
      const { [missing]: _drop, ...rest } = confirm as Record<string, unknown>;
      expect(() => TransportFrameSchema.parse(rest)).toThrow();
    }
  });

  test('hello 接受免认证的 pairing 角色', () => {
    // 全新设备换不到 token，pairing 角色正是为它开的受限入口
    const pairing = TransportFrameSchema.parse({
      type: 'hello',
      v: 1,
      role: 'pairing',
      deviceId: 'brand-new-phone',
    });
    expect(pairing.type).toBe('hello');
    if (pairing.type !== 'hello') throw new Error('unreachable');
    expect(pairing.role).toBe('pairing');
    expect(pairing.authToken).toBeUndefined();
    // 角色仍是封闭枚举
    expect(() =>
      TransportFrameSchema.parse({
        type: 'hello',
        v: 1,
        role: 'admin',
        deviceId: 'x',
      }),
    ).toThrow();
  });

  test('decodeTransportFrame 拒绝非 JSON 与非法帧', () => {
    expect(() => decodeTransportFrame('not json')).toThrow();
    expect(() => decodeTransportFrame('{"type":"bogus"}')).toThrow();
  });
});

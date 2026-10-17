/**
 * ClaudeSession 集成测试：注入假的 SDK query，验证整条链路
 * （排队 → 事件流 → 完成 → 续跑 → 停止），不起真子进程。
 *
 * 假 query 模拟 SDK 的关键契约：
 * - `Query` 是 `AsyncGenerator<SDKMessage>`，会话层用 `.next()` 拉；
 * - 每轮以一条 `result` 消息收尾；
 * - 流式输入的 prompt 是 AsyncIterable，我们据此感知「收到了几条用户消息」。
 */
import { describe, expect, test } from 'bun:test';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeSession,
  createPushStream,
  type ClaudeSessionOptions,
  type SessionRuntimeMeta,
} from './session.ts';
import type { EventBody } from './types.ts';

/** 造一条 result 消息 */
function resultMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 100,
    duration_api_ms: 90,
    is_error: false,
    num_turns: 1,
    result: 'ok',
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: 'u',
    session_id: 's1',
    ...overrides,
  } as unknown as SDKMessage;
}

function assistantMessage(text: string, id = 'msg_1'): SDKMessage {
  return {
    type: 'assistant',
    message: { id, role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid: 'u',
    session_id: 's1',
  } as unknown as SDKMessage;
}

/**
 * 假 query 工厂。
 *
 * @param scripts 每轮（每条用户消息）要吐的消息序列；用完后最后一个脚本复用
 */
function fakeQueryFactory(scripts: SDKMessage[][]) {
  const calls: { options: Options | undefined; userMessages: SDKUserMessage[] }[] = [];
  let turnIndex = 0;

  const factory = (params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
  }): Query => {
    const record: { options: Options | undefined; userMessages: SDKUserMessage[] } = {
      options: params.options,
      userMessages: [],
    };
    calls.push(record);

    // 消费输入流，记录收到的用户消息
    const inputIterator =
      typeof params.prompt === 'string'
        ? undefined
        : params.prompt[Symbol.asyncIterator]();

    let queued: SDKMessage[] = [];
    let interrupted = false;

    const gen = {
      async next(): Promise<IteratorResult<SDKMessage, void>> {
        const pending = queued.shift();
        if (pending !== undefined) return { value: pending, done: false };
        if (interrupted) return { value: undefined, done: true };

        // 等下一条用户消息，然后按脚本吐这一轮
        const input = await inputIterator?.next();
        if (input === undefined || input.done === true) {
          return { value: undefined, done: true };
        }
        record.userMessages.push(input.value);
        const script = scripts[Math.min(turnIndex, scripts.length - 1)] ?? [];
        turnIndex += 1;
        queued = [...script];
        const first = queued.shift();
        if (first === undefined) return { value: undefined, done: true };
        return { value: first, done: false };
      },
      return(): Promise<IteratorResult<SDKMessage, void>> {
        return Promise.resolve({ value: undefined, done: true });
      },
      throw(err: unknown): Promise<IteratorResult<SDKMessage, void>> {
        return Promise.reject(err);
      },
      [Symbol.asyncIterator](): unknown {
        return gen;
      },
      interrupt(): Promise<undefined> {
        // 真 interrupt 只结束**当前 turn**，query 进程仍在、还能接下一条消息
        // （等价交互式的 Esc）。把它模拟成「丢掉本轮剩余脚本」，
        // 而不是让整个迭代器 done——后者是 close() 的语义。
        queued = [];
        return Promise.resolve(undefined);
      },
      setPermissionMode: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      close: () => {
        interrupted = true;
      },
    };

    // 假 Query 只实现会话层实际用到的成员（next/interrupt/close/setModel…），
    // 真 Query 有 25+ 个方法，全实现纯属噪音——所以经 unknown 转型。
    return gen as unknown as Query;
  };

  return { factory: factory as never, calls };
}

function makeSession(
  scripts: SDKMessage[][],
  overrides: Partial<ClaudeSessionOptions> = {},
) {
  const events: EventBody[] = [];
  const { factory, calls } = fakeQueryFactory(scripts);
  /** 续跑退避实际请求过的时长，测试据此断言退避曲线 */
  const sleeps: number[] = [];
  const session = new ClaudeSession({
    sessionId: 's1',
    cwd: '/tmp',
    model: 'claude-opus-4',
    permissionMode: 'default',
    emit: (body) => events.push(body),
    queryFn: factory,
    heartbeatIntervalMs: 999_999, // 测试里不让心跳自己跳
    // 假延时：记录时长但不真睡，否则 1s+2s+4s 的退避会把测试拖成 7 秒
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...overrides,
  });
  return { session, events, calls, sleeps };
}

/** 等到某个条件成立（假 SDK 是异步的，事件不是同步到齐的） */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await Bun.sleep(1);
  }
}

describe('ClaudeSession · SDK 配置对齐（硬约束）', () => {
  test('显式传 systemPrompt preset 与 settingSources', async () => {
    const { session, calls } = makeSession([[assistantMessage('hi'), resultMessage()]]);
    session.send('m1', '你好');
    await waitFor(() => calls.length > 0);

    const options = calls[0]!.options!;
    expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    await session.close();
  });

  test('给了 pathToClaudeCodeExecutable 就透传（全局 claude），不给则不出现该键（SDK 内置）', async () => {
    const withPath = makeSession([[resultMessage()]], { pathToClaudeCodeExecutable: '/home/u/.local/bin/claude' });
    withPath.session.send('m1', '你好');
    await waitFor(() => withPath.calls.length > 0);
    expect(withPath.calls[0]!.options!.pathToClaudeCodeExecutable).toBe('/home/u/.local/bin/claude');
    await withPath.session.close();

    const without = makeSession([[resultMessage()]]);
    without.session.send('m1', '你好');
    await waitFor(() => without.calls.length > 0);
    expect('pathToClaudeCodeExecutable' in without.calls[0]!.options!).toBe(false);
    await without.session.close();
  });

  test('开启 includePartialMessages 与 canUseTool（流式权限转发的前提）', async () => {
    const { session, calls } = makeSession([[resultMessage()]]);
    session.send('m1', '你好');
    await waitFor(() => calls.length > 0);

    const options = calls[0]!.options!;
    expect(options.includePartialMessages).toBe(true);
    expect(typeof options.canUseTool).toBe('function');
    expect(options.cwd).toBe('/tmp');
    expect(options.permissionMode).toBe('default');
    await session.close();
  });

  test('新建会话传 sessionId，resume 会话传 resume', async () => {
    const fresh = makeSession([[resultMessage()]]);
    fresh.session.send('m1', 'x');
    await waitFor(() => fresh.calls.length > 0);
    expect(fresh.calls[0]!.options!.sessionId).toBe('s1');
    expect(fresh.calls[0]!.options!.resume).toBeUndefined();
    await fresh.session.close();

    const resumed = makeSession([[resultMessage()]], { resume: true });
    resumed.session.send('m1', 'x');
    await waitFor(() => resumed.calls.length > 0);
    expect(resumed.calls[0]!.options!.resume).toBe('s1');
    await resumed.session.close();
  });
});

describe('ClaudeSession · 事件流', () => {
  test('一轮完整对话的事件序列', async () => {
    const { session, events } = makeSession([
      [assistantMessage('你好呀'), resultMessage()],
    ]);

    session.send('m1', '你好');
    await waitFor(() => events.some((e) => e.type === 'run.done'));

    const types = events.map((e) => e.type);
    // 用户回显 → 运行中 → 回复 → 完成 → 空闲
    expect(types).toContain('user.message');
    expect(types).toContain('run.state');
    expect(types).toContain('assistant.done');
    expect(types).toContain('run.done');

    const done = events.find((e) => e.type === 'assistant.done');
    expect(done).toMatchObject({ text: '你好呀' });
    await session.close();
  });

  test('回显带 clientMsgId 供发起端确认', async () => {
    const { session, events } = makeSession([[resultMessage()]]);
    session.send('m1', '你好');
    await waitFor(() => events.length > 0);

    expect(events[0]).toMatchObject({
      type: 'user.message',
      clientMsgId: 'm1',
      text: '你好',
    });
    await session.close();
  });

  test('run 结束回到 idle', async () => {
    const { session, events } = makeSession([[resultMessage()]]);
    session.send('m1', '你好');
    await waitFor(() => events.some((e) => e.type === 'run.done'));
    await waitFor(() => session.state === 'idle');

    const states = events.filter((e) => e.type === 'run.state').map((e) => (e as { state: string }).state);
    expect(states).toEqual(['running', 'idle']);
    await session.close();
  });

  test('成本累计到会话', async () => {
    const { session, events } = makeSession([
      [resultMessage({ total_cost_usd: 0.25 })],
    ]);
    session.send('m1', '你好');
    await waitFor(() => events.some((e) => e.type === 'run.done'));

    expect(session.costUsd).toBeCloseTo(0.25, 10);
    await session.close();
  });
});

describe('ClaudeSession · 排队与去重', () => {
  test('运行中发第二条 → input.queued 回执', async () => {
    // 第一轮吐 assistant 后卡住不给 result，直到第二条消息进来
    const { session, events } = makeSession([
      [assistantMessage('第一轮'), resultMessage()],
      [assistantMessage('第二轮'), resultMessage()],
    ]);

    session.send('m1', '第一条');
    session.send('m2', '第二条');

    await waitFor(() => events.some((e) => e.type === 'input.queued'));
    const queued = events.find((e) => e.type === 'input.queued');
    expect(queued).toMatchObject({ clientMsgId: 'm2' });

    await waitFor(() => events.filter((e) => e.type === 'run.done').length === 2);
    await session.close();
  });

  test('重复 clientMsgId 不重复执行，但仍回执', async () => {
    const { session, events, calls } = makeSession([[resultMessage()]]);

    session.send('m1', '你好');
    await waitFor(() => events.some((e) => e.type === 'run.done'));

    const before = calls[0]!.userMessages.length;
    const again = session.send('m1', '你好');

    expect(again.duplicate).toBe(true);
    expect(events.filter((e) => e.type === 'input.queued')).toHaveLength(1);
    await Bun.sleep(10);
    expect(calls[0]!.userMessages.length).toBe(before);
    await session.close();
  });

  test('排队的消息按序执行', async () => {
    const { session, events, calls } = makeSession([
      [assistantMessage('A'), resultMessage()],
      [assistantMessage('B'), resultMessage()],
      [assistantMessage('C'), resultMessage()],
    ]);

    session.send('m1', '一');
    session.send('m2', '二');
    session.send('m3', '三');

    await waitFor(() => events.filter((e) => e.type === 'run.done').length === 3, 3_000);

    const texts = calls[0]!.userMessages.map((m) => {
      const content = (m.message as { content: unknown }).content;
      return typeof content === 'string' ? content : '';
    });
    expect(texts).toEqual(['一', '二', '三']);
    await session.close();
  });

  test('同步连发多条只启动一个 drain 循环（不并发跑同一队列）', async () => {
    const { session, events, calls } = makeSession([
      [assistantMessage('A'), resultMessage()],
      [assistantMessage('B'), resultMessage()],
      [assistantMessage('C'), resultMessage()],
    ]);

    // 三条同步连发：若 drain 无并发保护，会起多个循环同时 takeNext，
    // 导致同一轮里往 SDK 推多条消息、run.done 数量与状态机错乱。
    session.send('m1', '一');
    session.send('m2', '二');
    session.send('m3', '三');

    await waitFor(() => events.filter((e) => e.type === 'run.done').length === 3, 3_000);
    await Bun.sleep(30);

    // 每条消息恰好被送进 SDK 一次，且总量正确
    const texts = calls.flatMap((c) =>
      c.userMessages.map((m) => {
        const content = (m.message as { content: unknown }).content;
        return typeof content === 'string' ? content : '';
      }),
    );
    expect(texts).toEqual(['一', '二', '三']);
    // 不多不少三次完成
    expect(events.filter((e) => e.type === 'run.done')).toHaveLength(3);
    // 最终停在 idle
    expect(session.state).toBe('idle');
    await session.close();
  });

  test('recall 撤回排队中的消息——被撤回的不得进 SDK', async () => {
    const { session, events, calls } = makeSession([
      [assistantMessage('A'), resultMessage()],
      [assistantMessage('B'), resultMessage()],
    ]);

    session.send('m1', '一');
    session.send('m2', '二');
    await waitFor(() => events.some((e) => e.type === 'input.queued'));

    // m2 还在队列里就撤回
    expect(session.recall('m2')).toBe(true);
    await waitFor(() => events.some((e) => e.type === 'run.done'));
    await Bun.sleep(50);

    const texts = calls.flatMap((c) =>
      c.userMessages.map((m) => {
        const content = (m.message as { content: unknown }).content;
        return typeof content === 'string' ? content : '';
      }),
    );
    expect(texts).toContain('一');
    expect(texts).not.toContain('二');
    await session.close();
  });
});

describe('ClaudeSession · 错误与续跑', () => {
  test('瞬时错误自动续跑，且不重发原消息', async () => {
    const { session, events, calls } = makeSession([
      // 第一轮：错误型 result → 触发续跑
      [resultMessage({ subtype: 'error_during_execution', errors: ['socket hang up'] })],
      // 第二轮：成功
      [assistantMessage('恢复后的回复'), resultMessage()],
    ]);

    session.send('m1', '原始消息');
    await waitFor(() => events.some((e) => e.type === 'error.transient'), 3_000);
    await waitFor(() => events.some((e) => e.type === 'assistant.done'), 3_000);

    const transient = events.find((e) => e.type === 'error.transient');
    expect(transient).toMatchObject({ attempt: 1 });

    // 续跑用的是提示语而非原消息——防 double-write
    const allUserTexts = calls.flatMap((c) =>
      c.userMessages.map((m) => {
        const content = (m.message as { content: unknown }).content;
        return typeof content === 'string' ? content : '';
      }),
    );
    expect(allUserTexts[0]).toBe('原始消息');
    expect(allUserTexts[1]).not.toBe('原始消息');
    expect(allUserTexts[1]).toContain('核实');
    await session.close();
  });

  test('fatal 错误不续跑，直接报 error.fatal', async () => {
    const { session, events } = makeSession([
      [resultMessage({ subtype: 'error_during_execution', errors: ['Invalid API key'] })],
    ]);

    session.send('m1', '你好');
    await waitFor(() => events.some((e) => e.type === 'error.fatal'), 3_000);

    const fatal = events.find((e) => e.type === 'error.fatal');
    expect(fatal).toMatchObject({ kind: 'auth' });
    expect(events.some((e) => e.type === 'error.transient')).toBe(false);
    expect(session.state).toBe('error');
    await session.close();
  });

  test('额度错误带 retryAt', async () => {
    const { session, events } = makeSession([
      [
        resultMessage({
          subtype: 'error_during_execution',
          errors: ['Usage limit reached. Your limit will reset at 2026-08-30T15:00:00Z'],
        }),
      ],
    ]);

    session.send('m1', '你好');
    await waitFor(() => events.some((e) => e.type === 'error.fatal'), 3_000);

    const fatal = events.find((e) => e.type === 'error.fatal') as { kind: string; retryAt?: number };
    expect(fatal.kind).toBe('quota');
    expect(fatal.retryAt).toBe(Date.parse('2026-08-30T15:00:00Z'));
    await session.close();
  });

  test('迭代器意外结束（进程崩溃）走续跑而非静默设 idle', async () => {
    // 空脚本 → 假 query 在收到消息后直接 done，模拟子进程崩溃/OOM kill。
    // 早先这里静默 return，用户看到状态变 idle 但聊天流里什么都没有。
    const { session, events } = makeSession([[]]);

    session.send('m1', '你好');
    await waitFor(
      () => events.some((e) => e.type === 'error.transient' || e.type === 'error.fatal'),
      3_000,
    );

    // 必须留下痕迹，不能凭空消失
    expect(
      events.some((e) => e.type === 'error.transient' || e.type === 'error.fatal'),
    ).toBe(true);
    await session.close();
  });

  test('续跑后的成本累加进会话，不被 clamp 成 0', async () => {
    const { session, events } = makeSession([
      // 第一轮：错误型 result（累计 0.5）触发续跑
      [
        resultMessage({
          subtype: 'error_during_execution',
          errors: ['socket hang up'],
          total_cost_usd: 0.5,
        }),
      ],
      // 第二轮：新 query 从 0 重新累计，本轮花 0.3
      [assistantMessage('恢复'), resultMessage({ total_cost_usd: 0.3 })],
    ]);

    session.send('m1', '你好');
    await waitFor(() => events.some((e) => e.type === 'assistant.done'), 3_000);
    await Bun.sleep(30);

    // 会话累计 = 基线 0.5 + 当前 query 0.3；直接赋值的写法会得到 0.3
    expect(session.costUsd).toBeCloseTo(0.8, 6);
    await session.close();
  });

  test('max_turns 类错误不自动续跑（重跑必然同样失败）', async () => {
    const { session, events, calls } = makeSession([
      [resultMessage({ subtype: 'error_max_turns', errors: [] })],
    ]);

    session.send('m1', '你好');
    await waitFor(() => events.some((e) => e.type === 'error.fatal'), 3_000);
    await Bun.sleep(30);

    expect(events.some((e) => e.type === 'error.transient')).toBe(false);
    // 只推了原始那一条，没有续跑提示
    const total = calls.reduce((n, c) => n + c.userMessages.length, 0);
    expect(total).toBe(1);
    await session.close();
  });

  test('续跑按 1s/2s/4s 指数退避', async () => {
    const { session, events, sleeps } = makeSession([
      [resultMessage({ subtype: 'error_during_execution', errors: ['socket hang up'] })],
    ]);

    session.send('m1', '你好');
    await waitFor(() => events.some((e) => e.type === 'error.fatal'), 3_000);

    // 立刻重试对「上游正在抖动」没有帮助，只会把三次机会在一秒内烧光
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    await session.close();
  });

  test('退避期间心跳继续发（界面显示「正在恢复」而非冻住）', async () => {
    const beats: number[] = [];
    const { session, events } = makeSession(
      [[resultMessage({ subtype: 'error_during_execution', errors: ['socket hang up'] })]],
      {
        // 假延时里让出事件循环，好让心跳定时器有机会跑
        sleep: async () => {
          const before = events.filter((e) => e.type === 'run.heartbeat').length;
          await Bun.sleep(12);
          beats.push(events.filter((e) => e.type === 'run.heartbeat').length - before);
        },
        heartbeatIntervalMs: 2,
      },
    );

    session.send('m1', '你好');
    await waitFor(() => events.some((e) => e.type === 'error.fatal'), 3_000);

    // 三次退避窗口里都必须有心跳产出
    expect(beats).toHaveLength(3);
    expect(beats.every((n) => n > 0)).toBe(true);
    await session.close();
  });

  test('连续瞬时错误超上限后转 fatal（不无限烧额度）', async () => {
    const { session, events } = makeSession([
      [resultMessage({ subtype: 'error_during_execution', errors: ['socket hang up'] })],
    ]);

    session.send('m1', '你好');
    await waitFor(() => events.some((e) => e.type === 'error.fatal'), 5_000);

    // 恰好 MAX_TRANSIENT_RETRIES(3) 次续跑尝试后转 fatal——是契约，不是范围
    const transients = events.filter((e) => e.type === 'error.transient');
    expect(transients.map((e) => (e as { attempt: number }).attempt)).toEqual([1, 2, 3]);
    expect(events.some((e) => e.type === 'error.fatal')).toBe(true);
    await session.close();
  });
});

describe('ClaudeSession · 停止与关闭', () => {
  test('stop 迁移到 stopped 状态', async () => {
    const { session, events } = makeSession([[assistantMessage('长任务'), resultMessage()]]);
    session.send('m1', '你好');
    await waitFor(() => events.some((e) => e.type === 'run.state'));

    await session.stop();
    expect(session.state).toBe('stopped');
    await session.close();
  });

  test('stop 后不再执行排队中的消息', async () => {
    const { session, events, calls } = makeSession([
      [assistantMessage('第一轮'), resultMessage()],
      [assistantMessage('第二轮'), resultMessage()],
    ]);

    session.send('m1', '第一条');
    session.send('m2', '第二条');
    await waitFor(() => events.some((e) => e.type === 'input.queued'));

    await session.stop();
    await Bun.sleep(80);

    // 「停止」必须连队列一起停：否则用户按了停止还眼睁睁看着下一条接着跑
    const texts = calls.flatMap((c) =>
      c.userMessages.map((m) => {
        const content = (m.message as { content: unknown }).content;
        return typeof content === 'string' ? content : '';
      }),
    );
    expect(texts).not.toContain('第二条');
    expect(session.state).toBe('stopped');
    expect(session.queueLength).toBe(0);
    await session.close();
  });

  test('stop 之后再 send 可以重新开跑', async () => {
    const { session, events } = makeSession([
      [assistantMessage('A'), resultMessage()],
      [assistantMessage('B'), resultMessage()],
    ]);

    session.send('m1', '第一条');
    await waitFor(() => events.some((e) => e.type === 'run.state'));
    await session.stop();

    const doneBefore = events.filter((e) => e.type === 'run.done').length;
    session.send('m2', '再来一条');
    await waitFor(
      () => events.filter((e) => e.type === 'run.done').length > doneBefore,
      3_000,
    );
    expect(session.state).not.toBe('stopped');
    await session.close();
  });

  test('反复 stop/send：消息真正下发，且一个 query 上只有一个 pump', async () => {
    // 回归：interrupt() 不保证挂起的 next() 返回，若 stop 只放开闸门而留着
    // query，下一次 send 会在同一迭代器上起第二个消费者。两个 pump 争抢帧时
    // 孤儿可截获 result，新 pump 永挂——表现为消息只收到 input.queued 回执却
    // 永不进 SDK、状态却显示 idle。修复前实测 4 个 waiter 堆在同一迭代器上。
    const delivered: string[] = [];
    let waiters = 0;
    let maxWaiters = 0;

    const factory = ((params: {
      prompt: string | AsyncIterable<SDKUserMessage>;
      options?: Options;
    }): Query => {
      const it =
        typeof params.prompt === 'string'
          ? undefined
          : params.prompt[Symbol.asyncIterator]();
      let closed = false;
      const outbox: SDKMessage[] = [];
      const gen = {
        async next(): Promise<IteratorResult<SDKMessage, void>> {
          if (closed) return { value: undefined, done: true };
          const buffered = outbox.shift();
          if (buffered !== undefined) return { value: buffered, done: false };
          waiters += 1;
          maxWaiters = Math.max(maxWaiters, waiters);
          try {
            const r = await it!.next();
            if (r.done === true) return { value: undefined, done: true };
            const content = (r.value.message as { content: unknown }).content;
            delivered.push(typeof content === 'string' ? content : '');
            // 吐一条 assistant 后本轮 result 永不到来（模拟任务还在跑）
            return { value: assistantMessage('working'), done: false };
          } finally {
            waiters -= 1;
          }
        },
        return: () => Promise.resolve({ value: undefined, done: true }),
        throw: (e: unknown) => Promise.reject(e),
        [Symbol.asyncIterator](): unknown {
          return gen;
        },
        interrupt: () => Promise.resolve(undefined),
        setPermissionMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        close: () => {
          closed = true;
        },
      };
      return gen as unknown as Query;
    }) as never;

    const session = new ClaudeSession({
      sessionId: 's1',
      cwd: '/tmp',
      model: 'm',
      permissionMode: 'default',
      emit: () => {},
      queryFn: factory,
      heartbeatIntervalMs: 999_999,
    });

    for (const [id, text] of [
      ['m1', 'FIRST'],
      ['m2', 'SECOND'],
      ['m3', 'THIRD'],
      ['m4', 'FOURTH'],
    ] as const) {
      session.send(id, text);
      await Bun.sleep(40);
      if (text !== 'FOURTH') {
        await session.stop();
        await Bun.sleep(10);
      }
    }
    await Bun.sleep(80);

    // 每条消息都必须真正抵达 SDK 的输入流——只断言 state/事件是不够的
    expect(delivered).toEqual(['FIRST', 'SECOND', 'THIRD', 'FOURTH']);
    // 迭代器上不得堆积消费者
    expect(maxWaiters).toBeLessThanOrEqual(1);
    await session.close();
  });

  /**
   * 造一个「首条消息挂住不收尾、其余正常」的假 query。
   *
   * 用来复现 stop 与 send 的时序竞态：第一轮必须停在「任务还在跑」的状态，
   * stop 才有孤儿 pump 可留。
   */
  function wedgeHarness() {
    const delivered: string[] = [];
    let globalServed = 0;
    const factory = ((params: {
      prompt: string | AsyncIterable<SDKUserMessage>;
      options?: Options;
    }): Query => {
      const it =
        typeof params.prompt === 'string'
          ? undefined
          : params.prompt[Symbol.asyncIterator]();
      let closed = false;
      const outbox: SDKMessage[] = [];
      const gen = {
        async next(): Promise<IteratorResult<SDKMessage, void>> {
          if (closed) return { value: undefined, done: true };
          const buffered = outbox.shift();
          if (buffered !== undefined) return { value: buffered, done: false };
          const r = await it!.next();
          if (r.done === true) return { value: undefined, done: true };
          const content = (r.value.message as { content: unknown }).content;
          delivered.push(typeof content === 'string' ? content : '');
          globalServed += 1;
          // 仅全局第一条挂住（本轮 result 永不到来），模拟任务正在跑
          if (globalServed === 1) {
            return { value: assistantMessage('working'), done: false };
          }
          outbox.push(resultMessage());
          return { value: assistantMessage('done'), done: false };
        },
        return: () => Promise.resolve({ value: undefined, done: true }),
        throw: (e: unknown) => Promise.reject(e),
        [Symbol.asyncIterator](): unknown {
          return gen;
        },
        interrupt: () => Promise.resolve(undefined),
        setPermissionMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        close: () => {
          closed = true;
        },
      };
      return gen as unknown as Query;
    }) as never;
    return { factory, delivered };
  }

  function wedgeSession() {
    const { factory, delivered } = wedgeHarness();
    const events: EventBody[] = [];
    const session = new ClaudeSession({
      sessionId: 's1',
      cwd: '/tmp',
      model: 'm',
      permissionMode: 'default',
      emit: (body) => events.push(body),
      queryFn: factory,
      heartbeatIntervalMs: 999_999,
      sleep: () => Promise.resolve(),
    });
    return { session, events, delivered };
  }

  test('stop() 后同宏任务立刻 send()：消息不被卡住', async () => {
    // WS 场景很常见：用户点了停止紧接着输入，两帧同批送达。
    // abort 同步 reject 了孤儿 next()，但孤儿的收尾段要到后续微任务才跑——
    // 若无代际守卫，它会把 setRunning(false)/setState('idle')/onIdle() 踩到
    // 新 run 头上，新 query 无人消费，那条消息卡住。
    const { session, events, delivered } = wedgeSession();

    session.send('m1', 'FIRST');
    await Bun.sleep(30);

    // 关键：stop() 之后不 await 任何东西，同一宏任务内直接 send
    const stopPromise = session.stop();
    session.send('m2', 'SECOND');
    await stopPromise;
    await Bun.sleep(120);

    expect(delivered).toContain('SECOND');
    expect(events.filter((e) => e.type === 'run.done')).toHaveLength(1);
    await session.close();
  });

  test('stop() 与 send() 之间只隔微任务：同样不被卡住', async () => {
    // settle 扫描口径：纯微任务间隔（await Promise.resolve()）也要覆盖，
    // 这是 stop 的收尾与新 drain 交错的另一个窗口
    const { session, events, delivered } = wedgeSession();

    session.send('m1', 'FIRST');
    await Bun.sleep(30);

    const stopPromise = session.stop();
    await Promise.resolve();
    session.send('m2', 'SECOND');
    await stopPromise;
    await Bun.sleep(120);

    expect(delivered).toContain('SECOND');
    expect(events.filter((e) => e.type === 'run.done')).toHaveLength(1);
    await session.close();
  });

  test('stop 后重起走 resume，接上同一会话上下文', async () => {
    const { session, calls } = makeSession([
      [assistantMessage('A'), resultMessage()],
      [assistantMessage('B'), resultMessage()],
    ]);

    session.send('m1', '一');
    await Bun.sleep(30);
    await session.stop();

    session.send('m2', '二');
    await Bun.sleep(60);

    // 第二个 query 必须带 resume，否则 stop 之后上下文就断了
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1]!.options!.resume).toBe('s1');
    await session.close();
  });

  test('close 幂等', async () => {
    const { session } = makeSession([[resultMessage()]]);
    await session.close();
    await session.close();
    expect(session.hasProcess).toBe(false);
  });

  test('close 作废挂起的权限请求', async () => {
    const { session, events } = makeSession([[resultMessage()]]);
    const controller = new AbortController();

    const pending = session.permissions.canUseTool(
      'Bash',
      { command: 'x' },
      { signal: controller.signal, toolUseID: 't', requestId: 'r' } as never,
    );
    await session.close();

    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(events.some((e) => e.type === 'permission.invalidated')).toBe(true);
  });
});

/** 造一条 system/status 消息（CLI 自行切权限模式时的回报） */
function statusMessage(permissionMode?: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'status',
    status: null,
    ...(permissionMode === undefined ? {} : { permissionMode }),
    uuid: 'u',
    session_id: 's1',
  } as unknown as SDKMessage;
}

describe('ClaudeSession · 同步 CLI 自行切换的权限模式', () => {
  test('status 带新 permissionMode → 更新本地模式并经 onMeta 广播（不回调 query.setPermissionMode）', async () => {
    const metas: SessionRuntimeMeta[] = [];
    const { session, events } = makeSession(
      [[statusMessage('default'), assistantMessage('ok'), resultMessage()]],
      { permissionMode: 'plan', onMeta: (m) => metas.push(m) },
    );
    session.send('m1', '执行计划');
    await waitFor(() => events.some((e) => e.type === 'run.done'));

    expect(session.permissionMode).toBe('default');
    expect(session.meta().permissionMode).toBe('default');
    expect(metas.some((m) => m.permissionMode === 'default')).toBe(true);
    // 切换之前的 meta 都还是 plan：模式确实是从 status 这条消息开始变的
    const firstDefault = metas.findIndex((m) => m.permissionMode === 'default');
    expect(metas.slice(0, firstDefault).every((m) => m.permissionMode === 'plan')).toBe(true);
    await session.close();
  });

  test('相同模式 / 不带 permissionMode / 协议外的模式（auto）都不触发变化', async () => {
    const metas: SessionRuntimeMeta[] = [];
    const { session, events } = makeSession(
      [[statusMessage('plan'), statusMessage(), statusMessage('auto'), resultMessage()]],
      { permissionMode: 'plan', onMeta: (m) => metas.push(m) },
    );
    session.send('m1', 'x');
    await waitFor(() => events.some((e) => e.type === 'run.done'));
    expect(session.permissionMode).toBe('plan');
    expect(metas.every((m) => m.permissionMode === 'plan')).toBe(true);
    await session.close();
  });

  test('status 回报的新模式用于下次拉起 query（resume 不再以 plan 启动）', async () => {
    const { session, events, calls } = makeSession(
      [[statusMessage('acceptEdits'), resultMessage()], [resultMessage()]],
      { permissionMode: 'plan' },
    );
    session.send('m1', 'x');
    await waitFor(() => events.some((e) => e.type === 'run.done'));
    await session.stop(); // 拆 query，下一条消息冷启动
    session.send('m2', 'y');
    await waitFor(() => calls.length >= 2);
    expect(calls[0]!.options!.permissionMode).toBe('plan');
    expect(calls[1]!.options!.permissionMode).toBe('acceptEdits');
    await session.close();
  });
});

describe('ClaudeSession · waitingFor', () => {
  test('挂起项决定 meta.waitingFor；答掉最早一条会重发 meta；清空后不带', async () => {
    const metas: SessionRuntimeMeta[] = [];
    const { session } = makeSession([[resultMessage()]], { onMeta: (m) => metas.push(m) });
    const controller = new AbortController();
    const opts = { signal: controller.signal, toolUseID: 't', requestId: 'r' } as never;

    void session.permissions.canUseTool('ExitPlanMode', { plan: '# p' }, opts);
    expect(session.state).toBe('waiting_permission');
    expect(metas.at(-1)).toMatchObject({ state: 'waiting_permission', waitingFor: 'plan' });

    void session.permissions.canUseTool('Bash', { command: 'x' }, opts);
    const [first, second] = session.permissions.snapshot();
    session.respondPermission({ requestId: first!.requestId, verdict: 'deny' });
    expect(metas.at(-1)).toMatchObject({ state: 'waiting_permission', waitingFor: 'permission' });

    session.respondPermission({ requestId: second!.requestId, verdict: 'allow' });
    expect(session.meta().state).not.toBe('waiting_permission');
    expect(metas.at(-1)).not.toHaveProperty('waitingFor');
    expect(session.meta()).not.toHaveProperty('waitingFor');
    await session.close();
  });
});

/** 造一条 system/init 消息（每轮开头一条，含自发轮） */
function initMessage(): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    model: 'claude-opus-4',
    slash_commands: [],
    mcp_servers: [],
    uuid: 'u',
    session_id: 's1',
  } as unknown as SDKMessage;
}

/** 造一条 message_start 流事件（includePartialMessages 下每轮的第一条回复帧） */
function messageStartEvent(id = 'msg_1'): SDKMessage {
  return {
    type: 'stream_event',
    event: { type: 'message_start', message: { id, role: 'assistant', content: [] } },
    parent_tool_use_id: null,
    uuid: 'u',
    session_id: 's1',
  } as unknown as SDKMessage;
}

/** 造一条后台任务类 system 消息（空闲期也会出现的旁路消息，不该开一轮） */
function systemMessage(subtype: string, fields: Record<string, unknown> = {}): SDKMessage {
  return { type: 'system', subtype, ...fields, uuid: 'u', session_id: 's1' } as unknown as SDKMessage;
}

/**
 * 更贴近真 SDK（claude 2.1.282 + SDK 0.3.251 实测行为）的假 query：
 *
 * - 每条用户消息按 `rounds(text)` 吐一轮，**第一条回复帧打 `user_message_uuid`**
 *   （= 推送时的 uuid）；
 * - `inject(frames)` 可在任意时刻塞入消息——自发轮（后台任务完成后 CLI 自己开的
 *   一轮）就是一串不打标记的 init → assistant → result；
 * - 与真 CLI 一样：一轮进行中（吐过会话帧、还没吐 result）**不去拉下一条用户消息**，
 *   用户消息排在当前轮后面。
 */
/** 一轮的脚本：帧序列；或让 query 在收到这条消息后抛错（'throw:<文案>'）/ 直接结束（'end'） */
type RoundScript = SDKMessage[] | 'end' | `throw:${string}`;

function liveQueryFactory(opts: { rounds: (text: string, queryIndex: number, uuid: string | undefined) => RoundScript; stamp?: boolean }) {
  const stamp = opts.stamp ?? true;
  const calls: {
    options: Options | undefined;
    userMessages: SDKUserMessage[];
    inject: (frames: SDKMessage[]) => void;
    interrupts: number;
    closed: boolean;
    stopped: string[];
  }[] = [];

  const factory = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query => {
    const it = typeof params.prompt === 'string' ? undefined : params.prompt[Symbol.asyncIterator]();
    const outbox: SDKMessage[] = [];
    let waiter: (() => void) | undefined;
    let roundOpen = false;
    let pulling = false;
    let ended = false;
    let throwNext: Error | undefined;
    const queryIndex = calls.length;
    const wake = (): void => {
      const w = waiter;
      waiter = undefined;
      w?.();
    };
    const record = {
      options: params.options,
      userMessages: [] as SDKUserMessage[],
      inject: (frames: SDKMessage[]): void => {
        outbox.push(...frames);
        wake();
      },
      interrupts: 0,
      closed: false,
      stopped: [] as string[],
    };
    calls.push(record);

    // 与真 CLI 一样：用户消息**立刻**从输入流读走，但一轮进行中不处理，
    // 排在当前轮（可能是自发轮）之后
    const heldRounds: SDKMessage[][] = [];
    const flushHeld = (): void => {
      if (roundOpen) return;
      const frames = heldRounds.shift();
      if (frames === undefined) return;
      outbox.push(...frames);
    };
    const pullInput = async (): Promise<void> => {
      pulling = true;
      const r = await it!.next();
      pulling = false;
      if (r.done === true) {
        ended = true;
        wake();
        return;
      }
      record.userMessages.push(r.value);
      const content = (r.value.message as { content: unknown }).content;
      const script = opts.rounds(typeof content === 'string' ? content : '', queryIndex, r.value.uuid as string | undefined);
      if (script === 'end') {
        ended = true;
        wake();
        return;
      }
      if (typeof script === 'string') {
        throwNext = new Error(script.slice('throw:'.length));
        wake();
        return;
      }
      const frames = script;
      if (stamp && r.value.uuid !== undefined) {
        const first = frames.find((f) => f.type === 'stream_event' || f.type === 'assistant');
        if (first !== undefined) {
          (first as unknown as { user_message_uuid: string }).user_message_uuid = r.value.uuid;
        }
      }
      heldRounds.push(frames);
      flushHeld();
      wake();
    };

    const gen = {
      async next(): Promise<IteratorResult<SDKMessage, void>> {
        for (;;) {
          if (record.closed) return { value: undefined, done: true };
          if (throwNext !== undefined) {
            const e = throwNext;
            throwNext = undefined;
            throw e;
          }
          const m = outbox.shift();
          if (m !== undefined) {
            if (m.type === 'result') {
              roundOpen = false;
              flushHeld();
            } else if (
              (m.type === 'system' && (m as { subtype: string }).subtype === 'init') ||
              m.type === 'assistant' ||
              m.type === 'stream_event' ||
              m.type === 'user'
            ) {
              roundOpen = true;
            }
            return { value: m, done: false };
          }
          if (ended) return { value: undefined, done: true };
          if (!pulling) void pullInput();
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
        }
      },
      return: () => Promise.resolve({ value: undefined, done: true as const }),
      throw: (e: unknown) => Promise.reject(e),
      [Symbol.asyncIterator](): unknown {
        return gen;
      },
      interrupt(): Promise<undefined> {
        record.interrupts += 1;
        outbox.length = 0;
        roundOpen = false;
        return Promise.resolve(undefined);
      },
      stopTask(taskId: string): Promise<void> {
        record.stopped.push(taskId);
        return Promise.resolve();
      },
      setPermissionMode: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      close: () => {
        record.closed = true;
        wake();
      },
    };
    return gen as unknown as Query;
  };
  return { factory: factory as never, calls };
}

function liveSession(
  rounds: (text: string, queryIndex: number, uuid: string | undefined) => RoundScript,
  overrides: Partial<ClaudeSessionOptions> & { stamp?: boolean } = {},
) {
  const { stamp, ...rest } = overrides;
  const events: EventBody[] = [];
  const { factory, calls } = liveQueryFactory({ rounds, ...(stamp === undefined ? {} : { stamp }) });
  let idles = 0;
  const session = new ClaudeSession({
    sessionId: 's1',
    cwd: '/tmp',
    model: 'claude-opus-4',
    permissionMode: 'default',
    emit: (body) => events.push(body),
    queryFn: factory,
    heartbeatIntervalMs: 999_999,
    sleep: () => Promise.resolve(),
    onIdle: () => {
      idles += 1;
    },
    ...rest,
  });
  return { session, events, calls, idles: () => idles };
}

const runStates = (events: EventBody[]): string[] =>
  events.filter((e) => e.type === 'run.state').map((e) => (e as { state: string }).state);
const doneCount = (events: EventBody[]): number => events.filter((e) => e.type === 'run.done').length;
const assistantTexts = (events: EventBody[]): string[] =>
  events.filter((e) => e.type === 'assistant.done').map((e) => (e as { text: string }).text);

/** 每条 assistant 消息一个新 id（真 SDK 的 message.id 全局唯一；复用会被 translate 按 id 累积全文） */
let msgSeq = 0;
const nextMsgId = (): string => `msg_${++msgSeq}`;

/** 一次典型的用户轮：init → message_start（带标记）→ 回复 → result */
const echoRound = (text: string): SDKMessage[] => {
  const id = nextMsgId();
  return [initMessage(), messageStartEvent(id), assistantMessage(`re:${text}`, id), resultMessage()];
};

/** 一次自发轮（后台任务完成后 CLI 自己开的）：init → 回复 → result，全程无标记 */
const spontaneousRound = (text = 'bg done'): SDKMessage[] => [initMessage(), assistantMessage(text, nextMsgId()), resultMessage()];

describe('ClaudeSession · 长驻读取循环与自发轮', () => {
  test('推送的用户消息带 uuid 与 origin:{kind:human}，clientMsgId ↔ uuid 可查', async () => {
    const { session, events, calls } = liveSession(echoRound);
    session.send('m1', 'hi');
    await waitFor(() => doneCount(events) === 1);

    const pushed = calls[0]!.userMessages[0]!;
    expect(typeof pushed.uuid).toBe('string');
    expect(pushed.origin).toEqual({ kind: 'human' });
    expect(session.userMessageUuid('m1')).toBe(pushed.uuid as string);
    await session.close();
  });

  test('空闲期自发轮完整走完：running → run.done → idle，事件都发出', async () => {
    const { session, events, calls, idles } = liveSession(echoRound);
    session.send('m1', 'start bg');
    await waitFor(() => session.state === 'idle' && doneCount(events) === 1);
    const idlesBefore = idles();

    // 空闲期：后台任务完成，CLI 自己开一轮
    calls[0]!.inject(spontaneousRound('BG_DONE seen'));
    await waitFor(() => doneCount(events) === 2);
    await waitFor(() => session.state === 'idle');

    expect(runStates(events)).toEqual(['running', 'idle', 'running', 'idle']);
    expect(assistantTexts(events)).toEqual(['re:start bg', 'BG_DONE seen']);
    // 自发轮同样触发 onIdle（空闲回收计时）
    expect(idles()).toBe(idlesBefore + 1);
    // 空闲期没有再推过用户消息
    expect(calls[0]!.userMessages).toHaveLength(1);
    await session.close();
  });

  test('空闲期的旁路 system 消息（后台任务通知）不开一轮、不改状态', async () => {
    const { session, events, calls } = liveSession(echoRound);
    session.send('m1', 'x');
    await waitFor(() => session.state === 'idle');

    calls[0]!.inject([
      systemMessage('background_tasks_changed', { tasks: [] }),
      systemMessage('task_updated', { task_id: 't1', patch: { status: 'completed' } }),
      systemMessage('task_notification', { task_id: 't1', status: 'completed', output_file: '', summary: 'done' }),
    ]);
    await Bun.sleep(30);
    expect(session.state).toBe('idle');
    expect(runStates(events)).toEqual(['running', 'idle']);
    expect(doneCount(events)).toBe(1);
    await session.close();
  });

  test('自发轮进行中用户发消息：排队回执，等自发轮 result 后再推，回复归属正确', async () => {
    const { session, events, calls } = liveSession(echoRound);
    session.send('m1', 'x');
    await waitFor(() => session.state === 'idle');

    // 自发轮开始但还没收尾
    calls[0]!.inject([initMessage(), assistantMessage('bg working', nextMsgId())]);
    await waitFor(() => session.state === 'running');

    session.send('m2', 'PONG?');
    expect(events.some((e) => e.type === 'input.queued' && (e as { clientMsgId: string }).clientMsgId === 'm2')).toBe(true);
    await Bun.sleep(20);
    // 自发轮没结束前不推用户消息
    expect(calls[0]!.userMessages).toHaveLength(1);

    calls[0]!.inject([resultMessage()]);
    await waitFor(() => doneCount(events) === 3, 2_000);
    await waitFor(() => session.state === 'idle');

    // 事件顺序：自发轮的 run.done 在 m2 的回复之前，m2 的回复在第三个 run.done 之前
    const types = events.map((e) => (e.type === 'assistant.done' ? `assistant:${(e as { text: string }).text}` : e.type));
    const bgDone = types.indexOf('run.done', types.indexOf('run.done') + 1);
    const reply = types.indexOf('assistant:re:PONG?');
    const replyDone = types.indexOf('run.done', reply);
    expect(bgDone).toBeGreaterThan(-1);
    expect(reply).toBeGreaterThan(bgDone);
    expect(replyDone).toBeGreaterThan(reply);
    expect(calls[0]!.userMessages).toHaveLength(2);
    // 全程只在最后回到 idle 一次（自发轮结束时队列非空 → 直接接着跑，不闪 idle）
    expect(runStates(events)).toEqual(['running', 'idle', 'running', 'idle']);
    await session.close();
  });

  test('用户轮与自发轮 result 背靠背：两张完成卡各归各的，不串', async () => {
    // 用户轮的 result 后紧跟一整个自发轮（后台任务在用户轮期间完成，CLI 收尾后立刻开自发轮）
    const { session, events, calls } = liveSession((text) => [...echoRound(text), ...spontaneousRound('BG')]);
    session.send('m1', 'go');
    await waitFor(() => doneCount(events) === 2, 2_000);
    await waitFor(() => session.state === 'idle');

    expect(assistantTexts(events)).toEqual(['re:go', 'BG']);
    expect(runStates(events).at(-1)).toBe('idle');
    // 只推过一条用户消息；自发轮不会被当成「下一条」的回复
    expect(calls[0]!.userMessages).toHaveLength(1);
    // 再发一条，回复仍然对得上（没有错位）
    session.send('m2', 'again');
    await waitFor(() => assistantTexts(events).includes('re:again'), 2_000);
    await waitFor(() => session.state === 'idle');
    expect(doneCount(events)).toBe(4);
    await session.close();
  });

  test('错位回归（desync-probe 时序）：run1 → 空闲期自发轮 → msg2 的回复落在 msg2 的 run 里', async () => {
    const { session, events, calls } = liveSession(echoRound);
    session.send('m1', 'start bg');
    await waitFor(() => session.state === 'idle' && doneCount(events) === 1);

    // 空闲期后台任务完成 → 自发轮
    calls[0]!.inject(spontaneousRound('bg finished'));
    await waitFor(() => doneCount(events) === 2);
    await waitFor(() => session.state === 'idle');

    session.send('m2', 'PONG?');
    await waitFor(() => doneCount(events) === 3, 2_000);
    await waitFor(() => session.state === 'idle');

    const types = events.map((e) =>
      e.type === 'assistant.done'
        ? `assistant:${(e as { text: string }).text}`
        : e.type === 'user.message'
          ? `user:${(e as { clientMsgId: string }).clientMsgId}`
          : e.type,
    );
    const userM2 = types.indexOf('user:m2');
    const secondDone = types.indexOf('run.done', types.indexOf('run.done') + 1);
    const reply = types.indexOf('assistant:re:PONG?');
    const thirdDone = types.indexOf('run.done', secondDone + 1);
    // run 边界：自发轮的 run.done 在 m2 之前；m2 的回复在 m2 之后、第三个 run.done 之前
    expect(secondDone).toBeLessThan(userM2);
    expect(reply).toBeGreaterThan(userM2);
    expect(thirdDone).toBeGreaterThan(reply);
    // 旧读法下 m2 推进去后读到的第一个 result 是自发轮的，PONG 要到再下一条消息才出来
    expect(runStates(events)).toEqual(['running', 'idle', 'running', 'idle', 'running', 'idle']);
    await session.close();
  });

  test('对端不打 user_message_uuid（旧 CLI）：用户轮按旧语义归在途消息，不挂死', async () => {
    const { session, events } = liveSession(echoRound, { stamp: false });
    session.send('m1', 'a');
    await waitFor(() => doneCount(events) === 1);
    await waitFor(() => session.state === 'idle');
    session.send('m2', 'b');
    await waitFor(() => doneCount(events) === 2);
    await waitFor(() => session.state === 'idle');
    expect(assistantTexts(events)).toEqual(['re:a', 're:b']);
    await session.close();
  });

  test('竞态：用户消息推进去时自发轮恰好开始——标记不匹配即自发轮，用户轮排后面', async () => {
    // 假 SDK 在收到用户消息前先塞了一个未收尾的自发轮：用户消息被 CLI 排在它后面。
    // 归属靠 uuid：自发轮的回复帧无标记（且本 query 已见过标记）→ 自发轮
    const { session, events, calls } = liveSession(echoRound);
    session.send('m1', 'x');
    await waitFor(() => session.state === 'idle');

    calls[0]!.inject([initMessage()]);
    // init 已经开了一轮，用户消息此刻推入（真实世界里两者几乎同时）
    session.send('m2', 'y');
    await Bun.sleep(10);
    calls[0]!.inject([assistantMessage('bg', nextMsgId()), resultMessage()]);
    await waitFor(() => doneCount(events) === 3, 2_000);
    await waitFor(() => session.state === 'idle');
    expect(assistantTexts(events)).toEqual(['re:x', 'bg', 're:y']);
    await session.close();
  });

  test('自发轮期间的权限请求照常工作（waiting_permission ↔ running）', async () => {
    const { session, events, calls } = liveSession(echoRound);
    session.send('m1', 'x');
    await waitFor(() => session.state === 'idle');

    calls[0]!.inject([initMessage(), assistantMessage('bg', nextMsgId())]);
    await waitFor(() => session.state === 'running');

    const controller = new AbortController();
    const pending = session.permissions.canUseTool(
      'Bash',
      { command: 'rm x' },
      { signal: controller.signal, toolUseID: 't', requestId: 'r' } as never,
    );
    expect(session.state).toBe('waiting_permission');
    const [req] = session.permissions.snapshot();
    session.respondPermission({ requestId: req!.requestId, verdict: 'allow' });
    await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
    expect(session.state).toBe('running');

    calls[0]!.inject([resultMessage()]);
    await waitFor(() => session.state === 'idle');
    const done = events.filter((e) => e.type === 'run.done').at(-1) as { permissionCount: number };
    expect(done.permissionCount).toBe(1);
    await session.close();
  });

  test('stop 中断自发轮：状态 stopped，query 被拆，下一条消息以 resume 重起', async () => {
    const { session, events, calls } = liveSession(echoRound);
    session.send('m1', 'x');
    await waitFor(() => session.state === 'idle');

    calls[0]!.inject([initMessage(), assistantMessage('bg', nextMsgId())]);
    await waitFor(() => session.state === 'running');

    await session.stop();
    expect(session.state).toBe('stopped');
    expect(calls[0]!.interrupts).toBe(1);
    expect(calls[0]!.closed).toBe(true);

    session.send('m2', 'y');
    await waitFor(() => calls.length === 2);
    expect(calls[1]!.options!.resume).toBe('s1');
    await waitFor(() => assistantTexts(events).includes('re:y'), 2_000);
    await waitFor(() => session.state === 'idle');
    await session.close();
  });

  test('query 被拆后读取循环退出：不误报崩溃（stop 与续跑两条路径）', async () => {
    // 路径一：stop 拆 query
    const a = liveSession(echoRound);
    a.session.send('m1', 'x');
    await waitFor(() => a.session.state === 'idle');
    a.calls[0]!.inject([initMessage(), assistantMessage('bg', nextMsgId())]);
    await waitFor(() => a.session.state === 'running');
    await a.session.stop();
    await Bun.sleep(50);
    expect(a.events.filter((e) => e.type === 'error.transient' || e.type === 'error.fatal')).toHaveLength(0);
    await a.session.close();

    // 路径二：错误型 result 触发续跑（#runOne 拆 query 再起新的）
    let n = 0;
    const b = liveSession((text) =>
      ++n === 1
        ? [initMessage(), messageStartEvent(), resultMessage({ subtype: 'error_during_execution', errors: ['socket hang up'] })]
        : echoRound(text),
    );
    b.session.send('m1', 'x');
    await waitFor(() => assistantTexts(b.events).length === 1, 2_000);
    await waitFor(() => b.session.state === 'idle');
    await Bun.sleep(50);
    // 恰好一次瞬时错误痕迹，旧 query 的读取循环没有再报任何东西
    expect(b.events.filter((e) => e.type === 'error.transient')).toHaveLength(1);
    expect(b.events.filter((e) => e.type === 'error.fatal')).toHaveLength(0);
    expect(b.calls).toHaveLength(2);
    await b.session.close();
  });

  test('存活 query 在空闲期意外结束：静默拆掉，下一条消息以 resume 重起', async () => {
    const { session, events, calls } = liveSession(echoRound);
    session.send('m1', 'x');
    await waitFor(() => session.state === 'idle');

    // 模拟子进程在空闲期退出（迭代器 done 而不是被我们拆）
    calls[0]!.closed = true;
    calls[0]!.inject([]);
    await waitFor(() => !session.hasProcess);
    expect(session.state).toBe('idle');
    expect(events.filter((e) => e.type === 'error.transient' || e.type === 'error.fatal')).toHaveLength(0);

    session.send('m2', 'y');
    await waitFor(() => calls.length === 2);
    expect(calls[1]!.options!.resume).toBe('s1');
    await waitFor(() => assistantTexts(events).includes('re:y'), 2_000);
    await session.close();
  });

  test('自发轮进行中进程意外结束：报 fatal 并收尾，不留 running', async () => {
    const { session, events, calls } = liveSession(echoRound);
    session.send('m1', 'x');
    await waitFor(() => session.state === 'idle');
    calls[0]!.inject([initMessage(), assistantMessage('bg', nextMsgId())]);
    await waitFor(() => session.state === 'running');

    calls[0]!.closed = true;
    calls[0]!.inject([]);
    await waitFor(() => session.state === 'error');
    expect(events.some((e) => e.type === 'error.fatal')).toBe(true);
    expect(session.hasProcess).toBe(false);
    await session.close();
  });

  test('stop() 后同宏任务 send()，之后第三条消息仍能跑（孤儿循环收尾不留 running）', async () => {
    const { session, events, calls } = liveSession(echoRound);
    session.send('m1', 'x');
    await waitFor(() => session.state === 'idle');
    calls[0]!.inject([initMessage(), assistantMessage('bg', nextMsgId())]);
    await waitFor(() => session.state === 'running');

    const stopping = session.stop();
    session.send('m2', 'y');
    await stopping;
    await waitFor(() => assistantTexts(events).includes('re:y'), 2_000);
    await waitFor(() => session.state === 'idle');

    session.send('m3', 'z');
    await waitFor(() => assistantTexts(events).includes('re:z'), 2_000);
    await waitFor(() => session.state === 'idle');
    await session.close();
  });
});

/** 真 claude 实测：后台 Bash 从启动到完成的 system 消息 */
const bgTaskStart = (id = 'bd4zj554r'): SDKMessage[] => [
  systemMessage('background_tasks_changed', { tasks: [{ task_id: id, task_type: 'local_bash', description: '后台 sleep' }] }),
  systemMessage('task_started', { task_id: id, tool_use_id: `toolu_${id}`, description: '后台 sleep', is_backgrounded: true, task_type: 'local_bash' }),
];
const bgTaskDone = (id = 'bd4zj554r'): SDKMessage[] => [
  systemMessage('background_tasks_changed', { tasks: [] }),
  systemMessage('task_updated', { task_id: id, patch: { status: 'completed', end_time: 1790397318094 } }),
  systemMessage('task_notification', { task_id: id, tool_use_id: `toolu_${id}`, status: 'completed', output_file: '/tmp/o', summary: 'Background command "后台 sleep" completed (exit code 0)' }),
];

describe('ClaudeSession · 后台任务', () => {
  const snapshots = (events: EventBody[]): string[][] =>
    events.filter((e) => e.type === 'bgtask.snapshot').map((e) => (e as { tasks: { status: string }[] }).tasks.map((t) => t.status));

  test('任务启动 / 完成 → bgtask.snapshot 状态序列 running → completed；meta.bgRunning 随之变化并广播', async () => {
    const metas: SessionRuntimeMeta[] = [];
    const { session, events, calls } = liveSession(
      (text) => [initMessage(), messageStartEvent(nextMsgId()), ...bgTaskStart(), assistantMessage(`re:${text}`, nextMsgId()), resultMessage()],
      { onMeta: (m) => metas.push(m) },
    );
    session.send('m1', 'bg');
    await waitFor(() => session.state === 'idle');
    expect(session.bgRunningCount).toBe(1);
    expect(session.meta().bgRunning).toBe(1);
    expect(metas.some((m) => m.bgRunning === 1)).toBe(true);
    // 第一帧是起进程时的空快照（M2 对账点），之后都是 running
    expect(snapshots(events)[0]).toEqual([]);
    expect(snapshots(events).slice(1).every((s) => s.join() === 'running')).toBe(true);

    // 空闲期任务完成 → 快照 completed；随后的自发轮带触发说明
    calls[0]!.inject([...bgTaskDone(), ...spontaneousRound('BG 已完成')]);
    await waitFor(() => doneCount(events) === 2);
    await waitFor(() => session.state === 'idle');
    expect(snapshots(events).at(-1)).toEqual(['completed']);
    expect(session.bgRunningCount).toBe(0);
    expect(metas.at(-1)!.bgRunning).toBe(0);
    const last = (events.filter((e) => e.type === 'bgtask.snapshot').at(-1) as { tasks: { summary?: string; toolUseId?: string; kind: string }[] }).tasks[0]!;
    expect(last).toMatchObject({ kind: 'bash', toolUseId: 'toolu_bd4zj554r', summary: 'Background command "后台 sleep" completed (exit code 0)' });
    const marker = events.find((e) => e.type === 'run.state' && (e as { detail?: string }).detail !== undefined) as { state: string; detail: string };
    expect(marker).toMatchObject({ state: 'running', detail: '后台任务“后台 sleep”已完成' });
    await session.close();
  });

  test('自发轮在用户轮进行中开始：状态不变也发一帧带 detail 的 run.state 标边界', async () => {
    const { session, events, calls } = liveSession(echoRound);
    session.send('m1', 'x');
    await waitFor(() => session.state === 'idle');
    calls[0]!.inject([initMessage(), assistantMessage('bg', nextMsgId())]);
    await waitFor(() => session.state === 'running');
    session.send('m2', 'y');
    calls[0]!.inject([resultMessage()]);
    await waitFor(() => doneCount(events) === 3, 2_000);
    // 自发轮期间没有结束通知 → 通用说明
    const markers = events.filter((e) => e.type === 'run.state' && (e as { detail?: string }).detail !== undefined);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ state: 'running', detail: '后台任务完成' });
    await session.close();
  });

  test('stopBgTask：交给 SDK stopTask；没进程 / 已结束 → not_found', async () => {
    const { session, events, calls } = liveSession(
      (text) => [initMessage(), messageStartEvent(nextMsgId()), ...bgTaskStart(), assistantMessage(`re:${text}`, nextMsgId()), resultMessage()],
    );
    expect(await session.stopBgTask('bd4zj554r')).toMatchObject({ ok: false, code: 'not_found' });
    session.send('m1', 'bg');
    await waitFor(() => session.state === 'idle');
    expect(await session.stopBgTask('bd4zj554r')).toEqual({ ok: true });
    expect(calls[0]!.stopped).toEqual(['bd4zj554r']);
    // CLI 随后回报 killed / stopped
    calls[0]!.inject([
      systemMessage('background_tasks_changed', { tasks: [] }),
      systemMessage('task_updated', { task_id: 'bd4zj554r', patch: { status: 'killed', end_time: 1 } }),
      systemMessage('task_notification', { task_id: 'bd4zj554r', status: 'stopped', output_file: '', summary: '后台 sleep' }),
    ]);
    await waitFor(() => snapshots(events).at(-1)?.[0] === 'stopped');
    expect(await session.stopBgTask('bd4zj554r')).toMatchObject({ ok: false, code: 'not_found' });
    await session.close();
  });

  test('stop / close 拆掉子进程时在跑的后台任务标 stopped 并发快照', async () => {
    const rounds = (text: string): SDKMessage[] => [initMessage(), messageStartEvent(nextMsgId()), ...bgTaskStart(), assistantMessage(`re:${text}`, nextMsgId()), resultMessage()];
    const a = liveSession(rounds);
    a.session.send('m1', 'bg');
    await waitFor(() => a.session.state === 'idle');
    await a.session.stop();
    expect(snapshots(a.events).at(-1)).toEqual(['stopped']);
    expect(a.session.bgRunningCount).toBe(0);
    await a.session.close();

    const b = liveSession(rounds);
    b.session.send('m1', 'bg');
    await waitFor(() => b.session.state === 'idle');
    await b.session.close();
    expect(snapshots(b.events).at(-1)).toEqual(['stopped']);
  });
});

describe('ClaudeSession · 评审回归（B1 / B2 / M1 / M3 / m5）', () => {
  test('B1：流抛 fatal 类错误（auth）后 query 被拆；下一条消息重起新 query，不挂死', async () => {
    const { session, events, calls } = liveSession((text, i) => (i === 0 ? 'throw:API Error: authentication_error invalid bearer token' : echoRound(text)));
    session.send('m1', 'x');
    await waitFor(() => session.state === 'error');
    expect(events.some((e) => e.type === 'error.fatal')).toBe(true);
    // 不变量：读取循环退出 ⇒ 没有活跃 query
    expect(session.hasProcess).toBe(false);

    session.send('m2', 'y');
    await waitFor(() => assistantTexts(events).includes('re:y'), 2_000);
    await waitFor(() => session.state === 'idle');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options!.resume).toBe('s1');
    await session.close();
  });

  test('B1 变体：进程反复秒退、续跑 3 次耗尽转 fatal 后，下一条消息仍能重起', async () => {
    const { session, events, calls } = liveSession((text, i) => (i < 4 ? 'end' : echoRound(text)));
    session.send('m1', 'x');
    await waitFor(() => session.state === 'error', 3_000);
    expect(calls).toHaveLength(4);
    expect(session.hasProcess).toBe(false);

    session.send('m2', 'y');
    await waitFor(() => assistantTexts(events).includes('re:y'), 2_000);
    expect(calls).toHaveLength(5);
    await waitFor(() => session.state === 'idle');
    await session.close();
  });

  test('B2：畸形 task 消息（缺 tasks / patch）不抛、不拆流；后续消息照常', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const logs: string[] = [];
      const { session, events, calls } = liveSession(echoRound, { log: (l) => logs.push(l) });
      session.send('m1', 'x');
      await waitFor(() => session.state === 'idle');
      calls[0]!.inject([
        systemMessage('background_tasks_changed', {}),
        systemMessage('task_updated', { task_id: 't' }),
        systemMessage('task_started', {}),
      ]);
      await Bun.sleep(30);
      expect(session.hasProcess).toBe(true);
      expect(session.state).toBe('idle');

      session.send('m2', 'y');
      await waitFor(() => assistantTexts(events).includes('re:y'), 2_000);
      expect(calls).toHaveLength(1);
      expect(rejections).toHaveLength(0);
      await session.close();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  test('B2：翻译层 / 发帧抛异常只丢那一帧，读取循环继续、轮的记账不乱', async () => {
    const logs: string[] = [];
    let boom = true;
    const events: EventBody[] = [];
    const { factory, calls } = liveQueryFactory({ rounds: echoRound });
    const session = new ClaudeSession({
      sessionId: 's1',
      cwd: '/tmp',
      model: 'm',
      permissionMode: 'default',
      emit: (body) => {
        // 模拟下游发帧对某一帧抛错（如 emitter 序列化失败）
        if (boom && body.type === 'session.capabilities') {
          boom = false;
          throw new Error('emit 炸了');
        }
        events.push(body);
      },
      queryFn: factory,
      heartbeatIntervalMs: 999_999,
      sleep: () => Promise.resolve(),
      log: (l) => logs.push(l),
    });
    session.send('m1', 'x');
    await waitFor(() => assistantTexts(events).includes('re:x'), 2_000);
    await waitFor(() => session.state === 'idle');
    expect(logs.some((l) => l.includes('处理 SDK 消息失败'))).toBe(true);
    // 那一帧之后的消息照常，本轮 result 照常收轮
    expect(doneCount(events)).toBe(1);
    session.send('m2', 'y');
    await waitFor(() => assistantTexts(events).includes('re:y'), 2_000);
    expect(calls).toHaveLength(1);
    await session.close();
  });

  test('M1：零回复帧的错误型自发轮恰逢用户消息在途 → result 无标记判自发，用户原文不丢', async () => {
    const { session, events, calls } = liveSession(echoRound);
    session.send('m1', 'x');
    await waitFor(() => session.state === 'idle');
    session.send('m2', 'IMPORTANT USER TEXT');
    // 用户消息刚推入（在途），CLI 恰好先开了自发轮且零帧就错（API 抖动）
    calls[0]!.inject([initMessage(), resultMessage({ subtype: 'error_during_execution', errors: ['socket hang up'] })]);
    await waitFor(() => assistantTexts(events).includes('re:IMPORTANT USER TEXT'), 2_000);
    await waitFor(() => session.state === 'idle');
    // 没有拆进程重推 RESUME_HINT：用户原文在同一个 query 里被处理
    expect(calls).toHaveLength(1);
    expect(calls[0]!.userMessages.map((m) => (m.message as { content: string }).content)).toEqual(['x', 'IMPORTANT USER TEXT']);
    // 自发轮的错误留一行非致命痕迹，会话没进 error
    expect(events.filter((e) => e.type === 'error.fatal')).toHaveLength(0);
    expect(events.some((e) => e.type === 'error.transient' && (e as { reason: string }).reason.includes('后台任务触发'))).toBe(true);
    await session.close();
  });

  test('M1：错误型 result 带用户 uuid → 归用户轮（走续跑）；带别的 uuid → 自发轮；首帧漏标由 result 纠正', async () => {
    // 归用户：零帧错误 result 回显在途 uuid → 用户轮 → 续跑（拆 query 重起、推 RESUME_HINT）
    const a = liveSession((text, i, uuid) =>
      i === 0 ? [initMessage(), resultMessage({ subtype: 'error_during_execution', errors: ['socket hang up'], user_message_uuid: uuid })] : echoRound(text),
    );
    a.session.send('m1', 'x');
    await waitFor(() => a.calls.length === 2, 2_000);
    await waitFor(() => a.session.state === 'idle', 2_000);
    expect(a.events.some((e) => e.type === 'error.transient')).toBe(true);
    expect((a.calls[1]!.userMessages[0]!.message as { content: string }).content).toContain('核实');
    await a.session.close();

    const b = liveSession(echoRound);
    b.session.send('m1', 'x');
    await waitFor(() => b.session.state === 'idle');
    b.session.send('m2', 'y');
    await waitFor(() => b.calls[0]!.userMessages.length === 2);
    const uuid = b.calls[0]!.userMessages[1]!.uuid as string;
    // 在途 m2；先来一个带**别的** uuid 的零帧错误 result（自发/其它来源）→ 自发轮，m2 继续等
    b.calls[0]!.inject([initMessage(), resultMessage({ subtype: 'error_during_execution', errors: ['x'], user_message_uuid: 'someone-else' })]);
    await waitFor(() => assistantTexts(b.events).includes('re:y'), 2_000);
    expect(b.calls).toHaveLength(1);
    await b.session.close();

    void uuid;
    // 归用户：首帧漏标（本 query 已见过标记 → 会判自发）但 result 回显在途 uuid → 改判用户轮，不挂死。
    // 手工打标记：第一轮首帧 + result 都带，第二轮只有 result 带
    const c = liveSession(
      (text, _i, u) => {
        const first = messageStartEvent(nextMsgId());
        if (text === 'x') (first as unknown as { user_message_uuid?: string }).user_message_uuid = u;
        return [initMessage(), first, assistantMessage(`re:${text}`, nextMsgId()), resultMessage({ user_message_uuid: u })];
      },
      { stamp: false },
    );
    c.session.send('m1', 'x');
    await waitFor(() => c.session.state === 'idle');
    c.session.send('m2', 'y');
    await waitFor(() => assistantTexts(c.events).includes('re:y'), 2_000);
    // 早先：首帧无标记判自发 → m2 永远在途、状态永远 running
    await waitFor(() => c.session.state === 'idle', 2_000);
    expect(doneCount(c.events)).toBe(2);
    expect(c.calls).toHaveLength(1);
    await c.session.close();
  });

  test('M3：drain 忙时自发轮出错误型 result → 不置 error，用户轮完成后回 idle', async () => {
    const { session, events, calls } = liveSession(echoRound);
    session.send('m1', 'x');
    await waitFor(() => session.state === 'idle');
    session.send('m2', 'y');
    // m2 已推入在途；CLI 先跑了一个无标记自发轮（同步注入，排在 m2 的轮之前），且它以 max_turns 错误收尾
    calls[0]!.inject([initMessage(), assistantMessage('bg', nextMsgId()), resultMessage({ subtype: 'error_max_turns', errors: [] })]);
    await waitFor(() => assistantTexts(events).includes('re:y'), 2_000);
    await waitFor(() => session.state === 'idle');
    expect(events.filter((e) => e.type === 'error.fatal')).toHaveLength(0);
    expect(events.some((e) => e.type === 'error.transient')).toBe(true);
    expect(runStates(events).at(-1)).toBe('idle');
    await session.close();
  });

  test('M3 对照：独占 run 的自发轮出错仍报 fatal（下一条消息恢复）', async () => {
    const { session, events, calls } = liveSession(echoRound);
    session.send('m1', 'x');
    await waitFor(() => session.state === 'idle');
    calls[0]!.inject([initMessage(), assistantMessage('bg', nextMsgId()), resultMessage({ subtype: 'error_max_turns', errors: [] })]);
    await waitFor(() => session.state === 'error');
    expect(events.some((e) => e.type === 'error.fatal')).toBe(true);
    session.send('m2', 'y');
    await waitFor(() => assistantTexts(events).includes('re:y'), 2_000);
    await waitFor(() => session.state === 'idle');
    await session.close();
  });

  test('m5：通知在用户轮期间到达、自发轮紧随其后 → detail 仍带任务名', async () => {
    const { session, events } = liveSession((text) => [
      initMessage(),
      messageStartEvent(nextMsgId()),
      ...bgTaskStart(),
      assistantMessage(`re:${text}`, nextMsgId()),
      ...bgTaskDone(),
      resultMessage(),
      ...spontaneousRound('BG'),
    ]);
    session.send('m1', 'x');
    await waitFor(() => doneCount(events) === 2, 2_000);
    const marker = events.find((e) => e.type === 'run.state' && (e as { detail?: string }).detail !== undefined) as { detail: string };
    expect(marker.detail).toBe('后台任务“后台 sleep”已完成');
    await session.close();
  });

  test('M2：每次起进程都发一帧后台任务快照（首条消息 / stop 后重起），空也发', async () => {
    const rounds = (text: string): SDKMessage[] => [initMessage(), messageStartEvent(nextMsgId()), ...bgTaskStart(), assistantMessage(`re:${text}`, nextMsgId()), resultMessage()];
    const { session, events } = liveSession(rounds);
    const snaps = () => events.filter((e) => e.type === 'bgtask.snapshot').map((e) => (e as { tasks: { status: string }[] }).tasks.map((t) => t.status));
    session.send('m1', 'x');
    await waitFor(() => session.state === 'idle');
    expect(snaps()[0]).toEqual([]);
    await session.stop();
    const before = snaps().length;
    session.send('m2', 'y');
    await waitFor(() => snaps().length > before);
    // 重起时的那一帧：上个进程的任务已标 stopped
    expect(snaps()[before]).toEqual(['stopped']);
    await session.close();
  });
});

describe('createPushStream', () => {
  test('先 push 后消费', async () => {
    const stream = createPushStream<number>();
    stream.push(1);
    stream.push(2);
    stream.end();

    const seen: number[] = [];
    for await (const value of stream.iterable) seen.push(value);
    expect(seen).toEqual([1, 2]);
  });

  test('消费者领先时挂起等待', async () => {
    const stream = createPushStream<number>();
    const iterator = stream.iterable[Symbol.asyncIterator]();

    const pending = iterator.next();
    stream.push(42);
    expect(await pending).toEqual({ value: 42, done: false });
  });

  test('end 让迭代器收尾', async () => {
    const stream = createPushStream<number>();
    const iterator = stream.iterable[Symbol.asyncIterator]();
    const pending = iterator.next();
    stream.end();
    expect((await pending).done).toBe(true);
  });
});

describe('ClaudeSession · 子 agent（subagent-view）', () => {
  const PARENT = 'toolu_parent';
  const script: SDKMessage[] = [
    {
      type: 'assistant',
      message: { id: 'msg_m', role: 'assistant', content: [{ type: 'tool_use', id: PARENT, name: 'Agent', input: { description: 'Run echo' } }] },
      parent_tool_use_id: null,
      uuid: 'u',
      session_id: 's1',
    } as unknown as SDKMessage,
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'a000000000000001',
      tool_use_id: PARENT,
      description: 'Run echo',
      subagent_type: 'general-purpose',
      is_backgrounded: false,
      task_type: 'local_agent',
      uuid: 'u',
      session_id: 's1',
    } as unknown as SDKMessage,
    // 子 agent 自己同步跑的 Bash 也发 task_started（task_type local_bash）——不进映射
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'bash-task',
      tool_use_id: 'toolu_c1',
      description: 'echo',
      is_backgrounded: false,
      owned_by_subagent: true,
      task_type: 'local_bash',
      uuid: 'u',
      session_id: 's1',
    } as unknown as SDKMessage,
    {
      type: 'assistant',
      message: { id: 'msg_s', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_c1', name: 'Bash', input: { command: 'echo SUB1' } }] },
      parent_tool_use_id: PARENT,
      uuid: 'u',
      session_id: 's1',
    } as unknown as SDKMessage,
    {
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_c1', type: 'tool_result', content: 'SUB1' }] },
      parent_tool_use_id: PARENT,
      uuid: 'u',
      session_id: 's1',
    } as unknown as SDKMessage,
    {
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: PARENT, type: 'tool_result', content: 'done' }] },
      parent_tool_use_id: null,
      tool_use_result: { status: 'completed', totalToolUseCount: 1, totalDurationMs: 1200 },
      uuid: 'u',
      session_id: 's1',
    } as unknown as SDKMessage,
    resultMessage(),
  ];

  test('子工具帧带 parentToolUseId 发出；run.done 的 toolCount 只算主线程', async () => {
    const { session, events } = makeSession([script]);
    session.send('m1', '跑个子 agent');
    await waitFor(() => events.some((e) => e.type === 'run.done'));
    const starts = events.filter((e) => e.type === 'tool.start');
    expect(starts.map((e) => [e.toolUseId, 'parentToolUseId' in e ? e.parentToolUseId : null])).toEqual([
      [PARENT, null],
      ['toolu_c1', PARENT],
    ]);
    const ends = events.filter((e) => e.type === 'tool.end');
    expect(ends.map((e) => [e.toolUseId, 'parentToolUseId' in e ? e.parentToolUseId : null])).toEqual([
      ['toolu_c1', PARENT],
      [PARENT, null],
    ]);
    expect(ends[1]).toMatchObject({ resultSummary: '✓ 1 次工具调用 · 1.2s' });
    expect(events.find((e) => e.type === 'run.done')).toMatchObject({ toolCount: 1 });
    await session.close();
  });

  test('canUseTool 的 agentID（task_id）经 task_started 映射成 permission.request.parentToolUseId', async () => {
    const { session, events } = makeSession([script]);
    session.send('m1', '跑个子 agent');
    await waitFor(() => events.some((e) => e.type === 'run.done'));
    const signal = new AbortController().signal;
    void session.permissions.canUseTool('Write', { file_path: '/x' }, { signal, toolUseID: 'toolu_w', requestId: 'r', agentID: 'a000000000000001' } as never);
    void session.permissions.canUseTool('Write', { file_path: '/y' }, { signal, toolUseID: 'toolu_w2', requestId: 'r2', agentID: 'bash-task' } as never);
    void session.permissions.canUseTool('Write', { file_path: '/z' }, { signal, toolUseID: 'toolu_w3', requestId: 'r3' } as never);
    const reqs = events.filter((e) => e.type === 'permission.request');
    expect(reqs.map((e) => ('parentToolUseId' in e ? e.parentToolUseId : null))).toEqual([PARENT, null, null]);
    await session.close();
  });
});

describe('ClaudeSession · 空闲期的权限请求（评审 M2）', () => {
  test('主线程 idle 时后台子 agent 要权限 → 批准后回 idle（不滞留无轮的 running）', async () => {
    const { session, events } = makeSession([[assistantMessage('ok'), resultMessage()]]);
    session.send('m1', 'go');
    await waitFor(() => events.some((e) => e.type === 'run.done') && session.state === 'idle');
    const pending = session.permissions.canUseTool(
      'Write',
      { file_path: '/x' },
      { signal: new AbortController().signal, toolUseID: 'toolu_c1', requestId: 'r', agentID: 'task1' } as never,
    );
    expect(session.state).toBe('waiting_permission');
    const req = events.find((e): e is Extract<EventBody, { type: 'permission.request' }> => e.type === 'permission.request')!;
    session.respondPermission({ requestId: req.requestId, verdict: 'allow' });
    await pending;
    expect(session.state).toBe('idle');
    const states = events.filter((e): e is Extract<EventBody, { type: 'run.state' }> => e.type === 'run.state').map((e) => e.state);
    expect(states.slice(-2)).toEqual(['waiting_permission', 'idle']);
    await session.close();
  });
});

describe('ClaudeSession · 后台子 agent 的父卡收尾（评审 M1）', () => {
  const PARENT = 'toolu_bgparent';
  const ASYNC_TEXT =
    'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a404 (internal ID - do not mention to user.)\nThe agent is working in the background.';
  const sys = (fields: Record<string, unknown>): SDKMessage => ({ type: 'system', uuid: 'u', session_id: 's1', ...fields }) as unknown as SDKMessage;
  const script = (backgrounded: boolean): SDKMessage[] => [
    {
      type: 'assistant',
      message: { id: 'msg_m', role: 'assistant', content: [{ type: 'tool_use', id: PARENT, name: 'Agent', input: { description: '后台执行', run_in_background: backgrounded } }] },
      parent_tool_use_id: null,
      uuid: 'u',
      session_id: 's1',
    } as unknown as SDKMessage,
    sys({ subtype: 'task_started', task_id: 'a404', tool_use_id: PARENT, description: '后台执行', is_backgrounded: backgrounded, task_type: 'local_agent' }),
    {
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: PARENT, type: 'tool_result', content: [{ type: 'text', text: backgrounded ? ASYNC_TEXT : 'done' }] }] },
      parent_tool_use_id: null,
      tool_use_result: backgrounded ? { isAsync: true, status: 'async_launched', agentId: 'a404' } : { status: 'completed', totalToolUseCount: 3, totalDurationMs: 18_288 },
      uuid: 'u',
      session_id: 's1',
    } as unknown as SDKMessage,
    resultMessage(),
    sys({
      subtype: 'task_notification',
      task_id: 'a404',
      tool_use_id: PARENT,
      status: 'completed',
      summary: '三个步骤都已完成。',
      usage: { total_tokens: 24895, tool_uses: 3, duration_ms: 18_288 },
    }),
  ];

  test('父卡「已启动」的 tool.end 不带内部元数据预览；task_notification 时再发一帧 tool.end 收尾', async () => {
    const { session, events } = makeSession([script(true)]);
    session.send('m1', '后台跑');
    await waitFor(() => events.filter((e) => e.type === 'tool.end').length >= 2);
    const ends = events.filter((e): e is Extract<EventBody, { type: 'tool.end' }> => e.type === 'tool.end' && e.toolUseId === PARENT);
    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({ resultSummary: '✓ 后台子 agent 已启动' });
    expect(ends[0]!.outputPreview).toBeUndefined();
    expect(ends[1]).toMatchObject({ status: 'ok', resultSummary: '✓ 3 次工具调用 · 18.3s', durationMs: 18_288, outputPreview: '三个步骤都已完成。' });
    await session.close();
  });

  test('前台子 agent 的 task_notification 不重发 tool.end', async () => {
    const { session, events } = makeSession([script(false)]);
    session.send('m1', '前台跑');
    await waitFor(() => events.some((e) => e.type === 'run.done'));
    await Bun.sleep(20);
    expect(events.filter((e) => e.type === 'tool.end' && e.toolUseId === PARENT)).toHaveLength(1);
    await session.close();
  });
});

describe('ClaudeSession · 权限来源兜底（评审 m6）', () => {
  test('没有 task_started 映射时，按在途子工具的 parent 标来源', async () => {
    const sub: SDKMessage = {
      type: 'assistant',
      message: { id: 'ms', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: '/x' } }] },
      parent_tool_use_id: 'toolu_parent',
      uuid: 'u',
      session_id: 's1',
    } as unknown as SDKMessage;
    const { session, events } = makeSession([[sub, resultMessage()]]);
    session.send('m1', 'go');
    await waitFor(() => events.some((e) => e.type === 'tool.start'));
    void session.permissions.canUseTool('Write', { file_path: '/x' }, { signal: new AbortController().signal, toolUseID: 'toolu_w', requestId: 'r', agentID: 'no-task-started' } as never);
    const req = events.find((e) => e.type === 'permission.request');
    expect(req).toMatchObject({ parentToolUseId: 'toolu_parent' });
    await session.close();
  });
});

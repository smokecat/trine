/**
 * translate 层：SDK 消息 → 事件体。
 *
 * 这一层是纯函数，所以测试可以直接构造 SDK 形状的消息，不用起真进程。
 * 消息用 `as unknown as SDKMessage` 造——SDK 的类型带一堆 optional 字段，
 * 测试只关心 translate 实际读的那几个。
 */
import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentToClientEventSchema } from '@trine/core';
import { createTranslateState, permissionModeFromStatus, translateMessage, type TranslateState } from './translate.ts';

function ctx(state: TranslateState, now = 1_000): { now: number; state: TranslateState } {
  return { now, state };
}

function assistantMessage(content: unknown[], id = 'msg_1'): SDKMessage {
  return {
    type: 'assistant',
    message: { id, role: 'assistant', content },
    parent_tool_use_id: null,
    uuid: 'uuid-1',
    session_id: 's1',
  } as unknown as SDKMessage;
}

function userMessage(content: unknown[]): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  } as unknown as SDKMessage;
}

function streamEvent(event: unknown, parent: string | null = null): SDKMessage {
  return {
    type: 'stream_event',
    event,
    parent_tool_use_id: parent,
    uuid: 'uuid-s',
    session_id: 's1',
  } as unknown as SDKMessage;
}

describe('translateMessage · 文本流', () => {
  test('text_delta → assistant.delta', () => {
    const state = createTranslateState(0);
    translateMessage(
      streamEvent({ type: 'message_start', message: { id: 'msg_9' } }),
      ctx(state),
    );
    const out = translateMessage(
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } }),
      ctx(state),
    );

    expect(out).toEqual([{ type: 'assistant.delta', messageId: 'msg_9', text: '你好' }]);
  });

  test('空 delta 不产出事件', () => {
    const state = createTranslateState(0);
    const out = translateMessage(
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }),
      ctx(state),
    );
    expect(out).toEqual([]);
  });

  test('thinking_delta 只发一次 thinking.start，且不带正文', () => {
    const state = createTranslateState(0);
    translateMessage(
      streamEvent({ type: 'message_start', message: { id: 'm1' } }),
      ctx(state),
    );
    const first = translateMessage(
      streamEvent({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: '秘密推理' },
      }),
      ctx(state),
    );
    const second = translateMessage(
      streamEvent({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: '更多推理' },
      }),
      ctx(state),
    );

    expect(first).toEqual([{ type: 'thinking.start', messageId: 'm1' }]);
    expect(second).toEqual([]);
    expect(JSON.stringify(first)).not.toContain('秘密推理');
  });

  test('子 agent 的流不进主聊天流', () => {
    const state = createTranslateState(0);
    const out = translateMessage(
      streamEvent(
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } },
        'tool_use_abc',
      ),
      ctx(state),
    );
    expect(out).toEqual([]);
  });

  test('message_start 缺席时 delta 与 done 落在同一气泡（不留孤儿）', () => {
    const state = createTranslateState(0);
    // 没有 message_start 就直接来 delta——增量只能挂占位 id
    const delta = translateMessage(
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: '半截' } }),
      ctx(state),
    );
    const done = translateMessage(assistantMessage([{ type: 'text', text: '半截话' }], 'msg_real'), ctx(state));

    const deltaId = (delta[0] as { messageId: string }).messageId;
    const doneId = (done[0] as { messageId: string }).messageId;
    // 两者必须一致，否则 client 上那条占位气泡永远等不到 done
    expect(doneId).toBe(deltaId);
  });

  test('一条消息结束后游标复位，下条消息不续用上条的 id', () => {
    const state = createTranslateState(0);
    translateMessage(streamEvent({ type: 'message_start', message: { id: 'msg_a' } }), ctx(state));
    translateMessage(assistantMessage([{ type: 'text', text: 'A' }], 'msg_a'), ctx(state));
    translateMessage(streamEvent({ type: 'message_stop' }), ctx(state));

    // 第二条消息还没 message_start 就来 delta → 应落在占位 id，而非 msg_a
    const delta = translateMessage(
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'B' } }),
      ctx(state),
    );
    expect((delta[0] as { messageId: string }).messageId).not.toBe('msg_a');
  });

  test('thinking 块 + text 块同属一条消息：text 的 delta/done 用真实 id，不落占位', () => {
    // opus 带 thinking 的回复：一次 message_start 下先 thinking 块（先到一条
    // assistant 消息），再 text 块。早先 thinking 的 assistant 消息就把游标复位，
    // text 的 delta 只能挂占位 id
    const state = createTranslateState(0);
    translateMessage(streamEvent({ type: 'message_start', message: { id: 'msg_t' } }), ctx(state));
    const think = translateMessage(
      streamEvent({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } }),
      ctx(state),
    );
    translateMessage(assistantMessage([{ type: 'thinking', thinking: '' }], 'msg_t'), ctx(state));
    const delta = translateMessage(
      streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: '答' } }),
      ctx(state),
    );
    const done = translateMessage(assistantMessage([{ type: 'text', text: '答案' }], 'msg_t'), ctx(state));
    translateMessage(streamEvent({ type: 'message_stop' }), ctx(state));

    expect(think[0]).toMatchObject({ type: 'thinking.start', messageId: 'msg_t' });
    expect(delta[0]).toMatchObject({ type: 'assistant.delta', messageId: 'msg_t' });
    expect(done[0]).toMatchObject({ type: 'assistant.done', messageId: 'msg_t', text: '答案' });
  });

  test('不同消息的占位 id 互不相同，client 不会把新回复覆盖进旧气泡', () => {
    const state = createTranslateState(0);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const delta = translateMessage(
        streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } }),
        ctx(state),
      );
      const done = translateMessage(assistantMessage([{ type: 'text', text: 'x' }], `msg_${i}`), ctx(state));
      expect((done[0] as { messageId: string }).messageId).toBe((delta[0] as { messageId: string }).messageId);
      ids.push((delta[0] as { messageId: string }).messageId);
      translateMessage(streamEvent({ type: 'message_stop' }), ctx(state));
    }
    expect(ids[0]).not.toBe(ids[1]);
  });

  test('同 message.id 的多块消息累积全文，前面的块不被覆盖丢失', () => {
    // SDK 流式期间每个完成的内容块发一条 assistant 消息，连续几条共享 message.id。
    // 协议里 assistant.done 是「终态全文覆盖」，若每块各发各的，client 覆盖后
    // 只剩最后一块——典型场景「文本A + tool_use + 文本B」会让 A 消失。
    const state = createTranslateState(0);
    const a = translateMessage(assistantMessage([{ type: 'text', text: '块A' }], 'msg_same'), ctx(state));
    const b = translateMessage(assistantMessage([{ type: 'text', text: '块B' }], 'msg_same'), ctx(state));

    expect(a[0]).toMatchObject({ messageId: 'msg_same', text: '块A' });
    // 第二条必须是累积后的全文，而不是只有 B
    expect(b[0]).toMatchObject({ messageId: 'msg_same', text: '块A块B' });
  });

  test('换了 messageId 就重新累积，不串到上一条', () => {
    const state = createTranslateState(0);
    translateMessage(assistantMessage([{ type: 'text', text: '第一条' }], 'msg_1'), ctx(state));
    const second = translateMessage(
      assistantMessage([{ type: 'text', text: '第二条' }], 'msg_2'),
      ctx(state),
    );
    expect(second[0]).toMatchObject({ messageId: 'msg_2', text: '第二条' });
  });

  test('assistant 消息 → assistant.done 终态全文', () => {
    const state = createTranslateState(0);
    const out = translateMessage(
      assistantMessage([{ type: 'text', text: '完整回复' }], 'msg_x'),
      ctx(state),
    );
    expect(out).toEqual([
      { type: 'assistant.done', messageId: 'msg_x', text: '完整回复' },
    ]);
  });
});

describe('translateMessage · 工具卡', () => {
  test('tool_use → tool.start，含 argSummary', () => {
    const state = createTranslateState(0);
    const out = translateMessage(
      assistantMessage([
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'git status' } },
      ]),
      ctx(state),
    );

    expect(out).toEqual([
      { type: 'tool.start', toolUseId: 'tu_1', toolName: 'Bash', argSummary: 'git status' },
    ]);
    expect(state.toolCount).toBe(1);
  });

  test('tool_result → tool.end，耗时按 start 到 end 计算', () => {
    const state = createTranslateState(0);
    translateMessage(
      assistantMessage([
        { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'sleep' } },
      ]),
      ctx(state, 1_000),
    );
    const out = translateMessage(
      userMessage([{ type: 'tool_result', tool_use_id: 'tu_2', content: 'done' }]),
      ctx(state, 3_500),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'tool.end',
      toolUseId: 'tu_2',
      status: 'ok',
      durationMs: 2_500,
    });
    // 配对后在途记录要清掉，否则长会话会泄漏
    expect(state.pendingTools.size).toBe(0);
  });

  test('is_error 的 tool_result → status error', () => {
    const state = createTranslateState(0);
    translateMessage(
      assistantMessage([{ type: 'tool_use', id: 'tu_3', name: 'Bash', input: {} }]),
      ctx(state, 0),
    );
    const out = translateMessage(
      userMessage([
        { type: 'tool_result', tool_use_id: 'tu_3', content: '命令失败', is_error: true },
      ]),
      ctx(state, 100),
    );

    expect(out[0]).toMatchObject({ type: 'tool.end', status: 'error' });
  });

  test('没有配对 start 的 tool_result 仍收尾（resume 跨进程场景）', () => {
    const state = createTranslateState(0);
    const out = translateMessage(
      userMessage([{ type: 'tool_result', tool_use_id: 'orphan', content: 'ok' }]),
      ctx(state, 500),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'tool.end', toolUseId: 'orphan', durationMs: 0 });
  });

  test('超长输出截断进 outputPreview', () => {
    const state = createTranslateState(0);
    translateMessage(
      assistantMessage([{ type: 'tool_use', id: 'tu_4', name: 'Read', input: {} }]),
      ctx(state, 0),
    );
    const long = 'x'.repeat(5000);
    const out = translateMessage(
      userMessage([{ type: 'tool_result', tool_use_id: 'tu_4', content: long }]),
      ctx(state, 10),
    );

    const end = out[0] as { outputPreview?: string };
    expect(end.outputPreview).toBeDefined();
    expect(end.outputPreview!.length).toBeLessThan(long.length);
  });
});

describe('translateMessage · result', () => {
  function result(overrides: Record<string, unknown>): SDKMessage {
    return {
      type: 'result',
      subtype: 'success',
      duration_ms: 1234,
      duration_api_ms: 1000,
      is_error: false,
      num_turns: 2,
      result: 'ok',
      stop_reason: 'end_turn',
      total_cost_usd: 0.5,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      uuid: 'u',
      session_id: 's1',
      ...overrides,
    } as unknown as SDKMessage;
  }

  test('result → run.done，成本取本轮增量（SDK 给的是累计值）', () => {
    const state = createTranslateState(0);
    state.toolCount = 3;
    state.permissionCount = 1;

    const first = translateMessage(result({ total_cost_usd: 0.5 }), ctx(state));
    expect(first[0]).toMatchObject({
      type: 'run.done',
      durationMs: 1234,
      costUsd: 0.5,
      toolCount: 3,
      permissionCount: 1,
      turns: 2,
    });

    // 第二轮累计 1.25 → 本轮增量 0.75
    const second = translateMessage(result({ total_cost_usd: 1.25 }), ctx(state));
    expect((second[0] as { costUsd: number }).costUsd).toBeCloseTo(0.75, 10);
  });

  test('累计值回退（会话 /clear 重置）不产生负成本', () => {
    const state = createTranslateState(0);
    translateMessage(result({ total_cost_usd: 2 }), ctx(state));
    const out = translateMessage(result({ total_cost_usd: 0.1 }), ctx(state));
    expect((out[0] as { costUsd: number }).costUsd).toBe(0);
  });
});

describe('translateMessage · 协议 schema 符合性', () => {
  /** 补上信封后过 core 的真 schema——这是 client 侧实际会做的校验 */
  function validates(body: unknown): boolean {
    return AgentToClientEventSchema.safeParse({
      ...(body as object),
      ts: 1,
      seq: 1,
      dir: 'a2c',
      sessionId: 's',
    }).success;
  }

  test('缺 total_cost_usd 的崩溃 result 不产出 NaN', () => {
    const state = createTranslateState(0);
    const msg = {
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 100,
      duration_api_ms: 90,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      errors: ['进程崩了'],
      uuid: 'u',
      session_id: 's',
    } as unknown as SDKMessage;

    const out = translateMessage(msg, ctx(state));
    expect(Number.isFinite((out[0] as { costUsd: number }).costUsd)).toBe(true);
    // 崩溃场景恰恰最需要这张完成卡，帧被 schema 拒掉就等于 UI 永停「运行中」
    expect(validates(out[0])).toBe(true);
  });

  test('非整数 duration_ms 被取整（协议要求 int）', () => {
    const state = createTranslateState(0);
    const msg = {
      type: 'result',
      subtype: 'success',
      duration_ms: 1234.56,
      duration_api_ms: 90,
      is_error: false,
      num_turns: 1,
      result: 'ok',
      stop_reason: 'end_turn',
      total_cost_usd: 0.5,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      uuid: 'u',
      session_id: 's',
    } as unknown as SDKMessage;

    const out = translateMessage(msg, ctx(state));
    expect(Number.isInteger((out[0] as { durationMs: number }).durationMs)).toBe(true);
    expect(validates(out[0])).toBe(true);
  });

  test('非整数时钟下 tool.end 的 durationMs 仍是整数', () => {
    const state = createTranslateState(0);
    translateMessage(
      assistantMessage([{ type: 'tool_use', id: 'tu', name: 'Bash', input: {} }]),
      ctx(state, 0.5),
    );
    const out = translateMessage(
      userMessage([{ type: 'tool_result', tool_use_id: 'tu', content: 'ok' }]),
      ctx(state, 1234.9),
    );
    expect(Number.isInteger((out[0] as { durationMs: number }).durationMs)).toBe(true);
    expect(validates(out[0])).toBe(true);
  });

  test('api_retry 的 attempt=0 被抬到 1（协议要求 positive）', () => {
    const state = createTranslateState(0);
    const out = translateMessage(
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 0,
        max_retries: 3,
        retry_delay_ms: 100,
        error_status: 500,
        error: 'server_error',
        uuid: 'u',
        session_id: 's',
      } as unknown as SDKMessage,
      ctx(state),
    );
    expect((out[0] as { attempt: number }).attempt).toBe(1);
    expect(validates(out[0])).toBe(true);
  });

  test('在途工具表有界，孤儿条目不会累积成泄漏', () => {
    const state = createTranslateState(0);
    for (let i = 0; i < 500; i += 1) {
      translateMessage(
        assistantMessage([{ type: 'tool_use', id: `tu_${i}`, name: 'Bash', input: {} }]),
        ctx(state),
      );
    }
    expect(state.pendingTools.size).toBeLessThanOrEqual(200);
  });
});

describe('translateMessage · system 与未知消息', () => {
  test('init → session.capabilities', () => {
    const state = createTranslateState(0);
    const out = translateMessage(
      {
        type: 'system',
        subtype: 'init',
        model: 'claude-opus-4',
        slash_commands: ['review', 'commit'],
        mcp_servers: [{ name: 'dune', status: 'connected' }],
        tools: [],
        cwd: '/tmp',
        apiKeySource: 'oauth',
        claude_code_version: '2.1.251',
        permissionMode: 'default',
        output_style: 'default',
        skills: [],
        plugins: [],
        uuid: 'u',
        session_id: 's1',
      } as unknown as SDKMessage,
      ctx(state),
    );

    expect(out[0]).toMatchObject({
      type: 'session.capabilities',
      models: ['claude-opus-4'],
    });
    const caps = out[0] as { slashCommands: unknown[]; mcpServers: unknown[] };
    expect(caps.slashCommands).toHaveLength(2);
    expect(caps.mcpServers[0]).toMatchObject({ name: 'dune', state: 'connected' });
  });

  test('session_state_changed 映射到协议状态', () => {
    const state = createTranslateState(0);
    const out = translateMessage(
      {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'requires_action',
        uuid: 'u',
        session_id: 's',
      } as unknown as SDKMessage,
      ctx(state),
    );
    expect(out).toEqual([{ type: 'run.state', state: 'waiting_permission' }]);
  });

  test('未知消息类型静默忽略，不抛错', () => {
    const state = createTranslateState(0);
    const unknowns: SDKMessage[] = [
      { type: 'system', subtype: 'some_future_subtype' } as unknown as SDKMessage,
      { type: 'brand_new_message_type' } as unknown as SDKMessage,
      { type: 'system', subtype: 'compact_boundary' } as unknown as SDKMessage,
    ];
    for (const message of unknowns) {
      expect(() => translateMessage(message, ctx(state))).not.toThrow();
      expect(translateMessage(message, ctx(state))).toEqual([]);
    }
  });
});

describe('permissionModeFromStatus', () => {
  const status = (over: Record<string, unknown>) =>
    ({ type: 'system', subtype: 'status', status: null, uuid: 'u', session_id: 's1', ...over }) as unknown as SDKMessage;

  test('status 带协议已知的 permissionMode → 取出', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const) {
      expect(permissionModeFromStatus(status({ permissionMode: mode }))).toBe(mode);
    }
  });

  test('不带 / 协议外的模式 / 非 status 消息 → undefined', () => {
    expect(permissionModeFromStatus(status({}))).toBeUndefined();
    expect(permissionModeFromStatus(status({ permissionMode: 'auto' }))).toBeUndefined();
    expect(permissionModeFromStatus(status({ permissionMode: 'dontAsk' }))).toBeUndefined();
    expect(
      permissionModeFromStatus({ type: 'system', subtype: 'init', permissionMode: 'plan' } as unknown as SDKMessage),
    ).toBeUndefined();
  });

  test('status 消息本身不产出任何协议事件（模式同步是会话层副作用）', () => {
    expect(translateMessage(status({ permissionMode: 'default' }), { now: 0, state: createTranslateState(0) })).toEqual([]);
  });
});

describe('translateSystem · init 缺字段不抛（评审 B2）', () => {
  test('slash_commands / mcp_servers 缺失或形状不对 → 空清单，不抛', () => {
    const state = createTranslateState(0);
    const bad = { type: 'system', subtype: 'init', model: 'm', uuid: 'u', session_id: 's' } as unknown as SDKMessage;
    expect(translateMessage(bad, { now: 0, state })).toEqual([
      { type: 'session.capabilities', slashCommands: [], models: ['m'], mcpServers: [] },
    ]);
    const mixed = {
      type: 'system',
      subtype: 'init',
      model: 'm',
      slash_commands: ['/a', 3, null],
      mcp_servers: [{ name: 'x', status: 'connected' }, { status: 'x' }, null],
      uuid: 'u',
      session_id: 's',
    } as unknown as SDKMessage;
    const [caps] = translateMessage(mixed, { now: 0, state }) as unknown as [{ slashCommands: unknown[]; mcpServers: unknown[] }];
    expect(caps.slashCommands).toEqual([{ name: '/a', source: 'project' }]);
    expect(caps.mcpServers).toEqual([{ name: 'x', state: 'connected', toolCount: 0 }]);
  });
});

// ---------------------------------------------------------------------------
// 子 agent 的帧（subagent-view）——使用合成标识复现 Claude 子代理帧结构
// ---------------------------------------------------------------------------

const PARENT = 'toolu_fixture0002';

function subAssistant(content: unknown[], id = 'msg_sub'): SDKMessage {
  return {
    type: 'assistant',
    message: { id, role: 'assistant', content },
    parent_tool_use_id: PARENT,
    uuid: 'uuid-sub',
    session_id: 's1',
  } as unknown as SDKMessage;
}

function subUser(content: unknown): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: PARENT,
  } as unknown as SDKMessage;
}

/** Agent 工具的结构化输出（实测字段，删掉了无关的） */
const AGENT_RESULT = {
  status: 'completed',
  prompt: '请按顺序完成以下步骤…',
  agentId: 'a000000000000001',
  agentType: 'general-purpose',
  content: [{ type: 'text', text: '三个步骤都成功了，没有报错。\n\n1. `echo SUB1` 的输出是 `SUB1`。' }],
  totalDurationMs: 18288,
  totalTokens: 26412,
  totalToolUseCount: 3,
  toolStats: { readCount: 1, searchCount: 0, bashCount: 1, editFileCount: 1, linesAdded: 1, linesRemoved: 0, otherToolCount: 0 },
  resolvedModel: 'claude-opus-5-5[1m]',
};

const AGENT_RESULT_TEXT =
  '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:\n' +
  '  三个步骤都成功了，没有报错。\n  \n  1. `echo SUB1` 的输出是 `SUB1`。\n' +
  "agentId: a000000000000001 (use SendMessage with to: 'a000000000000001', summary: '<5-10 word recap>' to continue this agent)\n" +
  '<usage>subagent_tokens: 26412\ntool_uses: 3\nduration_ms: 18288</usage>';

describe('translateMessage · 子 agent', () => {
  test('子 agent 的 tool_use → 带 parentToolUseId 的 tool.start；不计入 toolCount', () => {
    const state = createTranslateState(0);
    translateMessage(assistantMessage([{ type: 'tool_use', id: PARENT, name: 'Agent', input: { description: 'Run echo, write, read file', prompt: 'p' } }]), ctx(state));
    expect(state.toolCount).toBe(1);

    const out = translateMessage(
      subAssistant([{ type: 'tool_use', id: 'toolu_c1', name: 'Bash', input: { command: 'echo SUB1' } }]),
      ctx(state, 2_000),
    );
    expect(out).toEqual([{ type: 'tool.start', toolUseId: 'toolu_c1', toolName: 'Bash', argSummary: 'echo SUB1', parentToolUseId: PARENT }]);
    expect(state.toolCount).toBe(1);
    // 帧对协议合法
    const frame = { ...out[0]!, ts: 1, seq: 1, dir: 'a2c', sessionId: 's1' };
    expect(AgentToClientEventSchema.safeParse(frame).success).toBe(true);
  });

  test('子 agent 的 tool_result → 带 parentToolUseId 的 tool.end，耗时按 start 算', () => {
    const state = createTranslateState(0);
    translateMessage(subAssistant([{ type: 'tool_use', id: 'toolu_c1', name: 'Bash', input: { command: 'echo SUB1' } }]), ctx(state, 1_000));
    const out = translateMessage(
      subUser([{ tool_use_id: 'toolu_c1', type: 'tool_result', content: 'SUB1', is_error: false }]),
      ctx(state, 1_250),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'tool.end', toolUseId: 'toolu_c1', status: 'ok', durationMs: 250, parentToolUseId: PARENT, outputPreview: 'SUB1' });
  });

  test('子 agent 的文本 / thinking / 流事件 / 首条 prompt 都不出帧，也不动主线程的 done 累积', () => {
    const state = createTranslateState(0);
    translateMessage(assistantMessage([{ type: 'text', text: '主线程A' }], 'msg_main'), ctx(state));
    expect(translateMessage(subAssistant([{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '子文本' }]), ctx(state))).toEqual([]);
    expect(translateMessage(subUser('请按顺序完成以下步骤'), ctx(state))).toEqual([]);
    expect(
      translateMessage(streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: '子' } }, PARENT), ctx(state)),
    ).toEqual([]);
    const next = translateMessage(assistantMessage([{ type: 'text', text: 'B' }], 'msg_main'), ctx(state));
    expect(next).toEqual([{ type: 'assistant.done', messageId: 'msg_main', text: '主线程AB' }]);
  });

  test('嵌套：孙工具的 parent 是子 agent 里那次 Agent 调用', () => {
    const state = createTranslateState(0);
    const inner = translateMessage(subAssistant([{ type: 'tool_use', id: 'toolu_inner', name: 'Agent', input: { description: 'inner' } }]), ctx(state));
    expect(inner[0]).toMatchObject({ toolUseId: 'toolu_inner', parentToolUseId: PARENT });
    const grand = translateMessage(
      {
        type: 'assistant',
        message: { id: 'm3', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_g', name: 'Read', input: { file_path: '/a' } }] },
        parent_tool_use_id: 'toolu_inner',
        uuid: 'u',
        session_id: 's1',
      } as unknown as SDKMessage,
      ctx(state),
    );
    expect(grand[0]).toMatchObject({ toolUseId: 'toolu_g', parentToolUseId: 'toolu_inner' });
  });

  test('Agent 结果：摘要取 tool_use_result 的调用次数与耗时，预览是干净的报告正文', () => {
    const state = createTranslateState(0);
    translateMessage(assistantMessage([{ type: 'tool_use', id: PARENT, name: 'Agent', input: { description: 'd' } }]), ctx(state, 0));
    const out = translateMessage(
      {
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: PARENT, type: 'tool_result', content: [{ type: 'text', text: AGENT_RESULT_TEXT }] }] },
        parent_tool_use_id: null,
        tool_use_result: AGENT_RESULT,
      } as unknown as SDKMessage,
      ctx(state, 19_000),
    );
    expect(out[0]).toMatchObject({ type: 'tool.end', status: 'ok', resultSummary: '✓ 3 次工具调用 · 18.3s' });
    expect((out[0] as { outputPreview?: string }).outputPreview).toBe('三个步骤都成功了，没有报错。\n\n1. `echo SUB1` 的输出是 `SUB1`。');
    expect('parentToolUseId' in out[0]!).toBe(false);
  });

  test('Agent 结果没有结构化输出（旧 CLI）：从文本的 <usage> 块取，预览剥掉前言与尾巴', () => {
    const state = createTranslateState(0);
    translateMessage(assistantMessage([{ type: 'tool_use', id: PARENT, name: 'Task', input: { description: 'd' } }]), ctx(state, 0));
    const out = translateMessage(userMessage([{ tool_use_id: PARENT, type: 'tool_result', content: AGENT_RESULT_TEXT }]), ctx(state, 20_000));
    expect(out[0]).toMatchObject({ resultSummary: '✓ 3 次工具调用 · 18.3s' });
    expect((out[0] as { outputPreview?: string }).outputPreview).toBe('三个步骤都成功了，没有报错。\n\n1. `echo SUB1` 的输出是 `SUB1`。');
  });
});

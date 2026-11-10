import { describe, expect, test } from 'bun:test';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HistoryItem } from '@trine/core';
import {
  cutAtRewind,
  HISTORY_TEXT_MAX,
  humanUserText,
  normalizeUserText,
  paginateHistory,
  toHistoryItems,
} from './history.ts';
import { taskNotificationLines } from './task-notification.ts';

/** 造一行转录：形状照 SDK 0.3.251 getSessionMessages 实测（多出 timestamp 字段） */
function line(
  type: 'user' | 'assistant' | 'system',
  uuid: string,
  message: unknown,
  at: string,
  parent: string | null = null,
): SessionMessage {
  return {
    type,
    uuid,
    session_id: 's1',
    message,
    parent_tool_use_id: parent,
    parent_agent_id: null,
    timestamp: at,
  } as unknown as SessionMessage;
}

const T0 = '2026-09-24T17:53:28.000Z';
const T1 = '2026-09-24T17:53:30.000Z';
const T2 = '2026-09-24T17:53:35.500Z';
const T3 = '2026-09-24T17:53:40.000Z';
const T4 = '2026-09-24T17:53:50.000Z';
const ms = (iso: string) => Date.parse(iso);

function assistant(uuid: string, id: string, content: unknown[], at: string, parent: string | null = null) {
  return line('assistant', uuid, { id, type: 'message', role: 'assistant', content }, at, parent);
}
function user(uuid: string, content: unknown, at: string, parent: string | null = null) {
  return line('user', uuid, { role: 'user', content }, at, parent);
}

describe('toHistoryItems', () => {
  test('真实形状：同 msg id 拆多行按 id 合并、thinking 丢弃、tool_result 配对', () => {
    const items = toHistoryItems([
      user('u1', '在手机端测，如何批准', T0),
      assistant('a1', 'msg_A', [{ type: 'thinking', thinking: '', signature: 'x' }], T1),
      assistant('a2', 'msg_A', [{ type: 'text', text: '先看看。' }], T1),
      assistant('a3', 'msg_A', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }], T1),
      assistant('a4', 'msg_A', [{ type: 'text', text: '然后……' }], T1),
      user('r1', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a\nb', is_error: false }], T2),
      assistant('a5', 'msg_B', [{ type: 'text', text: '好了' }], T3),
    ]);
    expect(items).toEqual([
      { kind: 'user', id: 'u1', text: '在手机端测，如何批准', ts: ms(T0) },
      { kind: 'assistant', id: 'msg_A', text: '先看看。然后……', ts: ms(T1) },
      {
        kind: 'tool',
        id: 'toolu_1',
        toolName: 'Bash',
        argSummary: 'ls -la',
        status: 'ok',
        durationMs: 5500,
        resultSummary: expect.stringContaining('5.5s') as unknown as string,
        outputPreview: 'a\nb',
        ts: ms(T1),
      },
      { kind: 'assistant', id: 'msg_B', text: '好了', ts: ms(T3) },
    ]);
  });

  test('tool_result 内容是块数组、is_error → error', () => {
    const items = toHistoryItems([
      assistant('a1', 'msg_A', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x/a.ts' } }], T0),
      user(
        'r1',
        [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ENOENT: no such file' }], is_error: true }],
        T1,
      ),
    ]);
    const tool = items[0] as Extract<HistoryItem, { kind: 'tool' }>;
    expect(tool.status).toBe('error');
    expect(tool.resultSummary).toStartWith('✗ ENOENT');
    expect(tool.outputPreview).toBe('ENOENT: no such file');
    expect(tool.argSummary).toBe('/x/a.ts');
  });

  test('没配到结果的工具：省略 status 等字段', () => {
    const items = toHistoryItems([
      assistant('a1', 'msg_A', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 9' } }], T0),
    ]);
    expect(items).toEqual([{ kind: 'tool', id: 'toolu_1', toolName: 'Bash', argSummary: 'sleep 9', ts: ms(T0) }]);
  });

  test('子代理消息（parent_tool_use_id 非空）与 system 行都丢弃', () => {
    const items = toHistoryItems([
      assistant('a1', 'msg_A', [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: { description: '调研' } }], T0),
      user('su', '子代理的 prompt', T1, 'toolu_task'),
      assistant('sa', 'msg_SUB', [{ type: 'text', text: '子代理回复' }], T1, 'toolu_task'),
      assistant('sb', 'msg_SUB', [{ type: 'tool_use', id: 'toolu_sub', name: 'Bash', input: { command: 'x' } }], T1, 'toolu_task'),
      line('system', 'sys', { subtype: 'compact_boundary' }, T2),
      user('r1', [{ type: 'tool_result', tool_use_id: 'toolu_task', content: 'done' }], T3),
    ]);
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(['tool:toolu_task']);
    expect((items[0] as Extract<HistoryItem, { kind: 'tool' }>).status).toBe('ok');
  });

  test('user 字符串 content / 块数组 content / 图片转附件 / 空文本丢弃', () => {
    const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    const items = toHistoryItems([
      user('u1', 'plain', T0),
      user('u2', [{ type: 'text', text: '看图' }, png], T1),
      user('u3', '   ', T2),
      user('u4', [], T2),
      // 只有图片也是一条用户消息
      user('u5', [png, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAAAA==' } }], T2),
      assistant('a1', 'msg_E', [{ type: 'text', text: '' }], T3),
    ]);
    expect(items).toEqual([
      { kind: 'user', id: 'u1', text: 'plain', ts: ms(T0) },
      {
        kind: 'user',
        id: 'u2',
        text: '看图',
        attachments: [{ name: 'image-1.png', mime: 'image/png', size: 3, kind: 'image' }],
        ts: ms(T1),
      },
      {
        kind: 'user',
        id: 'u5',
        text: '',
        attachments: [
          { name: 'image-1.png', mime: 'image/png', size: 3, kind: 'image' },
          { name: 'image-2.jpg', mime: 'image/jpeg', size: 4, kind: 'image' },
        ],
        ts: ms(T2),
      },
    ]);
  });

  test('trine 发的附件：按 manifest 还原列表，去掉末尾的路径清单', () => {
    const file = { name: 'report.pdf', mime: 'application/pdf', size: 10, kind: 'file' as const, blobId: 'b'.repeat(22), key: 'k'.repeat(43) };
    const items = toHistoryItems(
      [
        user('u1', '看看这个\n\n<attached-files>\n/home/x/uploads/s/m/report.pdf\n</attached-files>', T0),
        user('u2', '<attached-files>\n/a\n</attached-files>', T1),
      ],
      new Map([
        ['u1', [file]],
        ['u2', [file]],
      ]),
    );
    expect(items).toEqual([
      { kind: 'user', id: 'u1', text: '看看这个', attachments: [file], ts: ms(T0) },
      { kind: 'user', id: 'u2', text: '', attachments: [file], ts: ms(T1) },
    ]);
  });

  test('斜杠命令标记还原、本地命令输出丢弃', () => {
    const items = toHistoryItems([
      user('c1', '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>', T0),
      user('c2', '<local-command-stdout>cleared</local-command-stdout>', T1),
      user('c3', '<command-name>/review</command-name><command-args>PR 12</command-args>', T2),
    ]);
    expect(items.map((i) => (i.kind === 'tool' ? '' : i.text))).toEqual(['/clear', '/review PR 12']);
  });

  test('normalizeUserText：没有命令标记的文本原样', () => {
    expect(normalizeUserText('a <b> c')).toBe('a <b> c');
    expect(normalizeUserText('<command-name>model</command-name>')).toBe('/model');
  });

  test('超长文本截断并标注；缺 timestamp 沿用上一行', () => {
    const long = 'x'.repeat(HISTORY_TEXT_MAX + 10);
    const noTs = { ...user('u2', 'later', T0), timestamp: undefined } as unknown as SessionMessage;
    const items = toHistoryItems([user('u1', long, T1), noTs]);
    const first = items[0] as Extract<HistoryItem, { kind: 'user' }>;
    expect(first.text.length).toBeLessThan(long.length + 100);
    expect(first.text).toStartWith('x'.repeat(HISTORY_TEXT_MAX));
    expect(first.text).toContain('已截断');
    expect(items[1]).toEqual({ kind: 'user', id: 'u2', text: 'later', ts: ms(T1) });
  });

  test('assistant 合并后再截断（截的是全文）', () => {
    const half = 'y'.repeat(HISTORY_TEXT_MAX);
    const items = toHistoryItems([
      assistant('a1', 'msg_A', [{ type: 'text', text: half }], T0),
      assistant('a2', 'msg_A', [{ type: 'text', text: half }], T0),
    ]);
    expect(items).toHaveLength(1);
    expect((items[0] as Extract<HistoryItem, { kind: 'assistant' }>).text).toContain(`原文共 ${HISTORY_TEXT_MAX * 2} 字`);
  });

  test('非对象 message / 未知行型不抛错', () => {
    const weird = [
      { type: 'user', uuid: 'w1', session_id: 's1', message: null, parent_tool_use_id: null, parent_agent_id: null },
      { type: 'assistant', uuid: 'w2', session_id: 's1', message: 'str', parent_tool_use_id: null, parent_agent_id: null },
    ] as unknown as SessionMessage[];
    expect(toHistoryItems(weird)).toEqual([]);
    expect(toHistoryItems([user('u', 'ok', T4)])).toHaveLength(1);
  });
});

describe('paginateHistory', () => {
  const all: HistoryItem[] = Array.from({ length: 10 }, (_, i) => ({
    kind: 'user' as const,
    id: `u${i}`,
    text: `m${i}`,
    ts: i,
  }));

  test('无 before：最新 limit 条，hasMore + nextBefore = 本页最旧', () => {
    const page = paginateHistory(all, { limit: 3 });
    expect(page.items.map((i) => i.id)).toEqual(['u7', 'u8', 'u9']);
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).toBe('u7');
  });

  test('before 翻页直到取完', () => {
    const p2 = paginateHistory(all, { before: 'u7', limit: 3 });
    expect(p2.items.map((i) => i.id)).toEqual(['u4', 'u5', 'u6']);
    const p3 = paginateHistory(all, { before: 'u1', limit: 3 });
    expect(p3.items.map((i) => i.id)).toEqual(['u0']);
    expect(p3.hasMore).toBe(false);
    expect(p3.nextBefore).toBeUndefined();
  });

  test('一页取完：hasMore false；默认 limit 200', () => {
    expect(paginateHistory(all)).toEqual({ items: all, hasMore: false });
  });

  test('before 找不到 → 空页、不重放', () => {
    expect(paginateHistory(all, { before: 'nope' })).toEqual({ items: [], hasMore: false });
  });

  test('体积封顶：从最旧那头少给，hasMore 置真', () => {
    const big: HistoryItem[] = Array.from({ length: 5 }, (_, i) => ({
      kind: 'assistant' as const,
      id: `msg_${i}`,
      text: 'z'.repeat(1000),
      ts: i,
    }));
    const page = paginateHistory(big, { maxBytes: 2500 });
    expect(page.items.map((i) => i.id)).toEqual(['msg_3', 'msg_4']);
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).toBe('msg_3');
    const serialized = Buffer.byteLength(JSON.stringify(page.items), 'utf8');
    expect(serialized).toBeLessThanOrEqual(2500);
  });

  test('单条超预算也至少给一条（防死循环翻页）', () => {
    const page = paginateHistory(all, { maxBytes: 1 });
    expect(page.items.map((i) => i.id)).toEqual(['u9']);
    expect(page.nextBefore).toBe('u9');
  });
});

describe('toHistoryItems · Agent/Task 结果（subagent-view）', () => {
  test('主转录里的 Agent 结果：摘要从 <usage> 块取，预览是报告正文', () => {
    const text =
      '[Subagent hand-back] The text below is the final report. The report follows:\n  全部完成。\n  第二行\n' +
      "agentId: a1 (use SendMessage with to: 'a1' to continue this agent)\n<usage>subagent_tokens: 10\ntool_uses: 3\nduration_ms: 18288</usage>";
    const items = toHistoryItems([
      line('assistant', 'a1', { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_p', name: 'Agent', input: { description: 'Run echo' } }] }, T0),
      line('user', 'u2', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_p', content: [{ type: 'text', text }] }] }, '2026-09-24T17:53:48.000Z'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'tool', argSummary: 'Run echo', status: 'ok', resultSummary: '✓ 3 次工具调用 · 18.3s', outputPreview: '全部完成。\n第二行' });
  });
});

/** 合成的任务通知文本（形状照 spike S1；id 与内容都是假的） */
function notification(toolUseId: string, status = 'completed', result = '报告正文'): string {
  return [
    '<task-notification>',
    '<task-id>task-fixture-1</task-id>',
    `<tool-use-id>${toolUseId}</tool-use-id>`,
    '<output-file>/tmp/out-fixture</output-file>',
    `<status>${status}</status>`,
    '<summary>Agent "probe" finished</summary>',
    `<result>${result}</result>`,
    '<usage><subagent_tokens>100</subagent_tokens><tool_uses>2</tool_uses><duration_ms>9000</duration_ms></usage>',
    '</task-notification>',
  ].join('\n');
}

describe('toHistoryItems · 后台子 agent（spike S1）', () => {
  const launch = [
    assistant('a1', 'msg_1', [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'probe', prompt: 'p', subagent_type: 'Explore' } }], T0),
    user('r1', [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: [{ type: 'text', text: 'Async agent launched successfully. (internal)' }] }], T1),
    assistant('a2', 'msg_2', [{ type: 'text', text: 'launched' }], T1),
  ];

  test('没有结束证据：标后台 + 状态未知；带类型与 prompt', () => {
    const items = toHistoryItems(launch);
    expect(items[0]).toMatchObject({
      kind: 'tool',
      resultSummary: '✓ 后台子 agent 已启动',
      argDetail: 'p',
      subagent: { agentType: 'Explore', background: true, state: 'unknown' },
    });
  });

  test('主链上的通知行（关联 id 对得上）：不出用户气泡，回填最终状态与报告', () => {
    const items = toHistoryItems([...launch, user('n1', notification('toolu_bg'), T2), assistant('a3', 'msg_3', [{ type: 'text', text: 'ok' }], T3)]);
    expect(items.map((i) => i.kind)).toEqual(['tool', 'assistant', 'assistant']);
    expect(items[0]).toMatchObject({
      status: 'ok',
      resultSummary: '✓ 2 次工具调用 · 9.0s',
      durationMs: 9000,
      outputPreview: '报告正文',
      subagent: { background: true, state: 'completed' },
    });
  });

  test('失败 / 已停止 映射到 error / warn', () => {
    const failed = toHistoryItems([...launch, user('n1', notification('toolu_bg', 'failed'), T2)]);
    expect(failed[0]).toMatchObject({ status: 'error', subagent: { state: 'failed' } });
    const stopped = toHistoryItems([...launch, user('n1', notification('toolu_bg', 'killed'), T2)]);
    expect(stopped[0]).toMatchObject({ status: 'warn', subagent: { state: 'stopped' } });
  });

  test('来源校验：origin 说是人发的就照常显示；没有 origin 且关联 id 对不上也照常显示', () => {
    const human = toHistoryItems([...launch, user('n1', notification('toolu_bg'), T2)], new Map(), { origins: new Map([['n1', 'human']]), notices: [] });
    expect(human.some((i) => i.kind === 'user' && i.id === 'n1')).toBe(true);
    expect(human[0]).toMatchObject({ subagent: { state: 'unknown' } });
    const stranger = toHistoryItems([...launch, user('n1', notification('toolu_other'), T2)]);
    expect(stranger.some((i) => i.kind === 'user' && i.id === 'n1')).toBe(true);
    // 不完整的通知（只有前缀）不算
    const partial = toHistoryItems([...launch, user('n1', '<task-notification>\n<task-id>x</task-id>', T2)]);
    expect(partial.some((i) => i.kind === 'user' && i.id === 'n1')).toBe(true);
  });

  test('origin 标为 task-notification：即使关联 id 不在本页也不出气泡', () => {
    const items = toHistoryItems([user('n1', notification('toolu_far'), T2)], new Map(), {
      origins: new Map([['n1', 'task-notification']]),
      notices: [],
    });
    expect(items).toEqual([]);
  });

  test('被吸收进轮次的通知（原始转录的 queued_command）也回填：要能沿父行走回当前主链', () => {
    const items = toHistoryItems(launch, new Map(), {
      origins: new Map(),
      // 附件 att-2 挂在 r1 下，主链上的 a2 又挂在它下面：它在当前分支上
      notices: [{ taskId: 't', toolUseId: 'toolu_bg', status: 'completed', result: 'r', usage: { tool_uses: 1 }, uuid: 'att-2', parentUuid: 'r1' }],
      parents: new Map([['att-2', 'r1']]),
      children: new Map([['att-2', ['a2']]]),
    });
    expect(items[0]).toMatchObject({ resultSummary: '✓ 1 次工具调用', subagent: { state: 'completed' } });
  });

  test('复审 部分6：旧分支附件直接挂在保留的消息上也不算；没有后代时只认挂在主链末端的', () => {
    const notice = { taskId: 't', toolUseId: 'toolu_bg', status: 'completed', result: '旧分支报告', uuid: 'att-old', parentUuid: 'r1' };
    // att-old 挂在保留的 r1 上，但它的后代 u-dropped 不在当前主链（被回退撤掉的分支）
    const abandoned = toHistoryItems(launch, new Map(), {
      origins: new Map(),
      notices: [notice],
      parents: new Map([['att-old', 'r1']]),
      children: new Map([['att-old', ['u-dropped']]]),
    });
    expect(abandoned[0]).toMatchObject({ subagent: { state: 'unknown' } });
    // 没有后代、挂在主链末端（a2）：刚写进去的，算
    const atTail = { ...notice, parentUuid: 'a2' };
    const tail = toHistoryItems(launch, new Map(), { origins: new Map(), notices: [atTail], parents: new Map([['att-old', 'a2']]) });
    expect(tail[0]).toMatchObject({ subagent: { state: 'completed' } });
    // 主链被待生效的回退截断过：末端不可信，不算
    expect(toHistoryItems(launch, new Map(), { origins: new Map(), notices: [atTail] }, { cutAtRewind: true })[0]).toMatchObject({
      subagent: { state: 'unknown' },
    });
    // 没有后代、挂在中间（r1）的：拿不准，不算
    expect(toHistoryItems(launch, new Map(), { origins: new Map(), notices: [notice] })[0]).toMatchObject({ subagent: { state: 'unknown' } });
  });

  test('评审 中6：回退撤掉的分支上的附件通知不算（走不回当前主链 / 没有父行）', () => {
    const origins = {
      origins: new Map<string, string>(),
      notices: [
        { taskId: 't', toolUseId: 'toolu_bg', status: 'completed', result: '撤掉分支的报告', parentUuid: 'att-x' },
        { taskId: 't', toolUseId: 'toolu_bg', status: 'completed', result: '无父行' },
      ],
      // att-x 挂在被撤掉的用户消息 u-dropped 之后
      parents: new Map([['att-x', 'u-dropped']]),
    };
    const items = toHistoryItems(launch, new Map(), origins);
    expect(items[0]).toMatchObject({ subagent: { state: 'unknown' } });
    expect((items[0] as { outputPreview?: string }).outputPreview).toBeUndefined();
  });

  test('评审 中5：来源不明时兜底收紧——引用 Read 调用、或缺结束 status 的文本仍是用户消息', () => {
    const readCall = [
      assistant('a1', 'msg_1', [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/a' } }], T0),
      user('r1', [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'x' }], T1),
    ];
    const items = toHistoryItems([...readCall, user('n1', notification('toolu_read'), T2)]);
    expect(items.some((i) => i.kind === 'user' && i.id === 'n1')).toBe(true);
    const noStatus = '<task-notification>\n<task-id>t</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n</task-notification>';
    const items2 = toHistoryItems([...launch, user('n2', noStatus, T2)]);
    expect(items2.some((i) => i.kind === 'user' && i.id === 'n2')).toBe(true);
    // 回退口径相同
    expect(humanUserText(user('n2', noStatus, T2), taskNotificationLines([...launch, user('n2', noStatus, T2)]))).toBe(noStatus);
  });

  test('评审 中9：后台启动本身失败 → 失败，不是状态未知', () => {
    const items = toHistoryItems([
      assistant('a1', 'msg_1', [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'p', run_in_background: true } }], T0),
      user('r1', [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Agent type not found', is_error: true }], T1),
    ]);
    expect(items[0]).toMatchObject({ status: 'error', subagent: { background: true, state: 'failed' } });
  });

  test('规格缺口：meta.json 只说 finished → 「已结束 · 结果未知」，不当成功', () => {
    const items = toHistoryItems(launch, new Map(), { origins: new Map(), notices: [], finished: new Set(['toolu_bg']) });
    expect(items[0]).toMatchObject({ status: 'ok', resultSummary: '✓ 后台子 agent 已启动', subagent: { state: 'ended' } });
  });

  test('后台 Bash 的通知只过滤气泡，不改 Bash 卡', () => {
    const items = toHistoryItems([
      assistant('a1', 'msg_1', [{ type: 'tool_use', id: 'toolu_sh', name: 'Bash', input: { command: 'sleep 1', run_in_background: true } }], T0),
      // 回执 id 与通知的 task-id 一致（spike S1：后台 Bash 的任务 id 就是回执里的 ID）
      user('r1', [{ type: 'tool_result', tool_use_id: 'toolu_sh', content: 'Command running in background with ID: task-fixture-1. Output is being written to: /tmp/x' }], T1),
      user('n1', notification('toolu_sh'), T2),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ toolName: 'Bash', resultSummary: '✓ 已在后台运行 · task-fixture-1' });
    expect('subagent' in items[0]!).toBe(false);
  });
});

describe('回退辅助（humanUserText / cutAtRewind）', () => {
  test('humanUserText：只认主线程里用户说的话', () => {
    expect(humanUserText(user('u1', '改一下 README', T0))).toBe('改一下 README');
    const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    expect(humanUserText(user('u2', [{ type: 'text', text: 'a' }, png], T0))).toBe('a');
    // 只有图片：仍是用户消息（可作回退目标），预填文本为空
    expect(humanUserText(user('u2b', [png], T0))).toBe('');
    expect(humanUserText(user('u2c', 'hi\n\n<attached-files>\n/p\n</attached-files>', T0))).toBe('hi');
    expect(humanUserText(user('u3', '<command-name>/review</command-name><command-args>x</command-args>', T0))).toBe('/review x');
    // 工具结果载体、本地命令输出、子代理行、空文本、助手行都不是
    expect(humanUserText(user('u4', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], T0))).toBeUndefined();
    expect(humanUserText(user('u5', '<local-command-stdout>hi</local-command-stdout>', T0))).toBeUndefined();
    expect(humanUserText(user('u6', 'sub', T0, 'toolu_parent'))).toBeUndefined();
    expect(humanUserText(user('u7', '   ', T0))).toBeUndefined();
    expect(humanUserText(assistant('a1', 'msg_1', [{ type: 'text', text: 'x' }], T0))).toBeUndefined();
    // 系统来源的任务通知（taskNotificationLines 认出的）不是用户说的话
    expect(humanUserText(user('n1', notification('toolu_bg'), T0), new Map([['n1', {}]]))).toBeUndefined();
    expect(humanUserText(user('n1', notification('toolu_bg'), T0))).toContain('<task-notification>');
  });

  test('cutAtRewind：从 dropFrom 起截掉；没有 / 找不到原样返回', () => {
    const chain = [user('u1', 'q1', T0), assistant('a1', 'msg_1', [{ type: 'text', text: 'x' }], T1), user('u2', 'q2', T2)];
    expect(cutAtRewind(chain, 'u2').map((m) => m.uuid)).toEqual(['u1', 'a1']);
    expect(cutAtRewind(chain, 'u1')).toEqual([]);
    expect(cutAtRewind(chain, undefined)).toBe(chain);
    expect(cutAtRewind(chain, 'nope')).toBe(chain);
  });
});

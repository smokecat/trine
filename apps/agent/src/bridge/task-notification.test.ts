import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  parseTaskNotification,
  parseTranscriptOrigins,
  readTranscriptOrigins,
  taskNotificationLines,
} from './task-notification.ts';

/** 合成的通知文本（形状照 spike S1） */
const NOTICE = [
  '<task-notification>',
  '<task-id>task-1</task-id>',
  '<tool-use-id>toolu_a</tool-use-id>',
  '<output-file>/tmp/o</output-file>',
  '<status>completed</status>',
  '<summary>Agent "x" finished</summary>',
  '<result>done\nline2</result>',
  '<usage><subagent_tokens>10</subagent_tokens><tool_uses>3</tool_uses><duration_ms>1200</duration_ms></usage>',
  '</task-notification>',
].join('\n');

function msg(type: 'user' | 'assistant', uuid: string, content: unknown): SessionMessage {
  return { type, uuid, session_id: 's', message: { role: type, content }, parent_tool_use_id: null, parent_agent_id: null } as unknown as SessionMessage;
}

describe('parseTaskNotification', () => {
  test('完整通知 → 字段；usage 新旧格式都认', () => {
    expect(parseTaskNotification(NOTICE)).toEqual({
      taskId: 'task-1',
      toolUseId: 'toolu_a',
      status: 'completed',
      summary: 'Agent "x" finished',
      result: 'done\nline2',
      usage: { tool_uses: 3, duration_ms: 1200 },
    });
    const old = NOTICE.replace(/<usage>[\s\S]*<\/usage>/, '<usage>tool_uses: 4\nduration_ms: 50</usage>');
    expect(parseTaskNotification(old)?.usage).toEqual({ tool_uses: 4, duration_ms: 50 });
  });

  test('不完整 / 前后有别的文字 / 缺 task-id → undefined', () => {
    expect(parseTaskNotification('<task-notification>\n<task-id>x</task-id>')).toBeUndefined();
    expect(parseTaskNotification(`看这个：${NOTICE}`)).toBeUndefined();
    expect(parseTaskNotification('<task-notification><status>completed</status></task-notification>')).toBeUndefined();
  });
});

describe('taskNotificationLines', () => {
  const chain = [
    msg('assistant', 'a1', [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: {} }]),
    msg('user', 'n1', NOTICE),
  ];

  test('无 origin：关联 id 是更早的工具调用才算', () => {
    expect([...taskNotificationLines(chain).keys()]).toEqual(['n1']);
    // 通知在工具调用之前（不可能是它的结束通知）
    expect(taskNotificationLines([chain[1]!, chain[0]!]).size).toBe(0);
  });

  test('有 origin 以 origin 为准', () => {
    expect(taskNotificationLines(chain, new Map([['n1', 'human']])).size).toBe(0);
    expect(taskNotificationLines([chain[1]!], new Map([['n1', 'task-notification']])).size).toBe(1);
  });

  test('单个文本块的内容也认；子 agent 行不算', () => {
    const block = msg('user', 'n2', [{ type: 'text', text: NOTICE }]);
    expect(taskNotificationLines([chain[0]!, block]).has('n2')).toBe(true);
    const sub = { ...block, parent_tool_use_id: 'toolu_a' } as SessionMessage;
    expect(taskNotificationLines([chain[0]!, sub]).size).toBe(0);
  });
});

describe('parseTranscriptOrigins / readTranscriptOrigins', () => {
  const lines = [
    { type: 'user', uuid: 'u-h', origin: { kind: 'human' }, message: { role: 'user', content: 'hi' } },
    { type: 'user', uuid: 'u-n', origin: { kind: 'task-notification', producer: 'session-task' }, message: { role: 'user', content: NOTICE } },
    { type: 'user', uuid: 'u-p', origin: { kind: 'human' }, message: { role: 'user', content: `粘贴 ${NOTICE}` } },
    {
      type: 'attachment',
      uuid: 'att',
      attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: NOTICE.replace('toolu_a', 'toolu_b'), origin: { kind: 'task-notification' } },
    },
    { type: 'attachment', uuid: 'att2', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'task-notification 字样' } },
  ];
  const text = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{坏行 task-notification\n`;

  test('只收含通知字样的 user 行的 origin；queued_command 只收 task-notification 模式', () => {
    const parsed = parseTranscriptOrigins(text);
    expect([...parsed.origins]).toEqual([
      ['u-n', 'task-notification'],
      ['u-p', 'human'],
    ]);
    expect(parsed.notices.map((n) => n.toolUseId)).toEqual(['toolu_b']);
  });

  test('按 cwd 猜到转录目录读取；找不到返回 undefined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trine-origins-'));
    const cwd = '/w/proj';
    await mkdir(join(root, '-w-proj'), { recursive: true });
    await writeFile(join(root, '-w-proj', 'sess-1.jsonl'), text);
    const read = await readTranscriptOrigins('sess-1', { cwd, projectsDir: root });
    expect(read?.origins.get('u-n')).toBe('task-notification');
    // cwd 猜不中走扫描
    expect((await readTranscriptOrigins('sess-1', { cwd: '/other', projectsDir: root }))?.notices).toHaveLength(1);
    expect(await readTranscriptOrigins('nope', { projectsDir: root })).toBeUndefined();
    expect(await readTranscriptOrigins('../x', { projectsDir: root })).toBeUndefined();
  });
});

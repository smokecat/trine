import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  parseTaskNotification,
  parseTranscriptOrigins,
  readTranscriptOrigins,
  scanTranscriptForTest,
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
  // 后台启动回执里的 agentId 与通知的 task-id 一致（spike S1）
  const launched = msg('user', 'r1', [
    { type: 'tool_result', tool_use_id: 'toolu_a', content: 'Async agent launched successfully. (internal)\nagentId: task-1 (internal ID)' },
  ]);
  const chain = [msg('assistant', 'a1', [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: {} }]), launched, msg('user', 'n1', NOTICE)];

  test('无 origin：关联 id 必须是更早的一次后台启动', () => {
    expect([...taskNotificationLines(chain).keys()]).toEqual(['n1']);
    // 通知在工具调用之前（不可能是它的结束通知）
    expect(taskNotificationLines([chain[2]!, chain[0]!, chain[1]!]).size).toBe(0);
  });

  test('复审 部分5：普通前台调用 / 启动回执的任务 id 对不上：仍是用户消息', () => {
    const foreground = msg('user', 'r1', [{ type: 'tool_result', tool_use_id: 'toolu_a', content: '前台跑完的报告' }]);
    expect(taskNotificationLines([chain[0]!, foreground, chain[2]!]).size).toBe(0);
    const bash = [
      msg('assistant', 'a1', [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'ls' } }]),
      msg('user', 'r1', [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'a.txt\nb.txt' }]),
      msg('user', 'n1', NOTICE),
    ];
    expect(taskNotificationLines(bash).size).toBe(0);
    const otherId = msg('user', 'r1', [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'Async agent launched successfully.\nagentId: other-task (x)' }]);
    expect(taskNotificationLines([chain[0]!, otherId, chain[2]!]).size).toBe(0);
    // 后台 Bash：回执 id 与 task-id 一致才算
    const bgBash = [
      msg('assistant', 'a1', [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'sleep 1', run_in_background: true } }]),
      msg('user', 'r1', [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'Command running in background with ID: task-1. Output is being written to: /tmp/x' }]),
      msg('user', 'n1', NOTICE),
    ];
    expect(taskNotificationLines(bgBash).has('n1')).toBe(true);
  });

  test('有 origin 以 origin 为准', () => {
    expect(taskNotificationLines(chain, new Map([['n1', 'human']])).size).toBe(0);
    expect(taskNotificationLines([chain[2]!], new Map([['n1', 'task-notification']])).size).toBe(1);
  });

  test('单个文本块的内容也认；子 agent 行不算', () => {
    const block = msg('user', 'n2', [{ type: 'text', text: NOTICE }]);
    expect(taskNotificationLines([chain[0]!, launched, block]).has('n2')).toBe(true);
    const sub = { ...block, parent_tool_use_id: 'toolu_a' } as SessionMessage;
    expect(taskNotificationLines([chain[0]!, launched, sub]).size).toBe(0);
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

  test('评审 低11：流式读、按 (路径, mtime, size) 缓存，翻页不重扫；文件变了重扫；超上限放弃', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trine-origins-cache-'));
    await mkdir(join(root, '-w-p'), { recursive: true });
    const path = join(root, '-w-p', 'sess-2.jsonl');
    await writeFile(path, text);
    const first = await readTranscriptOrigins('sess-2', { cwd: '/w/p', projectsDir: root });
    const again = await readTranscriptOrigins('sess-2', { cwd: '/w/p', projectsDir: root });
    expect(again).toBe(first!);
    const extra = { type: 'user', uuid: 'u-new', origin: { kind: 'task-notification' }, message: { role: 'user', content: NOTICE } };
    await writeFile(path, `${text}${JSON.stringify(extra)}\n`);
    const changed = await readTranscriptOrigins('sess-2', { cwd: '/w/p', projectsDir: root });
    expect(changed).not.toBe(first!);
    expect(changed?.origins.get('u-new')).toBe('task-notification');
    expect(await readTranscriptOrigins('sess-2', { cwd: '/w/p', projectsDir: root, maxBytes: 10 })).toBeUndefined();
  });

  test('附件 / system 行记父子关系，附件通知带 parentUuid', () => {
    const parsed = parseTranscriptOrigins(
      [
        { type: 'system', uuid: 's1', parentUuid: 'a1', subtype: 'x' },
        { type: 'attachment', uuid: 'att1', parentUuid: 's1', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: NOTICE } },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    );
    expect(parsed.parents?.get('att1')).toBe('s1');
    expect(parsed.parents?.get('s1')).toBe('a1');
    expect(parsed.notices[0]?.parentUuid).toBe('s1');
    expect(parsed.notices[0]?.uuid).toBe('att1');
  });

  test('复审 部分6：挂在附件 / system 行下的行（以 parentUuid 开头）记成子行', () => {
    // 键顺序照真实转录：每行以 parentUuid 开头
    const text = [
      '{"parentUuid":"m1","type":"attachment","uuid":"att1","attachment":{"type":"queued_command","commandMode":"task-notification","prompt":' +
        JSON.stringify(NOTICE) +
        '}}',
      '{"parentUuid":"att1","isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[]},"uuid":"m2"}',
      '{"parentUuid":"m2","isSidechain":false,"type":"user","message":{"role":"user","content":"hi"},"uuid":"m3"}',
    ].join('\n');
    const parsed = parseTranscriptOrigins(text);
    expect(parsed.children?.get('att1')).toEqual(['m2']);
    expect(parsed.children?.has('m2')).toBe(false);
  });

  test('复审 新低4：扫描中文件变长，跨上限的块只处理上限内的完整行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'trine-origins-grow-'));
    const path = join(root, 'grow.jsonl');
    const first = JSON.stringify({ type: 'user', uuid: 'u-1', origin: { kind: 'human' }, message: { role: 'user', content: NOTICE } });
    const later = JSON.stringify({ type: 'user', uuid: 'u-2', origin: { kind: 'task-notification' }, message: { role: 'user', content: NOTICE } });
    await writeFile(path, `${first}\n${later}\n`);
    // 上限 = 第一行之后又写了一半：以前整块丢弃，得到空结果
    const limit = Buffer.byteLength(`${first}\n`) + 10;
    const scanned = await scanTranscriptForTest(path, limit);
    expect([...scanned.origins]).toEqual([['u-1', 'human']]);
  });
});

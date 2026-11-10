/**
 * 后台任务结束通知（`<task-notification>`）在转录里的识别与来源校验。
 *
 * ## 转录里的形状（真 claude 2.1.322 实测，spike S1）
 *
 * 后台子 agent / 后台 Bash 结束时 CLI 给模型发一段通知文本：
 *
 * ```
 * <task-notification>
 * <task-id>…</task-id>
 * <tool-use-id>…</tool-use-id>          ← 启动它的那次工具调用
 * <output-file>…</output-file>
 * <status>completed|failed|stopped</status>
 * <summary>…</summary>
 * <result>…</result>                    ← 子 agent 的报告（可缺）
 * <usage><tool_uses>N</tool_uses><duration_ms>N</duration_ms>…</usage>
 * </task-notification>
 * ```
 *
 * 落盘有两种：
 * - 轮次之间完成：主链上一条 **user 行**（content 是字符串），原始 jsonl 行带
 *   `origin:{kind:'task-notification'}`、`promptSource:'system'`。SDK 的 getSessionMessages
 *   **不透传 origin**，于是它看起来就是一条用户消息；
 * - 轮次进行中完成：被吸收进当前轮，只留一条 `attachment{type:'queued_command',
 *   commandMode:'task-notification', prompt}`，主链上没有 user 行。
 *
 * ## 来源校验
 *
 * 不能只看文本前缀（用户也可能粘贴这段文字）：
 * 1. 原始 jsonl 能读到这一行的 origin 时以它为准：`task-notification` 才算，`human` 一律不算；
 * 2. 读不到（老 CLI 不写 origin / 转录找不到）时退回结构 + 关联校验：整段是完整的通知，
 *    且 `<tool-use-id>` 是本转录里**更早**出现过的工具调用。
 */
import { readFile } from 'node:fs/promises';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { locateTranscript } from './session-origin.ts';

export interface TaskNotice {
  taskId: string;
  toolUseId?: string;
  /** 原始 status 文本（completed / failed / stopped / killed …） */
  status?: string;
  summary?: string;
  /** 子 agent 的报告 */
  result?: string;
  usage?: { tool_uses?: number; duration_ms?: number };
}

/** 原始 jsonl 里拿到的来源信息（getSessionMessages 不给的那部分） */
export interface TranscriptOrigins {
  /** user 行 uuid → origin.kind（只收含通知文本的行，人发的也收，用来排除） */
  origins: ReadonlyMap<string, string>;
  /** 被吸收进轮次的通知（queued_command 附件），主链上没有对应的 user 行 */
  notices: readonly TaskNotice[];
}

export const TASK_NOTIFICATION_ORIGIN = 'task-notification';

const OPEN = '<task-notification>';
const CLOSE = '</task-notification>';

function tag(body: string, name: string): string | undefined {
  const m = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (m === null) return undefined;
  const v = (m[1] ?? '').trim();
  return v === '' ? undefined : v;
}

function usageNumber(block: string, name: string): number | undefined {
  // 新格式 `<tool_uses>3</tool_uses>`，旧格式 `tool_uses: 3`
  const m = block.match(new RegExp(`${name}(?:>|\\s*:)\\s*(\\d+)`));
  return m === null ? undefined : Number(m[1]);
}

/** 整段文本是不是一条完整的任务通知；是就解析出字段，否则 undefined */
export function parseTaskNotification(text: string): TaskNotice | undefined {
  const t = text.trim();
  if (!t.startsWith(OPEN) || !t.endsWith(CLOSE)) return undefined;
  const body = t.slice(OPEN.length, -CLOSE.length);
  const taskId = tag(body, 'task-id');
  if (taskId === undefined) return undefined;
  const toolUseId = tag(body, 'tool-use-id');
  const status = tag(body, 'status');
  const summary = tag(body, 'summary');
  const result = tag(body, 'result');
  const usageBlock = tag(body, 'usage');
  const toolUses = usageBlock === undefined ? undefined : usageNumber(usageBlock, 'tool_uses');
  const durationMs = usageBlock === undefined ? undefined : usageNumber(usageBlock, 'duration_ms');
  const usage =
    toolUses === undefined && durationMs === undefined
      ? undefined
      : { ...(toolUses === undefined ? {} : { tool_uses: toolUses }), ...(durationMs === undefined ? {} : { duration_ms: durationMs }) };
  return {
    taskId,
    ...(toolUseId === undefined ? {} : { toolUseId }),
    ...(status === undefined ? {} : { status }),
    ...(summary === undefined ? {} : { summary }),
    ...(result === undefined ? {} : { result }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** 主链 user 行若是任务通知，取出解析结果（只认字符串或单个文本块的内容） */
export function noticeOfLine(message: SessionMessage): TaskNotice | undefined {
  if (message.type !== 'user') return undefined;
  const content = asRecord(message.message)?.['content'];
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && content.length === 1) {
    const b = asRecord(content[0]);
    if (b?.['type'] === 'text' && typeof b['text'] === 'string') text = b['text'];
  }
  return text === undefined ? undefined : parseTaskNotification(text);
}

/**
 * 主链上哪些 user 行是系统来源的任务通知（见文件头「来源校验」）。toHistoryItems 据此
 * 不出用户气泡，回退据此不让选它——两处口径一致。
 */
export function taskNotificationLines(
  messages: readonly SessionMessage[],
  origins?: ReadonlyMap<string, string>,
): Map<string, TaskNotice> {
  const out = new Map<string, TaskNotice>();
  const seenTools = new Set<string>();
  for (const message of messages) {
    if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) continue;
    if (message.type === 'assistant') {
      const content = asRecord(message.message)?.['content'];
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = asRecord(block);
          if (b?.['type'] === 'tool_use' && typeof b['id'] === 'string') seenTools.add(b['id']);
        }
      }
      continue;
    }
    const notice = noticeOfLine(message);
    if (notice === undefined) continue;
    const kind = origins?.get(message.uuid);
    if (kind !== undefined) {
      if (kind === TASK_NOTIFICATION_ORIGIN) out.set(message.uuid, notice);
      continue;
    }
    if (notice.toolUseId !== undefined && seenTools.has(notice.toolUseId)) out.set(message.uuid, notice);
  }
  return out;
}

/** 原始转录只解析这么大以内的（getSessionMessages 本身也整读；再大就放弃来源信息） */
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

/** 原始 jsonl 文本 → 来源信息（纯函数，便于测试） */
export function parseTranscriptOrigins(text: string): TranscriptOrigins {
  const origins = new Map<string, string>();
  const notices: TaskNotice[] = [];
  for (const line of text.split('\n')) {
    // 绝大多数行与通知无关：先做便宜的子串判断再 parse
    if (!line.includes('task-notification')) continue;
    let rec: Record<string, unknown> | undefined;
    try {
      rec = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (rec === undefined) continue;
    if (rec['type'] === 'user' && typeof rec['uuid'] === 'string') {
      const kind = asRecord(rec['origin'])?.['kind'];
      if (typeof kind === 'string' && kind !== '') origins.set(rec['uuid'], kind);
      continue;
    }
    const att = asRecord(rec['attachment']);
    if (rec['type'] !== 'attachment' || att?.['type'] !== 'queued_command') continue;
    const originKind = asRecord(att['origin'])?.['kind'];
    if (att['commandMode'] !== TASK_NOTIFICATION_ORIGIN && originKind !== TASK_NOTIFICATION_ORIGIN) continue;
    const prompt = att['prompt'];
    const notice = typeof prompt === 'string' ? parseTaskNotification(prompt) : undefined;
    if (notice !== undefined) notices.push(notice);
  }
  return { origins, notices };
}

/** 读会话主转录的来源信息；找不到 / 读失败 / 过大返回 undefined（调用方退回结构校验） */
export async function readTranscriptOrigins(
  sessionId: string,
  options: { cwd?: string | undefined; projectsDir?: string } = {},
): Promise<TranscriptOrigins | undefined> {
  try {
    const path = await locateTranscript(sessionId, options);
    if (path === undefined) return undefined;
    const file = Bun.file(path);
    if (file.size > MAX_TRANSCRIPT_BYTES) return undefined;
    return parseTranscriptOrigins(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

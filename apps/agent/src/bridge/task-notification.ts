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
 * ## 来源校验（历史与回退共用 taskNotificationLines）
 *
 * 不能只看文本前缀（用户也可能粘贴这段文字）：
 * 1. 原始 jsonl 能读到这一行的 origin 时以它为准：`task-notification` 才算，其余（human 等）
 *    一律保留为用户消息；
 * 2. 这一行没有 origin（老 CLI / 转录读不到）时退回严格的结构 + 关联校验：完整的结束通知
 *    （task-id、tool-use-id、结束 status 齐全），且 tool-use-id 是本转录里**更早**的
 *    Agent / Task / Bash 调用（只有它们会起后台任务）。不满足就保留为用户消息（评审 中5）。
 *
 * ## 回退分支（评审 中6）
 *
 * queued_command 附件不在 getSessionMessages 的主链里，转录是整份读的：回退后被撤掉的分支上
 * 的附件也在。所以附件通知记下自己的 parentUuid，只认能沿 parentUuid 走回当前主链的那些。
 *
 * ## 读取（评审 低11）
 *
 * 流式按行扫，只解析含关键字的行；结果按 (路径, mtime, size) 缓存，翻页不重扫。
 */
import { stat } from 'node:fs/promises';
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
  /** 附件通知的父行（沿它走回主链才算数，见文件头「回退分支」） */
  parentUuid?: string;
}

/** 原始 jsonl 里拿到的来源信息（getSessionMessages 不给的那部分） */
export interface TranscriptOrigins {
  /** user 行 uuid → origin.kind（只收含通知文本的行，人发的也收，用来排除） */
  origins: ReadonlyMap<string, string>;
  /** 被吸收进轮次的通知（queued_command 附件），主链上没有对应的 user 行 */
  notices: readonly TaskNotice[];
  /** 非消息行（附件 / system）的 uuid → parentUuid：附件通知沿它走回主链 */
  parents?: ReadonlyMap<string, string>;
  /** 子转录 meta.json 说已结束（finished）的父工具调用 id：只证明结束，不证明成败 */
  finished?: ReadonlySet<string>;
}

export const TASK_NOTIFICATION_ORIGIN = 'task-notification';

/** 会起后台任务、因而可能收到结束通知的工具 */
const NOTIFYING_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'Bash']);
/** 结束通知里的 status 取值 */
const END_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped', 'killed']);

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

/** 整段文本是不是一条任务通知；是就解析出字段，否则 undefined */
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

/** 完整的结束通知：task-id、tool-use-id、结束 status 都在 */
export function isCompleteEndNotice(notice: TaskNotice): boolean {
  return notice.toolUseId !== undefined && notice.status !== undefined && END_STATUSES.has(notice.status);
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
  /** 已出现过的工具调用 id → 工具名 */
  const seenTools = new Map<string, string>();
  for (const message of messages) {
    if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) continue;
    if (message.type === 'assistant') {
      const content = asRecord(message.message)?.['content'];
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = asRecord(block);
          if (b?.['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') seenTools.set(b['id'], b['name']);
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
    // 来源不明：只有严格满足结构 + 关联才算，否则宁可当用户消息
    const tool = notice.toolUseId === undefined ? undefined : seenTools.get(notice.toolUseId);
    if (isCompleteEndNotice(notice) && tool !== undefined && NOTIFYING_TOOLS.has(tool)) out.set(message.uuid, notice);
  }
  return out;
}

/** 附件通知能不能沿 parentUuid 走回当前主链（chain = 当前主链 uuid，已按回退截断） */
export function noticeOnChain(notice: TaskNotice, parents: ReadonlyMap<string, string> | undefined, chain: ReadonlySet<string>): boolean {
  let cur = notice.parentUuid;
  for (let guard = 0; cur !== undefined && guard < 10_000; guard++) {
    if (chain.has(cur)) return true;
    cur = parents?.get(cur);
  }
  return false;
}

/** 增量扫描器：逐行喂，最后 result() 取结果（纯逻辑，便于测试） */
export class TranscriptOriginScanner {
  readonly #origins = new Map<string, string>();
  readonly #notices: TaskNotice[] = [];
  readonly #parents = new Map<string, string>();

  line(line: string): void {
    const notification = line.includes('task-notification');
    // 附件 / system 行（夹在主链消息之间）记父子关系；其余行与通知无关，不解析
    const between = line.includes('"type":"attachment"') || line.includes('"type":"system"');
    if (!notification && !between) return;
    let rec: Record<string, unknown> | undefined;
    try {
      rec = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (rec === undefined) return;
    const type = rec['type'];
    const uuid = typeof rec['uuid'] === 'string' ? rec['uuid'] : undefined;
    const parentUuid = typeof rec['parentUuid'] === 'string' ? rec['parentUuid'] : undefined;
    if ((type === 'attachment' || type === 'system') && uuid !== undefined && parentUuid !== undefined) this.#parents.set(uuid, parentUuid);
    if (!notification) return;
    if (type === 'user' && uuid !== undefined) {
      const kind = asRecord(rec['origin'])?.['kind'];
      if (typeof kind === 'string' && kind !== '') this.#origins.set(uuid, kind);
      return;
    }
    const att = asRecord(rec['attachment']);
    if (type !== 'attachment' || att?.['type'] !== 'queued_command') return;
    const originKind = asRecord(att['origin'])?.['kind'];
    if (att['commandMode'] !== TASK_NOTIFICATION_ORIGIN && originKind !== TASK_NOTIFICATION_ORIGIN) return;
    const prompt = att['prompt'];
    const notice = typeof prompt === 'string' ? parseTaskNotification(prompt) : undefined;
    if (notice !== undefined) this.#notices.push({ ...notice, ...(parentUuid === undefined ? {} : { parentUuid }) });
  }

  result(): TranscriptOrigins {
    return { origins: this.#origins, notices: this.#notices, parents: this.#parents };
  }
}

/** 原始 jsonl 文本 → 来源信息 */
export function parseTranscriptOrigins(text: string): TranscriptOrigins {
  const scanner = new TranscriptOriginScanner();
  for (const line of text.split('\n')) scanner.line(line);
  return scanner.result();
}

/** 原始转录最多扫这么多字节（getSessionMessages 本身也整读；再大就放弃来源信息） */
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
/** 缓存的转录份数 */
const CACHE_MAX = 8;
const cache = new Map<string, { mtimeMs: number; size: number; result: TranscriptOrigins }>();

/** 流式扫一份转录（按块解码、按行喂扫描器，不整读成一个大字符串） */
async function scanFile(path: string, limit: number): Promise<TranscriptOrigins> {
  const scanner = new TranscriptOriginScanner();
  const decoder = new TextDecoder();
  let rest = '';
  let read = 0;
  for await (const chunk of Bun.file(path).stream()) {
    read += chunk.byteLength;
    if (read > limit) break;
    rest += decoder.decode(chunk, { stream: true });
    let at = rest.indexOf('\n');
    while (at >= 0) {
      scanner.line(rest.slice(0, at));
      rest = rest.slice(at + 1);
      at = rest.indexOf('\n');
    }
  }
  rest += decoder.decode();
  if (rest !== '') scanner.line(rest);
  return scanner.result();
}

/** 读会话主转录的来源信息；找不到 / 读失败 / 过大返回 undefined（调用方退回结构校验） */
export async function readTranscriptOrigins(
  sessionId: string,
  options: { cwd?: string | undefined; projectsDir?: string; maxBytes?: number } = {},
): Promise<TranscriptOrigins | undefined> {
  try {
    const path = await locateTranscript(sessionId, options);
    if (path === undefined) return undefined;
    const info = await stat(path);
    if (info.size > (options.maxBytes ?? MAX_TRANSCRIPT_BYTES)) return undefined;
    const hit = cache.get(path);
    if (hit !== undefined && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
      cache.delete(path);
      cache.set(path, hit);
      return hit.result;
    }
    const result = await scanFile(path, info.size);
    cache.delete(path);
    cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, result });
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
    return result;
  } catch {
    return undefined;
  }
}

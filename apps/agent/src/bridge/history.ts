/**
 * 本机转录 → 历史条目（`session.history.response`）的**纯函数**层。
 *
 * 输入是 SDK `getSessionMessages()` 的 `SessionMessage[]`（已按主链排好序的
 * user/assistant 行），输出协议的 `HistoryItem[]`。与 translate.ts 的实时路径
 * 口径一致：摘要都走 summarize.ts，子代理消息都不进主时间线，thinking 正文都不外传。
 *
 * ## 转录的真实形状（SDK 0.3.251 实测）
 *
 * - **assistant 同一个 `message.id` 会拆成多行**：thinking / text / tool_use 各一行，
 *   `message.id` 相同（`msg_…`）。按 id 合并文本，才与实时流 `assistant.done`
 *   「同一 messageId 累积全文」对得上；tool_use 块各自出一个 tool 条目。
 * - **user 行的 content 可能是字符串或块数组**。只含 tool_result 的 user 行不是
 *   用户说的话，而是给前面的 tool_use 配结果（status / resultSummary / outputPreview）。
 * - 每行还带 `timestamp`（ISO 字符串）——**SessionMessage 类型里没有**，按 unknown 取。
 * - 斜杠命令在转录里是 `<command-name>/x</command-name><command-args>…` 标记，
 *   本地命令输出是 `<local-command-stdout>` 之类。前者还原成 `/x args`（与在 trine
 *   里发命令时时间线显示的文本一致），后者不是对话内容，丢掉。
 *
 * ## 子 agent 转录（toSubagentHistoryItems）
 *
 * 子 agent 的过程不在主转录里，而在 `<会话目录>/subagents/agent-<agentId>.jsonl`
 * （每行 `isSidechain:true`；链上夹着大量 `attachment` 行——SDK 的
 * getSubagentMessages 正是被它们打断链、只返回最后 1 条，所以自己解析）。行的形状
 * 与主转录相同（type / uuid / message / timestamp），直接复用 toHistoryItems 的
 * 转换，再只留工具项（与实时流一致：子 agent 只出工具卡）。
 *
 * ## 分页与封顶（paginateHistory）
 *
 * 响应帧会进服务端 SQLite 做离线补发，不能无界：单条文本截断到
 * `HISTORY_TEXT_MAX`，整页序列化体积封顶 `HISTORY_PAGE_MAX_BYTES`，超了就从
 * 最旧那头少给几条并 `hasMore: true`。
 */
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HistoryItem } from '@trine/core';
import { outputPreview, subagentReportText, summarizeToolArgs, summarizeToolResult } from './summarize.ts';

/** 单条 user/assistant 文本上限（字符数），超出截断并标注 */
export const HISTORY_TEXT_MAX = 8 * 1024;
/** 默认每页条数 */
export const HISTORY_DEFAULT_LIMIT = 200;
/**
 * 一页 items 序列化后的字节上限。整帧还有信封与加密开销（base64 ≈ ×4/3），
 * 取 512KB 让密文落在 ~700KB 内。
 */
export const HISTORY_PAGE_MAX_BYTES = 512 * 1024;

type ToolItem = Extract<HistoryItem, { kind: 'tool' }>;

/** 截断过长文本，尾部说明原长 */
export function truncateText(text: string, max = HISTORY_TEXT_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…（已截断，原文共 ${text.length} 字）`;
}

/** 行上的 timestamp（ISO）→ epoch 毫秒；缺失或非法返回 undefined */
function lineTs(message: SessionMessage): number | undefined {
  const raw = (message as unknown as Record<string, unknown>)['timestamp'];
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms) && ms >= 0) return Math.floor(ms);
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** tool_result 块的内容可能是字符串或块数组，拍平成文本（与 translate.ts 同口径） */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    const b = asRecord(block);
    if (b !== undefined && typeof b['text'] === 'string') parts.push(b['text']);
  }
  return parts.join('');
}

/** 本地命令输出 / 提示语：不是对话内容 */
const LOCAL_COMMAND_NOISE = /^\s*<(local-command-stdout|local-command-stderr|local-command-caveat)>/;
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * 用户文本的清洗：命令标记还原成 `/name args`，本地命令输出丢掉（返回 ''）。
 * 不认识的一律原样保留——宁可多显示，也不擅自吞掉用户说过的话。
 */
export function normalizeUserText(text: string): string {
  if (LOCAL_COMMAND_NOISE.test(text)) return '';
  const name = text.match(COMMAND_NAME);
  if (name !== null) {
    const cmd = (name[1] ?? '').trim();
    const args = (text.match(COMMAND_ARGS)?.[1] ?? '').trim();
    const withSlash = cmd.startsWith('/') ? cmd : `/${cmd}`;
    return args === '' ? withSlash : `${withSlash} ${args}`;
  }
  return text;
}

/** user 行的 content → 用户文本；图片块给个占位，免得纯图片消息整条消失 */
function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b === undefined) continue;
    if (b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text']);
    else if (b['type'] === 'image') parts.push('[图片]');
  }
  return parts.join('\n');
}

/**
 * 主链上的一行是不是「用户说的话」：是就返回清洗后的文本，否则 undefined
 * （子代理行、工具结果载体、本地命令输出、空文本）。与 toHistoryItems 出 user 条目
 * 的口径一致——回退只能指向历史里看得见的用户消息。
 */
export function humanUserText(message: SessionMessage): string | undefined {
  if (message.type !== 'user') return undefined;
  if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) return undefined;
  const raw = asRecord(message.message);
  if (raw === undefined) return undefined;
  const content = raw['content'];
  if (Array.isArray(content) && content.some((b) => asRecord(b)?.['type'] === 'tool_result')) return undefined;
  const text = normalizeUserText(userText(content));
  return text.trim() === '' ? undefined : text;
}

/**
 * 待生效的截断点（回退对话后、下一条消息之前）：转录主链还是回退前的长链，读历史
 * 要从被撤掉的那条用户消息（`dropFrom`）起截掉。找不到就原样返回。
 */
export function cutAtRewind(messages: readonly SessionMessage[], dropFrom: string | undefined): readonly SessionMessage[] {
  if (dropFrom === undefined) return messages;
  const at = messages.findIndex((m) => m.uuid === dropFrom);
  return at < 0 ? messages : messages.slice(0, at);
}

/**
 * SessionMessage[] → HistoryItem[]（旧 → 新）。
 *
 * 丢弃：system 行、子代理行（`parent_tool_use_id` 非空）、thinking、空文本、
 * 本地命令输出。缺 timestamp 的行沿用上一行的 ts（首行缺则为 0）。
 */
export function toHistoryItems(messages: readonly SessionMessage[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  /** assistant message.id → items 下标（按 id 合并文本） */
  const assistantIdx = new Map<string, number>();
  /** toolUseId → items 下标（配对 tool_result） */
  const toolIdx = new Map<string, number>();
  const seenUser = new Set<string>();
  let lastTs = 0;

  for (const message of messages) {
    if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) continue;
    const ts = lineTs(message) ?? lastTs;
    lastTs = ts;
    const raw = asRecord(message.message);
    if (raw === undefined) continue;

    if (message.type === 'assistant') {
      const content = raw['content'];
      const id = typeof raw['id'] === 'string' && raw['id'] !== '' ? raw['id'] : message.uuid;
      const blocks: unknown[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      for (const block of blocks) {
        const b = asRecord(block);
        if (b === undefined) continue;
        if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'] !== '') {
          const at = assistantIdx.get(id);
          if (at === undefined) {
            assistantIdx.set(id, items.length);
            items.push({ kind: 'assistant', id, text: b['text'], ts });
          } else {
            const cur = items[at] as Extract<HistoryItem, { kind: 'assistant' }>;
            items[at] = { ...cur, text: cur.text + b['text'] };
          }
        } else if (b['type'] === 'tool_use') {
          const toolUseId = b['id'];
          const toolName = b['name'];
          if (typeof toolUseId !== 'string' || toolUseId === '' || typeof toolName !== 'string' || toolName === '') continue;
          if (toolIdx.has(toolUseId)) continue;
          toolIdx.set(toolUseId, items.length);
          items.push({ kind: 'tool', id: toolUseId, toolName, argSummary: summarizeToolArgs(toolName, b['input']), ts });
        }
        // thinking / redacted_thinking / 其他块：不外传
      }
      continue;
    }

    if (message.type !== 'user') continue;
    const content = raw['content'];
    const results = Array.isArray(content)
      ? content.map(asRecord).filter((b): b is Record<string, unknown> => b?.['type'] === 'tool_result')
      : [];
    if (results.length > 0) {
      // 工具结果载体，不是用户消息
      for (const b of results) {
        const toolUseId = b['tool_use_id'];
        if (typeof toolUseId !== 'string') continue;
        const at = toolIdx.get(toolUseId);
        if (at === undefined) continue;
        const tool = items[at] as ToolItem;
        const text = toolResultText(b['content']);
        const durationMs = Math.max(0, ts - tool.ts);
        const isError = b['is_error'] === true;
        // 结构化输出（转录行的 toolUseResult；SDK 的 SessionMessage 不透传它，子转录
        // 的原始行才有）：挂在整行上，只有一个 tool_result 时才确定是它的
        const structured = results.length === 1 ? (message as unknown as Record<string, unknown>)['toolUseResult'] : undefined;
        const { status, resultSummary } = summarizeToolResult(tool.toolName, {
          text,
          isError,
          durationMs,
          ...(structured === undefined ? {} : { structured }),
        });
        const isSubagentTool = tool.toolName === 'Agent' || tool.toolName === 'Task';
        const preview = outputPreview(isSubagentTool && !isError ? subagentReportText(structured, text) : text);
        items[at] = {
          ...tool,
          status,
          durationMs,
          resultSummary,
          ...(preview === undefined ? {} : { outputPreview: preview }),
        };
      }
      continue;
    }
    const text = normalizeUserText(userText(content));
    if (text.trim() === '') continue;
    if (seenUser.has(message.uuid)) continue;
    seenUser.add(message.uuid);
    items.push({ kind: 'user', id: message.uuid, text, ts });
  }

  // 截断放最后：合并期间要拼的是全文
  return items.map((item) =>
    item.kind === 'tool' || item.text.length <= HISTORY_TEXT_MAX ? item : { ...item, text: truncateText(item.text) },
  );
}

/**
 * 子 agent 转录的 jsonl 行（已 JSON.parse）→ 工具项（旧 → 新）。
 *
 * 只留工具项：子 agent 的首条 user 是父 agent 写给它的 prompt，最终报告已经是父
 * Agent/Task 工具卡的展开预览——都带上就是重复；实时流同样只转发子工具卡。
 * 非 user/assistant 行（attachment / system …）与坏行一律跳过。
 */
export function toSubagentHistoryItems(lines: readonly unknown[]): HistoryItem[] {
  const messages: SessionMessage[] = [];
  for (const line of lines) {
    const rec = asRecord(line);
    if (rec === undefined) continue;
    const type = rec['type'];
    if (type !== 'user' && type !== 'assistant') continue;
    const uuid = typeof rec['uuid'] === 'string' && rec['uuid'] !== '' ? rec['uuid'] : undefined;
    if (uuid === undefined) continue;
    messages.push({
      type,
      uuid,
      session_id: typeof rec['sessionId'] === 'string' ? rec['sessionId'] : '',
      message: rec['message'],
      // 子转录里的行都属于这个子 agent 自己，对它而言就是「主链」
      parent_tool_use_id: null,
      parent_agent_id: null,
      ...(rec['timestamp'] === undefined ? {} : { timestamp: rec['timestamp'] }),
      // 嵌套子 agent 的 Agent 调用结果摘要要用（toHistoryItems 按 unknown 取）
      ...(rec['toolUseResult'] === undefined ? {} : { toolUseResult: rec['toolUseResult'] }),
    } as SessionMessage);
  }
  return toHistoryItems(messages).filter((item) => item.kind === 'tool');
}

export interface HistoryPage {
  items: HistoryItem[];
  hasMore: boolean;
  nextBefore?: string;
}

/** 一条目序列化后的字节数（含数组逗号） */
function itemBytes(item: HistoryItem): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
}

/**
 * 取 `before` 之前最近的 `limit` 条，并按体积封顶。
 *
 * - `before` 省略 = 从最新一条往前取；给了但找不到（转录被改写 / 游标来自别的会话）
 *   → 空页、hasMore false：宁可停，也不从头重放一遍造成重复
 * - 体积超了从最旧那头丢，保证返回的总是紧贴 `before` 的连续一段
 * - `nextBefore` = 本页最旧一条的 id（有更多时才给）
 */
export function paginateHistory(
  all: readonly HistoryItem[],
  options: { before?: string | undefined; limit?: number | undefined; maxBytes?: number } = {},
): HistoryPage {
  const limit = Math.max(1, Math.min(options.limit ?? HISTORY_DEFAULT_LIMIT, 500));
  const maxBytes = options.maxBytes ?? HISTORY_PAGE_MAX_BYTES;
  let end = all.length;
  if (options.before !== undefined) {
    const idx = all.findIndex((item) => item.id === options.before);
    if (idx < 0) return { items: [], hasMore: false };
    end = idx;
  }
  let start = Math.max(0, end - limit);
  // 从新往旧累加，超预算就停（至少给一条，单条已截断过，不会大到离谱）
  let bytes = 0;
  let cut = end;
  while (cut > start) {
    const size = itemBytes(all[cut - 1]!);
    if (bytes + size > maxBytes && cut < end) break;
    bytes += size;
    cut -= 1;
  }
  start = cut;
  const items = all.slice(start, end);
  const hasMore = start > 0;
  const first = items[0];
  return hasMore && first !== undefined ? { items, hasMore, nextBefore: first.id } : { items, hasMore: false };
}

/**
 * 工具卡摘要生成（PROTOCOL-REQUIREMENTS §1.2）。
 *
 * 协议明确要求「由 agent 端生成」单行摘要，让 client 不必理解每种工具的参数结构：
 * - `argSummary`：Bash → 命令、Edit/Read/Write → 文件路径、Grep → 模式…
 * - `resultSummary`：`✓ +9 −2` / `⚠ 1 failed · 3.5s` 之类
 *
 * 未知工具（MCP 工具、未来新增内置工具）必须优雅降级，绝不抛错——
 * 这里的失败只该导致「摘要不好看」，不该中断事件流。
 */
import type { ToolResultStatus } from '@trine/core';

/** CSI（颜色、光标）与 OSC（标题、超链接）转义序列 */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** 去掉终端转义序列（`claude update` 的输出、本地斜杠命令的输出里都有） */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** 单行摘要最大长度，超出尾部截断加省略号 */
const SUMMARY_MAX = 120;
/** outputPreview 尾部保留字节数（协议注释给的 ~2KB） */
export const OUTPUT_PREVIEW_MAX = 2048;

/** 压成单行 + 限长 */
export function toSingleLine(text: string, max = SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** 从 unknown 的工具输入里安全取一个字符串字段 */
function str(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function flag(input: unknown, key: string): boolean {
  if (typeof input !== 'object' || input === null) return false;
  return (input as Record<string, unknown>)[key] === true;
}

function num(input: unknown, key: string): number | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 参数摘要里的「后台」标记（Bash / Agent 带 run_in_background:true） */
export const BACKGROUND_MARK = '后台 · ';

/**
 * Bash 后台启动的 tool_result 开头（真 claude 2.1.282 实测）：
 * `Command running in background with ID: bd4zj554r. Output is being written to: …`
 */
const BASH_BACKGROUND_RESULT = /^Command running in background with ID:\s*([^\s.]+)/;
/** Agent 后台启动的 tool_result 开头（实测）：`Async agent launched successfully. …` */
const AGENT_BACKGROUND_RESULT = /^Async agent launched successfully/;

/** 路径缩写：绝对路径太长时只留尾部两级，前面加 … */
function shortPath(path: string): string {
  if (path.length <= 48) return path;
  const parts = path.split('/');
  const tail = parts.slice(-2).join('/');
  return `…/${tail}`;
}

/**
 * 生成工具调用的单行参数摘要。
 *
 * @param toolName 工具名（内置工具名或 `mcp__server__tool`）
 * @param input 工具参数，结构随工具而异
 */
export function summarizeToolArgs(toolName: string, input: unknown): string {
  switch (toolName) {
    case 'Bash': {
      const cmd = str(input, 'command');
      if (cmd) return flag(input, 'run_in_background') ? `${BACKGROUND_MARK}${toSingleLine(cmd, 120 - BACKGROUND_MARK.length)}` : toSingleLine(cmd);
      break;
    }
    case 'BashOutput':
    case 'TaskOutput': {
      // TaskOutput(task_id, block?, timeout?)：查后台任务输出；旧名 BashOutput(bash_id)
      const id = str(input, 'task_id') ?? str(input, 'bash_id') ?? str(input, 'shell_id');
      if (id) {
        const wait = flag(input, 'block') ? ' · 等待完成' : '';
        const timeout = num(input, 'timeout');
        return `${id}${wait}${timeout === undefined ? '' : ` · ${formatDuration(timeout)}`}`;
      }
      break;
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const path = str(input, 'file_path') ?? str(input, 'notebook_path');
      if (path) return shortPath(path);
      break;
    }
    case 'Glob': {
      const pattern = str(input, 'pattern');
      const path = str(input, 'path');
      if (pattern) return path ? `${pattern} in ${shortPath(path)}` : pattern;
      break;
    }
    case 'Grep': {
      const pattern = str(input, 'pattern');
      const path = str(input, 'path');
      if (pattern) return path ? `${pattern} in ${shortPath(path)}` : pattern;
      break;
    }
    case 'WebFetch': {
      const url = str(input, 'url');
      if (url) return toSingleLine(url);
      break;
    }
    case 'WebSearch': {
      const q = str(input, 'query');
      if (q) return toSingleLine(q);
      break;
    }
    case 'Task':
    case 'Agent': {
      const desc = str(input, 'description');
      if (desc) return flag(input, 'run_in_background') ? `${BACKGROUND_MARK}${toSingleLine(desc, 120 - BACKGROUND_MARK.length)}` : toSingleLine(desc);
      break;
    }
    case 'TodoWrite':
      return '更新待办清单';
    case 'KillShell': {
      const id = str(input, 'shell_id');
      if (id) return `kill ${id}`;
      break;
    }
    case 'TaskStop': {
      const id = str(input, 'task_id');
      if (id) return `stop ${id}`;
      break;
    }
  }

  // 通用降级：挑第一个短字符串字段；再不行给字段名列表
  if (typeof input === 'object' && input !== null) {
    const entries = Object.entries(input as Record<string, unknown>);
    const firstString = entries.find(
      ([, v]) => typeof v === 'string' && v.length > 0,
    );
    if (firstString) {
      const [key, value] = firstString;
      return toSingleLine(`${key}: ${String(value)}`);
    }
    if (entries.length > 0) {
      return toSingleLine(entries.map(([k]) => k).join(', '));
    }
  }
  return '';
}

/** 工具结果的原始形态：SDK 的 tool_result 内容块可能是字符串或块数组 */
export interface ToolOutcome {
  /** 结果文本（已拼接） */
  text: string;
  /** SDK 标记的错误位 */
  isError: boolean;
  /** 工具从 start 到 end 的耗时 */
  durationMs: number;
  /**
   * SDK 的结构化工具输出（实时流 user 消息的 `tool_use_result`；转录里拿不到，
   * 省略）。目前只有 Agent/Task 用它：`{status, totalToolUseCount, totalDurationMs,
   * content, …}`（真 claude 2.1.283 实测形状）。
   */
  structured?: unknown;
}

/** 把耗时格式化成人读的形式（`820ms` / `3.5s` / `2m10s`） */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

/**
 * 从 Edit/Write 类结果里捞 diff 统计，捞不到返回 undefined。
 *
 * 只在**文件编辑类工具**上调用（见 summarizeToolResult），且要求 `+N` 与 `−N`
 * 之间只隔空白——否则普通文本里的 `+3 -1`（比如一段解释、一个算式）会被
 * 当成 diff stat 报出去。这是「宁可不显示，也不显示错的」。
 */
function diffStat(text: string): string | undefined {
  const match = text.match(/(?:^|\s)\+(\d+)[ \t]*[−-][ \t]*(\d+)(?:\s|$)/);
  if (match) return `+${match[1]} −${match[2]}`;
  return undefined;
}

/**
 * 生成工具结果的状态 + 单行摘要。
 *
 * 状态判定：SDK 的 isError → error；结果文本里有 warning 迹象 → warn；否则 ok。
 */
export function summarizeToolResult(
  toolName: string,
  outcome: ToolOutcome,
): { status: ToolResultStatus; resultSummary: string } {
  const { text, isError, durationMs } = outcome;
  const elapsed = formatDuration(durationMs);
  const lower = text.toLowerCase();

  if (isError) {
    const firstLine = toSingleLine(text, 80);
    return {
      status: 'error',
      resultSummary: firstLine ? `✗ ${firstLine} · ${elapsed}` : `✗ 失败 · ${elapsed}`,
    };
  }

  // 子 agent：摘要给「N 次工具调用 · 耗时」（耗时取子 agent 自报的，比 start→end
  // 更准）。放在 warning 判定之前——子 agent 的报告正文是自由文本，提到 warning
  // 不代表这次调用有问题
  if (toolName === 'Agent' || toolName === 'Task') {
    const run = subagentRunStats(outcome.structured, text);
    if (run !== undefined) {
      const took = run.durationMs === undefined ? elapsed : formatDuration(run.durationMs);
      return { status: 'ok', resultSummary: `✓ ${run.toolUses} 次工具调用 · ${took}` };
    }
  }

  const warned =
    lower.includes('warning') ||
    lower.includes('deprecated') ||
    /\b\d+\s+failed\b/.test(lower);
  if (warned) {
    const hint = text.match(/\b(\d+)\s+failed\b/i);
    const detail = hint ? `${hint[1]} failed` : 'warning';
    return { status: 'warn', resultSummary: `⚠ ${detail} · ${elapsed}` };
  }

  // 后台启动的回执是一长段英文（含输出文件路径），截断后没有信息量；
  // 认出来就换成一句人话，task id 留着方便与后台任务条 / TaskOutput 对上
  if (toolName === 'Bash') {
    const bg = text.match(BASH_BACKGROUND_RESULT);
    if (bg) return { status: 'ok', resultSummary: `✓ 已在后台运行 · ${bg[1]}` };
  }
  if ((toolName === 'Agent' || toolName === 'Task') && AGENT_BACKGROUND_RESULT.test(text)) {
    return { status: 'ok', resultSummary: '✓ 后台子 agent 已启动' };
  }

  // diff stat 只对文件编辑类工具有意义；对 Bash/Read 之流，输出里的 `+9 −2`
  // 多半只是普通文本，报成 diff stat 是误导
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    const stat = diffStat(text);
    if (stat) return { status: 'ok', resultSummary: `✓ ${stat} · ${elapsed}` };
  }

  switch (toolName) {
    case 'Read': {
      const lines = text.split('\n').length;
      return { status: 'ok', resultSummary: `✓ ${lines} 行 · ${elapsed}` };
    }
    case 'Edit':
    case 'Write':
      return { status: 'ok', resultSummary: `✓ 已写入 · ${elapsed}` };
    case 'Glob':
    case 'Grep': {
      const hits = text.trim() === '' ? 0 : text.trim().split('\n').length;
      return { status: 'ok', resultSummary: `✓ ${hits} 条匹配 · ${elapsed}` };
    }
  }

  const preview = toSingleLine(text, 60);
  return {
    status: 'ok',
    resultSummary: preview ? `✓ ${preview} · ${elapsed}` : `✓ 完成 · ${elapsed}`,
  };
}

/** 子 agent 一次运行的统计（Agent/Task 工具卡的结果摘要用） */
export interface SubagentRunStats {
  toolUses: number;
  durationMs?: number;
}

/**
 * tool_result 文本尾部的用量块（真 claude 2.1.283 实测）：
 * `<usage>subagent_tokens: 26412\ntool_uses: 3\nduration_ms: 18288</usage>`。
 * 转录里没有结构化输出，历史回看只能靠它。
 */
const AGENT_USAGE_BLOCK = /<usage>([\s\S]*?)<\/usage>/;

/**
 * 从 Agent/Task 的结果里取子 agent 的运行统计：优先结构化输出（实时流的
 * `tool_use_result.totalToolUseCount / totalDurationMs`，status 须为 completed），
 * 其次文本尾部的 `<usage>` 块。都没有返回 undefined（调用方回落通用摘要）。
 */
export function subagentRunStats(structured: unknown, text: string): SubagentRunStats | undefined {
  if (typeof structured === 'object' && structured !== null) {
    const status = str(structured, 'status');
    const toolUses = num(structured, 'totalToolUseCount');
    if ((status === undefined || status === 'completed') && toolUses !== undefined) {
      const durationMs = num(structured, 'totalDurationMs');
      return {
        toolUses: Math.max(0, Math.round(toolUses)),
        ...(durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(durationMs)) }),
      };
    }
  }
  const block = text.match(AGENT_USAGE_BLOCK)?.[1];
  if (block === undefined) return undefined;
  const toolUses = block.match(/(?:^|\n)\s*tool_uses:\s*(\d+)/)?.[1];
  if (toolUses === undefined) return undefined;
  const durationMs = block.match(/(?:^|\n)\s*duration_ms:\s*(\d+)/)?.[1];
  return { toolUses: Number(toolUses), ...(durationMs === undefined ? {} : { durationMs: Number(durationMs) }) };
}

/** Agent 结果文本的 hand-back 前言（实测）：`[Subagent hand-back] … The report follows:\n` */
const AGENT_HANDBACK_PREFIX = /^\[Subagent hand-back\][\s\S]*?The report follows:\n/;
/** 报告之后的尾巴：`agentId: …` 一行与 `<usage>…</usage>` 块 */
const AGENT_TRAILER = /\n(?:agentId: [^\n]*\n?)?(?:<usage>[\s\S]*?<\/usage>\s*)?$/;

/**
 * Agent/Task 结果的「报告正文」：给展开预览用，去掉写给模型看的前言 / agentId /
 * usage 尾巴。结构化输出的 `content` 文本块就是干净的报告（SDK 注释原话：the
 * subagent's final report without the model-directed agentId/usage trailer），
 * 优先用；否则从文本里剥（报告每行被缩进两格，一并去掉）。认不出格式就原样返回。
 */
export function subagentReportText(structured: unknown, text: string): string {
  // 后台启动回执是写给模型的内部元数据（原文明说 never quote or paste），不外传；
  // 真正的报告在子 agent 完成时由 task_notification 补上（backgroundSubagentEnd）
  if (str(structured, 'status') === 'async_launched' || AGENT_BACKGROUND_RESULT.test(text)) return '';
  if (typeof structured === 'object' && structured !== null) {
    const content = (structured as Record<string, unknown>)['content'];
    if (Array.isArray(content)) {
      const parts = content
        .map((b) => (typeof b === 'object' && b !== null && (b as Record<string, unknown>)['type'] === 'text' ? (b as Record<string, unknown>)['text'] : undefined))
        .filter((t): t is string => typeof t === 'string');
      if (parts.length > 0) return parts.join('\n');
    }
  }
  if (!AGENT_HANDBACK_PREFIX.test(text)) return text;
  const body = text.replace(AGENT_HANDBACK_PREFIX, '').replace(AGENT_TRAILER, '');
  return body
    .split('\n')
    .map((line) => (line.startsWith('  ') ? line.slice(2) : line))
    .join('\n');
}

/** 后台子 agent 完成时给父 Agent/Task 卡的收尾（backgroundSubagentEnd 的产出） */
export interface SubagentEnd {
  status: ToolResultStatus;
  durationMs: number;
  resultSummary: string;
  outputPreview?: string;
}

/**
 * 后台子 agent 结束（`task_notification`：status completed / failed / stopped、
 * `usage{tool_uses, duration_ms}`、`summary` 报告，真 claude 2.1.283 实测）→ 父卡的
 * 终结摘要。父卡的 tool.end 早在「已启动」时就发过了，会话层用它再发一帧
 * 同 toolUseId 的 tool.end 原地收尾（评审 M1）。
 */
export function backgroundSubagentEnd(status: unknown, usage: unknown, summary: unknown): SubagentEnd {
  const toolUses = num(usage, 'tool_uses');
  const durationRaw = num(usage, 'duration_ms');
  const durationMs = durationRaw === undefined ? 0 : Math.max(0, Math.round(durationRaw));
  const took = durationRaw === undefined ? '' : ` · ${formatDuration(durationMs)}`;
  const calls = toolUses === undefined ? '' : `${Math.max(0, Math.round(toolUses))} 次工具调用`;
  const preview = typeof summary === 'string' ? outputPreview(summary) : undefined;
  const withPreview = preview === undefined ? {} : { outputPreview: preview };
  if (status === 'failed') {
    return { status: 'error', durationMs, resultSummary: `✗ 子 agent 失败${calls === '' ? '' : ` · ${calls}`}${took}`, ...withPreview };
  }
  if (status === 'stopped' || status === 'killed') {
    return { status: 'warn', durationMs, resultSummary: `⏹ 子 agent 已停止${calls === '' ? '' : ` · ${calls}`}${took}`, ...withPreview };
  }
  return { status: 'ok', durationMs, resultSummary: calls === '' ? `✓ 子 agent 已完成${took}` : `✓ ${calls}${took}`, ...withPreview };
}

/** 尾部截断的输出预览；空结果返回 undefined（协议里该字段 optional） */
export function outputPreview(text: string): string | undefined {
  if (text.length === 0) return undefined;
  if (text.length <= OUTPUT_PREVIEW_MAX) return text;
  return `…${text.slice(-OUTPUT_PREVIEW_MAX)}`;
}

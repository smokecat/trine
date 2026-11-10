/**
 * Codex thread item → trine 的 HistoryItem。
 *
 * 只取用得上的字段，逐个校验形状：协议没有稳定性承诺，认不出的条目直接跳过，不让整段
 * 历史失败（同 D15）。工具名沿用 web 已有的词汇（Read / Edit / WebSearch / mcp__…），
 * 文件预览等能力因此不用另接；只有命令用 Shell，因为 Codex 不一定跑在 bash 上。
 */
import type { HistoryItem, ToolResultStatus } from '@trine/core';
import { truncateText } from '../../bridge/history.ts';
import { capArgDetail, detailIfHidden, formatDuration, outputPreview, toSingleLine } from '../../bridge/summarize.ts';

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null;
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function duration(value: unknown): { durationMs?: number } {
  const ms = num(value);
  return ms === undefined || ms < 0 ? {} : { durationMs: Math.round(ms) };
}
function preview(text: string | undefined): { outputPreview?: string } {
  const out = text === undefined ? undefined : outputPreview(text);
  return out === undefined ? {} : { outputPreview: out };
}

/** 统一状态：Codex 的 completed / failed / declined；还在进行就不给（工具卡显示无结果） */
function statusOf(raw: unknown, ok = true): { status?: ToolResultStatus } {
  if (raw === 'completed') return { status: ok ? 'ok' : 'error' };
  if (raw === 'failed' || raw === 'declined') return { status: 'error' };
  if (raw === 'interrupted') return { status: 'warn' };
  return {};
}

function userText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  const text = content.filter(isRecord).map((p) => (p['type'] === 'text' ? (str(p['text']) ?? '') : '')).join('\n');
  for (const part of content) {
    if (!isRecord(part)) continue;
    const type = part['type'];
    if (type === 'text') parts.push(str(part['text']) ?? '');
    else if (type === 'image' || type === 'localImage') parts.push('[图片]');
    else if (type === 'skill' || type === 'mention') {
      // 文本里通常已经写了 `$name`（实测 skill 就是这样），不重复
      const token = `$${str(part['name']) ?? ''}`;
      if (!text.includes(token)) parts.push(token);
    }
  }
  return parts.join('\n');
}

/** 单条 `read` 动作的命令显示成读文件：有路径，工具卡能直接预览 */
function singleReadPath(actions: unknown): string | undefined {
  if (!Array.isArray(actions) || actions.length !== 1) return undefined;
  const action: unknown = actions[0];
  if (!isRecord(action) || action['type'] !== 'read') return undefined;
  return str(action['path']);
}

/** Codex 把命令包在 `/usr/bin/zsh -lc "…"` 里，每张卡都一样，显示时去掉 */
export function unwrapShellCommand(command: string): string {
  const match = /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  if (match === null) return command;
  const inner = match[2]!;
  // 中间还有未转义的同种引号，说明不是一整段（如 `bash -lc "a" && echo "b"`），不动它。
  // 转义过的引号还原，只为显示，不用于执行
  if (match[1] === '"') {
    if (/(^|[^\\])"/.test(inner)) return command;
    return inner.replace(/\\(["\\$`])/g, '$1');
  }
  const single = inner.replace(/'\\''/g, "'");
  return inner.replace(/'\\''/g, '').includes("'") ? command : single;
}

function commandItem(item: Rec, id: string, ts: number): HistoryItem {
  const command = unwrapShellCommand(str(item['command']) ?? '');
  const exitCode = num(item['exitCode']);
  const failed = exitCode !== undefined && exitCode !== 0;
  const path = singleReadPath(item['commandActions']);
  const argSummary = toSingleLine(path ?? command);
  const argDetail = command.trim() === '' ? undefined : path === undefined ? detailIfHidden(command, argSummary) : capArgDetail(command.replace(/\s+$/, ''));
  const ms = num(item['durationMs']);
  const summary = [
    exitCode === undefined ? undefined : `exit ${exitCode}`,
    ms === undefined ? undefined : formatDuration(ms),
  ]
    .filter((s) => s !== undefined)
    .join(' · ');
  return {
    kind: 'tool',
    id,
    toolName: path === undefined ? 'Shell' : 'Read',
    argSummary,
    ...(path === undefined ? {} : { filePath: path.slice(0, 4096) }),
    // Read 的摘要是路径，命令原文另看；Shell 的摘要是命令本身，看不全时才带
    ...(argDetail === undefined ? {} : { argDetail }),
    ...statusOf(item['status'], !failed),
    ...duration(item['durationMs']),
    ...(summary === '' ? {} : { resultSummary: summary }),
    ...preview(str(item['aggregatedOutput'])),
    ts,
  };
}

function fileChangeItem(item: Rec, id: string, ts: number): HistoryItem {
  const changes = Array.isArray(item['changes']) ? item['changes'].filter(isRecord) : [];
  const paths = changes.map((c) => str(c['path'])).filter((p) => p !== undefined);
  const diffs = changes.map((c) => str(c['diff']) ?? '');
  let added = 0;
  let removed = 0;
  for (const diff of diffs) {
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
    }
  }
  const only = paths.length === 1 ? paths[0] : undefined;
  return {
    kind: 'tool',
    id,
    toolName: 'Edit',
    argSummary: toSingleLine(only ?? `${paths.length} 个文件`),
    ...(only === undefined ? {} : { filePath: only.slice(0, 4096) }),
    ...statusOf(item['status']),
    resultSummary: `+${added} −${removed}`,
    ...preview(diffs.join('\n')),
    ts,
  };
}

function mcpItem(item: Rec, id: string, ts: number): HistoryItem {
  const server = str(item['server']) ?? 'unknown';
  const tool = str(item['tool']) ?? 'unknown';
  const result = item['result'];
  const texts: string[] = [];
  if (isRecord(result) && Array.isArray(result['content'])) {
    for (const part of result['content']) {
      if (isRecord(part) && typeof part['text'] === 'string') texts.push(part['text']);
    }
  }
  const error = item['error'];
  const errorText = isRecord(error) ? str(error['message']) : undefined;
  let args = '';
  try {
    args = JSON.stringify(item['arguments']) ?? '';
  } catch {
    // 参数只用来显示，序列化不了就不显示
  }
  return {
    kind: 'tool',
    id,
    toolName: `mcp__${server}__${tool}`,
    argSummary: toSingleLine(args),
    ...statusOf(item['status']),
    ...duration(item['durationMs']),
    ...(errorText === undefined ? {} : { resultSummary: toSingleLine(errorText) }),
    ...preview(texts.length > 0 ? texts.join('\n') : errorText),
    ts,
  };
}

const COLLAB_ACTION: Record<string, string> = {
  sendInput: '发消息给子 agent',
  sendMessage: '发消息给子 agent',
  followupTask: '追加任务给子 agent',
  resumeAgent: '恢复子 agent',
  wait: '等待子 agent',
  closeAgent: '关闭子 agent',
  interruptAgent: '中断子 agent',
  listAgents: '列出子 agent',
};

/** 派生、等待子 agent 等操作：一张卡，不展开子 thread 的过程（没有实测过，字段都按可缺处理） */
function collabItem(item: Rec, id: string, ts: number): HistoryItem {
  const tool = str(item['tool']) ?? '';
  const prompt = str(item['prompt']);
  const action = tool === 'spawnAgent' ? '派生子 agent' : (COLLAB_ACTION[tool] ?? (tool === '' ? '子 agent' : tool));
  const states = isRecord(item['agentsStates']) ? Object.values(item['agentsStates']).filter(isRecord) : [];
  const counts = new Map<string, number>();
  for (const state of states) {
    const status = str(state['status']);
    if (status !== undefined) counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const messages = states.map((s) => str(s['message'])).filter((m): m is string => m !== undefined && m !== '');
  const failed = (counts.get('errored') ?? 0) + (counts.get('notFound') ?? 0) > 0;
  return {
    kind: 'tool',
    id,
    // 不用 Agent：那是 Claude 的子 agent 卡，会去拉 Codex 没有的子过程
    toolName: 'SubAgent',
    argSummary: toSingleLine(tool === 'spawnAgent' && prompt !== undefined ? prompt : prompt === undefined ? action : `${action}：${prompt}`),
    ...statusOf(item['status'], !failed),
    ...(counts.size === 0 ? {} : { resultSummary: [...counts].map(([status, n]) => `${status} ${n}`).join(' · ') }),
    ...preview(messages.length > 0 ? messages.join('\n') : undefined),
    ts,
  };
}

const ACTIVITY_LABEL: Record<string, string> = {
  started: '子 agent 已启动',
  interacted: '子 agent 有新动作',
  interrupted: '子 agent 已中断',
  completed: '子 agent 已完成',
};

function subAgentActivityItem(item: Rec, id: string, ts: number): HistoryItem {
  const kind = str(item['kind']) ?? '';
  const path = str(item['agentPath']);
  return {
    kind: 'tool',
    id,
    toolName: 'SubAgent',
    argSummary: toSingleLine([ACTIVITY_LABEL[kind] ?? `子 agent：${kind}`, path].filter((p) => p !== undefined).join(' · ')),
    status: kind === 'interrupted' ? 'warn' : 'ok',
    ts,
  };
}

/** 一个 thread item 转成历史条目；不需要展示或认不出的返回 undefined */
export function codexItemToHistory(item: unknown, fallbackTs: number): HistoryItem | undefined {
  if (!isRecord(item)) return undefined;
  const id = str(item['id']);
  if (id === undefined || id === '') return undefined;
  const started = num(item['startedAtMs']);
  const ts = started === undefined || started < 0 ? fallbackTs : Math.round(started);
  switch (item['type']) {
    case 'userMessage':
      // 经 trine 发的消息有 clientId，等于实时流的 messageId，client 才能去重
      return { kind: 'user', id: str(item['clientId']) ?? id, text: truncateText(userText(item['content'])), ts };
    case 'agentMessage':
      return { kind: 'assistant', id, text: truncateText(str(item['text']) ?? ''), ts };
    case 'commandExecution':
      return commandItem(item, id, ts);
    case 'fileChange':
      return fileChangeItem(item, id, ts);
    case 'mcpToolCall':
      return mcpItem(item, id, ts);
    case 'webSearch':
      return {
        kind: 'tool',
        id,
        toolName: 'WebSearch',
        argSummary: toSingleLine(str(item['query']) ?? ''),
        status: 'ok',
        ts,
      };
    case 'collabAgentToolCall':
      return collabItem(item, id, ts);
    case 'subAgentActivity':
      return subAgentActivityItem(item, id, ts);
    case 'contextCompaction':
      // 手动 /compact 和自动压缩都会有；实时和历史都显示成同一张卡
      return { kind: 'tool', id, toolName: 'Compact', argSummary: '压缩对话上下文', status: 'ok', ts };
    default:
      return undefined;
  }
}

/**
 * Codex thread item → trine 的 HistoryItem。
 *
 * 只取用得上的字段，逐个校验形状：协议没有稳定性承诺，认不出的条目直接跳过，不让整段
 * 历史失败（同 D15）。工具名沿用 web 已有的词汇（Read / Edit / WebSearch / mcp__…），
 * 文件预览等能力因此不用另接；只有命令用 Shell，因为 Codex 不一定跑在 bash 上。
 */
import { SUBAGENT_LABEL_MAX, type HistoryItem, type SubagentInfo, type SubagentState, type ToolResultStatus } from '@trine/core';
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

/**
 * 调用状态（CollabAgentToolCallStatus）的中文。这是「这次 spawn / wait 调用」本身的状态，
 * 不是子 agent 的状态——wait 调用完成 ≠ 子 agent 完成（plan §7）。
 */
export const COLLAB_CALL_LABEL: Record<string, string> = {
  inProgress: '调用进行中',
  completed: '调用完成',
  failed: '调用失败',
  interrupted: '调用已中断',
};

/** 子 agent 状态（CollabAgentStatus，全部枚举）→ 协议的 SubagentState */
export function collabAgentState(raw: unknown): SubagentState | undefined {
  switch (raw) {
    case 'pendingInit':
      return 'pending';
    case 'running':
      return 'running';
    case 'interrupted':
      return 'interrupted';
    case 'completed':
      return 'completed';
    case 'errored':
      return 'failed';
    case 'shutdown':
      return 'shutdown';
    case 'notFound':
      return 'not_found';
    default:
      return undefined;
  }
}

/** 子 agent 状态的中文（resultSummary 里的计数用；web 有同一份） */
const AGENT_STATE_LABEL: Record<SubagentState, string> = {
  pending: '等待启动',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  interrupted: '已中断',
  shutdown: '已关闭',
  not_found: '找不到',
  unknown: '状态未知',
};

/** 限长的子 agent 标签（协议 SUBAGENT_LABEL_MAX） */
function label(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v === undefined || v === '' ? undefined : v.slice(0, SUBAGENT_LABEL_MAX);
}

/** thread/read 读到的昵称 / 角色 / 模型 → SubagentInfo 字段（限长；角色放 agentType） */
export function subagentLabels(info: { nickname?: string; role?: string; model?: string }): SubagentInfo {
  const nickname = label(info.nickname);
  const role = label(info.role);
  const model = label(info.model);
  return {
    ...(nickname === undefined ? {} : { nickname }),
    ...(role === undefined ? {} : { agentType: role }),
    ...(model === undefined ? {} : { model }),
  };
}

/** agentPath（`/root/<名>`）的最后一段：没有昵称时的可读名字 */
export function agentPathName(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const last = path.split('/').filter((p) => p !== '').at(-1);
  return label(last);
}

/** 派生、等待子 agent 等操作：一张卡；右侧是调用状态，子 agent 的状态放进 subagent */
function collabItem(item: Rec, id: string, ts: number): HistoryItem {
  const tool = str(item['tool']) ?? '';
  const prompt = str(item['prompt']);
  const action = tool === 'spawnAgent' ? '派生子 agent' : (COLLAB_ACTION[tool] ?? (tool === '' ? '子 agent' : tool));
  const entries = isRecord(item['agentsStates']) ? Object.entries(item['agentsStates']).filter((e): e is [string, Rec] => isRecord(e[1])) : [];
  const counts = new Map<SubagentState, number>();
  for (const [, state] of entries) {
    const mapped = collabAgentState(state['status']);
    if (mapped !== undefined) counts.set(mapped, (counts.get(mapped) ?? 0) + 1);
  }
  const messages = entries.map(([, s]) => str(s['message'])).filter((m): m is string => m !== undefined && m !== '');
  const failed = (counts.get('failed') ?? 0) + (counts.get('not_found') ?? 0) > 0;
  const call = COLLAB_CALL_LABEL[str(item['status']) ?? ''];
  const agents = [...counts].map(([state, n]) => `${AGENT_STATE_LABEL[state]} ${n}`).join(' · ');
  const summary = [call, agents === '' ? undefined : `子 agent ${agents}`].filter((p) => p !== undefined).join(' · ');
  // 只有一个目标时，卡上的子 agent 信息就是它的
  const receivers = Array.isArray(item['receiverThreadIds']) ? item['receiverThreadIds'].filter((r): r is string => typeof r === 'string' && r !== '') : [];
  const targetId = receivers.length === 1 ? receivers[0] : entries.length === 1 ? entries[0]![0] : undefined;
  const targetState = targetId === undefined ? undefined : collabAgentState(entries.find(([k]) => k === targetId)?.[1]['status']);
  const model = label(str(item['model']));
  const subagent: SubagentInfo = {
    ...(label(targetId) === undefined ? {} : { agentId: label(targetId)! }),
    ...(targetState === undefined ? {} : { state: targetState }),
    ...(model === undefined ? {} : { model }),
  };
  return {
    kind: 'tool',
    id,
    // 不用 Agent：那是 Claude 的子 agent 卡，会去拉 Codex 没有的子过程
    toolName: 'SubAgent',
    argSummary: toSingleLine(tool === 'spawnAgent' && prompt !== undefined ? prompt : prompt === undefined ? action : `${action}：${prompt}`),
    ...statusOf(item['status'], !failed),
    ...(summary === '' ? {} : { resultSummary: summary }),
    ...preview(messages.length > 0 ? messages.join('\n') : undefined),
    ...(Object.keys(subagent).length === 0 ? {} : { subagent }),
    ts,
  };
}

const ACTIVITY_LABEL: Record<string, string> = {
  started: '子 agent 已启动',
  interacted: '子 agent 有新动作',
  interrupted: '子 agent 已中断',
  completed: '子 agent 已完成',
};

/** subAgentActivity 的 kind → 子 agent 状态 */
export function activityState(kind: unknown): SubagentState | undefined {
  switch (kind) {
    case 'started':
    case 'interacted':
      return 'running';
    case 'interrupted':
      return 'interrupted';
    case 'completed':
      return 'completed';
    default:
      return undefined;
  }
}

/**
 * 子 agent 动态。`started` 就是派生（v2 下没有 spawnAgent 的 collabAgentToolCall，spike S2），
 * 显示成派生卡：右侧「已派生」，子 agent 的 thread / 模型 / 状态放进 subagent；其余 kind
 * 在能对上派生卡时并进它（见 codexItemsToHistory / 会话的实时路径），对不上才单独成卡。
 */
function subAgentActivityItem(item: Rec, id: string, ts: number): HistoryItem {
  const kind = str(item['kind']) ?? '';
  const path = str(item['agentPath']);
  const agentId = label(str(item['agentThreadId']));
  const model = label(str(item['model']));
  const state = activityState(kind);
  const subagent: SubagentInfo = {
    ...(agentId === undefined ? {} : { agentId }),
    ...(model === undefined ? {} : { model }),
    ...(state === undefined ? {} : { state }),
  };
  const spawned = kind === 'started';
  const name = agentPathName(path);
  return {
    kind: 'tool',
    id,
    toolName: 'SubAgent',
    argSummary: spawned
      ? toSingleLine(['派生子 agent', name].filter((p) => p !== undefined).join(' · '))
      : toSingleLine([ACTIVITY_LABEL[kind] ?? `子 agent：${kind}`, path].filter((p) => p !== undefined).join(' · ')),
    status: kind === 'interrupted' ? 'warn' : 'ok',
    ...(spawned ? { resultSummary: '已派生' } : {}),
    ...(Object.keys(subagent).length === 0 ? {} : { subagent }),
    ts,
  };
}

/** 一条 raw item 若是派生，返回子 thread id 与派生卡 id（subAgentActivity started / spawnAgent） */
export function spawnOf(item: unknown): { childThreadId: string; cardId: string }[] {
  if (!isRecord(item)) return [];
  const id = str(item['id']);
  if (id === undefined || id === '') return [];
  if (item['type'] === 'subAgentActivity' && item['kind'] === 'started') {
    const child = str(item['agentThreadId']);
    return child === undefined || child === '' ? [] : [{ childThreadId: child, cardId: id }];
  }
  if (item['type'] === 'collabAgentToolCall' && item['tool'] === 'spawnAgent' && Array.isArray(item['receiverThreadIds'])) {
    return item['receiverThreadIds']
      .filter((r): r is string => typeof r === 'string' && r !== '')
      .map((childThreadId) => ({ childThreadId, cardId: id }));
  }
  return [];
}

/** 某条 raw item 带来的子 agent 状态更新：子 thread id → 状态（派生本身不算） */
export function childStatesOf(item: unknown): Map<string, SubagentState> {
  const out = new Map<string, SubagentState>();
  if (!isRecord(item)) return out;
  if (item['type'] === 'subAgentActivity' && item['kind'] !== 'started') {
    const child = str(item['agentThreadId']);
    const state = activityState(item['kind']);
    if (child !== undefined && state !== undefined) out.set(child, state);
  } else if (item['type'] === 'collabAgentToolCall' && isRecord(item['agentsStates'])) {
    for (const [child, raw] of Object.entries(item['agentsStates'])) {
      const state = isRecord(raw) ? collabAgentState(raw['status']) : undefined;
      if (state !== undefined) out.set(child, state);
    }
  }
  return out;
}

/**
 * 一个 thread 的 raw items → 历史条目。比逐条 codexItemToHistory 多做一件事：子 agent 的后续
 * 动态并进它的派生卡（subagent.state），不再各自成卡；没有任何结束证据的派生卡标「状态未知」。
 */
export function codexItemsToHistory(raw: readonly unknown[], fallbackTs: number): HistoryItem[] {
  const items: HistoryItem[] = [];
  /** 子 thread id → items 下标（它的派生卡） */
  const cards = new Map<string, number>();
  let ts = fallbackTs;
  for (const item of raw) {
    const states = childStatesOf(item);
    const isActivity = isRecord(item) && item['type'] === 'subAgentActivity' && item['kind'] !== 'started';
    let merged = false;
    for (const [child, state] of states) {
      const at = cards.get(child);
      if (at === undefined) continue;
      const card = items[at] as Extract<HistoryItem, { kind: 'tool' }>;
      items[at] = { ...card, subagent: { ...card.subagent, state } };
      merged = true;
    }
    // 动态已经并进派生卡就不再单独成卡；collab 调用（wait 等）照常成卡
    if (isActivity && merged) continue;
    const converted = codexItemToHistory(item, ts);
    if (converted === undefined) continue;
    ts = converted.ts;
    for (const spawn of spawnOf(item)) cards.set(spawn.childThreadId, items.length);
    items.push(converted);
  }
  for (const at of new Set(cards.values())) {
    const card = items[at] as Extract<HistoryItem, { kind: 'tool' }>;
    const state = card.subagent?.state;
    if (state === undefined || state === 'running' || state === 'pending') {
      items[at] = { ...card, subagent: { ...card.subagent, state: 'unknown' } };
    }
  }
  return items;
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

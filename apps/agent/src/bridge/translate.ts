/**
 * SDK 消息 → 协议事件体的**纯函数**转换层。
 *
 * ## 为什么是纯函数（决策 1）
 *
 * 这里不碰 seq、不碰 ts、不碰 dir、不碰 sessionId——那四个信封字段由发送层
 * （emitter.ts）统一补。本层输入「SDK 消息 + 一点点转换游标」，输出「事件体」，
 * 没有 I/O、没有时钟依赖（耗时由调用方传入 now），因此可以脱离 SDK 直接单测。
 *
 * ## 转换游标（TranslateState）
 *
 * 有几件事必须跨消息记账，做不成无状态：
 * - **tool.start/end 配对**：tool_use 块出现在 assistant 消息里，tool_result 出现在
 *   后续 user 消息里，二者靠 toolUseId 关联，耗时要用 start 时刻算；
 * - **assistant.delta 去重**：stream_event 的 text_delta 与随后 assistant 消息的
 *   全文会重复描述同一条消息，靠 messageId 记账避免重复计数；
 * - **run 统计**：toolCount / permissionCount 要在 run.done 时汇报。
 *
 * 游标是显式传入的可变对象而非模块级状态——每个会话一份，测试可自造。
 *
 * ## 子 agent 的帧（subagent-view）
 *
 * `parent_tool_use_id` 非 null 的消息是子 agent 产出的（值 = 主会话里那次 Agent/Task
 * 工具调用的 tool_use id）。其中 assistant 的 tool_use 与 user 的 tool_result 照常转成
 * tool.start / tool.end，带上 `parentToolUseId`，client 把它们挂到父工具卡下；子 agent
 * 的文本 / thinking / 流事件仍丢弃（不开 forwardSubagentText，只展示子工具卡）。
 * run 统计（toolCount）只算主线程——完成卡说的是「这一轮 Claude 调了几次工具」。
 *
 * ## 未知消息优雅降级
 *
 * SDK 0.3.251 的 `SDKMessage` 是 38 个成员的联合（远超调研报告提到的几种），
 * 且 0.x 期间还会增。本层对不认识的消息一律返回空数组，**绝不抛错**：
 * 一个新增的 system 子类型不该让整条事件流断掉。
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { PermissionModeSchema, type PermissionMode, type SessionState } from '@trine/core';
import {
  outputPreview,
  subagentReportText,
  stripAnsi,
  summarizeToolArgs,
  summarizeToolResult,
  toSingleLine,
} from './summarize.ts';
import type { EventBody } from './types.ts';

/**
 * 尚未见到 message_start 时，增量事件挂靠的占位 messageId 前缀。
 *
 * 协议要求 messageId 非空，而 client 只用它给「原地追加」定位。占位 id 记在
 * 游标里，让同一条消息的 delta 与 done 落在同一个气泡上（见 translateAssistant
 * 里的孤儿气泡防护）；且按会话递增编号——早先是固定串 `'pending'`，所有占位
 * 消息共用一个 id，client 按 id 原地覆盖，于是后续回复全被写进时间线上方第一个
 * 占位气泡里（已 done 的还会丢弃新 delta），底部只剩「思考中…」。
 */
const PENDING_MESSAGE_PREFIX = 'pending-';

function isPendingId(id: string | undefined): id is string {
  return id !== undefined && id.startsWith(PENDING_MESSAGE_PREFIX);
}

/** 在途工具表的容量上限（防孤儿条目累积成泄漏） */
const MAX_PENDING_TOOLS = 200;

/**
 * 把任意数值收成协议要求的非负整数毫秒。
 *
 * 协议里所有时长字段都是 `z.number().int().nonnegative()`，而上游（SDK 的
 * duration_ms、注入的 now()）只保证是 number。非整数或 NaN 会让**整帧**被
 * client 的 schema 拒掉——丢的是完成卡/工具卡这种关键帧，所以统一在这里收口。
 */
function safeDuration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

/** 同上，用于计数类字段（int + nonnegative） */
function safeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

/** 一次工具调用的在途记录（start 已发、end 未发） */
interface PendingTool {
  toolUseId: string;
  toolName: string;
  startedAt: number;
  /** 子 agent 的工具调用：父 Agent/Task 的 toolUseId */
  parentToolUseId?: string;
}

/** 跨消息的转换游标；每会话一份 */
export interface TranslateState {
  /** toolUseId → 在途工具 */
  pendingTools: Map<string, PendingTool>;
  /**
   * 最近一条已发过 thinking.start 的 messageId。
   *
   * 只记「最近一条」而非全集：thinking.start 的去重语义是「同一条消息里
   * 首个 thinking_delta 才发信号」，而 delta 天然按消息顺序到达，
   * 记住当前这条就够。存全集会在长会话里无界增长。
   */
  thinkingStartedFor: string | undefined;
  /** 本 run 的工具调用计数 */
  toolCount: number;
  /** 本 run 的权限请求计数（由权限桥累加，run.done 时读） */
  permissionCount: number;
  /** run 开始时刻，run.done 的 durationMs 用 */
  runStartedAt: number;
  /** 上一次 result 的累计成本——SDK 的 total_cost_usd 是累计值，见下 */
  lastCostUsd: number;
  /** 正在累积 assistant.done 全文的 messageId（多块消息共享同一 id） */
  doneTextFor: string | undefined;
  /** 该 messageId 已累积的全文 */
  doneText: string;
  /**
   * 当前正在流式产出的 assistant messageId。
   *
   * 同样只记「当前一条」：delta 需要的仅仅是「把文本追加到哪条消息上」，
   * 而 message_start 会在每条新消息前把它更新掉，message_stop 清掉。
   */
  currentMessageId: string | undefined;
  /** 已分配的占位 messageId 个数（占位 id 的递增编号） */
  pendingSeq: number;
  /**
   * 本 run 推送的用户消息若是斜杠命令，记命令名（不带 `/`），由会话层在推送时设置。
   * 本地命令的输出消息只带输出、不带命令名（命令名要等 result 的 `local_command`），
   * 靠它给 assistant.done 标上是哪个命令。
   */
  slashCommand: string | undefined;
}

export function createTranslateState(now: number): TranslateState {
  return {
    pendingTools: new Map(),
    thinkingStartedFor: undefined,
    toolCount: 0,
    permissionCount: 0,
    runStartedAt: now,
    lastCostUsd: 0,
    currentMessageId: undefined,
    pendingSeq: 0,
    doneTextFor: undefined,
    doneText: '',
    slashCommand: undefined,
  };
}

/** 转换上下文：调用方注入的时钟读数（保持纯函数） */
export interface TranslateContext {
  now: number;
  state: TranslateState;
}

/** 从 Anthropic 内容块里取文本（块可能是字符串或块数组） */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] === 'text' && typeof b['text'] === 'string') {
      parts.push(b['text']);
    }
  }
  return parts.join('');
}

/** tool_result 块的内容可能是字符串或块数组，拍平成文本 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (typeof b['text'] === 'string') parts.push(b['text']);
  }
  return parts.join('');
}

/**
 * 转换一条 SDK 消息为零到多个事件体。
 *
 * @returns 事件体数组；不认识的消息返回空数组
 */
export function translateMessage(
  message: SDKMessage,
  ctx: TranslateContext,
): EventBody[] {
  switch (message.type) {
    case 'stream_event':
      return translateStreamEvent(message, ctx);
    case 'assistant':
      return translateAssistant(message, ctx);
    case 'user':
      return translateUser(message, ctx);
    case 'result':
      return translateResult(message, ctx);
    case 'system':
      return translateSystem(message, ctx);
    default:
      // 未知消息类型：静默忽略（见文件头「未知消息优雅降级」）
      return [];
  }
}

/** stream_event → assistant.delta / thinking.start（token 级增量） */
function translateStreamEvent(
  message: Extract<SDKMessage, { type: 'stream_event' }>,
  ctx: TranslateContext,
): EventBody[] {
  // 子 agent 的流不进主聊天流（parent_tool_use_id 非 null 即子 agent 产出），
  // 否则会和主 agent 的文本交错。工具卡已经表达了「子 agent 在跑」。
  if (message.parent_tool_use_id !== null) return [];

  const event = message.event as unknown as Record<string, unknown>;
  const eventType = event['type'];

  if (eventType === 'content_block_delta') {
    const delta = event['delta'];
    if (typeof delta !== 'object' || delta === null) return [];
    const d = delta as Record<string, unknown>;
    const messageId = currentMessageId(ctx.state);

    if (d['type'] === 'text_delta' && typeof d['text'] === 'string') {
      if (d['text'].length === 0) return [];
      return [{ type: 'assistant.delta', messageId, text: d['text'] }];
    }
    // thinking 正文不外传（MVP 只显示「思考中…」占位），
    // 但首次出现要给一个 thinking.start 信号
    if (d['type'] === 'thinking_delta') {
      if (ctx.state.thinkingStartedFor === messageId) return [];
      ctx.state.thinkingStartedFor = messageId;
      return [{ type: 'thinking.start', messageId }];
    }
    return [];
  }

  if (eventType === 'message_start') {
    const msg = event['message'];
    if (typeof msg === 'object' && msg !== null) {
      const id = (msg as Record<string, unknown>)['id'];
      if (typeof id === 'string') ctx.state.currentMessageId = id;
    }
    return [];
  }

  if (eventType === 'message_stop') {
    // 整条 API 消息流完才复位游标。不能在每个内容块的 assistant 消息上复位：
    // thinking 块 + text 块同属一次 message_start，thinking 块的 assistant
    // 消息一复位，text 的 delta 就失去真实 id、落到占位 id 上
    ctx.state.currentMessageId = undefined;
    return [];
  }

  return [];
}

/**
 * 当前正在流式产出的 assistant messageId。
 *
 * stream_event 的 content_block_delta 本身不带 message id（它在 message_start
 * 里），所以用游标里记的「当前消息」。还没见过 message_start 就退化成一个稳定
 * 占位串——协议要求 messageId 非空，而 client 只用它做「原地追加」的定位。
 */
function currentMessageId(state: TranslateState): string {
  if (state.currentMessageId !== undefined) return state.currentMessageId;
  // 记下「本条消息已经用占位 id 流过内容了」，好让随后的 assistant.done
  // 沿用同一个 id（孤儿气泡防护，见 translateAssistant）
  state.pendingSeq += 1;
  const id = `${PENDING_MESSAGE_PREFIX}${state.pendingSeq}`;
  state.currentMessageId = id;
  return id;
}

/** assistant 消息 → assistant.done + tool.start */
function translateAssistant(
  message: Extract<SDKMessage, { type: 'assistant' }>,
  ctx: TranslateContext,
): EventBody[] {
  // 子 agent：只出工具卡，文本与 done 累积都不碰（不能动主线程的游标）
  const parent = parentOf(message);
  if (parent !== undefined) return toolStarts(message.message, ctx, parent);

  const out: EventBody[] = [];
  const raw = message.message as unknown as Record<string, unknown>;
  const realId =
    typeof raw['id'] === 'string' && raw['id'].length > 0
      ? raw['id']
      : message.uuid;

  // 孤儿气泡防护：若本条消息的增量是在见到 message_start 之前就流出去的
  // （那时只能挂在占位 id 上），终态必须沿用同一个占位 id，否则 client 那边
  // 那个「占位气泡」永远等不到它的 done，会留下一条半截文本的孤儿。
  const pending = ctx.state.currentMessageId;
  const messageId = isPendingId(pending) ? pending : realId;
  // 占位游标用一次即复位：下一块在见到 message_start 之前会拿到新的占位 id，
  // 而不是续用这一块的。真实 id 的游标留到 message_stop 再复位（见上）。
  if (isPendingId(pending)) ctx.state.currentMessageId = undefined;

  const content = raw['content'];
  // 本地斜杠命令（/usage、/cost…）的输出：CLI 合成的一条 assistant 消息，wrapper 上带
  // `local_command_source`（类型定义里没有，实测）。整条一次给出、不流式，单独标出来
  // 让 client 按命令输出卡渲染，不当 Markdown
  if (typeof (message as { local_command_source?: unknown }).local_command_source === 'string') {
    const text = stripAnsi(contentText(content)).trimEnd();
    if (text === '') return [];
    return [{ type: 'assistant.done', messageId, text, command: ctx.state.slashCommand ?? '' }];
  }
  const blockText = contentText(content);
  if (blockText.length > 0) {
    // 多块累积：SDK 在流式期间**每个完成的内容块发一条 assistant 消息**，
    // 连续几条会共享同一个 message.id（文档原话："several consecutive
    // assistant messages can share message.id and each carries just that block"）。
    // 而协议里 assistant.done 的语义是「终态**全文覆盖**」——若每块都按自己那点
    // 文本发一次 done，client 覆盖之后就只剩最后一块，前面的文本全丢
    // （典型场景：文本A + tool_use + 文本B，A 会消失）。
    // 所以按 messageId 累积，每次发累积后的全文。
    const accumulated =
      ctx.state.doneTextFor === messageId
        ? ctx.state.doneText + blockText
        : blockText;
    ctx.state.doneTextFor = messageId;
    ctx.state.doneText = accumulated;
    out.push({ type: 'assistant.done', messageId, text: accumulated });
  }

  out.push(...toolStarts(raw, ctx, undefined));
  return out;
}

/** 子 agent 帧的父 toolUseId（主线程 = undefined；空串按主线程对待，不造非法帧） */
function parentOf(message: { parent_tool_use_id: string | null }): string | undefined {
  const parent = message.parent_tool_use_id;
  return typeof parent === 'string' && parent !== '' ? parent : undefined;
}

/** assistant 消息里的 tool_use 块 → tool.start（子 agent 的带 parentToolUseId） */
function toolStarts(messageBody: unknown, ctx: TranslateContext, parentToolUseId: string | undefined): EventBody[] {
  if (typeof messageBody !== 'object' || messageBody === null) return [];
  const content = (messageBody as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return [];
  const out: EventBody[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] !== 'tool_use') continue;
    const toolUseId = b['id'];
    const toolName = b['name'];
    if (typeof toolUseId !== 'string' || toolUseId === '' || typeof toolName !== 'string' || toolName === '') continue;

    ctx.state.pendingTools.set(toolUseId, {
      toolUseId,
      toolName,
      startedAt: ctx.now,
      ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
    });
    // 有界化：被 interrupt 的 turn、崩溃的子 agent 都会留下没有 tool_result
    // 配对的孤儿条目，只增不减就是内存泄漏。Map 保插入序，超限即淘汰最旧的
    // （最旧的孤儿也最不可能再等到它的 result）。
    while (ctx.state.pendingTools.size > MAX_PENDING_TOOLS) {
      const oldest = ctx.state.pendingTools.keys().next();
      if (oldest.done === true) break;
      ctx.state.pendingTools.delete(oldest.value);
    }
    // run 统计只算主线程（见文件头「子 agent 的帧」）
    if (parentToolUseId === undefined) ctx.state.toolCount += 1;
    out.push({
      type: 'tool.start',
      toolUseId,
      toolName,
      argSummary: summarizeToolArgs(toolName, b['input']),
      ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
    });
  }
  return out;
}

/** user 消息 → tool.end（tool_result 回填）。真正的用户输入回显由会话层发 */
function translateUser(
  message: Extract<SDKMessage, { type: 'user' }>,
  ctx: TranslateContext,
): EventBody[] {
  // 子 agent 的 tool_result 同样回填（带 parentToolUseId）；它的首条 prompt 文本不出帧
  const parent = parentOf(message);

  const raw = message.message as unknown as Record<string, unknown>;
  const content = raw['content'];
  if (!Array.isArray(content)) return [];

  const out: EventBody[] = [];
  const results = content.filter(
    (block) => typeof block === 'object' && block !== null && (block as Record<string, unknown>)['type'] === 'tool_result',
  ).length;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] !== 'tool_result') continue;
    const toolUseId = b['tool_use_id'];
    if (typeof toolUseId !== 'string') continue;

    const pending = ctx.state.pendingTools.get(toolUseId);
    // 没有对应 start 的 result：可能是 resume 续跑跨了进程，
    // 此时耗时无从算起，用 0 而不是丢弃事件——工具卡该收尾还是要收尾。
    const durationMs = pending ? safeDuration(ctx.now - pending.startedAt) : 0;
    const toolName = pending?.toolName ?? 'unknown';
    ctx.state.pendingTools.delete(toolUseId);

    const text = toolResultText(b['content']);
    const isError = b['is_error'] === true;
    // 结构化输出挂在整条 user 消息上（不在块里）；只有一个 tool_result 时才确定是它的
    const structured = results === 1 ? message.tool_use_result : undefined;
    const { status, resultSummary } = summarizeToolResult(toolName, {
      text,
      isError,
      durationMs,
      ...(structured === undefined ? {} : { structured }),
    });

    // Agent/Task 的预览给报告正文，不给写给模型看的前言与 usage 尾巴
    const isSubagentTool = toolName === 'Agent' || toolName === 'Task';
    const preview = outputPreview(isSubagentTool && !isError ? subagentReportText(structured, text) : text);
    // parent 以消息上的为准；消息没带（不该发生）再用 start 时记的
    const parentToolUseId = parent ?? pending?.parentToolUseId;
    out.push({
      type: 'tool.end',
      toolUseId,
      status,
      durationMs,
      resultSummary,
      ...(preview === undefined ? {} : { outputPreview: preview }),
      ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
    });
  }
  return out;
}

/**
 * result 消息 → run.done（或 error.*）。
 *
 * **成本是累计值**：SDK 文档明确 `total_cost_usd` 在流式输入会话里跨 turn 累计，
 * 每个 result 带的是「到目前为止的总额」。所以 run.done 的 costUsd 取差值
 * （本次 run 的增量），会话级累计另由会话层记 lastCostUsd。
 */
function translateResult(
  message: Extract<SDKMessage, { type: 'result' }>,
  ctx: TranslateContext,
): EventBody[] {
  // 崩溃/启动失败的 result 可能带零值、甚至整个缺 total_cost_usd（SDK 文档
  // 明说 "Crash/startup-error results may carry zeroed values"）。缺字段时
  // `undefined - lastCostUsd` = NaN，而协议的 costUsd 是 z.number()——NaN 过不了
  // schema，client 会把整条 run.done 丢掉，UI 就永远停在「运行中」。
  // 恰恰是崩溃场景最需要这张完成卡，所以这里必须兜住。
  const raw = message.total_cost_usd;
  const cumulative = typeof raw === 'number' && Number.isFinite(raw) ? raw : ctx.state.lastCostUsd;
  const delta = Math.max(0, cumulative - ctx.state.lastCostUsd);
  ctx.state.lastCostUsd = cumulative;

  const done: EventBody = {
    type: 'run.done',
    // 协议的时长字段都是 z.number().int()，而 SDK 的 duration_ms 只保证 number。
    // 不取整会让整帧被 schema 拒（实测 1234.56 即失败）。
    durationMs: safeDuration(message.duration_ms),
    costUsd: delta,
    toolCount: ctx.state.toolCount,
    permissionCount: ctx.state.permissionCount,
    turns: safeCount(message.num_turns),
  };

  if (message.subtype !== 'success') {
    // 错误型 result：errors 数组里是原因文本。分类交给会话层（要决定是否续跑），
    // 这里只把完成卡发出去，保证 UI 不会永远停在「运行中」。
    return [done];
  }
  return [done];
}

/** system 消息 → 会话能力 / 状态类事件 */
function translateSystem(
  message: Extract<SDKMessage, { type: 'system' }>,
  _ctx: TranslateContext,
): EventBody[] {
  switch (message.subtype) {
    case 'init': {
      // 字段判空：CLI 随全局 claude 自动更新，init 形状可能变；缺字段只该让能力
      // 清单空着，不该让整条事件流断掉（本层「绝不抛错」的约定）
      const rawCommands: unknown = message.slash_commands;
      const slashCommands = (Array.isArray(rawCommands) ? rawCommands : [])
        .filter((name): name is string => typeof name === 'string')
        .map((name) => ({
          name,
          // SDK 的 init 只给命令名字符串，来源需要 supportedCommands() 才有细节；
          // 这里统一标 project，会话层拿到 SlashCommand[] 后可覆盖。
          source: 'project' as const,
        }));
      const rawServers: unknown = message.mcp_servers;
      const mcpServers = (Array.isArray(rawServers) ? rawServers : [])
        .filter((s): s is { name: string; status: string } => typeof s === 'object' && s !== null && typeof (s as { name?: unknown }).name === 'string')
        .map((s) => ({
          name: s.name,
          state: mapMcpState(typeof s.status === 'string' ? s.status : ''),
          toolCount: 0,
        }));
      return [
        {
          type: 'session.capabilities',
          slashCommands,
          models: [message.model],
          mcpServers,
        },
      ];
    }
    case 'session_state_changed': {
      const state = mapSessionState(message.state);
      return state === undefined ? [] : [{ type: 'run.state', state }];
    }
    case 'api_retry':
      // SDK 内部重试：作为瞬时错误痕迹展示，不触发我们自己的 resume
      return [
        {
          type: 'error.transient',
          // 协议的 attempt 是 positive()，而 SDK 的 attempt 可能从 0 起算
          attempt: Math.max(1, safeCount(message.attempt)),
          reason: toSingleLine(`API 重试（${message.error}）`),
        },
      ];
    default:
      return [];
  }
}

/** SDK 的 mcp server status 字符串 → 协议枚举 */
function mapMcpState(status: string): 'connected' | 'failed' | 'needs_auth' {
  const lower = status.toLowerCase();
  if (lower === 'connected' || lower === 'ready') return 'connected';
  if (lower.includes('auth')) return 'needs_auth';
  return 'failed';
}

/** SDK 的 session state → 协议 SessionState；不认识的返回 undefined 表示不发帧 */
function mapSessionState(state: string): SessionState | undefined {
  switch (state) {
    case 'idle':
      return 'idle';
    case 'running':
      return 'running';
    case 'requires_action':
      return 'waiting_permission';
    default:
      return undefined;
  }
}

/**
 * CLI 自行切换权限模式的回报：`system/status` 消息上带 `permissionMode`
 * 时取出（协议已知的四种之一），否则 undefined。
 *
 * ## 为什么单独一个函数而不是 translateMessage 的产出
 *
 * translateMessage 只产出**协议事件体**（发给 client 的帧）；「会话权限模式变了」
 * 不是一帧事件，而是会话状态——要改 ClaudeSession 的 #permissionMode、经 onMeta
 * 广播 session.updated、再由 app 持久化进 state.json。那些都是有状态的副作用，
 * 属于会话层。这里只做「从消息里认出这件事」的纯解析，会话泵拿到结果自己落地
 * （session.ts #consumeUntilResult），本层纯函数的约定不破。
 *
 * 典型来源：plan 模式下 ExitPlanMode 被批准后 CLI 自己切回 default，或按
 * updatedPermissions setMode 切到 acceptEdits（已用真 claude 2.1.282 实测）。
 *
 * SDK 的 PermissionMode 比协议多 `dontAsk` / `auto`；协议表达不了的值返回
 * undefined（不同步），不硬塞进 SessionMeta 让 client 的 schema 整帧拒掉。
 */
export function permissionModeFromStatus(message: SDKMessage): PermissionMode | undefined {
  if (message.type !== 'system' || message.subtype !== 'status') return undefined;
  const parsed = PermissionModeSchema.safeParse(message.permissionMode);
  return parsed.success ? parsed.data : undefined;
}

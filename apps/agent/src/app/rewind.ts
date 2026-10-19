/**
 * 回退（`session.rewind.preview` / `session.rewind`）：定位目标消息 → 判断能不能回退 →
 * 还原文件 / 截断对话。对应 Claude Code `/rewind` 的「代码+对话 / 仅对话 / 仅代码」。
 *
 * 机制见 bridge/session.ts 文件头「回退」，这里只管编排：
 *
 * - **定位**：目标 id 先按 clientMsgId 查会话里记的推送 uuid，查不到就当它本身是转录
 *   uuid。在 `getSessionMessages` 的主链上找它（已有待生效截断点时先截掉被撤的尾巴），
 *   必须是用户说的话。截断点 = 主链上它的前一条；它是第一条消息时没有截断点，
 *   只能回退代码。
 * - **busy**：运行中 / 等批准 / 有排队 / 有后台任务一律拒绝（`rewindBlocker`）。
 * - **both**：先还原文件，失败就整体失败、对话不动；对话截断点先落盘再拆 query。
 *
 * 读转录与持久化都经注入的函数，测试不碰真 ~/.claude。
 */
import { relative, isAbsolute } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RewindErrorCode, RewindFilesStat, RewindMode } from '@trine/core';
import { cutAtRewind, humanUserText } from '../bridge/history.ts';
import type { ClaudeSession, RewindPoint } from '../bridge/session.ts';
import { errorText } from '../bridge/errors.ts';
import { toSingleLine } from '../bridge/summarize.ts';

export interface RewindDeps {
  /** 读会话主链（router 的转录读取，含 cwd 猜不中时的兜底） */
  readMessages: (sessionId: string) => Promise<readonly SessionMessage[]>;
  /** 持久化截断点（state.json） */
  setPendingRewind: (sessionId: string, point: RewindPoint) => void;
}

export interface RewindFailure {
  ok: false;
  error: { code: RewindErrorCode; message: string };
}

export interface RewindPreview {
  ok: true;
  text: string;
  conversation: { available: boolean; reason?: string };
  files: { available: boolean; reason?: string } & Partial<RewindFilesStat>;
}

export interface RewindDone {
  ok: true;
  text: string;
  files?: RewindFilesStat & { skippedLinks?: number };
  /** 广播 session.rewound 用 */
  rewound: { targetMessageIds: string[]; mode: RewindMode; filesChanged?: number };
}

interface Located {
  uuid: string;
  text: string;
  /** 截断点；目标是第一条消息时没有 */
  resumeAt: string | undefined;
  /** 广播给各设备对时间线用的全部 id */
  ids: string[];
}

const FIRST_MESSAGE_REASON = '这是对话的第一条消息，之前没有可以保留的对话；如需从头开始请新建会话';

export async function previewRewind(
  deps: RewindDeps,
  session: ClaudeSession,
  targetMessageId: string,
): Promise<RewindPreview | RewindFailure> {
  const blocker = session.rewindBlocker();
  if (blocker !== undefined) return fail('busy', blocker);
  const located = await locate(deps, session, targetMessageId);
  if (!located.ok) return located;
  const { target } = located;

  let files: RewindPreview['files'];
  try {
    const result = await session.previewFiles(target.uuid);
    files = result.canRewind
      ? { available: true, ...stat(session, result) }
      : { available: false, reason: noSnapshotReason(result.error) };
  } catch (err) {
    files = { available: false, reason: toSingleLine(`读取文件快照失败：${errorText(err)}`, 300) };
  }
  return {
    ok: true,
    text: target.text,
    conversation: target.resumeAt === undefined ? { available: false, reason: FIRST_MESSAGE_REASON } : { available: true },
    files,
  };
}

export async function executeRewind(
  deps: RewindDeps,
  session: ClaudeSession,
  targetMessageId: string,
  mode: RewindMode,
): Promise<RewindDone | RewindFailure> {
  const blocker = session.rewindBlocker();
  if (blocker !== undefined) return fail('busy', blocker);
  const located = await locate(deps, session, targetMessageId);
  if (!located.ok) return located;
  const { target } = located;
  const withCode = mode !== 'conversation';
  const withConversation = mode !== 'code';
  // 先把做不到的挡掉，免得文件已经还原了才发现对话回退不了
  if (withConversation && target.resumeAt === undefined) return fail('invalid', FIRST_MESSAGE_REASON);

  let files: RewindDone['files'];
  if (withCode) {
    try {
      const result = await session.restoreFiles(target.uuid);
      if (!result.canRewind) return fail('unavailable', noSnapshotReason(result.error));
      files = {
        ...stat(session, result),
        ...(result.skippedLinks === undefined ? {} : { skippedLinks: result.skippedLinks }),
      };
    } catch (err) {
      return fail('io', toSingleLine(`还原文件失败：${errorText(err)}`, 300));
    }
  }
  if (withConversation && target.resumeAt !== undefined) {
    const point: RewindPoint = { resumeAt: target.resumeAt, dropFrom: target.uuid };
    // 先落盘再拆：拆完之前 agent 崩了，下次起来照样从截断点接上
    deps.setPendingRewind(session.sessionId, point);
    session.rewindConversation(point);
  }
  return {
    ok: true,
    text: target.text,
    ...(files === undefined ? {} : { files }),
    rewound: {
      targetMessageIds: target.ids,
      mode,
      ...(files === undefined ? {} : { filesChanged: files.filesChanged.length }),
    },
  };
}

async function locate(
  deps: RewindDeps,
  session: ClaudeSession,
  targetMessageId: string,
): Promise<{ ok: true; target: Located } | RewindFailure> {
  const uuid = session.userMessageUuid(targetMessageId) ?? targetMessageId;
  let chain: readonly SessionMessage[];
  try {
    chain = cutAtRewind(await deps.readMessages(session.sessionId), session.pendingRewind?.dropFrom);
  } catch (err) {
    return fail('io', toSingleLine(`读取会话转录失败：${errorText(err)}`, 300));
  }
  const at = chain.findIndex((m) => m.uuid === uuid);
  const message = at < 0 ? undefined : chain[at];
  if (message === undefined) return fail('not_found', '对话里找不到这条消息（可能已经被回退，或者还没写进转录）');
  const text = humanUserText(message);
  if (text === undefined) return fail('invalid', '只能回退到你发的消息');
  const clientMsgId = session.clientMsgIdOf(uuid);
  const ids = [...new Set([targetMessageId, uuid, ...(clientMsgId === undefined ? [] : [clientMsgId])])];
  return { ok: true, target: { uuid, text, resumeAt: at > 0 ? chain[at - 1]?.uuid : undefined, ids } };
}

/** SDK 的改动统计 → 协议形状；路径相对会话 cwd（cwd 之外的保持绝对路径） */
function stat(
  session: ClaudeSession,
  result: { filesChanged?: string[]; insertions?: number; deletions?: number },
): RewindFilesStat {
  const cwd = session.meta().cwd;
  return {
    filesChanged: (result.filesChanged ?? []).map((path) => {
      if (cwd === '' || !isAbsolute(path)) return path;
      const rel = relative(cwd, path);
      return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? path : rel;
    }),
    insertions: result.insertions ?? 0,
    deletions: result.deletions ?? 0,
  };
}

function noSnapshotReason(error: string | undefined): string {
  const detail = error === undefined || error.trim() === '' ? '' : `（${toSingleLine(error, 200)}）`;
  return `没有这条消息之前的文件快照${detail}。开启文件快照之前的轮次无法还原代码`;
}

function fail(code: RewindErrorCode, message: string): RewindFailure {
  return { ok: false, error: { code, message } };
}

/**
 * 测试用的内存版「SDK 转录目录」：listSessions / getSessionInfo /
 * renameSession / deleteSession 四个 SDK 函数的假实现，共享一份状态。
 *
 * 形状按真 SDK 0.3.251 的行为造（learnings：自愈路径测试要用对端真能产生的
 * 数据形状）：
 * - 转录在会话**第一次处理消息**时才出现（`write`），新建未发消息的会话没有；
 * - rename / delete 找不到转录时抛普通 Error，消息含 "not found"
 *   （sdk.mjs：`Session ${id} not found in any project directory`）；
 * - rename 会刷新 lastModified（追加一行 = 改 mtime），summary 随 customTitle 变；
 * - getSessionInfo 查不到返回 undefined（不抛）。
 *
 * 绝不碰真 ~/.claude：注入了它的 manager / app 不会落到 SDK 默认实现上。
 */
import type {
  deleteSession,
  getSessionInfo,
  listSessions,
  renameSession,
  SDKSessionInfo,
} from '@anthropic-ai/claude-agent-sdk';

export class FakeTranscripts {
  readonly #files = new Map<string, SDKSessionInfo>();
  /** 每次调用留痕：`rename:<sid>:<title>` / `delete:<sid>` / `info:<sid>` / `list` */
  readonly calls: string[] = [];
  /** 让下一次 rename / delete 抛这个错误（模拟 IO 失败），用一次即清 */
  failNext: Error | undefined = undefined;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** 会话处理了一条消息：没有转录就建，有就刷新 mtime */
  write(sessionId: string, patch: Partial<SDKSessionInfo> = {}): SDKSessionInfo {
    const current = this.#files.get(sessionId);
    const next: SDKSessionInfo = {
      ...(current ?? { sessionId, summary: '', lastModified: 0, createdAt: this.now() }),
      ...patch,
      sessionId,
    };
    // firstPrompt 是「第一条」：已有就不被后来的消息覆盖
    if (current?.firstPrompt !== undefined) next.firstPrompt = current.firstPrompt;
    next.summary = next.customTitle ?? next.firstPrompt ?? '';
    next.lastModified = patch.lastModified ?? this.now();
    this.#files.set(sessionId, next);
    return next;
  }

  has(sessionId: string): boolean {
    return this.#files.has(sessionId);
  }

  info(sessionId: string): SDKSessionInfo | undefined {
    const info = this.#files.get(sessionId);
    return info === undefined ? undefined : { ...info };
  }

  /** 把转录的 mtime 往回拨（删除有「60s 内写过则拒绝」的前置检查） */
  backdate(sessionId: string, ms: number): void {
    const info = this.#files.get(sessionId);
    if (info !== undefined) info.lastModified -= ms;
  }

  readonly listSessions = (async () => {
    this.calls.push('list');
    return [...this.#files.values()].map((i) => ({ ...i }));
  }) as typeof listSessions;

  readonly getSessionInfo = (async (sessionId: string) => {
    this.calls.push(`info:${sessionId}`);
    return this.info(sessionId);
  }) as typeof getSessionInfo;

  readonly renameSession = (async (sessionId: string, title: string) => {
    this.calls.push(`rename:${sessionId}:${title}`);
    this.#throwIfArmed();
    const info = this.#files.get(sessionId);
    if (info === undefined) throw notFound(sessionId);
    info.customTitle = title;
    info.summary = title;
    info.lastModified = this.now();
  }) as typeof renameSession;

  readonly deleteSession = (async (sessionId: string) => {
    this.calls.push(`delete:${sessionId}`);
    this.#throwIfArmed();
    if (!this.#files.delete(sessionId)) throw notFound(sessionId);
  }) as typeof deleteSession;

  #throwIfArmed(): void {
    const err = this.failNext;
    if (err === undefined) return;
    this.failNext = undefined;
    throw err;
  }
}

function notFound(sessionId: string): Error {
  return new Error(`Session ${sessionId} not found in any project directory`);
}

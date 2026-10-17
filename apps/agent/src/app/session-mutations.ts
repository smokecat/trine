/**
 * 会话元数据命令：重命名 / 归档 / 永久删除（session-list-v2，方案 v2 §3.4）。
 *
 * 由 router 在该会话的命令链上调用（与同 sid 的 input.send 串行），**绝不**
 * resolveSession（评审 B2：历史会话改个名不该占并发名额、更不该先 resume 一次）：
 * 有活跃实例就看实例的状态，没有就直接操作 SDK 与 flags store。
 *
 * 每个命令返回一个 `MutationOutcome`，router 把它包成机器级
 * `session.mutate.response`；成功时的广播（session.updated / session.removed）
 * 在这里发。业务拒绝一律走 outcome，不抛；抛出来的是真意外，router 转 `io`。
 */
import type { SessionMutateErrorCode } from '@trine/core';
import type { EventEmitter } from '../bridge/emitter.ts';
import type { SessionManager } from '../bridge/manager.ts';
import type { ClaudeSession } from '../bridge/session.ts';
import type { CapabilitiesCache } from './router.ts';
import type { SessionFlagsStore } from './session-flags.ts';
import type { AgentState } from './state.ts';

/** 与 SDK 读取 custom-title 时的上限一致（sdk.mjs `G4`） */
export const SESSION_TITLE_MAX = 200;
/** 转录在这么久之内被（trine 以外的进程）写过 → 拒删（多半是本机终端正开着这个会话，评审 Q1） */
export const DELETE_RECENT_WRITE_MS = 60_000;
/**
 * 删除成功后多久复查一次转录是否又冒出来（评审 CB1）。SDK 的
 * ProcessTransport.close() 同步返回，子进程若还活着要 **2s** 后才 SIGTERM、再
 * **5s** 后 SIGKILL；CLI 退出时的 re-stamp（reAppendSessionMetadata，不带
 * onlyIfExists）可能在我们 deleteSession 之后重建一个只含元数据的 jsonl。
 * 2s + 5s + 1s 余量。
 */
export const DELETE_RECHECK_DELAY_MS = 8_000;
/**
 * 复查只删「疑似 re-stamp 残影」（评审 N1）：转录 mtime 落在
 * `[deletedAt - DELETE_RESTAMP_SLACK_MS, deletedAt + DELETE_RESTAMP_WINDOW_MS]` 内。
 * re-stamp 发生在 close 后 2s（SIGTERM）到 7s（SIGKILL）之间，15s 给足余量；
 * 更晚的写入只能是用户删除后在本机终端又用了这个 sid（续聊 / 从 `--resume`
 * 点进幽灵），那是真实的新内容，**不删**。
 */
export const DELETE_RESTAMP_WINDOW_MS = 15_000;
/**
 * 窗口下沿的容差：墓碑时刻取在 deleteSession 返回**之后**，re-stamp 恰好落在两者
 * 之间时 mtime 会略早于 deletedAt；再加上 mtime 与 Date.now 的取整差。
 */
export const DELETE_RESTAMP_SLACK_MS = 2_000;
/** 删除的 60s 检查里，转录 mtime 早于 trine 自己那次写的时刻不超过这么多（且不晚于它）才算「最后一次写是我们」（评审 N2） */
export const SELF_WRITE_MATCH_MS = 1_000;

/**
 * 标题规范化，规则取自 CLI / SDK 显示标题时用的那套（sdk.mjs `W4`/`q1e`/`wy`）：
 * trim → 连续的控制 / 格式字符（\p{Cc} \p{Cf} U+2028 U+2029）换成一个空格 →
 * 去掉残余的 \x00-\x1f\x7f-\x9f → 按码点截到 200 → 再 trim。
 *
 * 注意 SDK 的 getSessionInfo / listSessions 读取 customTitle 时**不**做规范化
 * （原样返回，已用真 SDK 实测，见 sdk-probe.test.ts）。在写入端先规范化的理由是：
 * CLI 显示时会按这套规则处理，写进去的就与各处显示一致；而且广播出去的值与之后
 * listSessions 原样读回的值逐字相等，列表不会闪。
 */
export function normalizeSessionTitle(raw: string): string {
  const spaced = raw.trim().replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ');
  const stripped = spaced.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  return [...stripped].slice(0, SESSION_TITLE_MAX).join('').trim();
}

/** SDK renameSession / deleteSession 找不到转录时抛的是普通 Error，只能认消息 */
export function isSessionNotFound(err: unknown): boolean {
  return err instanceof Error && /not found/i.test(err.message);
}

export type MutationOutcome =
  | { ok: true }
  | { ok: false; code: SessionMutateErrorCode; message: string };

const OK: MutationOutcome = { ok: true };

function fail(code: SessionMutateErrorCode, message: string): MutationOutcome {
  return { ok: false, code, message };
}

/** 与 setCwd / reapIdle 同口径（评审 M3）：运行中、等批准、有排队消息都算忙 */
function isBusy(session: ClaudeSession | undefined): boolean {
  if (session === undefined) return false;
  return (
    session.state === 'running' ||
    session.state === 'waiting_permission' ||
    session.queueLength > 0
  );
}

export interface SessionMutationsDeps {
  manager: SessionManager;
  emitter: EventEmitter;
  state: AgentState;
  flags: SessionFlagsStore;
  capabilities: CapabilitiesCache;
  now: () => number;
  log: (line: string) => void;
  /** 清掉 router 里该会话的 resumeAt 定时器与 in-flight resolve（删除第 2 步） */
  cancelPending: (sessionId: string) => void;
  /** 删除后延迟复查用的定时器（router 注入，默认实现须 unref）；dispose 时清 */
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** 把任务挂到该会话的命令链上（复查与同 sid 的其他命令串行） */
  onChain: (sessionId: string, task: () => Promise<void>) => void;
}

export class SessionMutations {
  readonly #deps: SessionMutationsDeps;
  /** 删除后的延迟复查定时器（sessionId → handle） */
  readonly #rechecks = new Map<string, unknown>();

  constructor(deps: SessionMutationsDeps) {
    this.#deps = deps;
  }

  /** 挂着的复查定时器数（测试用） */
  get pendingRecheckCount(): number {
    return this.#rechecks.size;
  }

  /** 进程退出：清掉所有复查定时器 */
  dispose(): void {
    for (const handle of this.#rechecks.values()) this.#deps.clearTimer(handle);
    this.#rechecks.clear();
  }

  // -------------------------------------------------------------------------
  // rename
  // -------------------------------------------------------------------------

  /**
   * 有转录 → SDK renameSession（与 CLI `/rename` 同一条 custom-title 记录）；
   * 从没发过消息（state 记着 started:false，没有 jsonl）→ 记 pendingTitle，
   * 首条消息落盘后由 `flushPendingTitle` 补写（评审 M8）。
   */
  async rename(sessionId: string, rawTitle: string): Promise<MutationOutcome> {
    const { manager, state, flags, now } = this.#deps;
    const title = normalizeSessionTitle(rawTitle);
    if (title === '') return fail('invalid', '标题不能为空');

    if (state.sessionParams(sessionId)?.started === false) {
      await flags.setPendingTitle(sessionId, title, now());
    } else {
      let written = false;
      try {
        await manager.renameTranscript(sessionId, title);
        written = true;
        // 写完再记时刻：mtime ≤ 这个值 ⇒ 最后一次写是我们自己（删除的 60s 检查据此排除）
        flags.noteSelfWrite(sessionId, now());
      } catch (err) {
        if (!isSessionNotFound(err)) throw err;
        // 有活跃实例却还没有转录：首条消息刚发出、子进程还没写 jsonl 的那个窗口。
        // 先记 pendingTitle，一轮跑完时补写
        if (!manager.has(sessionId)) return fail('not_found', `找不到会话 ${sessionId} 的记录`);
        await flags.setPendingTitle(sessionId, title, now());
      }
      // 已写进转录：旧的 pendingTitle 不能再盖在上面（decorate 里它优先）
      if (written) await flags.clearPendingTitle(sessionId).catch(() => {});
    }
    manager.updateMeta(sessionId, { title });
    await this.#broadcastUpdated(sessionId);
    return OK;
  }

  /**
   * 把 pendingTitle 补写进转录（input.send 之后、每轮跑完时各试一次）。
   * 转录还没落盘就原样留着等下次；其余失败只 log——这是后台补写，没有请求方可应答。
   */
  async flushPendingTitle(sessionId: string): Promise<void> {
    const { manager, flags, log, now } = this.#deps;
    const title = flags.pendingTitle(sessionId);
    if (title === undefined || flags.isDeleted(sessionId)) return;
    // 转录里已有别处（本机 CLI `/rename`）在 pending 之后写的正式标题 → 以它为准，
    // 丢掉 pending，别把它盖回去（评审 minor 1）。pending 只在「没有转录」时设，
    // 所以转录里出现的任何不同的 customTitle 都晚于它；设置时刻只在内存，重启后按 0
    let info;
    try {
      info = await manager.sessionInfo(sessionId);
    } catch {
      info = undefined;
    }
    const external = info?.customTitle;
    if (
      info !== undefined &&
      external !== undefined &&
      external !== title &&
      info.lastModified >= (flags.pendingTitleSetAt(sessionId) ?? 0)
    ) {
      log(`[mutations] 会话 ${sessionId} 的转录已有更新的标题，放弃未落盘的标题`);
      manager.updateMeta(sessionId, { title: external });
      await flags.clearPendingTitle(sessionId).catch(() => {});
      // 此前的 updated 都带着 pending（decorate 覆盖），web 显示的是它：补发一次
      // 外部标题，别等下一次状态迁移或 list 才纠正（评审 N4）
      await this.#broadcastUpdated(sessionId);
      return;
    }
    try {
      await manager.renameTranscript(sessionId, title);
      flags.noteSelfWrite(sessionId, now());
    } catch (err) {
      if (!isSessionNotFound(err)) {
        log(`[mutations] 补写会话 ${sessionId} 的标题失败：${(err as Error).message}`);
      }
      return;
    }
    // 补写成功：此后以转录为准。updateMeta 让缓存 title 与转录一致，
    // pendingTitle 清掉后 decorate 不再覆盖，显示值不变
    manager.updateMeta(sessionId, { title });
    await flags.clearPendingTitle(sessionId).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // archive
  // -------------------------------------------------------------------------

  async archive(sessionId: string, archived: boolean): Promise<MutationOutcome> {
    const { manager, flags, now } = this.#deps;
    if (archived) {
      if (isBusy(manager.get(sessionId))) {
        return fail('busy', '会话运行中、等待批准或有排队消息，不能归档；请等它跑完或先停止');
      }
      if (flags.archivedAt(sessionId) === undefined) {
        if (!(await this.#known(sessionId))) return fail('not_found', `找不到会话 ${sessionId}`);
        await flags.setArchived(sessionId, now());
      }
    } else if (flags.archivedAt(sessionId) !== undefined) {
      // 标记在就清：即使转录已不在（外部删了），也允许把残留标记清掉
      await flags.clearArchived(sessionId);
    } else if (!(await this.#known(sessionId))) {
      return fail('not_found', `找不到会话 ${sessionId}`);
    }
    // 幂等的重复请求也广播一次：发起端可能正是因为本地状态过期才重发
    await this.#broadcastUpdated(sessionId);
    return OK;
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  /**
   * 永久删除（评审 B4 的 7 步，全程在会话链上串行）：
   * 1. 前置：已归档；不忙；转录 60s 内没被写过
   * 2. 清 resumeAt 定时器与 in-flight resolve
   * 3. 有实例 → 先 release。注意 release **不等子进程退出**（评审 CB1）：SDK 的
   *    close() 同步返回，2s 后才 SIGTERM；CLI 退出时的 re-stamp 可能在第 4 步之后
   *    重建一个只含元数据的 jsonl，由第 8 步兜底
   * 4. SDK deleteSession；找不到且从没发过消息（没有 jsonl）视为成功
   * 5. 清 manager 缓存 meta、state.sessions、CapabilitiesCache
   * 6. flags：清 archived / pendingTitle，写墓碑
   * 7. 广播 session.removed。emitter 的 outSeq **不** dropScope（D10 保守取向）
   * 8. 约 8s 后复查（DELETE_RECHECK_DELAY_MS）：转录又能查到、且 mtime 在删除时刻
   *    附近的窗口里（DELETE_RESTAMP_WINDOW_MS）就再删一次。墓碑挡住
   *    列表只管 8 天，残缺 jsonl 不删掉的话第 9 天会作为幽灵会话回来，本机
   *    `claude --resume` 里更是一直看得见
   *
   * 为什么不改成真等进程退出：要拿到子进程句柄只能接管 SDK 的
   * spawnClaudeCodeProcess，那会替换所有会话的默认 spawn（可执行文件检查、
   * debug-file 等都要自己重做），代价远大于一次延迟复查。
   */
  async delete(sessionId: string): Promise<MutationOutcome> {
    const { manager, state, flags, capabilities, emitter, now, log } = this.#deps;

    // 1. 前置
    if (flags.archivedAt(sessionId) === undefined) {
      return fail('not_archived', '只能永久删除已归档的会话，请先归档');
    }
    if (isBusy(manager.get(sessionId))) {
      return fail('busy', '会话运行中、等待批准或有排队消息，不能删除；请等它跑完或先停止');
    }
    const info = await manager.sessionInfo(sessionId);
    if (info !== undefined && now() - info.lastModified < DELETE_RECENT_WRITE_MS) {
      // 最近那次写是 trine 自己（改名 / 补写标题）就不算「本机在用」（评审 minor 2）。
      // 精确匹配（评审 N2）：mtime 落在 [自写时刻 - 1s, 自写时刻] 才豁免。自写时刻取在
      // 写完**之后**，我们那次写留下的 mtime 只会 ≤ 它（粗粒度文件系统向下取整，
      // 故下沿留 1s）；更晚是别人在我们之后写过，更早则不是我们那次写留下的
      const self = flags.lastSelfWriteAt(sessionId);
      const lag = self === undefined ? undefined : self - info.lastModified;
      if (lag === undefined || lag < 0 || lag > SELF_WRITE_MATCH_MS) {
        return fail('busy', '本机终端可能正在使用该会话（60 秒内有写入），请确认本机终端没开着它，稍后再删');
      }
    }
    const neverStarted = state.sessionParams(sessionId)?.started === false;

    // 2.
    this.#deps.cancelPending(sessionId);

    // 3.
    if (manager.has(sessionId)) await manager.release(sessionId, '会话已被永久删除');

    // 4.
    try {
      await manager.deleteTranscript(sessionId);
    } catch (err) {
      if (!isSessionNotFound(err)) throw err;
      if (!neverStarted) return fail('not_found', `找不到会话 ${sessionId} 的记录`);
    }

    // 5.
    manager.forget(sessionId);
    state.forgetSession(sessionId);
    capabilities.forget(sessionId);

    // 6. 转录已删，墓碑写盘失败也不回滚（内存墓碑本进程照样生效，下次写盘补写）
    await flags.markDeleted(sessionId, now()).catch((err: unknown) => {
      log(`[mutations] 会话 ${sessionId} 的墓碑落盘失败（本进程内仍生效）：${(err as Error).message}`);
    });

    // 7.
    emitter.emit({ type: 'session.removed', targetSessionId: sessionId }, null);

    // 8.
    this.#scheduleRecheck(sessionId);
    return OK;
  }

  /**
   * 复查一个已删除会话的转录：还能查到、且 mtime 落在删除时刻附近的窗口里（子进程
   * 退出时 re-stamp 重建的残缺 jsonl）就再删一次。not-found 视为已干净；其他失败
   * 只 log——后台兜底，没有请求方可应答。启动与每日 sweep 也对全部墓碑跑一遍
   * （覆盖复查定时器没来得及触发 agent 就退出了的情况）。
   *
   * mtime 在窗口外（评审 N1）：删除之后本机终端又用过这个 sid，文件里是用户的
   * 新内容。不删，并立即撤掉墓碑让它作为合法会话回到列表——否则这里会把用户
   * 在本机新写的对话整份删掉。
   */
  async recheckDeleted(sessionId: string): Promise<void> {
    const { manager, flags, log } = this.#deps;
    const deletedAt = flags.deletedAt(sessionId);
    if (deletedAt === undefined) return;
    let info;
    try {
      info = await manager.sessionInfo(sessionId);
    } catch (err) {
      log(`[mutations] 复查已删除会话 ${sessionId} 失败：${(err as Error).message}`);
      return;
    }
    if (info === undefined) return;
    const offset = info.lastModified - deletedAt;
    if (offset < -DELETE_RESTAMP_SLACK_MS || offset > DELETE_RESTAMP_WINDOW_MS) {
      log(
        `[mutations] 已删除会话 ${sessionId} 的转录在删除后 ${Math.round(offset / 1000)}s 被写过` +
          '（不像退出补写，多半是本机终端又用了它），保留转录并撤掉墓碑',
      );
      await flags.clearTombstone(sessionId).catch((err: unknown) => {
        log(`[mutations] 撤掉会话 ${sessionId} 的墓碑落盘失败（本进程内已生效）：${(err as Error).message}`);
      });
      return;
    }
    log(`[mutations] 已删除会话 ${sessionId} 的转录又出现了（多半是子进程退出时补写的元数据），再删一次`);
    try {
      await manager.deleteTranscript(sessionId);
    } catch (err) {
      if (!isSessionNotFound(err)) {
        log(`[mutations] 再删已删除会话 ${sessionId} 的转录失败：${(err as Error).message}`);
      }
    }
  }

  #scheduleRecheck(sessionId: string): void {
    const { setTimer, clearTimer, onChain } = this.#deps;
    const previous = this.#rechecks.get(sessionId);
    if (previous !== undefined) clearTimer(previous);
    const handle = setTimer(() => {
      this.#rechecks.delete(sessionId);
      onChain(sessionId, () => this.recheckDeleted(sessionId));
    }, DELETE_RECHECK_DELAY_MS);
    this.#rechecks.set(sessionId, handle);
  }

  // -------------------------------------------------------------------------

  /** agent 是否知道这个会话：活跃实例 / 缓存 meta / state.json / SDK 转录 */
  async #known(sessionId: string): Promise<boolean> {
    const { manager, state } = this.#deps;
    if (manager.has(sessionId) || manager.metaOf(sessionId) !== undefined) return true;
    if (state.sessionParams(sessionId) !== undefined) return true;
    return (await manager.sessionInfo(sessionId)) !== undefined;
  }

  /**
   * 成功后广播最新 meta。命令本身已经成功，查询失败只 log、不改变应答——
   * 别让「广播没发出去」把一次已生效的改名报成失败。
   */
  async #broadcastUpdated(sessionId: string): Promise<void> {
    let meta;
    try {
      meta = await this.#deps.manager.snapshot(sessionId);
    } catch (err) {
      this.#deps.log(`[mutations] 取会话 ${sessionId} 的最新元数据失败，跳过广播：${(err as Error).message}`);
      return;
    }
    if (meta === undefined) return;
    this.#deps.emitter.emit({ type: 'session.updated', session: meta }, null);
  }
}

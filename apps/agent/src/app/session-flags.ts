/**
 * 会话标记：`~/.trine/sessions.json`（session-list-v2，DECISIONS D12）。
 *
 * `{ v:1, archived: {sid: ts}, deleted: {sid: ts}, pendingTitle: {sid: title} }`
 * 三类标记合在一个 store（评审 S3）：
 *
 * - **archived** —— 归档标记。只在显式取消归档 / 删除时移除；**绝不**按
 *   「本次 listSessions 没列出」清理（评审 M2：SDK 单文件读失败静默跳过、
 *   将来分页，缺席 ≠ 已删）。惰性 GC 只清「标记超过 30 天且 getSessionInfo
 *   查无此会话」的条目，并且只在每日 sweep 里做，不进可分页的 list 路径。
 * - **deleted** —— 永久删除的墓碑。命中墓碑的会话级帧一律不 resolve（防
 *   「删了又复活」，评审 B4）。TTL 见 `TOMBSTONE_TTL_MS`。
 * - **pendingTitle** —— 还没有转录（从未发过消息）的会话的标题：SDK
 *   renameSession 对不存在 / 0 字节的 jsonl 抛错（评审 M8），首条消息落盘后
 *   由 router 补写并清掉。
 *
 * 与 cwd-store 同一范式：文件坏了 warn + 回空、不阻止启动；tmp+rename、0600。
 * 与 cwd-store 不同的是，这份文件存的是用户意图（归档 / 墓碑）：解析失败时先
 * 把原文件改名成 `sessions.json.corrupt-<ts>` 留底，再按空启动——否则下一次
 * 写盘就把它覆盖了，想手工抢救都没有原件（评审 minor 6）。
 *
 * 另有两项**只在内存**的记录（不落盘，重启即清——它们只服务 60 秒量级的
 * 判断，持久化得不偿失）：pendingTitle 的设置时刻、trine 自己最后一次写
 * 转录的时刻。
 *
 * ## 写策略
 *
 * 内存**先改**（decorate 立刻看到新值——manager 的 `#onMeta` 是同步回调，自动
 * 取消归档必须在同一次广播里生效），落盘串行排队、每次写最新全量快照。写失败
 * 置脏、下次改动时重试。显式命令用的 setter 在写盘失败时回滚自己那次内存改动
 * 再 reject，调用方据此回 `io` 应答，内存与应答保持一致。
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { SessionFlags } from '../bridge/manager.ts';

/**
 * 墓碑保留 8 天。依据 apps/server/src/config.ts 的默认值：
 * `parkedTtlMs`（TRINE_PARKED_TTL_MS）= 24h——agent 离线期间 client 发来的帧
 * 最多在服务端 park 这么久，之后才投递给 agent；`relayRetentionMs`
 * （TRINE_RELAY_TTL_MS）= 7d——断线补发（sync.request）能取回的 c2a 帧最老这么久。
 * 一帧「指向已删会话的旧命令」最晚在 park 24h + relay 7d 之内到达，取两者之和。
 * 服务端若把这两个 env 调大，这里要同步调。
 */
export const TOMBSTONE_TTL_MS = 8 * 24 * 60 * 60 * 1000;
/** 归档标记惰性 GC 的年龄门槛（且须 getSessionInfo 查无此会话） */
export const ARCHIVED_GC_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 墓碑 / 归档 GC 的周期 */
export const FLAGS_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const TsMap = z.record(z.string(), z.number().int().nonnegative());

export const SessionFlagsFileSchema = z.object({
  v: z.literal(1),
  archived: TsMap,
  deleted: TsMap,
  pendingTitle: z.record(z.string(), z.string()),
});
export type SessionFlagsFile = z.infer<typeof SessionFlagsFileSchema>;

export class SessionFlagsStore implements SessionFlags {
  readonly #path: string;
  readonly #log: (line: string) => void;
  #data: SessionFlagsFile;
  #dirty = false;
  /** 串行化写盘，避免 tmp 互相覆盖 / 旧快照晚写盖掉新快照 */
  #writing: Promise<void> = Promise.resolve();
  /** pendingTitle 的设置时刻（仅内存；重启后缺失按 0 处理） */
  readonly #pendingSetAt = new Map<string, number>();
  /** trine 自己最后一次写转录（rename / 补写标题）的时刻（仅内存） */
  readonly #selfWriteAt = new Map<string, number>();

  private constructor(path: string, data: SessionFlagsFile, log: (line: string) => void) {
    this.#path = path;
    this.#data = data;
    this.#log = log;
  }

  /**
   * 读盘。不存在 → 空标记；读失败 → 空标记 + warn；解析失败 → 原文件改名为
   * `.corrupt-<ts>` 留底后按空启动 + warn（都不阻止启动）。
   */
  static async load(
    path: string,
    options: { log?: (line: string) => void; now?: () => number } = {},
  ): Promise<SessionFlagsStore> {
    const log = options.log ?? (() => {});
    const now = options.now ?? (() => Date.now());
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log(`[flags] 读取失败，按空标记启动：${(err as Error).message}`);
      }
      return new SessionFlagsStore(path, emptyFlags(), log);
    }
    try {
      return new SessionFlagsStore(path, SessionFlagsFileSchema.parse(JSON.parse(raw)), log);
    } catch (err) {
      const backup = `${path}.corrupt-${now()}`;
      try {
        await rename(path, backup);
        log(`[flags] 文件损坏，原文件已移到 ${backup}，按空标记启动：${(err as Error).message}`);
      } catch (renameErr) {
        log(
          `[flags] 文件损坏，且无法移走留底（${(renameErr as Error).message}），按空标记启动；` +
            `下次写盘会覆盖它：${(err as Error).message}`,
        );
      }
      return new SessionFlagsStore(path, emptyFlags(), log);
    }
  }

  /** 当前内容的副本（测试 / 排查用） */
  snapshot(): SessionFlagsFile {
    return structuredClone(this.#data);
  }

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  archivedAt(sessionId: string): number | undefined {
    return own(this.#data.archived, sessionId);
  }

  pendingTitle(sessionId: string): string | undefined {
    return own(this.#data.pendingTitle, sessionId);
  }

  isDeleted(sessionId: string): boolean {
    return own(this.#data.deleted, sessionId) !== undefined;
  }

  /** 墓碑写下的时刻（删除成功时）；没有墓碑返回 undefined */
  deletedAt(sessionId: string): number | undefined {
    return own(this.#data.deleted, sessionId);
  }

  /** 当前全部墓碑的 sessionId（启动 / 每日 sweep 复查残缺转录用） */
  deletedIds(): string[] {
    return Object.keys(this.#data.deleted);
  }

  /** pendingTitle 是何时设的（仅内存；未知返回 undefined） */
  pendingTitleSetAt(sessionId: string): number | undefined {
    return this.#pendingSetAt.get(sessionId);
  }

  /** trine 自己最后一次写该会话转录的时刻（删除的 60s 检查据此排除自己的写） */
  lastSelfWriteAt(sessionId: string): number | undefined {
    return this.#selfWriteAt.get(sessionId);
  }

  /** 记一次 trine 自己对转录的写入（仅内存） */
  noteSelfWrite(sessionId: string, at: number): void {
    this.#selfWriteAt.set(sessionId, at);
  }

  // -------------------------------------------------------------------------
  // 写（内存先改，返回落盘结果）
  // -------------------------------------------------------------------------

  /** 已归档时保留原 archivedAt（重复归档幂等）。写盘失败回滚本次改动并 reject */
  setArchived(sessionId: string, at: number): Promise<void> {
    if (own(this.#data.archived, sessionId) !== undefined) return this.#settled();
    put(this.#data.archived, sessionId, at);
    return this.#persistOrRevert(() => {
      if (own(this.#data.archived, sessionId) === at) delete this.#data.archived[sessionId];
    });
  }

  /** 写盘失败回滚本次改动并 reject */
  clearArchived(sessionId: string): Promise<void> {
    const previous = own(this.#data.archived, sessionId);
    if (previous === undefined) return this.#settled();
    delete this.#data.archived[sessionId];
    return this.#persistOrRevert(() => {
      if (own(this.#data.archived, sessionId) === undefined) put(this.#data.archived, sessionId, previous);
    });
  }

  unarchiveNow(sessionId: string): void {
    if (own(this.#data.archived, sessionId) === undefined) return;
    delete this.#data.archived[sessionId];
    this.#persist().catch(() => {
      // #persist 已 log 并置脏，这里只是不让 rejection 漏成 unhandled
    });
  }

  /** 写盘失败回滚本次改动并 reject。`at` 是设置时刻（仅记内存，见 pendingTitleSetAt） */
  setPendingTitle(sessionId: string, title: string, at?: number): Promise<void> {
    const previous = own(this.#data.pendingTitle, sessionId);
    if (at !== undefined) this.#pendingSetAt.set(sessionId, at);
    if (previous === title) return this.#settled();
    put(this.#data.pendingTitle, sessionId, title);
    return this.#persistOrRevert(() => {
      if (own(this.#data.pendingTitle, sessionId) !== title) return;
      if (previous === undefined) delete this.#data.pendingTitle[sessionId];
      else put(this.#data.pendingTitle, sessionId, previous);
    });
  }

  /** 补写成功后清掉；写盘失败不回滚（转录里已经有标题了，留着只会多补写一次） */
  clearPendingTitle(sessionId: string): Promise<void> {
    this.#pendingSetAt.delete(sessionId);
    if (own(this.#data.pendingTitle, sessionId) === undefined) return this.#settled();
    delete this.#data.pendingTitle[sessionId];
    return this.#persist();
  }

  /**
   * 删除收尾：清 archived / pendingTitle，写墓碑——一次写盘。
   * 此时转录已经删掉了，写盘失败也不回滚（内存墓碑本进程内照样生效，
   * 置脏后下次写盘重试），调用方只 log。
   */
  markDeleted(sessionId: string, at: number): Promise<void> {
    delete this.#data.archived[sessionId];
    delete this.#data.pendingTitle[sessionId];
    this.#pendingSetAt.delete(sessionId);
    this.#selfWriteAt.delete(sessionId);
    put(this.#data.deleted, sessionId, at);
    return this.#persist();
  }

  /**
   * 提前撤掉一条墓碑：复查发现删除之后本机又正经用过这个 sid（转录 mtime 远晚于
   * 删除时刻，评审 N1）——它现在是合法会话，得重新出现在列表里、帧也要能 resolve。
   * 写盘失败不回滚（内存已生效，置脏后下次写盘补写），调用方只 log。
   */
  clearTombstone(sessionId: string): Promise<void> {
    if (own(this.#data.deleted, sessionId) === undefined) return this.#settled();
    delete this.#data.deleted[sessionId];
    return this.#persist();
  }

  /**
   * 清过期墓碑（启动与每日 sweep）。归档标记的惰性 GC 另见 `gcArchived`。
   * @returns 清掉的墓碑数
   */
  async sweepTombstones(now: number): Promise<number> {
    let removed = 0;
    for (const [sid, at] of Object.entries(this.#data.deleted)) {
      if (now - at >= TOMBSTONE_TTL_MS) {
        delete this.#data.deleted[sid];
        removed++;
      }
    }
    if (removed > 0) await this.#persist();
    return removed;
  }

  /**
   * 归档标记惰性 GC：标记超过 30 天、且 `exists(sid)` 明确回答「不存在」才清
   * （查询抛错按存在处理——宁留勿误清，M2 的取向）。
   * @returns 清掉的条目数
   */
  async gcArchived(now: number, exists: (sessionId: string) => Promise<boolean>): Promise<number> {
    let removed = 0;
    for (const [sid, at] of Object.entries(this.#data.archived)) {
      if (now - at < ARCHIVED_GC_AGE_MS) continue;
      let alive = true;
      try {
        alive = await exists(sid);
      } catch {
        alive = true;
      }
      // await 期间可能已被显式取消归档 / 重新归档：只清仍是同一条标记的
      if (!alive && this.#data.archived[sid] === at) {
        delete this.#data.archived[sid];
        removed++;
      }
    }
    if (removed > 0) await this.#persist();
    return removed;
  }

  /** 有未落盘改动时立即写（退出路径）；失败只 log */
  async flush(): Promise<void> {
    if (this.#dirty) await this.#persist().catch(() => {});
    else await this.#writing.catch(() => {});
  }

  // -------------------------------------------------------------------------

  /** 无改动的写操作：等前面排着的写盘结束（其失败不算本次的） */
  #settled(): Promise<void> {
    return this.#writing.catch(() => {});
  }

  /** 落盘；失败则执行 revert 把内存恢复成调用前、再 reject（显式命令据此回 io） */
  async #persistOrRevert(revert: () => void): Promise<void> {
    try {
      await this.#persist();
    } catch (err) {
      revert();
      throw err;
    }
  }

  #persist(): Promise<void> {
    this.#dirty = true;
    const next = this.#writing
      .catch(() => {})
      .then(async () => {
        // 排到自己时再序列化：拿的是此刻最新的全量内容，前面失败的改动也一并补写
        if (!this.#dirty) return;
        this.#dirty = false;
        try {
          await writeAtomic(this.#path, JSON.stringify(this.#data, null, 2));
        } catch (err) {
          this.#dirty = true;
          this.#log(`[flags] 落盘失败：${(err as Error).message}`);
          throw err;
        }
      });
    this.#writing = next;
    return next;
  }
}

function emptyFlags(): SessionFlagsFile {
  return { v: 1, archived: {}, deleted: {}, pendingTitle: {} };
}

/** 只认自有属性（sessionId 来自远端，别让 `__proto__` 之类撞到原型链） */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** 按自有数据属性写入：`record['__proto__'] = x` 会改原型而不是加键 */
function put<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

/** tmp + rename + 0600，与 cwd-store / state 同一套手法 */
async function writeAtomic(path: string, payload: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, payload, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

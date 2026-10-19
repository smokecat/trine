/**
 * agent 本地状态持久化：`~/.trine/state.json`。
 *
 * 存三样东西（方案 §4b）：
 * - `outSeq`  ——出站 seq 每 scope 的最后已用值（EventEmitter 是内存态，重启即归 1，
 *   服务端会以 seq_not_monotonic 拒收整条流的后续帧）；
 * - `inCursors`——入站游标（AgentNode.cursors 快照；重启后据此逐流 sync.request，
 *   并让重放防护不清零）；
 * - `sessions` ——每个会话的 {cwd, model, permissionMode}（重启后远端再发消息时
 *   能 resume，不必先 listSessions 慢查）。
 *
 * ## 这是快路径，不是正确性依赖
 *
 * 文件丢了 / 坏了 / machineId 对不上 → 一律当作空状态 + warn，**不阻止启动**：
 * - outSeq 起点错了会被服务端 relay.reject{expectedAfter} 纠正（outbox.ts 自愈）；
 * - inCursors 空了只是多补发一轮、重放防护回到进程起点（回退方向只多丢重放帧）；
 * - sessions 空了退化为 metaOf / listSessions 兜底。
 * 因此恢复时 outSeq 还会额外 +RESTART_GAP：只为省掉大概率会发生的那一次
 * reject 往返（进程崩溃时 debounce 里那 ≤300ms 的几帧没落盘），起点偏高在协议上
 * 只是子流跳号，无害。
 *
 * ## 写策略
 *
 * debounce ≤300ms 合并写（assistant.delta 期间每帧都动 outSeq，逐帧落盘会把
 * 磁盘打成瓶颈）；`flush()` 立即写（退出路径）；不 fsync。tmp+rename、0600——
 * 里面有 cwd 绝对路径，泄露面在 0600 下可接受（方案明写）。
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { PermissionModeSchema } from '@trine/core';
import type { SeqScope } from '../bridge/types.ts';

/** 恢复出站 seq 时额外跳过的余量（见文件头「快路径」） */
export const RESTART_GAP = 100;
/** 合并写的窗口 */
export const STATE_WRITE_DEBOUNCE_MS = 300;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export const SessionParamsSchema = z.object({
  cwd: z.string().min(1),
  model: z.string().min(1),
  permissionMode: PermissionModeSchema,
  /**
   * 是否已经发过消息（SDK 侧因此有转录可 resume）。省略视为 true——历史会话
   * 都是从 listSessions 查来的、必然有转录；只有本进程 session.create 出来、
   * 还没发过第一条消息的会话是 false。对没有转录的会话 resume 会让 SDK 找不到
   * 会话，所以 resume 与否要看它。
   */
  started: z.boolean().optional(),
});
export type SessionParams = z.infer<typeof SessionParamsSchema>;
export type RewindPoint = z.infer<typeof RewindPointSchema>;

const SeqMapSchema = z.record(z.string(), z.number().int().nonnegative());

/**
 * 待生效的对话截断点（回退对话后、下一条消息之前；见 bridge/session.ts「回退」）。
 * 必须落盘：CLI 只在新分支写出消息后才记住截断，agent 重启 / 空闲回收后若不带上，
 * 下次 resume 会回到回退前的长链。
 */
export const RewindPointSchema = z.object({
  resumeAt: z.string().min(1),
  dropFrom: z.string().min(1),
});

export const AgentStateFileSchema = z.object({
  v: z.literal(1),
  /** 与 identity.machineId 绑定：换了身份的旧状态文件不能沿用 */
  machineId: z.string().min(1),
  /** scope key（会话 sessionId；机器级空串）→ 最后已用 seq */
  outSeq: SeqMapSchema,
  /** SeqCursors.snapshot() 原样：key 含 NUL 分隔符 */
  inCursors: SeqMapSchema,
  sessions: z.record(z.string(), SessionParamsSchema),
  /** sessionId → 待生效的截断点（加法字段，省略 = 没有） */
  rewinds: z.record(z.string(), RewindPointSchema).optional(),
});
export type AgentStateFile = z.infer<typeof AgentStateFileSchema>;

/** 机器级 scope 在 outSeq 里的键（与 emitter.ts 的 MACHINE_SCOPE_KEY 一致） */
const MACHINE_SCOPE_KEY = '';

export interface AgentStateOptions {
  path: string;
  machineId: string;
  log?: (line: string) => void;
  debounceMs?: number;
}

export class AgentState {
  readonly #path: string;
  readonly #log: (line: string) => void;
  readonly #debounceMs: number;
  #data: AgentStateFile;
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | undefined = undefined;
  /** 串行化写盘：上一次还没写完就不开始下一次，避免 tmp 文件互相覆盖 */
  #writing: Promise<void> = Promise.resolve();

  private constructor(options: AgentStateOptions, data: AgentStateFile) {
    this.#path = options.path;
    this.#log = options.log ?? (() => {});
    this.#debounceMs = options.debounceMs ?? STATE_WRITE_DEBOUNCE_MS;
    this.#data = data;
  }

  /**
   * 读盘装载。不存在 / 损坏 / machineId 不符 → 空状态 + warn（见文件头）。
   * 损坏的文件不删：下一次 flush 会用好的内容覆盖它，中间留着供人查看。
   */
  static async load(options: AgentStateOptions): Promise<AgentState> {
    const log = options.log ?? (() => {});
    const empty = emptyState(options.machineId);
    let raw: string;
    try {
      raw = await readFile(options.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log(`[state] 读取失败，按空状态启动：${(err as Error).message}`);
      }
      return new AgentState(options, empty);
    }
    let parsed: AgentStateFile;
    try {
      parsed = AgentStateFileSchema.parse(JSON.parse(raw));
    } catch (err) {
      log(
        `[state] 状态文件损坏，按空状态启动（出站 seq 将由服务端 reject 纠正）：${
          (err as Error).message
        }`,
      );
      return new AgentState(options, empty);
    }
    if (parsed.machineId !== options.machineId) {
      log(
        `[state] 状态文件属于另一台机器（${parsed.machineId} ≠ ${options.machineId}），忽略`,
      );
      return new AgentState(options, empty);
    }
    return new AgentState(options, parsed);
  }

  /** 是否有尚未落盘的改动（测试用） */
  get dirty(): boolean {
    return this.#dirty;
  }

  // -------------------------------------------------------------------------
  // 出站 seq
  // -------------------------------------------------------------------------

  /**
   * 给 `EventEmitter.restore()` 用的起点：每 scope = 最后已用 + 1 + RESTART_GAP。
   * emitter 的快照语义是「下一个待分配」，这里算好再交出去，调用方不必自己加减。
   */
  outSeqForRestore(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, last] of Object.entries(this.#data.outSeq)) {
      out[key] = last + 1 + RESTART_GAP;
    }
    return out;
  }

  /** 记一帧已用的出站 seq（只进不退） */
  noteOutSeq(scope: SeqScope, seq: number): void {
    const key = scope ?? MACHINE_SCOPE_KEY;
    const last = this.#data.outSeq[key];
    if (last !== undefined && seq <= last) return;
    this.#data.outSeq[key] = seq;
    this.#markDirty();
  }

  // -------------------------------------------------------------------------
  // 入站游标
  // -------------------------------------------------------------------------

  /** 给 `SeqCursors.restore()` 用（原样） */
  inCursorsForRestore(): Record<string, number> {
    return { ...this.#data.inCursors };
  }

  /** 整份替换入站游标快照（AgentNode.cursors.snapshot() 的产物） */
  setInCursors(snapshot: Record<string, number>): void {
    this.#data.inCursors = { ...snapshot };
    this.#markDirty();
  }

  // -------------------------------------------------------------------------
  // 会话参数
  // -------------------------------------------------------------------------

  get sessions(): Readonly<Record<string, SessionParams>> {
    return this.#data.sessions;
  }

  sessionParams(sessionId: string): SessionParams | undefined {
    return this.#data.sessions[sessionId];
  }

  rememberSession(sessionId: string, params: SessionParams): void {
    const previous = this.#data.sessions[sessionId];
    if (
      previous !== undefined &&
      previous.cwd === params.cwd &&
      previous.model === params.model &&
      previous.permissionMode === params.permissionMode &&
      previous.started === params.started
    ) {
      return;
    }
    this.#data.sessions[sessionId] = { ...params };
    this.#markDirty();
  }

  /** 部分更新（setModel / setPermissionMode / setCwd 之后） */
  updateSession(sessionId: string, patch: Partial<SessionParams>): void {
    const current = this.#data.sessions[sessionId];
    if (current === undefined) return;
    this.rememberSession(sessionId, { ...current, ...patch });
  }

  /**
   * 永久删除会话时移除它的参数（session.delete 级联清理，评审 B4）。
   * 不动 outSeq / inCursors：seq 计数保守保留（与 emitter 不 dropScope 同取向，
   * D10），墓碑会挡住后续指向它的帧。
   */
  forgetSession(sessionId: string): void {
    this.setPendingRewind(sessionId, undefined);
    if (!Object.hasOwn(this.#data.sessions, sessionId)) return;
    delete this.#data.sessions[sessionId];
    this.#markDirty();
  }

  // -------------------------------------------------------------------------
  // 待生效的对话截断点
  // -------------------------------------------------------------------------

  pendingRewind(sessionId: string): RewindPoint | undefined {
    const rewinds = this.#data.rewinds;
    return rewinds !== undefined && Object.hasOwn(rewinds, sessionId) ? rewinds[sessionId] : undefined;
  }

  /** 记下 / 清掉（undefined）截断点 */
  setPendingRewind(sessionId: string, point: RewindPoint | undefined): void {
    const current = this.pendingRewind(sessionId);
    if (point === undefined) {
      if (current === undefined) return;
      const { [sessionId]: _gone, ...rest } = this.#data.rewinds ?? {};
      if (Object.keys(rest).length === 0) delete this.#data.rewinds;
      else this.#data.rewinds = rest;
    } else {
      if (current?.resumeAt === point.resumeAt && current.dropFrom === point.dropFrom) return;
      this.#data.rewinds = { ...this.#data.rewinds, [sessionId]: { ...point } };
    }
    this.#markDirty();
  }

  // -------------------------------------------------------------------------
  // 落盘
  // -------------------------------------------------------------------------

  /** 立即落盘（退出路径）；没有改动时不写 */
  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#dirty) this.#enqueueWrite();
    await this.#writing;
  }

  #markDirty(): void {
    this.#dirty = true;
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#enqueueWrite();
    }, this.#debounceMs);
    // 不拖住进程退出：退出路径会显式 flush()
    (this.#timer as { unref?: () => void }).unref?.();
  }

  #enqueueWrite(): void {
    // 先复位 dirty 再序列化：写盘期间新来的改动会重新置脏、触发下一轮
    this.#dirty = false;
    const payload = JSON.stringify(this.#data, null, 2);
    this.#writing = this.#writing
      .then(() => writeAtomic(this.#path, payload))
      .catch((err: unknown) => {
        // 写失败不致命（快路径），但要留痕；标回 dirty 让下一次改动再试
        this.#log(`[state] 落盘失败：${(err as Error).message}`);
        this.#dirty = true;
      });
  }
}

function emptyState(machineId: string): AgentStateFile {
  return { v: 1, machineId, outSeq: {}, inCursors: {}, sessions: {} };
}

/** tmp + rename + 0600，与 identity.ts 同一套手法 */
async function writeAtomic(path: string, payload: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, payload, { mode: FILE_MODE });
  await chmod(tmp, FILE_MODE);
  await rename(tmp, path);
}

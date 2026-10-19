/**
 * 本地状态的版本化读写（方案 §4.1）。
 *
 * 三块数据、两种介质：
 * - Kv（localStorage）：identity / peer / prefs——小、同步、启动即需；
 * - DocStore（IndexedDB）：timeline（每会话一份）与 machine 快照（每机器一份），
 *   两者都可到几百 KB。
 *
 * ## 为什么机器快照必须落盘（而不是刷新后重新同步拿）
 *
 * `machine.info` 与 `SessionMeta` 是**快照型**事件：agent 只在接入时（`#onOpen`）
 * 与配对确认时各广播一次。机器级游标一旦越过那一帧，重连时的 `sync.request`
 * 就只会拿到「你已是最新」——服务端不会、也不该重放已确认的历史。于是刷新后
 * `info` 恒为 null（机器卡「agent 未知 · claude 未知」）、会话列表 0 行，
 * 要等 agent 下次重连才恢复（真链路上表现为「重启 agent 才正常」）。
 *
 * 放 DocStore 不放 PeerState：339 个会话的 SessionMeta 是百 KB 级，
 * localStorage 的 5MB 配额经不起，且 PeerState 每次游标推进都要整体重写。
 *
 * 所有读取都过 zod：坏掉的数据当成不存在（identity 例外，见 loadIdentity），
 * 而不是让一处解析错拖垮整个页面。
 *
 * ## outSeq / inCursors 落盘规则：读现值取 max 再写（评审 A1）
 *
 * 即便有单主标签（leader.ts），主标签切换的瞬间仍可能出现「旧主最后一笔
 * 落盘晚于新主的首笔」——last-writer-wins 会让 seq 计数器或游标倒退，
 * 前者撞 seq_not_monotonic、后者把补发帧当重放丢。`persistPeer` 因此永远
 * 先读存储里的现值，对每个 scope 取 max 再写，并把合并结果返回给调用方
 * 采纳到内存态。
 */
// 从 `@trine/core/types` 取而不是根 `@trine/core`：根 index 会 re-export
// `./crypto`，而那条线静态引入 libsodium（730KB 的 asm.js/wasm 单文件）。
// storage.ts 在首屏的依赖图里（store/index.ts → 这里），从根引就等于把
// libsodium 钉进 entry 的必下集合。types 子路径只有 zod schema。
import {
  MachineInfoSchema,
  PermissionModeSchema,
  SessionMetaSchema,
  type MachineInfo,
  type PermissionMode,
  type SessionMeta,
} from '@trine/core/types';
import { z } from 'zod';
import type { DocStore, KvAdapter } from './adapters.ts';
import type { HistoryState, Timeline, TimelineEntry, ToolEntry } from './reducer.ts';
import { dropPending, isSubagentTool, type PendingChildren } from './tool-tree.ts';
import { BgTasksSchema, HistoryStateSchema, isHistoryEntry, PendingChildrenSchema, TimelineEntrySchema } from './reducer.ts';

export const KV_IDENTITY = 'trine.identity';
export const KV_PEER = 'trine.peer';
export const KV_PREFS = 'trine.prefs';
const TIMELINE_PREFIX = 'timeline:';
const MACHINE_PREFIX = 'machine:';

/** 每会话时间线条目上限（方案 R3） */
export const TIMELINE_MAX_ENTRIES = 500;
/** 记住的「已被裁掉的 Agent/Task 条目 id」上限（只留最近的） */
export const MAX_TRIMMED_TOOL_IDS = 200;

/**
 * 每机器落盘的 SessionMeta 上限。
 *
 * `peer.sessions` 是只增的（评审 C6 / 方案 O4），真机上已见过 339 个会话；
 * 不设上限的话这份文档会随使用无限长大。按 lastActivityAt 降序保留——
 * 列表页本就按活跃度排序，被裁掉的是滚动到最底下、且下次 `session.list.response`
 * 会重新带回来的那些。
 */
export const MACHINE_MAX_SESSIONS = 500;

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

const KeyPairSchema = z.object({ publicKey: z.string().min(1), secretKey: z.string().min(1) });

export const IdentitySchema = z.object({
  v: z.literal(1),
  /** `web-<uuid>`，只生成一次 */
  deviceId: z.string().min(1),
  sign: KeyPairSchema,
  box: KeyPairSchema,
});
export type Identity = z.infer<typeof IdentitySchema>;

const SeqMapSchema = z.record(z.string(), z.number().int().nonnegative());

export const MachinePeerSchema = z.object({
  agentBoxPubKey: z.string().min(1),
  /** 本地改的展示名（machine.rename 前的乐观值 / 旧 QR 无 machine.info 时的兜底） */
  name: z.string().optional(),
  pairedAt: z.number().int().nonnegative(),
  /** scope key（sessionId；机器级 ''）→ 最后已用 c2a seq */
  outSeq: SeqMapSchema,
  /** scope key → 已应用的最大 a2c seq */
  inCursors: SeqMapSchema,
  /**
   * 已知会话 → 最近活跃时刻。重连时只对「本地有时间线或 30 天内活跃」的
   * 会话发 sync.request（评审 C6：sessions 只增，不能每次全量同步）。
   */
  sessions: z.record(z.string(), z.object({ lastActivityAt: z.number().int().nonnegative() })),
  /**
   * 已永久删除的会话 → 本设备得知删除的时刻（session-list-v2 评审 CM1）。
   * 命中的会话级帧直接丢弃、不同步、不能再打开——否则 sync 回放 / 迟到帧 /
   * 深链会把刚清掉的时间线与 peer.sessions 重新建出来。TTL 与 agent 墓碑一致
   * （8 天，见 client.ts `REMOVED_SESSION_TTL_MS`），加载时清过期。可选：老数据没有。
   */
  removedSessions: z.record(z.string(), z.number().int().nonnegative()).optional(),
});
export type MachinePeer = z.infer<typeof MachinePeerSchema>;

export const PeerStateSchema = z.object({
  v: z.literal(1),
  /** MVP 单服务端：所有机器共用（第二个 QR 的 serverUrl 不同即拒绝） */
  serverUrl: z.string().min(1),
  authToken: z.object({ token: z.string().min(1), expiresAt: z.number() }).optional(),
  machines: z.record(z.string(), MachinePeerSchema),
});
export type PeerState = z.infer<typeof PeerStateSchema>;

/** 新建会话的默认模型 / 权限模式（用户可在设置页改，存 prefs） */
export const DEFAULT_SESSION_MODEL = 'opus[1m]';
export const DEFAULT_SESSION_PERMISSION_MODE: PermissionMode = 'bypassPermissions';

export const PrefsSchema = z.object({
  v: z.literal(1),
  theme: z.enum(['system', 'light', 'dark']),
  promptSnippets: z.array(z.string()),
  /** 模型选择器候选（方案 O2：初值 ∪ agent capabilities 上报） */
  knownModels: z.array(z.string()),
  /**
   * 默认模型清单的补种版本。DEFAULT_KNOWN_MODELS 新增条目时把
   * KNOWN_MODELS_SEED +1，loadPrefs 只对低于该版本的 prefs 追加一次缺失项——
   * 之后用户在设置页删掉的默认模型不会被反复复活。老 prefs 无此字段视为 0。
   */
  knownModelsSeed: z.number().int().nonnegative().default(0),
  /**
   * 会话列表分组方式（session-list-v2 §4.1，评审 M7）。用 `.catch` 而不是
   * `.default`：缺字段（老 prefs）与将来新增枚举值后回滚版本都落到默认值，
   * 而不是让整份 prefs 解析失败被重置。标量缺失即默认，不需要 seed 版本号。
   */
  listGroupBy: z.enum(['none', 'workspace']).catch('workspace'),
  /** 会话列表是否显示临时会话（临时目录 / 非交互，见 list/filtering.ts isTempSession）。`.catch` 同 listGroupBy */
  listShowTemp: z.boolean().catch(false),
  /** 新建会话预选的模型（设置页可改）。`.catch` 同 listGroupBy：缺字段 / 坏值落默认 */
  defaultModel: z.string().min(1).catch(DEFAULT_SESSION_MODEL),
  /** 新建会话预选的权限模式（设置页可改，选 bypass 同样要两击确认） */
  defaultPermissionMode: PermissionModeSchema.catch(DEFAULT_SESSION_PERMISSION_MODE),
  /**
   * PC 上的发送键（见 components/composer/composer-keys.ts）：`enter` = Enter 发送、
   * Shift+Enter 换行；`mod-enter` = Cmd/Ctrl+Enter 发送、Enter 换行。触屏设备不看它，
   * 回车永远换行。`.catch` 同 listGroupBy
   */
  sendKey: z.enum(['enter', 'mod-enter']).catch('enter'),
});
export type Prefs = z.infer<typeof PrefsSchema>;

/**
 * 预置模型只放家族别名，由 Claude Code 解析到该家族最新版本（`[1m]` 后缀 =
 * 1M 上下文；haiku 没有 1M 形式，CLI 会拒收 `haiku[1m]`）。不放具体 ID：那样
 * 每次模型升级都得改这里并补种。
 */
export const DEFAULT_KNOWN_MODELS = ['fable', 'fable[1m]', 'opus', 'opus[1m]', 'sonnet', 'sonnet[1m]', 'haiku'];
/**
 * 与 DEFAULT_KNOWN_MODELS 同步递增：v1 首发四款；v2 加 claude-opus-5-5（2026-09-25）；
 * v3 换成别名，并移除 v1/v2 预置的具体 ID（2026-10-18）。
 */
export const KNOWN_MODELS_SEED = 3;
/** v3 之前预置过的具体 ID：补种 v3 时从老 prefs 里移除（用户自己加的不动） */
const LEGACY_KNOWN_MODELS = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
];

export function defaultPrefs(): Prefs {
  return {
    v: 1,
    theme: 'system',
    promptSnippets: [],
    knownModels: [...DEFAULT_KNOWN_MODELS],
    knownModelsSeed: KNOWN_MODELS_SEED,
    listGroupBy: 'workspace',
    listShowTemp: false,
    defaultModel: DEFAULT_SESSION_MODEL,
    defaultPermissionMode: DEFAULT_SESSION_PERMISSION_MODE,
    sendKey: 'enter',
  };
}

/** 把新增的默认模型补进已存的 prefs（只做一次，见 knownModelsSeed 注释） */
export function seedKnownModels(prefs: Prefs): Prefs {
  if (prefs.knownModelsSeed >= KNOWN_MODELS_SEED) return prefs;
  // v3：旧预置的具体 ID（含 agent 上报并入的 `[1m]` 变体）由别名取代
  const kept =
    prefs.knownModelsSeed < 3
      ? prefs.knownModels.filter((m) => !LEGACY_KNOWN_MODELS.includes(m.replace(/\[[^\]]*\]$/, '')))
      : prefs.knownModels;
  const known = new Set(kept);
  const added = DEFAULT_KNOWN_MODELS.filter((m) => !known.has(m));
  return { ...prefs, knownModels: [...added, ...kept], knownModelsSeed: KNOWN_MODELS_SEED };
}

const TimelineDocSchema = z.object({
  v: z.literal(1),
  lastAppliedSeq: z.number().int().nonnegative(),
  entries: z.array(TimelineEntrySchema),
  /** 历史回看翻页状态——**加法字段**，旧文档没有它即「尚未拉过历史」 */
  history: HistoryStateSchema.optional(),
  /** 后台任务快照——**加法字段**（background-tasks） */
  bgTasks: BgTasksSchema.optional(),
  /** 等父条目的子 agent 工具条目——**加法字段**（subagent-view）；工具条目的 children 随 entries 走 */
  pendingChildren: PendingChildrenSchema.optional(),
  /** 被裁掉的 Agent/Task 条目 id——**加法字段**（评审 m2），它们的迟到子帧直接丢 */
  trimmedToolIds: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Kv
// ---------------------------------------------------------------------------

function readJson<T>(kv: KvAdapter, key: string, schema: z.ZodType<T>): T | null | 'corrupt' {
  const raw = kv.get(key);
  if (raw === null) return null;
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    return 'corrupt';
  }
}

/**
 * identity 坏了**不能**静默重建：那会换掉 deviceId 与密钥，等于所有配对失效。
 * 抛出让 UI 明确告知用户（重置本地状态可清）。
 */
export function loadIdentity(kv: KvAdapter): Identity | null {
  const result = readJson(kv, KV_IDENTITY, IdentitySchema);
  if (result === 'corrupt') {
    throw new Error(`本地身份（${KV_IDENTITY}）已损坏，无法解析；需清除站点数据后重新配对`);
  }
  return result;
}

export function saveIdentity(kv: KvAdapter, identity: Identity): void {
  kv.set(KV_IDENTITY, JSON.stringify(identity));
}

export function loadPeer(kv: KvAdapter): PeerState | null {
  const result = readJson(kv, KV_PEER, PeerStateSchema);
  return result === 'corrupt' ? null : result;
}

/** 对两个 scope→seq 表按键取 max */
export function mergeSeqMaps(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = Math.max(out[k] ?? 0, v);
  }
  return out;
}

/**
 * 落盘 peer：outSeq / inCursors 与存储现值逐 scope 取 max，其余字段以传入为准。
 * 返回合并后的对象，调用方应把它采纳为新的内存态。
 */
export function persistPeer(kv: KvAdapter, peer: PeerState): PeerState {
  const stored = loadPeer(kv);
  let merged = peer;
  if (stored !== null && stored.serverUrl === peer.serverUrl) {
    const machines: PeerState['machines'] = {};
    for (const [machineId, mine] of Object.entries(peer.machines)) {
      const theirs = stored.machines[machineId];
      machines[machineId] =
        theirs === undefined
          ? mine
          : {
              ...mine,
              outSeq: mergeSeqMaps(mine.outSeq, theirs.outSeq),
              inCursors: mergeSeqMaps(mine.inCursors, theirs.inCursors),
            };
    }
    merged = { ...peer, machines };
  }
  kv.set(KV_PEER, JSON.stringify(merged));
  return merged;
}

export function clearPeer(kv: KvAdapter): void {
  kv.remove(KV_PEER);
}

export function loadPrefs(kv: KvAdapter): Prefs {
  const result = readJson(kv, KV_PREFS, PrefsSchema);
  if (result === null || result === 'corrupt') return defaultPrefs();
  const seeded = seedKnownModels(result);
  if (seeded !== result) savePrefs(kv, seeded);
  return seeded;
}

export function savePrefs(kv: KvAdapter, prefs: Prefs): void {
  kv.set(KV_PREFS, JSON.stringify(prefs));
}

// ---------------------------------------------------------------------------
// DocStore：timeline
// ---------------------------------------------------------------------------

export function timelineKey(machineId: string, sessionId: string): string {
  return `${machineId}/${sessionId}`;
}

export function parseTimelineKey(key: string): { machineId: string; sessionId: string } | null {
  const slash = key.indexOf('/');
  if (slash <= 0) return null;
  return { machineId: key.slice(0, slash), sessionId: key.slice(slash + 1) };
}

export async function loadTimeline(docs: DocStore, key: string): Promise<Timeline | null> {
  const raw = await docs.get(`${TIMELINE_PREFIX}${key}`);
  if (raw === undefined) return null;
  const parsed = TimelineDocSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { lastAppliedSeq, entries, history, bgTasks, pendingChildren, trimmedToolIds } = parsed.data;
  return {
    lastAppliedSeq,
    entries,
    heartbeat: null,
    state: null,
    ...(history === undefined ? {} : { history }),
    ...(bgTasks === undefined ? {} : { bgTasks }),
    ...(pendingChildren === undefined ? {} : { pendingChildren }),
    ...(trimmedToolIds === undefined ? {} : { trimmedToolIds }),
  };
}

/**
 * 裁到上限（保留最新的 TIMELINE_MAX_ENTRIES 条）。
 *
 * 裁掉的若含历史条目，翻页游标得跟着回退：游标原本指向「已拉到的最旧处」，
 * 那一截被裁后若不回退，下次「加载更早」会越过被裁的部分留下空洞。回退到
 * 剩下的最旧一条历史条目（它的 id 就是 agent 认的游标）；一条都不剩就清掉游标、
 * 从最新一页重拉（mergeHistory 的去重 + cutoff 会滤掉已有的）。
 */
export function trimTimelineForSave(timeline: Timeline): {
  entries: TimelineEntry[];
  history?: HistoryState;
  pendingChildren?: PendingChildren;
  trimmedToolIds?: string[];
} {
  const over = timeline.entries.length - TIMELINE_MAX_ENTRIES;
  const keepPending = timeline.pendingChildren === undefined ? {} : { pendingChildren: timeline.pendingChildren };
  const keepTrimmed = timeline.trimmedToolIds === undefined ? {} : { trimmedToolIds: timeline.trimmedToolIds };
  if (over <= 0) {
    return { entries: timeline.entries, ...(timeline.history === undefined ? {} : { history: timeline.history }), ...keepPending, ...keepTrimmed };
  }
  const entries = timeline.entries.slice(over);
  // 裁掉的 Agent/Task 条目（含子树里的）记下来：之后再来的子帧不该进暂存区永远等它
  // （评审 m2）；已在暂存区等它们的组一并丢掉
  const cut = trimmedParentIds(timeline.entries.slice(0, over));
  const trimmedToolIds = [...(timeline.trimmedToolIds ?? []).filter((id) => !cut.includes(id)), ...cut].slice(-MAX_TRIMMED_TOOL_IDS);
  let pendingChildren = timeline.pendingChildren;
  for (const id of cut) pendingChildren = dropPending(pendingChildren, id);
  const extra = {
    ...(pendingChildren === undefined ? {} : { pendingChildren }),
    ...(trimmedToolIds.length === 0 ? {} : { trimmedToolIds }),
  };
  if (timeline.history === undefined) return { entries, ...extra };
  const trimmedHistory = timeline.entries.slice(0, over).some(isHistoryEntry);
  if (!trimmedHistory) return { entries, history: timeline.history, ...extra };
  const oldest = entries.find(isHistoryEntry);
  return { entries, history: { hasMore: true, ...(oldest === undefined ? {} : { cursor: oldest.id }) }, ...extra };
}

/** 被裁掉的时间线条目里所有 Agent/Task 工具的 id（含子树） */
function trimmedParentIds(cut: readonly TimelineEntry[]): string[] {
  const out: string[] = [];
  const walk = (tools: readonly ToolEntry[]): void => {
    for (const t of tools) {
      if (isSubagentTool(t.toolName)) out.push(t.id);
      if (t.children !== undefined) walk(t.children);
    }
  };
  walk(cut.filter((e): e is ToolEntry => e.kind === 'tool'));
  return out;
}

/** 只存终态：裁到上限、丢 heartbeat 快照 */
export async function saveTimeline(docs: DocStore, key: string, timeline: Timeline): Promise<void> {
  const { entries, history, pendingChildren, trimmedToolIds } = trimTimelineForSave(timeline);
  await docs.set(`${TIMELINE_PREFIX}${key}`, {
    v: 1,
    lastAppliedSeq: timeline.lastAppliedSeq,
    entries,
    ...(history === undefined ? {} : { history }),
    ...(timeline.bgTasks === undefined ? {} : { bgTasks: timeline.bgTasks }),
    ...(pendingChildren === undefined ? {} : { pendingChildren }),
    ...(trimmedToolIds === undefined ? {} : { trimmedToolIds }),
  });
}

/** 所有已落盘的时间线 key（`machineId/sessionId`） */
export async function listTimelineKeys(docs: DocStore): Promise<string[]> {
  const all = await docs.keys();
  return all.filter((k) => k.startsWith(TIMELINE_PREFIX)).map((k) => k.slice(TIMELINE_PREFIX.length));
}

/** 删一份时间线文档（会话被永久删除时，session-list-v2 §4.1） */
export async function deleteTimeline(docs: DocStore, key: string): Promise<void> {
  await docs.del(`${TIMELINE_PREFIX}${key}`);
}

export async function deleteAllTimelines(docs: DocStore): Promise<void> {
  for (const key of await listTimelineKeys(docs)) await docs.del(`${TIMELINE_PREFIX}${key}`);
}

// ---------------------------------------------------------------------------
// DocStore：machine 快照
// ---------------------------------------------------------------------------

/**
 * 机器快照的**骨架**：`sessions` 在这里刻意宽松（`unknown` 值），逐条另解。
 *
 * 为什么不把 `sessions: z.record(SessionMetaSchema)` 放进同一个 safeParse
 * （评审 N7）：那样**一条坏会话行就丢掉整份快照**，info 与 cwd 一并陪葬，
 * 机器卡回到「agent 未知 · claude 未知」、列表 0 行——正是 M10 那一整个
 * commit 要修的 bug 被静默重新引入，而且无任何日志。坏行的来源不是理论
 * 上的：将来 SessionMeta 加字段、或 agent 版本发出本 web 构建 schema 不认的
 * meta 变体，都会撞上。
 */
const MachineDocFrameSchema = z.object({
  v: z.literal(1),
  /** 来源 `machine.info`；从未收到过为 null */
  info: MachineInfoSchema.nullable(),
  /** 来源 `cwd.list.response / cwd.updated` */
  cwd: z.object({ favorites: z.array(z.string()), defaultCwd: z.string() }).nullable(),
  /** sessionId → 完整 SessionMeta（来源 session.list.response / created / updated） */
  sessions: z.record(z.string(), z.unknown()),
});

export interface MachineDoc {
  v: 1;
  info: MachineInfo | null;
  cwd: { favorites: string[]; defaultCwd: string } | null;
  sessions: Record<string, SessionMeta>;
}

export function emptyMachineDoc(): MachineDoc {
  return { v: 1, info: null, cwd: null, sessions: {} };
}

/**
 * 读机器快照。坏的会话行**逐条丢弃、其余保留**（评审 N7）；
 * 骨架本身坏了才整份返回 null。
 *
 * @param onDropped 丢了几条坏行（调用方可据此打日志——静默丢弃是 M10 那个
 *   bug 当初难查的原因之一）
 */
export async function loadMachineDoc(
  docs: DocStore,
  machineId: string,
  onDropped?: (count: number) => void,
): Promise<MachineDoc | null> {
  const raw = await docs.get(`${MACHINE_PREFIX}${machineId}`);
  if (raw === undefined) return null;
  const frame = MachineDocFrameSchema.safeParse(raw);
  if (!frame.success) return null;
  const sessions: Record<string, SessionMeta> = {};
  let dropped = 0;
  for (const [sessionId, value] of Object.entries(frame.data.sessions)) {
    const meta = SessionMetaSchema.safeParse(value);
    if (meta.success) sessions[sessionId] = meta.data;
    else dropped++;
  }
  if (dropped > 0) onDropped?.(dropped);
  return { v: 1, info: frame.data.info, cwd: frame.data.cwd, sessions };
}

/** 落盘机器快照：sessions 按 lastActivityAt 降序裁到 MACHINE_MAX_SESSIONS */
export async function saveMachineDoc(
  docs: DocStore,
  machineId: string,
  doc: { info: MachineInfo | null; cwd: MachineDoc['cwd']; sessions: Record<string, SessionMeta> },
): Promise<void> {
  const all = Object.values(doc.sessions);
  let sessions = doc.sessions;
  if (all.length > MACHINE_MAX_SESSIONS) {
    sessions = {};
    for (const meta of [...all].sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, MACHINE_MAX_SESSIONS)) {
      sessions[meta.sessionId] = meta;
    }
  }
  await docs.set(`${MACHINE_PREFIX}${machineId}`, { v: 1, info: doc.info, cwd: doc.cwd, sessions });
}

/** 所有已落盘机器快照的 machineId */
export async function listMachineDocIds(docs: DocStore): Promise<string[]> {
  const all = await docs.keys();
  return all.filter((k) => k.startsWith(MACHINE_PREFIX)).map((k) => k.slice(MACHINE_PREFIX.length));
}

export async function deleteMachineDoc(docs: DocStore, machineId: string): Promise<void> {
  await docs.del(`${MACHINE_PREFIX}${machineId}`);
}

export async function deleteAllMachineDocs(docs: DocStore): Promise<void> {
  for (const id of await listMachineDocIds(docs)) await deleteMachineDoc(docs, id);
}

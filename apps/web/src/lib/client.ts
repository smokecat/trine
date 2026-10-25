/**
 * TrineClient：协议层门面（方案 §4.4 / §4.2 / §4.3 的装配点）。
 *
 * 持有全部客户端状态（identity / peer / 机器 / 会话列表 / 时间线 / 能力），
 * 装配 Connection（连接）、Inbound（入站管线）、Outbox（出站自愈），把变化以
 * 事件的形式吐给上层（zustand store 只是它的镜像）。**只有主标签页**该创建
 * 并 start() 它——单主选举在 leader.ts，由应用层衔接。
 *
 * ## 几条贯穿始终的规则
 *
 * - **onOpen 里不 await 任何 I/O**：sync.request 的 sinceSeq 从内存态取，
 *   与 hello 在同一同步栈里发出，live 帧没有机会抢在前面（评审 B1）。
 * - **游标与 outSeq 落盘取 max**（storage.persistPeer），加载时游标再与
 *   时间线的 lastAppliedSeq 取 max，二者自洽（评审 A1）。
 * - **request() 按 reqId 关联、不按 scope**：session.create.response 走机器级流。
 *   目标机器 `online === false` 时本地立即失败、不发帧——机器级帧离线被
 *   服务端静默 ignore，会话级会被 parked 占并发名额（评审 C4）。
 * - **同步范围**：机器级 '' 一律同步（新配对设备要靠它拿 machine.info）；
 *   会话只同步「本地有时间线或 30 天内活跃或正在打开」的；游标 0 且无时间线
 *   的不发（除非用户打开它）。空时间线且游标 > 0 → sinceSeq 0 回填。
 */
import { sodiumReady } from '@trine/core/crypto';
import { AuthClient, BlobClient, BlobClientError, httpBase, type AuthToken, type BlobConfig } from '@trine/core/net';
import { ATTACHMENT_NAME_MAX } from '@trine/core/types';
import { attachmentKind, attachmentRefs } from './attachment-model.ts';
import { encryptFile, maybeCompressImage, xhrUpload, type UploadFn } from './attachment-transfer.ts';
import type {
  AgentToClientEvent,
  AttachmentRef,
  FsEntry,
  FsErrorCode,
  FsFile,
  PermissionMode,
  RewindErrorCode,
  RewindMode,
  SessionMeta,
  SessionMutateErrorCode,
  TransportFrame,
} from '@trine/core';
import type { Clock, DocStore, KvAdapter, SocketFactory } from './adapters.ts';
import { Connection, type ConnectionSnapshot } from './connection.ts';
import { Inbound, type DroppedInfo } from './envelope.ts';
import { ensureIdentity } from './identity.ts';
import { Outbox, OutboxScopeFatalError, type OutboundBody } from './outbox.ts';
import { PairingFlow, type PairingDeps } from './pairing.ts';
import {
  addLocalUserEntry,
  applyEvent,
  applyMachineEvent,
  applyMachineStatus,
  applyParkedCount,
  applySessionsEvent,
  emptyMachine,
  emptyTimeline,
  expireParked,
  isDeletedResponse,
  expireParkedBySeq,
  failSendingEntries,
  clearStaleRecalls,
  markRecalling,
  RECALL_PENDING_MS,
  removeLocalEntry,
  markSendingAsFailed,
  agentSupportsCommands,
  mergeCommandDescriptions,
  mergeHistory,
  mergeSubagentHistory,
  nextParkedExpiry,
  setLocalStatus,
  setUserAttachment,
  type Capabilities,
  type MachineState,
  type Timeline,
  type UserEntry,
} from './reducer.ts';
import {
  clearPeer,
  deleteAllMachineDocs,
  deleteAllTimelines,
  deleteMachineDoc,
  deleteTimeline,
  listTimelineKeys,
  loadMachineDoc,
  loadPeer,
  loadPrefs,
  loadTimeline,
  parseTimelineKey,
  persistPeer,
  saveMachineDoc,
  savePrefs,
  saveTimeline,
  timelineKey,
  type Identity,
  type MachinePeer,
  type PeerState,
  type Prefs,
} from './storage.ts';

export interface ClientDeps {
  kv: KvAdapter;
  docs: DocStore;
  createSocket: SocketFactory;
  clock: Clock;
  uuid?: () => string;
  random?: () => number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** request() 默认超时 */
  requestTimeoutMs?: number;
  /** 「30 天内活跃」的窗口 */
  sessionActiveWindowMs?: number;
  /** 落盘去抖（trailing） */
  persistDebounceMs?: number;
  /** 时间线落盘的最大等待（流式期间也要周期落盘） */
  persistMaxWaitMs?: number;
  /** 附件密文上传（默认 XMLHttpRequest，测试注入假实现） */
  uploadBlob?: UploadFn;
}

export type ClientNotice =
  | { kind: 'cursor_regression'; machineId: string; scope: string }
  | { kind: 'scope_fatal'; machineId: string; scope: string; detail: string }
  | { kind: 'outbox_gave_up'; machineId: string; scope: string; detail: string }
  | { kind: 'machine_error'; machineId: string; error: NonNullable<MachineState['lastError']> }
  | { kind: 'dropped'; info: DroppedInfo };

export type SyncMode = 'normal' | 'backfill';

export interface ClientEvents {
  connection: (snapshot: ConnectionSnapshot) => void;
  /** 各 scope 同步/回填进行中的全量快照：key = 会话 timelineKey / 机器级 machineId */
  sync: (syncing: Record<string, SyncMode>) => void;
  /** 待发队列长度变化 */
  queue: (count: number) => void;
  peer: (peer: PeerState | null) => void;
  machine: (machine: MachineState) => void;
  sessions: (machineId: string, sessions: Record<string, SessionMeta>) => void;
  timeline: (machineId: string, sessionId: string, timeline: Timeline) => void;
  capabilities: (machineId: string, sessionId: string, capabilities: Capabilities) => void;
  prefs: (prefs: Prefs) => void;
  notice: (notice: ClientNotice) => void;
  /** 排队消息为编辑而撤回成功（或未送达的消息点了编辑）：把文本放回该会话的输入框 */
  restoreDraft: (machineId: string, sessionId: string, text: string) => void;
  /** 每条已应用的 a2c 事件（调试 / e2e 断言用） */
  event: (machineId: string, event: AgentToClientEvent) => void;
  /**
   * 会话被永久删除、本地缓存已清（`session.removed` 广播、本设备删除成功、或
   * agent 以 `deleted` 回应任何请求）。每个会话只报一次；正开着它的视图据此跳走。
   */
  sessionRemoved: (machineId: string, sessionId: string) => void;
}

/** request() 在超时内没等到应答 */
export class RequestTimeoutError extends Error {
  constructor(
    readonly requestType: string,
    readonly timeoutMs: number,
    message = `请求 ${requestType} 超时（${timeoutMs}ms）`,
  ) {
    super(message);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * agent 以 `session.mutate.response{ok:false}` 拒绝了请求。`message` 是 agent
 * 给的人话（`busy` 等业务拒绝原样展示）；`deleted` 表示会话已被永久删除——
 * 任何带 reqId 的会话级请求（含 session.status.request）都可能收到它。
 */
export class SessionMutateError extends Error {
  constructor(
    readonly code: SessionMutateErrorCode,
    message: string,
    readonly sessionId: string,
  ) {
    super(message);
    this.name = 'SessionMutateError';
  }
}

/** 回退被 agent 拒绝（`ok:false`）：message 是 agent 给的人话，原样展示 */
export class RewindError extends Error {
  constructor(
    readonly code: RewindErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RewindError';
  }
}

export type RewindPreviewResult = Extract<AgentToClientEvent, { type: 'session.rewind.preview.response' }>;
export type RewindResult = Extract<AgentToClientEvent, { type: 'session.rewind.response' }>;

/** 回退请求的超时：会话没有子进程时 agent 要临时起一个读文件快照（冷启动一两秒） */
const REWIND_TIMEOUT_MS = 45_000;

/** 会话元数据命令等不到应答时的说法：旧 agent 会静默丢弃未知帧（协议 §2 互操作） */
export const MUTATE_TIMEOUT_HINT = '未收到 agent 应答：agent 版本过旧或离线';

/**
 * `claude update` 的客户端等待上限：agent 侧 5 分钟超时 kill，再加上前后两次
 * `claude --version` 与中转延迟，给到 6 分钟——比 agent 短就会出现「agent 还在
 * 跑、web 已报超时」。
 */
export const CLAUDE_UPDATE_TIMEOUT_MS = 6 * 60_000;

/**
 * 重启 agent 的等待上限：应答在预检结束后才发，预检含 `bun install`（agent 侧 5 分钟超时）
 * 与加载检查（1 分钟），再留余量
 */
export const AGENT_RESTART_TIMEOUT_MS = 7 * 60_000;

/** 检查 claude 最新版本的等待上限：agent 侧请求发布源 15 秒超时，留余量 */
export const CLAUDE_CHECK_TIMEOUT_MS = 30_000;

/** 手动刷新限额用量的等待上限：agent 可能要临时起一个 claude 进程（agent 侧 30s 超时） */
export const USAGE_REFRESH_TIMEOUT_MS = 45_000;

/** 扩展请求超时：扩展进程最长 30s（action），留出余量 */
export const EXT_REQUEST_TIMEOUT_MS = 45_000;

/** `session.context.response`（ok 为 false 也照常返回，由调用方展示原因） */
export type ContextRefreshResult = Extract<AgentToClientEvent, { type: 'session.context.response' }>;

/** `machine.usage.response`（ok 为 false 也照常返回，由调用方展示原因） */
export type UsageRefreshResult = Extract<AgentToClientEvent, { type: 'machine.usage.response' }>;

/** `machine.agent.restart.response`（ok 为 false 也照常返回，由调用方展示原因） */
export type AgentRestartResult = Extract<AgentToClientEvent, { type: 'machine.agent.restart.response' }>;

/** `machine.claude.check.response`（ok 为 false 也照常返回，由调用方展示原因） */
export type ClaudeCheckResult = Extract<AgentToClientEvent, { type: 'machine.claude.check.response' }>;

/** `machine.claude.update.response`（ok 为 false 也照常返回，由调用方展示原因） */
export type ClaudeUpdateResult = Extract<AgentToClientEvent, { type: 'machine.claude.update.response' }>;

/** 配对流程（pairing.ts）成功后交给 client 的结果 */
export interface PairingResult {
  serverUrl: string;
  agentBoxPubKey: string;
  machineId?: string | undefined;
  token: AuthToken;
}

interface PendingRequest {
  resolve: (event: AgentToClientEvent) => void;
  reject: (err: Error) => void;
  timer: unknown;
}

const MACHINE_SCOPE = '';
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * 本地「已删会话」记忆的保留期，与 agent 墓碑 TTL 一致（8 天 = 服务端 park 24h +
 * relay 留存 7d）：过了这个期限，指向它的旧帧在服务端也已不复存在。
 */
export const REMOVED_SESSION_TTL_MS = 8 * DAY_MS;

type Listener = (...args: unknown[]) => void;

export class TrineClient {
  /** 本设备 id（唯一暴露给 UI 的身份信息；私钥留在 lib 内部） */
  readonly deviceId: string;
  /** 两把公钥（测试封帧 / 配对展示用）；私钥不暴露 */
  readonly publicKeys: { readonly sign: string; readonly box: string };
  readonly #identity: Identity;
  #peer: PeerState | null;
  #prefs: Prefs;
  readonly #machines = new Map<string, MachineState>();
  readonly #sessions = new Map<string, Record<string, SessionMeta>>();
  readonly #timelines = new Map<string, Timeline>();
  readonly #capabilities = new Map<string, Capabilities>();
  /** 用户当前打开的会话（即便游标 0 无时间线也要同步） */
  readonly #openSessions = new Set<string>();
  /** 撤回乐观态的结算定时器，每个会话至多一个（评审 C-2） */
  readonly #recallTimers = new Map<string, unknown>();
  /** 没有本地条目的 input.cancelled（key = machine\nsession\nclientMsgId → reason），见 adoptAgentSentInput */
  readonly #orphanCancels = new Map<string, string>();
  readonly #pending = new Map<string, PendingRequest>();
  /** 进行中的历史拉取（timelineKey → promise），同一会话同时只一发 */
  readonly #historyInflight = new Map<string, Promise<void>>();
  /** 进行中的斜杠命令拉取（timelineKey → promise），同一会话同时只一发 */
  readonly #commandsInflight = new Map<string, Promise<void>>();
  /** 子 agent 回看的在途请求：key = timelineKey + toolUseId */
  readonly #subagentInflight = new Map<string, Promise<void>>();
  /** 附件明文的 objectURL（blobId → url），页面生命周期内复用 */
  readonly #attachmentUrls = new Map<string, string>();
  /** 附件加载的在途请求：key = timelineKey + 条目 id + 下标 */
  readonly #attachmentInflight = new Map<string, Promise<string>>();
  /** 文件预览缓存：`machine#session#请求路径` → 已下载的文件（刷新时替换并释放旧 URL） */
  readonly #files = new Map<string, OpenedFile>();
  readonly #fileInflight = new Map<string, Promise<OpenedFile>>();
  #blobClient: BlobClient | null = null;
  #blobConfig: Promise<BlobConfig> | null = null;
  readonly #listeners = new Map<keyof ClientEvents, Set<Listener>>();
  readonly #machineWaiters: { resolve: (machineId: string) => void }[] = [];
  #connection: Connection | null = null;
  #syncing: Record<string, SyncMode> = {};
  #lastQueued = 0;
  #connectionSnapshot: ConnectionSnapshot = { status: 'idle', attempt: 0, nextRetryAt: null, lastCloseCode: null, lastError: null };
  readonly #inbound: Inbound;
  readonly #outbox: Outbox;
  readonly #saveTimers = new Map<string, { handle: unknown; firstAt: number }>();
  /** 机器快照落盘的去抖定时器（machineId → 定时器） */
  readonly #machineSaveTimers = new Map<string, { handle: unknown; firstAt: number }>();
  /** 有待落盘变更的机器；空跑的 flush 不写盘 */
  readonly #machineDocDirty = new Set<string>();
  readonly #maxWaitMs: number;
  #peerSaveTimer: unknown = null;
  #parkedTimer: unknown = null;
  readonly #log: (line: string) => void;
  readonly #uuid: () => string;
  readonly #requestTimeoutMs: number;
  readonly #activeWindowMs: number;
  readonly #debounceMs: number;
  #started = false;

  private constructor(
    private readonly deps: ClientDeps,
    identity: Identity,
    peer: PeerState | null,
    prefs: Prefs,
  ) {
    this.#identity = identity;
    this.deviceId = identity.deviceId;
    this.publicKeys = { sign: identity.sign.publicKey, box: identity.box.publicKey };
    this.#peer = peer;
    this.#prefs = prefs;
    this.#log = deps.log ?? (() => {});
    this.#uuid = deps.uuid ?? (() => crypto.randomUUID());
    this.#requestTimeoutMs = deps.requestTimeoutMs ?? 10_000;
    this.#activeWindowMs = deps.sessionActiveWindowMs ?? 30 * DAY_MS;
    this.#debounceMs = deps.persistDebounceMs ?? 200;
    this.#maxWaitMs = deps.persistMaxWaitMs ?? 1_000;

    for (const [machineId, m] of Object.entries(peer?.machines ?? {})) {
      this.#machines.set(machineId, emptyMachine(machineId, m.name));
    }

    this.#inbound = new Inbound({
      boxSecretKey: identity.box.secretKey,
      agentKeyFor: (machineId) => this.#peer?.machines[machineId]?.agentBoxPubKey,
      cursor: {
        get: (machineId, scope) => this.#machinePeer(machineId)?.inCursors[scope] ?? 0,
        set: (machineId, scope, seq) => {
          const mp = this.#machinePeer(machineId);
          if (!mp) return;
          mp.inCursors[scope] = Math.max(mp.inCursors[scope] ?? 0, seq);
          this.#schedulePeerSave();
        },
      },
      apply: (machineId, event) => this.#apply(machineId, event),
      onDropped: (info) => this.#emit('notice', { kind: 'dropped', info }),
      onCursorRegression: (machineId, scope) => this.#emit('notice', { kind: 'cursor_regression', machineId, scope }),
      log: this.#log,
    });

    this.#outbox = new Outbox({
      seq: {
        get: (machineId, scope) => this.#machinePeer(machineId)?.outSeq[scope] ?? 0,
        set: (machineId, scope, last) => {
          const mp = this.#machinePeer(machineId);
          if (!mp) return;
          mp.outSeq[scope] = last;
          this.#schedulePeerSave();
        },
      },
      agentKeyFor: (machineId) => this.#peer?.machines[machineId]?.agentBoxPubKey,
      boxSecretKey: identity.box.secretKey,
      transmit: (frame) => this.#connection?.send(frame) ?? false,
      now: () => deps.clock.now(),
      onGaveUp: (machineId, scope, detail, clientMsgIds) => {
        this.#failSending(machineId, scope, clientMsgIds, '出站序号自愈失败，请重发');
        this.#emit('notice', { kind: 'outbox_gave_up', machineId, scope, detail });
      },
      onScopeFatal: (machineId, scope, detail, clientMsgIds) => {
        this.#failSending(machineId, scope, clientMsgIds, '该会话出站计数器失效，重置后可重发');
        this.#emit('notice', { kind: 'scope_fatal', machineId, scope, detail });
      },
      onInputRejected: (machineId, sessionId, clientMsgId, reason) =>
        this.#updateTimeline(machineId, sessionId, (tl) => setLocalStatus(tl, clientMsgId, 'failed', { failReason: reason })),
      log: this.#log,
    });
  }

  static async create(deps: ClientDeps): Promise<TrineClient> {
    await sodiumReady();
    const identity = ensureIdentity(deps.kv, deps.uuid ?? (() => crypto.randomUUID()));
    const client = new TrineClient(deps, identity, loadPeer(deps.kv), loadPrefs(deps.kv));
    client.#pruneRemovedSessions();
    await client.#loadMachineDocs();
    await client.#loadTimelines();
    return client;
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  on<K extends keyof ClientEvents>(type: K, listener: ClientEvents[K]): () => void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener as Listener);
    return () => void set!.delete(listener as Listener);
  }

  #emit<K extends keyof ClientEvents>(type: K, ...args: Parameters<ClientEvents[K]>): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      try {
        listener(...(args as unknown[]));
      } catch (err) {
        this.#log(`[client] 监听器出错 ${type}：${String(err)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 快照
  // -------------------------------------------------------------------------

  get peer(): PeerState | null {
    return this.#peer;
  }
  get prefs(): Prefs {
    return this.#prefs;
  }
  get connection(): ConnectionSnapshot {
    return this.#connectionSnapshot;
  }
  /** 当前同步/回填中的 scope（key 同 sync 事件） */
  get syncing(): Record<string, SyncMode> {
    return { ...this.#syncing };
  }
  get isPaired(): boolean {
    return this.#peer !== null && Object.keys(this.#peer.machines).length > 0;
  }
  machines(): MachineState[] {
    return [...this.#machines.values()];
  }
  machine(machineId: string): MachineState | undefined {
    return this.#machines.get(machineId);
  }
  sessions(machineId: string): Record<string, SessionMeta> {
    return this.#sessions.get(machineId) ?? {};
  }
  timeline(machineId: string, sessionId: string): Timeline {
    return this.#timelines.get(timelineKey(machineId, sessionId)) ?? emptyTimeline();
  }
  capabilities(machineId: string, sessionId: string): Capabilities | undefined {
    return this.#capabilities.get(timelineKey(machineId, sessionId));
  }
  /** 待发队列长度（连接不在时积压的帧数） */
  get queuedCount(): number {
    return this.#outbox.queuedCount;
  }
  isScopeFatal(machineId: string, scope: string): boolean {
    return this.#outbox.isScopeFatal(machineId, scope);
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 已配对则接入服务端；未配对什么也不做（等 completePairing） */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#connect();
    this.#armParkedExpiry();
  }

  /** 断连并落盘；待发队列里的 input.send 标 failed */
  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#disconnect();
  }

  /** 断连 + 待发队列 failed + 落盘；**不改** #started（resetLocalState 复用，重置后再配对要能自动建连） */
  #disconnect(): void {
    this.#connection?.stop();
    this.#connection = null;
    for (const item of this.#outbox.dropQueue()) {
      if (item.event.type === 'input.send' && item.event.sessionId !== undefined) {
        this.#updateTimeline(item.machineId, item.event.sessionId, (tl) =>
          setLocalStatus(tl, (item.event as { clientMsgId: string }).clientMsgId, 'failed', { failReason: '连接断开前未能发出' }),
        );
      }
    }
    this.#emitQueue();
    this.#flushSaves();
    if (this.#parkedTimer !== null) {
      this.deps.clock.clearTimeout(this.#parkedTimer);
      this.#parkedTimer = null;
    }
    for (const handle of this.#recallTimers.values()) this.deps.clock.clearTimeout(handle);
    this.#recallTimers.clear();
  }

  /** 页面回前台 */
  wake(): void {
    this.#connection?.wake();
  }

  #connect(): void {
    const peer = this.#peer;
    if (peer === null || !this.#started) return;
    if (this.#connection !== null) return;
    const auth = new AuthClient({
      baseUrl: httpBase(peer.serverUrl),
      deviceId: this.#identity.deviceId,
      signKeys: this.#identity.sign,
      ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
    });
    this.#connection = new Connection({
      serverUrl: peer.serverUrl,
      deviceId: this.#identity.deviceId,
      authenticate: (signal) => auth.authenticate({ signal }),
      token: peer.authToken ?? null,
      onToken: (token) => {
        if (this.#peer === null) return;
        if (token === null) delete this.#peer.authToken;
        else this.#peer.authToken = token;
        this.#schedulePeerSave();
      },
      createSocket: this.deps.createSocket,
      clock: this.deps.clock,
      ...(this.deps.random === undefined ? {} : { random: this.deps.random }),
      onOpen: () => this.#onOpen(),
      onFrame: (frame) => this.#onFrame(frame),
      onClose: () => this.#resetSyncing(),
      onStatus: (snapshot) => {
        this.#connectionSnapshot = snapshot;
        this.#emit('connection', snapshot);
      },
      log: this.#log,
    });
    this.#connection.start();
  }

  /** hello 已发出：同步栈内逐 scope 发 sync.request，再冲待发队列 */
  #onOpen(): void {
    this.#resetSyncing();
    for (const machineId of Object.keys(this.#peer?.machines ?? {})) this.#syncMachine(machineId);
    this.#outbox.flush();
    this.#emitQueue();
  }

  #resetSyncing(): void {
    this.#inbound.onConnectionReset();
    if (Object.keys(this.#syncing).length > 0) {
      this.#syncing = {};
      this.#emitSync();
    }
  }

  #syncMachine(machineId: string): void {
    const mp = this.#machinePeer(machineId);
    if (!mp || !this.#connection?.isOpen) return;
    const now = this.deps.clock.now();
    // 机器级一律同步：新配对设备只有靠 sinceSeq 0 才拿得到配对时补发的 machine.info
    this.#requestSync(machineId, MACHINE_SCOPE, mp.inCursors[MACHINE_SCOPE] ?? 0, 'normal');
    for (const [sessionId, meta] of Object.entries(mp.sessions)) {
      if (this.#isRemoved(machineId, sessionId)) continue;
      const key = timelineKey(machineId, sessionId);
      const cursor = mp.inCursors[sessionId] ?? 0;
      const hasEntries = (this.#timelines.get(key)?.entries.length ?? 0) > 0;
      const open = this.#openSessions.has(key);
      const active = meta.lastActivityAt >= now - this.#activeWindowMs;
      if (!hasEntries && !open && !active) continue;
      if (cursor === 0 && !hasEntries && !open) continue; // 无意义的全窗口重放
      if (cursor > 0 && !hasEntries) {
        this.#requestSync(machineId, sessionId, 0, 'backfill');
      } else {
        this.#requestSync(machineId, sessionId, cursor, 'normal');
      }
    }
  }

  #syncKey(machineId: string, scope: string): string {
    return scope === MACHINE_SCOPE ? machineId : timelineKey(machineId, scope);
  }

  #emitSync(): void {
    this.#emit('sync', { ...this.#syncing });
  }

  #emitQueue(): void {
    const count = this.#outbox.queuedCount;
    if (count === this.#lastQueued) return;
    this.#lastQueued = count;
    this.#emit('queue', count);
  }

  #requestSync(machineId: string, scope: string, sinceSeq: number, mode: SyncMode): void {
    if (!this.#connection?.isOpen) return;
    this.#inbound.beginSync(machineId, scope, mode);
    this.#syncing[this.#syncKey(machineId, scope)] = mode;
    this.#emitSync();
    this.#connection.send({
      type: 'sync.request',
      machineId,
      ...(scope === MACHINE_SCOPE ? {} : { sessionId: scope }),
      sinceSeq,
    });
  }

  // -------------------------------------------------------------------------
  // 入站
  // -------------------------------------------------------------------------

  #onFrame(frame: TransportFrame): void {
    switch (frame.type) {
      case 'relay':
        this.#inbound.onRelay(frame);
        return;
      case 'relay.reject':
        this.#outbox.onReject(frame);
        return;
      case 'sync.done': {
        this.#inbound.onSyncDone(frame);
        const key = this.#syncKey(frame.machineId, frame.sessionId ?? MACHINE_SCOPE);
        if (key in this.#syncing) {
          delete this.#syncing[key];
          this.#emitSync();
        }
        if (this.#inbound.syncingCount === 0) this.#sweepParked();
        return;
      }
      case 'machine.status': {
        // 旧 QR 无 machineId 的回落：配对期任何在线机器都是候选，此时 #machines 为空，
        // waiter 结算必须在「未配对机器」守卫**之前**（评审阶段 1 B2）
        if (frame.online && this.#machineWaiters.length > 0) {
          for (const w of this.#machineWaiters.splice(0)) w.resolve(frame.machineId);
        }
        if (!this.#machines.has(frame.machineId)) return; // 未配对的机器（服务端对全部 agent 推）
        this.#updateMachine(frame.machineId, (m) => applyMachineStatus(m, frame));
        return;
      }
      case 'parked.count':
        if (!this.#machines.has(frame.machineId)) return;
        this.#updateMachine(frame.machineId, (m) => applyParkedCount(m, frame.parkedCount));
        if (frame.parkedCount === 0) this.#sweepParked();
        return;
      case 'input.parked': {
        const clientMsgId = this.#outbox.clientMsgIdForSeq(frame.machineId, frame.sessionId, frame.seq);
        if (clientMsgId === undefined) return;
        this.#updateTimeline(frame.machineId, frame.sessionId, (tl) =>
          setLocalStatus(tl, clientMsgId, 'parked', { parkedSeq: frame.seq, expiresAt: frame.expiresAt }),
        );
        this.#armParkedExpiry();
        return;
      }
      case 'park.expired':
        this.#updateTimeline(frame.machineId, frame.sessionId, (tl) => expireParkedBySeq(tl, frame.seq));
        return;
      case 'pair.confirm':
      case 'pair.abort':
        // 服务端把 agent 发的 pair.* 广播给全部 client：与本连接无关，静默忽略
        return;
      default:
        this.#log(`[client] 忽略未处理的 transport 帧 ${frame.type}`);
    }
  }

  /** Inbound 校验通过、游标已推进后的落点 */
  #apply(machineId: string, event: AgentToClientEvent): void {
    // request() 关联：按 reqId，不按 scope（machine.stats 的定时推送不带 reqId）
    if ('reqId' in event && event.reqId !== undefined) {
      const pending = this.#pending.get(event.reqId);
      if (pending !== undefined) {
        this.#pending.delete(event.reqId);
        this.deps.clock.clearTimeout(pending.timer);
        // 业务拒绝（含墓碑命中的 deleted）一律 reject：调用方不必各自认这帧
        if (event.type === 'session.mutate.response' && !event.ok) {
          const error = event.error ?? { code: 'io' as const, message: 'agent 拒绝了请求（未给原因）' };
          pending.reject(new SessionMutateError(error.code, error.message, event.targetSessionId));
        } else {
          pending.resolve(event);
        }
      }
    }

    if (event.sessionId !== undefined && this.#isRemoved(machineId, event.sessionId)) {
      // 已永久删除的会话（评审 CM1）：sync 回放 / 迟到的会话级帧一律丢弃，不重建
      // 时间线、不写回 peer.sessions。游标已由 Inbound 推进，免得反复补发
    } else if (event.sessionId !== undefined) {
      const sessionId = event.sessionId;
      this.#touchSession(machineId, sessionId, event.ts);
      // 为编辑而撤回的：条目随这帧删除，删之前取文本放回输入框
      const restore =
        event.type === 'input.cancelled' && event.reason === 'recalled' ? this.#editableText(machineId, sessionId, event.clientMsgId, true) : undefined;
      if (event.type === 'input.cancelled' && !this.timeline(machineId, sessionId).entries.some((e) => e.kind === 'user' && e.local && e.id === event.clientMsgId)) {
        // 没有本地条目的取消回执：可能是扩展代发、动作结果还没到的那条（见 adoptAgentSentInput）
        this.#orphanCancels.set(`${machineId}\n${sessionId}\n${event.clientMsgId}`, event.reason);
        if (this.#orphanCancels.size > 100) this.#orphanCancels.delete(this.#orphanCancels.keys().next().value!);
      }
      this.#updateTimeline(machineId, sessionId, (tl) => applyEvent(tl, event));
      if (restore !== undefined) this.#emit('restoreDraft', machineId, sessionId, restore);
      if (event.type === 'run.state') {
        this.#updateSessions(machineId, (s) => applySessionsEvent(s, event));
      }
      if (event.type === 'session.capabilities') {
        const key = timelineKey(machineId, sessionId);
        // init 只给命令名：按 name 把 session.commands.response 带来的描述并回去
        const known = this.#capabilities.get(key)?.slashCommands ?? [];
        const caps: Capabilities = {
          slashCommands: mergeCommandDescriptions(event.slashCommands, known),
          models: event.models,
          mcpServers: event.mcpServers,
        };
        this.#capabilities.set(key, caps);
        this.#emit('capabilities', machineId, sessionId, caps);
        // models 不并入 knownModels：init 上报的是别名解析后的具体 ID，并进去
        // 预置列表又会长回具体版本（别名的意义就没了）。会话设置里单独显示。
      }
    } else {
      switch (event.type) {
        case 'session.list.response': {
          // 已删会话不许回来（agent 墓碑本已过滤，这里是本地的第二道）
          const listed = event.sessions.filter((s) => !this.#isRemoved(machineId, s.sessionId));
          const filtered = listed.length === event.sessions.length ? event : { ...event, sessions: listed };
          for (const s of filtered.sessions) this.#touchSession(machineId, s.sessionId, s.lastActivityAt);
          this.#updateSessions(machineId, (s) => applySessionsEvent(s, filtered));
          break;
        }
        case 'session.created':
        case 'session.create.response':
        case 'session.updated':
          if (this.#isRemoved(machineId, event.session.sessionId)) break;
          this.#touchSession(machineId, event.session.sessionId, event.session.lastActivityAt);
          this.#updateSessions(machineId, (s) => applySessionsEvent(s, event));
          break;
        case 'machine.info':
        case 'machine.stats':
        case 'cwd.list.response':
        case 'cwd.updated':
          this.#updateMachine(machineId, (m) => applyMachineEvent(m, event));
          if (event.type === 'machine.info') {
            const mp = this.#machinePeer(machineId);
            if (mp && mp.name !== event.info.name) {
              mp.name = event.info.name;
              this.#schedulePeerSave();
            }
          }
          break;
        case 'error.fatal': {
          this.#updateMachine(machineId, (m) => applyMachineEvent(m, event));
          const error = this.#machines.get(machineId)?.lastError;
          if (error) this.#emit('notice', { kind: 'machine_error', machineId, error });
          break;
        }
        case 'session.removed':
          this.#removeSession(machineId, event.targetSessionId);
          break;
        case 'session.mutate.response':
          // 墓碑命中视同 removed（评审 B4）；其他应答只给 request() 关联
          if (isDeletedResponse(event)) this.#removeSession(machineId, event.targetSessionId);
          break;
        default:
          // session.status.response / mcp.status.response 等：request() 已关联；无挂起请求则是补发迟到，忽略
          break;
      }
    }
    this.#emit('event', machineId, event);
  }

  // -------------------------------------------------------------------------
  // 出站 API
  // -------------------------------------------------------------------------

  /**
   * 发一条用户消息：立即以 sending 入时间线，返回 clientMsgId。附件须已上传
   * （`uploadAttachment`），这里只带引用。
   */
  sendInput(machineId: string, sessionId: string, text: string, attachments: AttachmentRef[] = []): string {
    const clientMsgId = this.#uuid();
    this.#sendInputWith(machineId, sessionId, clientMsgId, text, attachments);
    return clientMsgId;
  }

  /** 重发一条 failed 的本地消息（沿用 clientMsgId，agent 按它去重） */
  retryInput(machineId: string, sessionId: string, clientMsgId: string): boolean {
    const entry = this.timeline(machineId, sessionId).entries.find(
      (e): e is UserEntry => e.kind === 'user' && e.local && e.id === clientMsgId,
    );
    if (!entry || entry.status !== 'failed') return false;
    this.#sendInputWith(machineId, sessionId, clientMsgId, entry.text, attachmentRefs(entry));
    return true;
  }

  #sendInputWith(
    machineId: string,
    sessionId: string,
    clientMsgId: string,
    text: string,
    attachments: AttachmentRef[],
  ): void {
    // 已删除的会话：不入时间线、不发（agent 墓碑只会忽略它，条目会永远停在「发送中」）
    if (!this.openSession(machineId, sessionId)) return;
    this.#updateTimeline(machineId, sessionId, (tl) =>
      addLocalUserEntry(tl, { clientMsgId, text, ts: this.deps.clock.now(), attachments }),
    );
    const body: OutboundBody = {
      type: 'input.send',
      sessionId,
      clientMsgId,
      text,
      ...(attachments.length === 0 ? {} : { attachments }),
    };
    if (!this.#safeSend(machineId, body)) {
      // fatal scope：不发，条目立即 failed（可在重置计数器后重发）
      this.#updateTimeline(machineId, sessionId, (tl) =>
        setLocalStatus(tl, clientMsgId, 'failed', { failReason: '该会话出站计数器失效，重置后可重发' }),
      );
    }
  }

  /** outbox.send 的安全封装：fatal scope 不发帧、发 notice、返回 false；其他错误照抛 */
  #safeSend(machineId: string, body: OutboundBody): boolean {
    try {
      this.#outbox.send(machineId, body);
      this.#emitQueue();
      return true;
    } catch (err) {
      if (err instanceof OutboxScopeFatalError) {
        this.#emit('notice', { kind: 'scope_fatal', machineId, scope: err.scope, detail: err.message });
        return false;
      }
      throw err;
    }
  }

  #failSending(machineId: string, scope: string, clientMsgIds: string[], reason: string): void {
    if (scope === MACHINE_SCOPE || clientMsgIds.length === 0) return;
    this.#updateTimeline(machineId, scope, (tl) => failSendingEntries(tl, clientMsgIds, reason));
  }

  /** 本设备的一条本地条目 */
  #localEntry(machineId: string, sessionId: string, clientMsgId: string): UserEntry | undefined {
    return this.timeline(machineId, sessionId).entries.find(
      (e): e is UserEntry => e.kind === 'user' && e.local && e.id === clientMsgId,
    );
  }

  /** 可以放回输入框的文本（带附件的放不回去：草稿附件要原始文件）；`onlyIfMarked` = 只认为编辑而撤回的 */
  #editableText(machineId: string, sessionId: string, clientMsgId: string, onlyIfMarked = false): string | undefined {
    const entry = this.#localEntry(machineId, sessionId, clientMsgId);
    if (entry === undefined || (onlyIfMarked && entry.recallForEdit !== true)) return undefined;
    if (entry.attachments !== undefined && entry.attachments.length > 0) return undefined;
    return entry.text;
  }

  /**
   * 撤回排队在服务端的消息（park.recall）。服务端对它没有回执，所以直接删掉本地条目；
   * 万一撤回与上线投递撞上、消息其实送到了，随后的回显会以普通消息出现在时间线里。
   * 也因为没有回执，不提供「撤回并编辑」：撞上时旧消息照样执行，再发就是两条。
   */
  recallParked(machineId: string, sessionId: string, clientMsgId: string): boolean {
    const entry = this.#localEntry(machineId, sessionId, clientMsgId);
    if (!entry || entry.status !== 'parked' || entry.parkedSeq === undefined) return false;
    const sent = this.#connection?.send({ type: 'park.recall', machineId, sessionId, seq: entry.parkedSeq }) ?? false;
    if (sent) this.#updateTimeline(machineId, sessionId, (tl) => removeLocalEntry(tl, clientMsgId));
    return sent;
  }

  /**
   * 撤回 agent 端排队中的消息（`input.recall`）。
   *
   * 条目先进「撤回中…」：成功的回执是 `input.cancelled(recalled)`（条目删除，`edit` 的
   * 把文本放回输入框）；来不及的信号是这条的 `user.message` 回显（升 confirmed、
   * 移进时间线）。都等不到就在 RECALL_PENDING_MS 后恢复按钮。
   */
  recallQueued(machineId: string, sessionId: string, clientMsgId: string, options: { edit?: boolean } = {}): void {
    if (!this.#safeSend(machineId, { type: 'input.recall', sessionId, clientMsgId })) return;
    this.#updateTimeline(machineId, sessionId, (tl) =>
      markRecalling(tl, clientMsgId, this.deps.clock.now(), options.edit === true),
    );
    this.#armRecallSettle(machineId, sessionId);
  }

  /**
   * 没送进对话的消息（cancelled / expired / failed）：放回输入框（`edit`）或直接丢弃，
   * 两种都删掉本地条目。排队中 / 离线暂存的要先撤回，走 recallQueued / recallParked。
   */
  discardPending(machineId: string, sessionId: string, clientMsgId: string, options: { edit?: boolean } = {}): boolean {
    const entry = this.#localEntry(machineId, sessionId, clientMsgId);
    if (!entry || (entry.status !== 'cancelled' && entry.status !== 'expired' && entry.status !== 'failed')) return false;
    const text = options.edit === true ? this.#editableText(machineId, sessionId, clientMsgId) : undefined;
    this.#updateTimeline(machineId, sessionId, (tl) => removeLocalEntry(tl, clientMsgId));
    if (text !== undefined) this.#emit('restoreDraft', machineId, sessionId, text);
    return true;
  }

  /**
   * 重发没送进对话的消息。failed 沿用 clientMsgId（agent 没收下过，去重表里没有它）；
   * cancelled / expired 换新 clientMsgId（agent 的去重表可能还记着旧的），旧条目删掉。
   */
  resendPending(machineId: string, sessionId: string, clientMsgId: string): boolean {
    const entry = this.#localEntry(machineId, sessionId, clientMsgId);
    if (!entry) return false;
    if (entry.status === 'failed') return this.retryInput(machineId, sessionId, clientMsgId);
    if (entry.status !== 'cancelled' && entry.status !== 'expired') return false;
    this.#updateTimeline(machineId, sessionId, (tl) => removeLocalEntry(tl, clientMsgId));
    this.sendInput(machineId, sessionId, entry.text, attachmentRefs(entry));
    return true;
  }

  /**
   * 「撤回中…」的超时（见 RECALL_PENDING_MS）：成功 / 失败都有入站事件，只有「等不到」
   * 没有，得靠定时器把按钮恢复。放在 client 而不是视图里：它是条目状态的真实迁移
   * （要落盘、要让别的视图也看到），不该依赖「恰好有人在看这个会话」。
   */
  #armRecallSettle(machineId: string, sessionId: string): void {
    const key = timelineKey(machineId, sessionId);
    if (this.#recallTimers.has(key)) return; // 同一会话共用一个，到点统一结算
    const handle = this.deps.clock.setTimeout(() => {
      this.#recallTimers.delete(key);
      this.#updateTimeline(machineId, sessionId, (tl) =>
        clearStaleRecalls(tl, this.deps.clock.now() - RECALL_PENDING_MS),
      );
      // 还有没到点的撤回（这次结算期间又点了一次）就再排一轮
      const rest = this.#timelines.get(key)?.entries.some((e) => e.kind === 'user' && e.recallingAt !== undefined);
      if (rest === true) this.#armRecallSettle(machineId, sessionId);
    }, RECALL_PENDING_MS);
    this.#recallTimers.set(key, handle);
  }

  respondPermission(
    machineId: string,
    sessionId: string,
    requestId: string,
    verdict: 'allow' | 'deny',
    options: {
      updatedInput?: unknown;
      remember?: { scope: 'session'; pattern: string };
      /** 拒绝附言（agent ≥ 0.6.0 生效；旧 agent 会 strip 掉，不拒帧） */
      message?: string;
      /** 批准同时切权限模式（同上） */
      setMode?: PermissionMode;
    } = {},
  ): void {
    this.#safeSend(machineId, {
      type: 'permission.respond',
      sessionId,
      requestId,
      verdict,
      ...(options.updatedInput === undefined ? {} : { updatedInput: options.updatedInput }),
      ...(options.remember === undefined ? {} : { remember: options.remember }),
      ...(options.message === undefined ? {} : { message: options.message }),
      ...(options.setMode === undefined ? {} : { setMode: options.setMode }),
    });
  }

  stopRun(machineId: string, sessionId: string): void {
    this.#safeSend(machineId, { type: 'run.stop', sessionId });
  }

  /**
   * 停止一个后台任务（`bgtask.stop`，agent ≥ 0.7.0）。应答复用机器级
   * session.mutate.response：agent 拒绝（not_found / io）时按 reqId 关联的
   * pending 已 reject 成 SessionMutateError，这里只认成功应答的形状。
   */
  async stopBgTask(machineId: string, sessionId: string, taskId: string): Promise<void> {
    // 与 #mutate 同款写法：显式标注的窄类型让 request 的泛型推断落在这一种帧上
    const body: { type: 'bgtask.stop'; sessionId: string; taskId: string } = { type: 'bgtask.stop', sessionId, taskId };
    const res = await this.request(machineId, body);
    if (res.type !== 'session.mutate.response') throw new Error(`意外的应答 ${res.type}`);
  }

  /**
   * 回退预览（`session.rewind.preview`，agent ≥ 0.9.0；版本门控由调用方做）。
   * 不改任何东西；`ok:false`（busy / not_found / io）抛 RewindError。
   * 响应是定向帧，只有本设备收得到。
   */
  async previewRewind(machineId: string, sessionId: string, targetMessageId: string): Promise<RewindPreviewResult> {
    const body: { type: 'session.rewind.preview'; sessionId: string; targetMessageId: string } = {
      type: 'session.rewind.preview',
      sessionId,
      targetMessageId,
    };
    const res = await this.request(machineId, body, { timeoutMs: Math.max(this.#requestTimeoutMs, REWIND_TIMEOUT_MS) });
    if (res.type !== 'session.rewind.preview.response') throw new Error(`意外的应答 ${res.type}`);
    if (!res.ok) throw rewindError(res.error);
    return res;
  }

  /**
   * 执行回退（`session.rewind`）。成功时 agent 已先广播 `session.rewound`，各设备的
   * 时间线由它截断；这里只返回结果（还原的文件、原消息文本供预填）。
   */
  async rewind(machineId: string, sessionId: string, targetMessageId: string, mode: RewindMode): Promise<RewindResult> {
    const body: { type: 'session.rewind'; sessionId: string; targetMessageId: string; mode: RewindMode } = {
      type: 'session.rewind',
      sessionId,
      targetMessageId,
      mode,
    };
    const res = await this.request(machineId, body, { timeoutMs: Math.max(this.#requestTimeoutMs, REWIND_TIMEOUT_MS) });
    if (res.type !== 'session.rewind.response') throw new Error(`意外的应答 ${res.type}`);
    if (!res.ok) throw rewindError(res.error);
    return res;
  }

  // -------------------------------------------------------------------------
  // 附件（relay blob，见 attachment-transfer.ts）
  // -------------------------------------------------------------------------

  /** relay 的 blob 配置（单个上限 / 保留时长）；失败不缓存，下次重试 */
  blobConfig(): Promise<BlobConfig> {
    if (this.#blobConfig === null) {
      const task = this.#blobs().config();
      this.#blobConfig = task;
      task.catch(() => {
        if (this.#blobConfig === task) this.#blobConfig = null;
      });
    }
    return this.#blobConfig;
  }

  /**
   * （按需压缩后）加密并上传一个文件，返回引用（之后随 sendInput 发出）。
   * `compressAboveBytes` > 0 时，超过它的图片先在浏览器里缩小重编码。
   */
  async uploadAttachment(
    original: File,
    options: { onProgress?: (fraction: number) => void; signal?: AbortSignal; compressAboveBytes?: number } = {},
  ): Promise<AttachmentRef> {
    const peer = this.#peer;
    if (peer === null) throw new Error('尚未配对');
    const file = await maybeCompressImage(original, options.compressAboveBytes ?? 0);
    const { key, body } = await encryptFile(file);
    const upload = this.deps.uploadBlob ?? xhrUpload;
    const url = `${httpBase(peer.serverUrl)}/blobs`;
    const attempt = async (refresh: boolean) =>
      upload({
        url,
        token: await this.#blobToken(refresh),
        body,
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    let res = await attempt(false);
    if (res.status === 401) res = await attempt(true);
    const payload = (res.body ?? {}) as { blobId?: unknown; error?: unknown; maxBytes?: unknown };
    if (res.status !== 200 || typeof payload.blobId !== 'string') {
      throw new Error(uploadErrorText(res.status, payload));
    }
    const mime = file.type === '' ? 'application/octet-stream' : file.type;
    const ref: AttachmentRef = {
      name: (file.name === '' ? 'file' : file.name).slice(0, ATTACHMENT_NAME_MAX),
      mime,
      size: file.size,
      kind: attachmentKind(mime),
      blobId: payload.blobId,
      key,
    };
    // 本机已有明文：直接缓存预览，自己发的图片点开不用再下载
    const preview = createObjectUrl(file);
    if (preview !== undefined) this.#attachmentUrls.set(ref.blobId, preview);
    return ref;
  }

  /** 已在本机的附件明文 URL（刚上传的 / 加载过的）；没有返回 undefined */
  attachmentUrl(blobId: string | undefined): string | undefined {
    return blobId === undefined ? undefined : this.#attachmentUrls.get(blobId);
  }

  /**
   * 取某条用户消息第 index 个附件的明文 URL：有引用就从 relay 下载解密；引用过期
   * （404）或根本没有（历史里 CLI 粘贴的图片）就请 agent 重新上传，新引用写回条目。
   */
  openAttachment(machineId: string, sessionId: string, entryId: string, index: number): Promise<string> {
    const entry = this.timeline(machineId, sessionId).entries.find(
      (e): e is UserEntry => e.kind === 'user' && e.id === entryId,
    );
    const att = entry?.attachments?.[index];
    if (entry === undefined || att === undefined) return Promise.reject(new Error('找不到这个附件'));
    const cached = this.attachmentUrl(att.blobId);
    if (cached !== undefined) return Promise.resolve(cached);
    const key = `${timelineKey(machineId, sessionId)}#${entryId}#${index}`;
    const inflight = this.#attachmentInflight.get(key);
    if (inflight !== undefined) return inflight;
    const task = (async () => {
      if (att.blobId !== undefined && att.key !== undefined) {
        try {
          return await this.#downloadAttachment({ ...att, blobId: att.blobId, key: att.key });
        } catch (err) {
          if (!(err instanceof BlobClientError && err.status === 404)) throw err;
        }
      }
      const uuid = entry.uuid;
      if (uuid === undefined) throw new Error('这条消息还没被 agent 确认，暂时无法加载附件');
      const body: { type: 'attachment.fetch.request'; sessionId: string; messageId: string; index: number } = {
        type: 'attachment.fetch.request',
        sessionId,
        messageId: uuid,
        index,
      };
      const res = await this.request(machineId, body, { timeoutMs: Math.max(this.#requestTimeoutMs, 60_000) });
      if (res.type !== 'attachment.fetch.response') throw new Error(`意外的应答 ${res.type}`);
      if (!res.ok || res.attachment === undefined) throw new Error(res.error?.message ?? '附件拉取失败');
      const fresh = res.attachment;
      this.#updateTimeline(machineId, sessionId, (tl) => setUserAttachment(tl, entryId, index, fresh));
      return this.#downloadAttachment(fresh);
    })().finally(() => {
      this.#attachmentInflight.delete(key);
    });
    this.#attachmentInflight.set(key, task);
    return task;
  }

  async #downloadAttachment(ref: AttachmentRef): Promise<string> {
    const parts: Uint8Array[] = [];
    await this.#blobs().downloadDecrypted(ref.blobId, ref.key, (chunk) => {
      parts.push(chunk);
    }, { maxBytes: ref.size });
    const blob = new Blob(parts as BlobPart[], { type: ref.mime === '' ? 'application/octet-stream' : ref.mime });
    const url = createObjectUrl(blob);
    if (url === undefined) throw new Error('当前环境无法显示附件');
    this.#attachmentUrls.set(ref.blobId, url);
    return url;
  }

  /**
   * 列目录（fs.list，agent ≥ 0.20.0，machine.info.files 存在才支持）。`path` 省略 = 会话 cwd。
   * agent 拒绝（不在范围内 / 不存在…）抛 `FsRequestError`。
   */
  async listFiles(machineId: string, sessionId: string, path?: string): Promise<FsListing> {
    const res = await this.request<Extract<OutboundBody, { type: 'fs.list.request' }>>(machineId, {
      type: 'fs.list.request',
      sessionId,
      ...(path === undefined ? {} : { path }),
    });
    if (res.type !== 'fs.list.response') throw new Error(`意外的应答 ${res.type}`);
    if (!res.ok || res.path === undefined || res.root === undefined || res.entries === undefined) {
      throw new FsRequestError(res.error?.code ?? 'io', res.error?.message ?? '读取目录失败');
    }
    return { path: res.path, root: res.root, entries: res.entries, truncated: res.truncated === true };
  }

  /**
   * 打开文件预览（fs.read）：agent 读文件、加密上传 blob，这里下载解密。同一路径默认用缓存，
   * `refresh` 时重新向 agent 要（旧的对象 URL 释放）。
   */
  openFile(machineId: string, sessionId: string, path: string, options: { refresh?: boolean } = {}): Promise<OpenedFile> {
    const key = `${machineId}#${sessionId}#${path}`;
    const cached = this.#files.get(key);
    if (cached !== undefined && options.refresh !== true) return Promise.resolve(cached);
    const inflight = this.#fileInflight.get(key);
    if (inflight !== undefined) return inflight;
    const task = (async () => {
      const res = await this.request<Extract<OutboundBody, { type: 'fs.read.request' }>>(
        machineId,
        { type: 'fs.read.request', sessionId, path },
        { timeoutMs: Math.max(this.#requestTimeoutMs, 60_000) },
      );
      if (res.type !== 'fs.read.response') throw new Error(`意外的应答 ${res.type}`);
      if (!res.ok || res.file === undefined) throw new FsRequestError(res.error?.code ?? 'io', res.error?.message ?? '读取文件失败');
      const file = res.file;
      const parts: Uint8Array[] = [];
      await this.#blobs().downloadDecrypted(file.blobId, file.key, (chunk) => {
        parts.push(chunk);
      }, { maxBytes: file.size });
      const blob = new Blob(parts as BlobPart[], { type: file.mime === '' ? 'application/octet-stream' : file.mime });
      const url = createObjectUrl(blob);
      if (url === undefined) throw new Error('当前环境无法显示文件');
      const opened: OpenedFile = { file, blob, url };
      const old = this.#files.get(key);
      if (old !== undefined && old.url !== url) URL.revokeObjectURL(old.url);
      this.#files.set(key, opened);
      return opened;
    })().finally(() => {
      this.#fileInflight.delete(key);
    });
    this.#fileInflight.set(key, task);
    return task;
  }

  #blobs(): BlobClient {
    const peer = this.#peer;
    if (peer === null) throw new Error('尚未配对');
    this.#blobClient ??= new BlobClient({
      baseUrl: httpBase(peer.serverUrl),
      getToken: (refresh) => this.#blobToken(refresh),
      ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
    });
    return this.#blobClient;
  }

  /** blob 端点用的 token：沿用 WS 那张（未过期时），否则重新挑战-应答并存回 peer */
  async #blobToken(refresh: boolean): Promise<string> {
    const peer = this.#peer;
    if (peer === null) throw new Error('尚未配对');
    const current = peer.authToken;
    if (!refresh && current !== undefined && current.expiresAt - 60_000 > this.deps.clock.now()) return current.token;
    const auth = new AuthClient({
      baseUrl: httpBase(peer.serverUrl),
      deviceId: this.#identity.deviceId,
      signKeys: this.#identity.sign,
      ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
    });
    const token = await auth.authenticate({ signal: AbortSignal.timeout(15_000) });
    if (this.#peer === peer) {
      peer.authToken = token;
      this.#schedulePeerSave();
    }
    return token.token;
  }

  /** 任意 c2a 事件（不等应答）；返回是否发出（fatal scope 为 false） */
  send(machineId: string, body: OutboundBody): boolean {
    return this.#safeSend(machineId, body);
  }

  /**
   * 请求-应答：按 reqId 关联。目标机器已知离线 → 立即失败不发帧。
   * body 里没给 reqId 会自动生成。
   */
  request<T extends Extract<OutboundBody, { reqId: string }>>(
    machineId: string,
    body: Omit<T, 'reqId'> & { reqId?: string },
    options: { timeoutMs?: number } = {},
  ): Promise<AgentToClientEvent> {
    const machine = this.#machines.get(machineId);
    if (machine === undefined) return Promise.reject(new Error(`机器 ${machineId} 未配对`));
    if (machine.online === false) return Promise.reject(new Error(`机器 ${machine.name} 离线，请求未发送`));
    const reqId = body.reqId ?? this.#uuid();
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    return new Promise<AgentToClientEvent>((resolve, reject) => {
      const timer = this.deps.clock.setTimeout(() => {
        this.#pending.delete(reqId);
        reject(new RequestTimeoutError((body as { type: string }).type, timeoutMs));
      }, timeoutMs);
      this.#pending.set(reqId, { resolve, reject, timer });
      try {
        this.#outbox.send(machineId, { ...body, reqId } as OutboundBody);
        this.#emitQueue();
      } catch (err) {
        this.#pending.delete(reqId);
        this.deps.clock.clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async listSessions(machineId: string): Promise<SessionMeta[]> {
    // 列表要按置顶工作区排（cwd.updated.pinned），而 cwd 快照平时只在打开新建会话 / 聊天页时拉：
    // 顺带拉一次，失败不影响列表
    void this.request(machineId, { type: 'cwd.list.request' }).catch(() => undefined);
    const res = await this.request(machineId, { type: 'session.list.request' });
    return res.type === 'session.list.response' ? res.sessions : [];
  }

  async createSession(
    machineId: string,
    args: { cwd: string; model: string; permissionMode: SessionMeta['permissionMode'] },
  ): Promise<SessionMeta> {
    const res = await this.request(machineId, { type: 'session.create', ...args });
    if (res.type !== 'session.create.response') throw new Error(`意外的应答 ${res.type}`);
    this.openSession(machineId, res.session.sessionId);
    return res.session;
  }

  /**
   * 会话元数据命令（session-list-v2 §2）：rename / archive / pin / delete。
   *
   * 走 `request()`，应答是机器级 `session.mutate.response`（按 reqId 关联）。
   * 业务拒绝抛 `SessionMutateError`（message 是 agent 的原话）；超时抛
   * `RequestTimeoutError`，message 换成 `MUTATE_TIMEOUT_HINT`——旧 agent 不认识
   * 这些帧、只会静默丢弃，超时是它唯一的表现。
   *
   * 成功时列表的变化**不在这里改**：agent 在应答之前已在同一条机器级流上广播
   * `session.updated` / `session.removed`（流内有序），到这里时已经落地。
   * delete 例外地再清一次本地缓存（幂等），防广播那帧因故没到。
   */
  async renameSession(machineId: string, sessionId: string, title: string): Promise<void> {
    await this.#mutate(machineId, { type: 'session.rename', sessionId, title });
  }

  async archiveSession(machineId: string, sessionId: string, archived: boolean): Promise<void> {
    await this.#mutate(machineId, { type: 'session.archive', sessionId, archived });
  }

  async pinSession(machineId: string, sessionId: string, pinned: boolean): Promise<void> {
    await this.#mutate(machineId, { type: 'session.pin', sessionId, pinned });
  }

  /**
   * 置顶 / 取消置顶工作区（sidebar-pin）。fire-and-forget（同 cwd.add）：agent 广播的
   * `cwd.updated` 带来新的 pinned。机器离线时发不出去返回 false。
   */
  pinWorkspace(machineId: string, cwd: string, pinned: boolean): boolean {
    return this.send(machineId, { type: 'cwd.pin', path: cwd, pinned });
  }

  async deleteSession(machineId: string, sessionId: string): Promise<void> {
    await this.#mutate(machineId, { type: 'session.delete', sessionId });
    this.#removeSession(machineId, sessionId);
  }

  async #mutate(
    machineId: string,
    body:
      | { type: 'session.rename'; sessionId: string; title: string }
      | { type: 'session.archive'; sessionId: string; archived: boolean }
      | { type: 'session.pin'; sessionId: string; pinned: boolean }
      | { type: 'session.delete'; sessionId: string },
  ): Promise<void> {
    let res: AgentToClientEvent;
    try {
      res = await this.request(machineId, body);
    } catch (err) {
      if (err instanceof RequestTimeoutError) throw new RequestTimeoutError(err.requestType, err.timeoutMs, MUTATE_TIMEOUT_HINT);
      throw err;
    }
    if (res.type !== 'session.mutate.response') throw new Error(`意外的应答 ${res.type}`);
  }

  /**
   * 会话已被永久删除：清掉本地关于它的一切（评审 B4 的 web 清单）——
   * sessions 条目、时间线（内存 + 文档 + 挂着的落盘/撤回定时器）、
   * `peer.sessions[sid]`、`inCursors[sid]`、capabilities、openSessions、
   * 同步中标记、outbox 里该 scope 的待发帧与重发缓冲。本地 parked 条目活在
   * 时间线里，随时间线一起走（parked 过期定时器随后重排）。
   *
   * 幂等：广播与本设备的删除应答都会走到这里，只有第一次真清到东西时才发
   * `sessionRemoved`（视图据此跳回列表）。`outSeq[sid]` 刻意保留，理由见
   * `Outbox.dropScope`。
   */
  #removeSession(machineId: string, sessionId: string): void {
    if (sessionId === MACHINE_SCOPE) return;
    const key = timelineKey(machineId, sessionId);
    let changed = false;

    const sessions = this.#sessions.get(machineId);
    if (sessions !== undefined && sessionId in sessions) {
      changed = true;
      const { [sessionId]: _gone, ...rest } = sessions;
      this.#sessions.set(machineId, rest);
      this.#scheduleMachineDocSave(machineId);
      this.#emit('sessions', machineId, rest);
    }

    const mp = this.#machinePeer(machineId);
    if (mp !== undefined) {
      // 记住「已删」（评审 CM1）：之后的回放帧 / 深链 / 同步都据此拦下
      const firstTime = mp.removedSessions?.[sessionId] === undefined;
      if (firstTime) mp.removedSessions = { ...mp.removedSessions, [sessionId]: this.deps.clock.now() };
      if (sessionId in mp.sessions || sessionId in mp.inCursors) {
        changed = true;
        delete mp.sessions[sessionId];
        delete mp.inCursors[sessionId];
        // 删键必须 force：persistPeer 默认与存储现值按键取 max，会把游标合回来
        this.#savePeerNow(true);
      } else if (firstTime) {
        this.#savePeerNow();
      }
    }

    const saveTimer = this.#saveTimers.get(key);
    if (saveTimer !== undefined) {
      this.deps.clock.clearTimeout(saveTimer.handle);
      this.#saveTimers.delete(key);
    }
    const recallTimer = this.#recallTimers.get(key);
    if (recallTimer !== undefined) {
      this.deps.clock.clearTimeout(recallTimer);
      this.#recallTimers.delete(key);
    }
    if (this.#timelines.delete(key)) changed = true;
    void deleteTimeline(this.deps.docs, key).catch((err: unknown) =>
      this.#log(`[client] 删除时间线文档失败 ${key}：${String(err)}`),
    );

    if (this.#capabilities.delete(key)) changed = true;
    if (this.#openSessions.delete(key)) changed = true;
    if (key in this.#syncing) {
      delete this.#syncing[key];
      this.#emitSync();
    }
    if (this.#outbox.dropScope(machineId, sessionId).length > 0) changed = true;
    this.#emitQueue();
    this.#armParkedExpiry();

    if (changed) this.#emit('sessionRemoved', machineId, sessionId);
  }

  /**
   * 用户打开某会话：记入 peer.sessions，若游标 0 且无时间线则立刻同步
   * （否则永远看不到该会话的历史）。
   *
   * 已永久删除的会话（浏览器后退 / 书签深链回来）返回 false、什么都不做——
   * 否则会把它加回 peer.sessions 并从 relay 留存里 backfill 出整份时间线（评审 CM1）。
   * 视图据此提示并跳回列表。
   */
  openSession(machineId: string, sessionId: string): boolean {
    if (this.#isRemoved(machineId, sessionId)) return false;
    const key = timelineKey(machineId, sessionId);
    const wasOpen = this.#openSessions.has(key);
    this.#openSessions.add(key);
    const mp = this.#machinePeer(machineId);
    if (!mp) return true;
    if (mp.sessions[sessionId] === undefined) {
      mp.sessions[sessionId] = { lastActivityAt: this.deps.clock.now() };
      this.#schedulePeerSave();
    }
    if (!this.#timelines.has(key)) {
      this.#timelines.set(key, emptyTimeline());
      this.#emit('timeline', machineId, sessionId, emptyTimeline());
    }
    if (!wasOpen && this.#connection?.isOpen && !this.#inbound.isSyncing(machineId, sessionId)) {
      const cursor = mp.inCursors[sessionId] ?? 0;
      const hasEntries = (this.#timelines.get(key)?.entries.length ?? 0) > 0;
      if (cursor === 0 && !hasEntries) this.#requestSync(machineId, sessionId, 0, 'normal');
      else if (cursor > 0 && !hasEntries) this.#requestSync(machineId, sessionId, 0, 'backfill');
    }
    return true;
  }

  #isRemoved(machineId: string, sessionId: string): boolean {
    const at = this.#machinePeer(machineId)?.removedSessions?.[sessionId];
    return at !== undefined && this.deps.clock.now() - at < REMOVED_SESSION_TTL_MS;
  }

  /**
   * 启动时清过期的「已删」记忆。连同它残留的入站游标一起清（回放帧被丢弃时
   * Inbound 仍会推进游标，把 inCursors[sid] 写回来）——过期后服务端也没有它的帧了。
   */
  #pruneRemovedSessions(): void {
    if (this.#peer === null) return;
    const now = this.deps.clock.now();
    let changed = false;
    for (const mp of Object.values(this.#peer.machines)) {
      if (mp.removedSessions === undefined) continue;
      for (const [sid, at] of Object.entries(mp.removedSessions)) {
        if (now - at < REMOVED_SESSION_TTL_MS) continue;
        delete mp.removedSessions[sid];
        if (mp.sessions[sid] === undefined) delete mp.inCursors[sid];
        changed = true;
      }
      if (Object.keys(mp.removedSessions).length === 0) delete mp.removedSessions;
    }
    // 删了游标键：必须 force，否则 persistPeer 按键取 max 合回来
    if (changed) this.#savePeerNow(true);
  }

  /**
   * 向 agent 拉一页本机转录历史并并进时间线（mergeHistory：cutoff + 去重 + 前插）。
   *
   * - 默认拉最新一页（打开会话、sync 结束后由视图调一次，见 shouldAutoLoadHistory）；
   * - `older: true` 按时间线里记的游标翻更早一页，没有更多时直接返回；
   * - 同一会话进行中的拉取复用同一个 promise（自动触发与按钮连点都不会重复发）。
   *
   * 响应是定向帧，只有本设备收得到；超时给得比普通 request 长——agent 要读文件，
   * 而且若这时会话恰好在补发，响应会在暂存区里等到 sync.done。
   */
  loadHistory(machineId: string, sessionId: string, options: { older?: boolean } = {}): Promise<void> {
    const key = timelineKey(machineId, sessionId);
    const inflight = this.#historyInflight.get(key);
    if (inflight !== undefined) return inflight;
    const history = this.timeline(machineId, sessionId).history;
    if (options.older === true && history?.hasMore !== true) return Promise.resolve();
    const before = options.older === true ? history?.cursor : undefined;
    const task = this.request(
      machineId,
      { type: 'session.history.request', sessionId, ...(before === undefined ? {} : { before }) },
      { timeoutMs: Math.max(this.#requestTimeoutMs, 30_000) },
    )
      .then((res) => {
        if (res.type !== 'session.history.response') throw new Error(`意外的应答 ${res.type}`);
        this.#updateTimeline(machineId, sessionId, (tl) => mergeHistory(tl, res));
      })
      .finally(() => {
        this.#historyInflight.delete(key);
      });
    this.#historyInflight.set(key, task);
    return task;
  }

  /**
   * 拉某次子 agent 调用（父 Agent/Task 的 toolUseId）的过程并挂到父工具条目下
   * （`subagent.history.request`，agent ≥ 0.8.0；版本门控由调用方做）。
   *
   * 历史回看里的 Task 卡没有实时收到的子工具卡，展开时由卡片调这里。同一调用并发
   * 复用同一个 promise。响应是定向帧；agent 读文件，超时给得同历史拉取。
   */
  loadSubagentHistory(machineId: string, sessionId: string, toolUseId: string): Promise<void> {
    const key = `${timelineKey(machineId, sessionId)}#${toolUseId}`;
    const inflight = this.#subagentInflight.get(key);
    if (inflight !== undefined) return inflight;
    // 显式标注的窄类型让 request 的泛型推断落在这一种帧上（同 stopBgTask）
    const body: { type: 'subagent.history.request'; sessionId: string; toolUseId: string } = {
      type: 'subagent.history.request',
      sessionId,
      toolUseId,
    };
    const task = this.request(machineId, body, { timeoutMs: Math.max(this.#requestTimeoutMs, 30_000) })
      .then((res) => {
        if (res.type !== 'subagent.history.response') throw new Error(`意外的应答 ${res.type}`);
        if (this.#isRemoved(machineId, sessionId)) return;
        this.#updateTimeline(machineId, sessionId, (tl) => mergeSubagentHistory(tl, toolUseId, res.items));
      })
      .finally(() => {
        this.#subagentInflight.delete(key);
      });
    this.#subagentInflight.set(key, task);
    return task;
  }

  /**
   * 打开会话时补拉斜杠命令清单（`session.commands.request`，agent ≥ 0.5.0）。
   *
   * `session.capabilities` 只在 agent 那边会话进程起来（首条消息）后才来，且
   * capabilities 只存内存——刷新 / agent 重启后、发消息前斜杠菜单是空的。
   * 只在「机器在线、agent 支持、该会话还没有命令清单」时发；同会话并发复用同一个
   * promise。拿到后写入 capabilities（保留已有 models / mcpServers，没有就空数组）；
   * 期间 init 先到了的，以 init 的命令名为准、只把描述并进去。
   *
   * 响应是定向帧；agent 冷探测要起一次 claude（一两秒），超时给得同历史拉取。
   */
  loadCommands(machineId: string, sessionId: string): Promise<void> {
    const key = timelineKey(machineId, sessionId);
    const inflight = this.#commandsInflight.get(key);
    if (inflight !== undefined) return inflight;
    const machine = this.#machines.get(machineId);
    if (machine === undefined || machine.online !== true) return Promise.resolve();
    if (!agentSupportsCommands(machine.info?.agentVersion)) return Promise.resolve();
    if ((this.#capabilities.get(key)?.slashCommands.length ?? 0) > 0) return Promise.resolve();
    const task = this.request(
      machineId,
      { type: 'session.commands.request', sessionId },
      { timeoutMs: Math.max(this.#requestTimeoutMs, 30_000) },
    )
      .then((res) => {
        if (res.type !== 'session.commands.response') throw new Error(`意外的应答 ${res.type}`);
        if (this.#isRemoved(machineId, sessionId)) return;
        const cur = this.#capabilities.get(key);
        const slashCommands =
          cur !== undefined && cur.slashCommands.length > 0
            ? mergeCommandDescriptions(cur.slashCommands, res.slashCommands)
            : res.slashCommands;
        const caps: Capabilities = {
          slashCommands,
          models: cur?.models ?? [],
          mcpServers: cur?.mcpServers ?? [],
        };
        this.#capabilities.set(key, caps);
        this.#emit('capabilities', machineId, sessionId, caps);
      })
      .finally(() => {
        this.#commandsInflight.delete(key);
      });
    this.#commandsInflight.set(key, task);
    return task;
  }

  /** 该会话是否有进行中的历史拉取 */
  isLoadingHistory(machineId: string, sessionId: string): boolean {
    return this.#historyInflight.has(timelineKey(machineId, sessionId));
  }

  closeSession(machineId: string, sessionId: string): void {
    this.#openSessions.delete(timelineKey(machineId, sessionId));
  }

  // -------------------------------------------------------------------------
  // 配对 / 重置
  // -------------------------------------------------------------------------

  /**
   * 造一个配对流程：identity（含签名私钥）由 lib 内部注入，UI 拿不到私钥。
   * serverUrl 的单服务端校验用当前 peer。
   */
  createPairingFlow(options: Omit<PairingDeps, 'identity' | 'currentServerUrl' | 'fetchImpl'>): PairingFlow {
    return new PairingFlow({
      ...options,
      identity: this.#identity,
      currentServerUrl: this.#peer?.serverUrl ?? null,
      ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
    });
  }

  /**
   * 配对完成（authenticate 已成功）：写 peer、接入、缺 machineId 时等首条
   * 在线 machine.status（10s）。返回最终 machineId。
   */
  async completePairing(result: PairingResult, options: { machineWaitMs?: number } = {}): Promise<string> {
    if (this.#peer !== null && httpBase(this.#peer.serverUrl) !== httpBase(result.serverUrl)) {
      throw new Error(`MVP 只支持单服务端：已配对 ${this.#peer.serverUrl}，无法再配对 ${result.serverUrl}`);
    }
    if (this.#peer === null) {
      this.#peer = { v: 1, serverUrl: result.serverUrl, authToken: result.token, machines: {} };
    } else {
      this.#peer.authToken = result.token;
    }
    this.#savePeerNow();
    this.#emit('peer', this.#peer);

    let machineId = result.machineId;
    if (machineId === undefined) {
      // 旧 QR：接入后等第一条在线 machine.status（多机场景可能记错，UI 提示核对）
      this.#started = true;
      this.#connect();
      machineId = await this.#waitForOnlineMachine(options.machineWaitMs ?? 10_000);
    }

    const existing = this.#peer.machines[machineId];
    const mp: MachinePeer = existing
      ? { ...existing, agentBoxPubKey: result.agentBoxPubKey, pairedAt: this.deps.clock.now() }
      : {
          agentBoxPubKey: result.agentBoxPubKey,
          pairedAt: this.deps.clock.now(),
          outSeq: {},
          inCursors: {},
          sessions: {},
        };
    this.#peer.machines[machineId] = mp;
    if (!this.#machines.has(machineId)) this.#machines.set(machineId, emptyMachine(machineId, mp.name));
    this.#savePeerNow();
    this.#emit('peer', this.#peer);
    this.#emit('machine', this.#machines.get(machineId)!);

    // 配对完成即视为「要连」：无论此前是否 start 过，都确保接入并挂上 parked 过期检查
    this.#started = true;
    if (this.#connection?.isOpen) this.#syncMachine(machineId);
    else this.#connect();
    this.#armParkedExpiry();
    return machineId;
  }

  #waitForOnlineMachine(timeoutMs: number): Promise<string> {
    const online = this.machines().find((m) => m.online === true);
    if (online) return Promise.resolve(online.machineId);
    return new Promise<string>((resolve, reject) => {
      const timer = this.deps.clock.setTimeout(() => {
        const idx = this.#machineWaiters.findIndex((w) => w.resolve === wrapped);
        if (idx >= 0) this.#machineWaiters.splice(idx, 1);
        reject(new Error('没有看到在线的 agent，无法确定 machineId；请确认 agent 仍在运行后重试'));
      }, timeoutMs);
      const wrapped = (machineId: string) => {
        this.deps.clock.clearTimeout(timer);
        resolve(machineId);
      };
      this.#machineWaiters.push({ resolve: wrapped });
    });
  }

  /** 忘记服务端与全部时间线，保留 identity（免重配对时换设备身份） */
  async resetLocalState(): Promise<void> {
    // 只断连不清 #started：重置是「忘记服务端」，不是「关掉客户端」——
    // 紧接着的 completePairing 必须无需刷新就自动建连（评审阶段 1 B1）
    this.#disconnect();
    this.#peer = null;
    clearPeer(this.deps.kv);
    for (const timer of this.#machineSaveTimers.values()) this.deps.clock.clearTimeout(timer.handle);
    this.#machineSaveTimers.clear();
    this.#machineDocDirty.clear();
    await deleteAllTimelines(this.deps.docs);
    await deleteAllMachineDocs(this.deps.docs);
    this.#timelines.clear();
    this.#machines.clear();
    this.#sessions.clear();
    this.#capabilities.clear();
    this.#openSessions.clear();
    for (const p of this.#pending.values()) {
      this.deps.clock.clearTimeout(p.timer);
      p.reject(new Error('本地状态已重置'));
    }
    this.#pending.clear();
    this.#emit('peer', null);
  }

  /** 服务端序号重置后的恢复：该 scope 游标置 0、时间线清空、重新同步 */
  resetScopeCursor(machineId: string, scope: string): void {
    const mp = this.#machinePeer(machineId);
    if (!mp) return;
    this.#resetScopeInMemory(mp, machineId, scope);
    this.#savePeerNow(true);
    if (this.#connection?.isOpen) this.#requestSync(machineId, scope, 0, 'normal');
  }

  /**
   * 一个 scope 的内存态重置：游标归零 + 清时间线 + 通知 UI + 排落盘。
   *
   * 与 `resetScopeCursor` 拆开，是为了让 `resetMachineCursors` 能把
   * **全量 PeerState 落盘**与 `sync.request` 挪到循环外（评审 N6）。
   */
  #resetScopeInMemory(mp: MachinePeer, machineId: string, scope: string): void {
    mp.inCursors[scope] = 0;
    if (scope === MACHINE_SCOPE) return;
    const key = timelineKey(machineId, scope);
    // 旧纪元的条目 id（type:seq）会与新序号撞车导致新事件被当重复吞掉，所以清空
    this.#timelines.set(key, emptyTimeline());
    this.#emit('timeline', machineId, scope, emptyTimeline());
    this.#scheduleTimelineSave(key);
  }

  /**
   * 重置这台机器**全部**流的入站游标（机器级 + 名下每个会话）。
   *
   * 为什么必须在 lib 做（评审 M7）：UI 早先按 store 里的 `sessions[machineId]`
   * 迭代，而这个按钮的适用场景（服务端库被删 → 用户刷新页面）里它恰好可能
   * 不全——`sessions` 只有拉过 `session.list` 才有，且不含「本地有时间线但
   * agent 列表里已经没有」的会话。lib 这里能看到三个来源的并集：
   * 持久化的 `peer.sessions`、已加载的时间线、当前打开的会话。
   *
   * @returns 实际重置的流数（含机器级那一条），供 UI 报数
   */
  resetMachineCursors(machineId: string): number {
    const mp = this.#machinePeer(machineId);
    if (!mp) return 0;
    const scopes = new Set<string>(Object.keys(mp.sessions));
    for (const key of this.#timelines.keys()) {
      const parsed = parseTimelineKey(key);
      if (parsed?.machineId === machineId) scopes.add(parsed.sessionId);
    }
    for (const key of this.#openSessions) {
      const parsed = parseTimelineKey(key);
      if (parsed?.machineId === machineId) scopes.add(parsed.sessionId);
    }
    // **循环内只改内存**（评审 N6）：早先每个 scope 都各自
    // `#savePeerNow(true)`（clear + 全量 PeerState 序列化写 localStorage）
    // + `#requestSync` + emit。这个按钮的适用场景恰恰是「会话很多且全乱了」
    // ——真机 339 个会话就是 339 次全量序列化同步写，主线程冻结数秒，
    // 手机上表现为点一下按钮页面假死。落盘与 sync 一律挪到循环外。
    for (const sessionId of scopes) this.#resetScopeInMemory(mp, machineId, sessionId);
    this.#resetScopeInMemory(mp, machineId, MACHINE_SCOPE);
    this.#savePeerNow(true); // 全部 scope 改完，写一次
    if (this.#connection?.isOpen) {
      for (const sessionId of scopes) this.#requestSync(machineId, sessionId, 0, 'normal');
      this.#requestSync(machineId, MACHINE_SCOPE, 0, 'normal');
    }
    return scopes.size + 1;
  }

  /** seq_too_far_ahead 的恢复：出站计数器归零 */
  resetOutSeq(machineId: string, scope: string): void {
    this.#outbox.resetScope(machineId, scope);
    this.#savePeerNow(true);
  }

  /** 本地改机器展示名（乐观）并发 machine.rename */
  renameMachine(machineId: string, name: string): void {
    const mp = this.#machinePeer(machineId);
    if (!mp) return;
    mp.name = name;
    this.#schedulePeerSave();
    this.#updateMachine(machineId, (m) => ({ ...m, name }));
    this.#safeSend(machineId, { type: 'machine.rename', name });
  }

  /**
   * 在代理机上跑 `claude update`（agent >= 0.4.0，调用方先做能力探测）。
   *
   * 业务失败（busy / not_found / timeout / failed）**不抛**，原样返回应答让界面
   * 展示原因与输出尾部；只有发不出去（离线 / 未配对）与等不到应答才抛。成功时
   * agent 已先广播过新版本的 machine.info（同一条机器级流，有序），机器卡到这里
   * 已是新版本。
   */
  async updateClaude(machineId: string): Promise<ClaudeUpdateResult> {
    let res: AgentToClientEvent;
    try {
      res = await this.request(machineId, { type: 'machine.claude.update.request' }, { timeoutMs: CLAUDE_UPDATE_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof RequestTimeoutError) throw new RequestTimeoutError(err.requestType, err.timeoutMs, MUTATE_TIMEOUT_HINT);
      throw err;
    }
    if (res.type !== 'machine.claude.update.response') throw new Error(`意外的应答 ${res.type}`);
    return res;
  }

  /**
   * 立即检查 claude 最新版本（machine.info.claudeLatest 存在才支持，调用方先做能力探测）。
   * 结果随 agent 先广播的 machine.info.claudeLatest 到达；业务失败不抛，发不出去 / 超时才抛。
   */
  async checkClaude(machineId: string): Promise<ClaudeCheckResult> {
    let res: AgentToClientEvent;
    try {
      res = await this.request(machineId, { type: 'machine.claude.check.request' }, { timeoutMs: CLAUDE_CHECK_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof RequestTimeoutError) throw new RequestTimeoutError(err.requestType, err.timeoutMs, MUTATE_TIMEOUT_HINT);
      throw err;
    }
    if (res.type !== 'machine.claude.check.response') throw new Error(`意外的应答 ${res.type}`);
    return res;
  }

  /**
   * 重启 agent（machine.info.restart 存在才支持，调用方先做能力探测）：`schedule` 等会话空闲后重启，
   * `now` 立即重启，`cancel` 取消。应答在预检结束后到达；排空进度随 machine.info.restart 广播。
   * 业务失败不抛，发不出去 / 超时才抛。
   */
  async restartAgent(machineId: string, action: 'schedule' | 'now' | 'cancel'): Promise<AgentRestartResult> {
    let res: AgentToClientEvent;
    try {
      res = await this.request<Extract<OutboundBody, { type: 'machine.agent.restart.request' }>>(
        machineId,
        { type: 'machine.agent.restart.request', action },
        action === 'cancel' ? {} : { timeoutMs: AGENT_RESTART_TIMEOUT_MS },
      );
    } catch (err) {
      if (err instanceof RequestTimeoutError) throw new RequestTimeoutError(err.requestType, err.timeoutMs, MUTATE_TIMEOUT_HINT);
      throw err;
    }
    if (res.type !== 'machine.agent.restart.response') throw new Error(`意外的应答 ${res.type}`);
    return res;
  }

  /**
   * 取一次资源快照（agent >= 0.14.0，调用方先做能力探测），可选订阅定时推送（见 core
   * `machine.stats.request`）。快照经 #apply 落进 machines[id].stats；这里只等应答，超时才抛。
   */
  async requestMachineStats(machineId: string, watch?: { intervalMs: number; ttlMs: number }): Promise<void> {
    const res = await this.request(machineId, {
      type: 'machine.stats.request',
      ...(watch === undefined ? {} : { watch }),
    });
    if (res.type !== 'machine.stats') throw new Error(`意外的应答 ${res.type}`);
  }

  /**
   * 手动刷新这台机器的订阅限额用量（agent >= 0.12.0，调用方先做能力探测）。新数据随
   * agent 先广播的 machine.info 到达；这里只返回成败。业务失败不抛，发不出去 / 超时才抛。
   */
  async refreshUsage(machineId: string): Promise<UsageRefreshResult> {
    const res = await this.request(machineId, { type: 'machine.usage.request' }, { timeoutMs: USAGE_REFRESH_TIMEOUT_MS });
    if (res.type !== 'machine.usage.response') throw new Error(`意外的应答 ${res.type}`);
    return res;
  }

  /**
   * 手动刷新会话的 context 用量（agent >= 0.13.0，调用方先做能力探测）。新值随 agent
   * 先广播的 session.updated 到达；这里只返回成败。业务失败不抛，发不出去 / 超时才抛。
   */
  // -------------------------------------------------------------------------
  // 扩展（ext.*，agent 带 machine.info.extensions 时才支持；视图模型见 lib/ext-model.ts）
  // -------------------------------------------------------------------------

  /** 扩展请求-应答：agent 定向回本设备，按 reqId 关联 */
  extRequest<T extends AgentToClientEvent['type']>(
    machineId: string,
    body: Extract<OutboundBody, { reqId: string }> extends infer B ? Omit<B & { type: string }, 'reqId'> : never,
    expect: readonly T[],
    timeoutMs = EXT_REQUEST_TIMEOUT_MS,
  ): Promise<Extract<AgentToClientEvent, { type: T }>> {
    return this.request(machineId, body as never, { timeoutMs }).then((res) => {
      if (!(expect as readonly string[]).includes(res.type)) throw new Error(`意外的应答 ${res.type}`);
      return res as Extract<AgentToClientEvent, { type: T }>;
    });
  }

  /** 发而不等应答（ext.action.cancel、退订） */
  extSend(machineId: string, body: OutboundBody): boolean {
    return this.#safeSend(machineId, body);
  }

  /**
   * agent 代发的消息（扩展的 prompt.send）在会话忙时排队：排队回执只对有本地条目的设备生效，
   * 所以发起设备补一条本地「排队中」条目，撤回 / 停止恢复文字照常工作。已有同 id 条目
   * （回显先到了）就不补。
   */
  adoptAgentSentInput(machineId: string, sessionId: string, clientMsgId: string, text: string): void {
    const exists = this.timeline(machineId, sessionId).entries.some((e) => e.kind === 'user' && e.id === clientMsgId);
    if (exists) return;
    // 取消回执比动作结果先到：按它的结局补条目（撤回的不补；停止 / 关闭的显示为未发送，可重发或编辑）
    const key = `${machineId}\n${sessionId}\n${clientMsgId}`;
    const cancelled = this.#orphanCancels.get(key);
    this.#orphanCancels.delete(key);
    if (cancelled === 'recalled') return;
    this.#updateTimeline(machineId, sessionId, (tl) => {
      const added = addLocalUserEntry(tl, { clientMsgId, text, ts: this.deps.clock.now() });
      return cancelled === undefined
        ? setLocalStatus(added, clientMsgId, 'queued')
        : setLocalStatus(added, clientMsgId, 'cancelled', { failReason: cancelled === 'stopped' ? '已停止，未发送' : '会话关闭，未发送' });
    });
  }

  async refreshContext(machineId: string, sessionId: string): Promise<ContextRefreshResult> {
    const res = await this.request(
      machineId,
      { type: 'session.context.request', sessionId },
      { timeoutMs: USAGE_REFRESH_TIMEOUT_MS },
    );
    if (res.type !== 'session.context.response') throw new Error(`意外的应答 ${res.type}`);
    return res;
  }

  /** 仅本地移除机器（agent 未实现 machine.unpair） */
  async forgetMachine(machineId: string): Promise<void> {
    if (!this.#peer) return;
    delete this.#peer.machines[machineId];
    this.#machines.delete(machineId);
    this.#sessions.delete(machineId);
    // 先撤掉待落盘的写，否则去抖回调会把刚删的文档写回来
    const timer = this.#machineSaveTimers.get(machineId);
    if (timer) {
      this.deps.clock.clearTimeout(timer.handle);
      this.#machineSaveTimers.delete(machineId);
    }
    this.#machineDocDirty.delete(machineId);
    await deleteMachineDoc(this.deps.docs, machineId);
    for (const key of [...this.#timelines.keys()]) {
      if (key.startsWith(`${machineId}/`)) {
        this.#timelines.delete(key);
        await this.deps.docs.del(`timeline:${key}`);
      }
    }
    this.#savePeerNow(true);
    this.#emit('peer', this.#peer);
  }

  updatePrefs(patch: Partial<Omit<Prefs, 'v'>>): void {
    this.#prefs = { ...this.#prefs, ...patch };
    savePrefs(this.deps.kv, this.#prefs);
    this.#emit('prefs', this.#prefs);
  }

  // -------------------------------------------------------------------------
  // 状态更新与持久化
  // -------------------------------------------------------------------------

  #machinePeer(machineId: string): MachinePeer | undefined {
    return this.#peer?.machines[machineId];
  }

  #touchSession(machineId: string, sessionId: string, at: number): void {
    const mp = this.#machinePeer(machineId);
    if (!mp) return;
    const cur = mp.sessions[sessionId];
    if (cur === undefined || cur.lastActivityAt < at) {
      mp.sessions[sessionId] = { lastActivityAt: at };
      this.#schedulePeerSave();
    }
  }

  #updateTimeline(machineId: string, sessionId: string, fn: (tl: Timeline) => Timeline): void {
    const key = timelineKey(machineId, sessionId);
    const cur = this.#timelines.get(key) ?? emptyTimeline();
    const next = fn(cur);
    if (next === cur) return;
    this.#timelines.set(key, next);
    this.#scheduleTimelineSave(key);
    this.#emit('timeline', machineId, sessionId, next);
  }

  #updateSessions(machineId: string, fn: (s: Record<string, SessionMeta>) => Record<string, SessionMeta>): void {
    const cur = this.#sessions.get(machineId) ?? {};
    const next = fn(cur);
    if (next === cur) return;
    this.#sessions.set(machineId, next);
    // SessionMeta 同样是快照型：session.list.response 只在请求时来，
    // 机器离线时刷新页面就再也拉不到——列表会空成 0 行
    this.#scheduleMachineDocSave(machineId);
    this.#emit('sessions', machineId, next);
  }

  #updateMachine(machineId: string, fn: (m: MachineState) => MachineState): void {
    const cur = this.#machines.get(machineId) ?? emptyMachine(machineId, this.#machinePeer(machineId)?.name);
    const next = fn(cur);
    if (next === cur) return;
    this.#machines.set(machineId, next);
    // info / cwd 是快照型事件，游标越过后服务端不会再补，必须落盘（否则刷新即丢）。
    // online / lastSeenAt / parkedCount 是 transport 帧，每次接入都会重来，不落。
    if (next.info !== cur.info || next.cwd !== cur.cwd) this.#scheduleMachineDocSave(machineId);
    this.#emit('machine', next);
  }

  /**
   * 加载每机器快照（`machine.info` / cwd / SessionMeta）。
   *
   * 必须在 `#loadTimelines` **之前**：后者会给没有 SessionMeta 的会话补一条
   * 只有 lastActivityAt 的占位，先加载快照才能让完整 meta 占住位置。
   *
   * 只加载已配对机器的快照；`removeMachine` 之后残留的孤儿文档顺手删掉。
   */
  async #loadMachineDocs(): Promise<void> {
    if (this.#peer === null) return;
    for (const machineId of Object.keys(this.#peer.machines)) {
      const doc = await loadMachineDoc(this.deps.docs, machineId, (n) =>
        // 静默丢弃正是 M10 那个 bug 当初难查的原因，留一行（评审 N7）
        this.#log(`[client] 机器快照 ${machineId} 丢弃 ${n} 条无法解析的会话行，其余保留`),
      );
      if (doc === null) continue;
      this.#machineDocDirty.delete(machineId);
      if (doc.info !== null || doc.cwd !== null) {
        const cur = this.#machines.get(machineId) ?? emptyMachine(machineId, this.#machinePeer(machineId)?.name);
        this.#machines.set(machineId, {
          ...cur,
          info: doc.info,
          cwd: doc.cwd,
          ...(doc.info === null ? {} : { name: doc.info.name }),
        });
      }
      if (Object.keys(doc.sessions).length > 0) {
        this.#sessions.set(machineId, { ...doc.sessions });
        // peer.sessions 是同步范围的判据（30 天活跃），落盘 meta 要能喂回去
        const mp = this.#machinePeer(machineId);
        if (mp) {
          for (const meta of Object.values(doc.sessions)) {
            const cur = mp.sessions[meta.sessionId]?.lastActivityAt ?? 0;
            if (meta.lastActivityAt > cur) mp.sessions[meta.sessionId] = { lastActivityAt: meta.lastActivityAt };
          }
        }
      }
    }
  }

  async #loadTimelines(): Promise<void> {
    if (this.#peer === null) return;
    for (const key of await listTimelineKeys(this.deps.docs)) {
      const parsed = parseTimelineKey(key);
      if (!parsed) continue;
      const mp = this.#machinePeer(parsed.machineId);
      if (!mp) continue;
      const loaded = await loadTimeline(this.deps.docs, key);
      if (!loaded) continue;
      const tl = markSendingAsFailed(loaded);
      this.#timelines.set(key, tl);
      // 有时间线 doc 时，游标 := doc.lastAppliedSeq（**不取 max**，评审阶段 1 A1）。
      // doc 里 entries 与 lastAppliedSeq 是同一份原子写入，恰好描述「已应用集合」；
      // peer 里的游标落盘节奏更快，流式期间可能领先 doc 一截——以它为准会把
      // 那一截钉成永久缺口（assistant.delta 非幂等，事后也补不回）。以 doc 为准
      // 重拉的帧都是未应用过的。而 peer 游标只在没有 doc 时才有意义（回填判据）。
      mp.inCursors[parsed.sessionId] = tl.lastAppliedSeq;
      if (mp.sessions[parsed.sessionId] === undefined) {
        const lastTs = tl.entries[tl.entries.length - 1]?.ts ?? 0;
        mp.sessions[parsed.sessionId] = { lastActivityAt: lastTs };
      }
      if (tl !== loaded) this.#scheduleTimelineSave(key);
    }
    // 主动回拨过游标：必须 force 写，否则 persistPeer 的取 max 会把旧的高游标合回来
    this.#savePeerNow(true);
  }

  /**
   * 时间线落盘：trailing 去抖 + 最大等待。纯 trailing 去抖在流式 delta 密集
   * （间隔 < debounce）时会被无限推后，而 peer 游标每个周期都落盘——刷新后
   * 游标领先时间线一截，那一截就是 A1 的缺口。maxWait 保证再密集也周期落盘。
   */
  #scheduleTimelineSave(key: string): void {
    const now = this.deps.clock.now();
    const existing = this.#saveTimers.get(key);
    const firstAt = existing?.firstAt ?? now;
    if (existing !== undefined) this.deps.clock.clearTimeout(existing.handle);
    const delay = Math.max(0, Math.min(this.#debounceMs, firstAt + this.#maxWaitMs - now));
    const handle = this.deps.clock.setTimeout(() => {
      this.#saveTimers.delete(key);
      this.#saveTimelineNow(key);
    }, delay);
    this.#saveTimers.set(key, { handle, firstAt });
  }

  /**
   * 机器快照落盘：与时间线同一套 trailing 去抖 + 最大等待。
   *
   * 去抖的理由和时间线一样——`run.state` 会把 SessionMeta 改得很密，
   * 每条都写一次 IndexedDB 没必要；maxWait 保证再密集也周期落盘。
   */
  #scheduleMachineDocSave(machineId: string): void {
    this.#machineDocDirty.add(machineId);
    const now = this.deps.clock.now();
    const existing = this.#machineSaveTimers.get(machineId);
    const firstAt = existing?.firstAt ?? now;
    if (existing !== undefined) this.deps.clock.clearTimeout(existing.handle);
    const delay = Math.max(0, Math.min(this.#debounceMs, firstAt + this.#maxWaitMs - now));
    const handle = this.deps.clock.setTimeout(() => {
      this.#machineSaveTimers.delete(machineId);
      this.#saveMachineDocNow(machineId);
    }, delay);
    this.#machineSaveTimers.set(machineId, { handle, firstAt });
  }

  #saveMachineDocNow(machineId: string): void {
    if (!this.#machineDocDirty.delete(machineId)) return;
    // 已移除的机器不再落盘（removeMachine 已删文档，这里避免把它写回来）
    if (this.#machinePeer(machineId) === undefined) return;
    const machine = this.#machines.get(machineId);
    void saveMachineDoc(this.deps.docs, machineId, {
      info: machine?.info ?? null,
      cwd: machine?.cwd ?? null,
      sessions: this.#sessions.get(machineId) ?? {},
    }).catch((err: unknown) => this.#log(`[client] 机器快照落盘失败 ${machineId}：${String(err)}`));
  }

  #saveTimelineNow(key: string): void {
    const tl = this.#timelines.get(key);
    if (tl) void saveTimeline(this.deps.docs, key, tl).catch((err: unknown) => this.#log(`[client] 时间线落盘失败 ${key}：${String(err)}`));
  }

  #schedulePeerSave(): void {
    if (this.#peerSaveTimer !== null) return;
    this.#peerSaveTimer = this.deps.clock.setTimeout(() => {
      this.#peerSaveTimer = null;
      this.#savePeerNow();
    }, this.#debounceMs);
  }

  /** 立即落盘；默认与存储现值取 max，`force` 用于游标/计数器人工归零 */
  #savePeerNow(force = false): void {
    if (this.#peerSaveTimer !== null) {
      this.deps.clock.clearTimeout(this.#peerSaveTimer);
      this.#peerSaveTimer = null;
    }
    if (this.#peer === null) return;
    if (force) {
      clearPeer(this.deps.kv);
    }
    this.#peer = persistPeer(this.deps.kv, this.#peer);
  }

  /** stop / 页面卸载前：把所有去抖中的落盘立刻做掉 */
  flushSaves(): void {
    this.#flushSaves();
  }

  #flushSaves(): void {
    this.#savePeerNow();
    for (const [key, timer] of this.#saveTimers) {
      this.deps.clock.clearTimeout(timer.handle);
      this.#saveTimelineNow(key);
    }
    this.#saveTimers.clear();
    for (const [machineId, timer] of this.#machineSaveTimers) {
      this.deps.clock.clearTimeout(timer.handle);
      this.#saveMachineDocNow(machineId);
    }
    this.#machineSaveTimers.clear();
  }

  // -------------------------------------------------------------------------
  // parked 本地过期
  // -------------------------------------------------------------------------

  #sweepParked(): void {
    const now = this.deps.clock.now();
    for (const key of [...this.#timelines.keys()]) {
      const parsed = parseTimelineKey(key);
      if (!parsed) continue;
      this.#updateTimeline(parsed.machineId, parsed.sessionId, (tl) => expireParked(tl, now));
    }
    this.#armParkedExpiry();
  }

  /** 按最近一个 expiresAt 定时；没有 parked 条目就不挂定时器 */
  #armParkedExpiry(): void {
    if (this.#parkedTimer !== null) {
      this.deps.clock.clearTimeout(this.#parkedTimer);
      this.#parkedTimer = null;
    }
    if (!this.#started) return;
    let next: number | null = null;
    for (const tl of this.#timelines.values()) {
      const at = nextParkedExpiry(tl);
      if (at !== null && (next === null || at < next)) next = at;
    }
    if (next === null) return;
    const delay = Math.max(0, next - this.deps.clock.now());
    this.#parkedTimer = this.deps.clock.setTimeout(() => {
      this.#parkedTimer = null;
      this.#sweepParked();
    }, delay);
  }
}

function rewindError(error: { code: RewindErrorCode; message: string } | undefined): RewindError {
  return error === undefined ? new RewindError('io', 'agent 拒绝了回退（未给原因）') : new RewindError(error.code, error.message);
}

function uploadErrorText(status: number, payload: { error?: unknown; maxBytes?: unknown }): string {
  if (status === 413) {
    const max = typeof payload.maxBytes === 'number' ? `（上限 ${Math.floor(payload.maxBytes / 1024 / 1024)}MB）` : '';
    return `文件超过服务端上限${max}`;
  }
  if (status === 503) return '服务端没有启用附件';
  if (status === 401) return '认证失败，请稍后重试';
  return `上传失败：HTTP ${status}${typeof payload.error === 'string' ? ` ${payload.error}` : ''}`;
}

/** 一次目录列表 */
export interface FsListing {
  path: string;
  root: string;
  entries: FsEntry[];
  truncated: boolean;
}

/** 已下载解密的文件：url 是对象 URL（client 持有，刷新时释放） */
export interface OpenedFile {
  file: FsFile;
  blob: Blob;
  url: string;
}

/** agent 拒绝了文件查看请求（code 见协议 FsErrorCode） */
export class FsRequestError extends Error {
  readonly code: FsErrorCode;
  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.name = 'FsRequestError';
    this.code = code;
  }
}

function createObjectUrl(blob: Blob): string | undefined {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : undefined;
}

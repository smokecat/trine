/**
 * 入站路由：已解密的 `ClientToAgentEvent` → SessionManager / cwd-store / identity。
 *
 * ## 每会话命令链
 *
 * 会话级事件一律挂到该 sessionId 的 Promise 链上串行执行。ClaudeSession 的
 * stop / setModel / setPermissionMode / close 都是 async，而 send / recall 是同步的：
 * 不串行的话「stop 紧接着 send」两帧同批到达时，send 会在 stop 的 interrupt
 * 还没落地前执行，新消息被半拆的 query 吃掉。链上任何异常捕获后转 error.fatal，
 * **不断链**——一条坏帧不能让这个会话此后全部命令都卡死。
 *
 * 机器级事件（session.create / list / cwd.* / machine.*）走一条独立的机器级链，
 * 同样串行：它们都会碰文件（cwd.json / identity.json）或并发名额，串行最省心。
 * 例外是 `machine.claude.update.request`：`claude update` 可能跑几分钟，在链上
 * await 会把 session.create / list 全堵住——链上只负责把它**发起**，执行在链外
 * （单飞由 ClaudeUpdater 保证），跑完再发机器级应答。`machine.usage.request` 同理
 * （可能要临时起一个 claude 进程，几秒到几十秒）。
 *
 * ## resolveSession：按需 resume + 去重 + 三级参数来源
 *
 * 远端对一个本进程没有活跃实例的 sessionId 发消息时，要把它 resume 起来。
 * 参数（cwd / model / permissionMode）按代价从低到高找：本地 state.json →
 * manager 的 meta 缓存 → SDK `listSessions`（慢，结果缓存 5s）。都没有 →
 * 机器级 `error.fatal(config)`——**不为不存在的会话开 seq 流**，否则任何
 * client 随手编个 sessionId 就能让服务端多一条流（可被膨胀）。
 * 并发两帧同 sid 只 acquire 一次：命令链已经串行化了同 sid 的处理，
 * in-flight 表是给链外调用者（resumeAt 定时器）的第二道保险。
 *
 * ## 会话元数据命令（rename / archive / delete）
 *
 * 挂会话链（与同 sid 的 input.send 串行，delete 尤其需要），但**绝不**
 * resolveSession（见 session-mutations.ts）。应答一律机器级
 * `session.mutate.response`；handler 内的异常在这里转成 `io` 应答，不交给链的
 * 兜底——那会发会话级 error.fatal，进聊天时间线且关联不到请求。
 *
 * ## 墓碑
 *
 * 永久删除过的会话（flags store 的 deleted）收到的**任何**会话级帧都不
 * resolve：带 reqId 的回机器级 `session.mutate.response{code:'deleted'}`
 * （client 的 request() 只按 reqId 关联）；不带的（input.send、parked 的旧帧、
 * 补发回来的旧帧……）log 后忽略，并对该 sid 广播 `session.removed`（按 sid
 * 限频，60s 至多一次），让还缓存着它的设备自清。
 *
 * ## 不 resolve 的会话级读命令：session.history.request
 *
 * 历史回看读的是本机转录（SDK `getSessionMessages`，纯文件读），**不拉起会话进程**、
 * 不占并发名额，也不走 resolveSession——否则打开一个老会话看一眼历史就会起一个
 * claude 子进程。它仍挂在该会话的命令链上，和同会话的其他命令保持先后。
 * 响应只定向发给请求方设备（大帧，别的设备用不上）。
 *
 * ## 不 resolve 的会话级读命令：subagent.history.request
 *
 * 子 agent 过程回看：同 session.history.request，只读本机子转录
 * （subagent-history.ts 定位 + history.ts 转换），不拉起会话进程、定向回请求方。
 * 找不到 → 空 items。体积封顶复用 paginateHistory（取最新的一段，截了置 truncated）。
 *
 * ## 带附件的 input.send
 *
 * 附件要先从 relay 下载、解密、落盘（attachments.ts）才能交给会话，几十 MB 要好一会儿。
 * 这一步放在**命令链外**做，免得堵住同会话的 run.stop / permission.respond；但同会话的
 * input.send 之间要保序，所以另有一条「输入准备链」：有附件的消息、以及排在它后面的
 * 消息都先过这条链，准备好了再挂上命令链走正常的 send。准备失败回 `input.rejected`
 * （没进队列也没进去重表，用户可原样重试）。
 *
 * ## 不 resolve 的会话级命令：attachment.fetch.request
 *
 * 附件按需重新上传（blob 过期 / CLI 里粘贴的图片）：读 manifest 或转录，不拉起会话进程，
 * 上传放链外跑，只定向回请求方。
 *
 * ## 不 resolve 的会话级读命令：fs.list.request / fs.read.request
 *
 * 文件查看（files/）：范围是会话 cwd（取法同 #readTranscript）加白名单，不拉起会话进程，
 * 读盘与上传放链外跑，只定向回请求方。
 *
 * ## 不 resolve 的会话级读命令：session.commands.request
 *
 * 斜杠命令清单：同样不拉起会话进程、不走 resolveSession，交给 CommandsProbe
 * （按 cwd 起一个不发消息的探测 query 取 supportedCommands，带缓存与单飞）。
 * 墓碑判定仍在会话链上做；探测本身（冷启动一两秒，最坏到超时）放到**链外**
 * 跑，不堵同会话紧随其后的 input.send。尽力而为：探测失败只 log、回空数组，
 * 不发 error.fatal（菜单拉取失败不该进聊天时间线）。只定向回请求方。
 *
 * ## 回退：session.rewind.preview / session.rewind
 *
 * 编排在 rewind.ts。要 resolveSession（读文件快照可能要起临时 query，会话实例是
 * 入口），但不发消息、不占着进程。应答会话级、只定向回请求方；成功的回退先对全部
 * 设备广播 `session.rewound` 再应答。处理中的异常收敛成 `io` 应答，不走链的兜底
 * （那会发 error.fatal 进时间线，且关联不到请求）。待生效的截断点存在 state.json，
 * 期间 session.history.request 按它截掉被撤的尾巴。
 *
 * ## 手动刷新 context：session.context.request
 *
 * 同回退：要 resolveSession（会话实例是入口，进程被回收时由它起临时 query），挂在会话
 * 链上执行（约 2 秒），不发消息。新值经 session.updated 广播，应答只定向回请求方；
 * 会话打不开时同回退一样回机器级 `not_found`。
 */
import { randomUUID } from 'node:crypto';
import { getSessionMessages, type SessionMessage, type SlashCommand as SdkSlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentToClientEvent,
  ClientToAgentEvent,
  FsErrorCode,
  MachineInfo,
  PermissionMode,
  McpServerStatus,
  SlashCommand,
} from '@trine/core';
import { AttachmentError, type AttachmentStore, type PreparedInput } from '../bridge/attachments.ts';
import { FileAccessError } from '../files/access.ts';
import type { FileService } from '../files/service.ts';
import type { EventEmitter } from '../bridge/emitter.ts';
import {
  cutAtRewind,
  paginateHistory,
  toHistoryItems,
  toSubagentHistoryItems,
  transcriptImages,
} from '../bridge/history.ts';
import { readSubagentTranscript } from '../bridge/subagent-history.ts';
import {
  ConcurrencyLimitError,
  seedFromInfo,
  type SessionManager,
  type SessionSeed,
} from '../bridge/manager.ts';
import type { ClaudeSession } from '../bridge/session.ts';
import type { EventBody, EventBodyOf } from '../bridge/types.ts';
import { LinkLimitError, type SessionLinksStore } from '../ext/links-store.ts';
import type { SessionRecordsStore } from '../ext/records-store.ts';
import type { ExtensionService, ExtHost } from '../ext/service.ts';
import type { Recipient } from '../net/recipients.ts';
import type { MachineStatsWatcher } from './machine-stats.ts';
import type { CwdStore } from './cwd-store.ts';
import type { ClaudeUpdateOutcome } from './claude-cli.ts';
import type { ClaudeCheckOutcome } from './claude-latest.ts';
import type { RestartOutcome } from './restart.ts';
import type { PlanUsageRefreshOutcome } from './plan-usage.ts';
import type { SessionFlagsStore } from './session-flags.ts';
import { executeRewind, previewRewind, type RewindDeps } from './rewind.ts';
import { SessionMutations, type MutationOutcome } from './session-mutations.ts';
import type { AgentState, SessionParams } from './state.ts';

/** resumeAt 最长等多久（协议里 retryAt 是额度重置时间，不该超过一天） */
export const RESUME_AT_MAX_DELAY_MS = 24 * 60 * 60 * 1000;
/** listSessions 结果缓存时长 */
export const LIST_CACHE_MS = 5_000;
/** 墓碑命中时为同一会话广播 session.removed 的最小间隔 */
export const REMOVED_ANNOUNCE_INTERVAL_MS = 60_000;

/** run.resumeAt 到点后发给会话的提示语（与 session.ts 的续跑提示同一取向：先核实再继续） */
export const RESUME_AT_PROMPT =
  '（额度已重置，自动续跑）请先核实上一步操作是否已经完成，再继续未完成的工作，不要重复已完成的修改。';

/** 斜杠命令 description 截断上限：菜单只显示一两行，插件的长描述没必要整段过 E2E */
export const COMMAND_DESCRIPTION_MAX = 300;

/** 机器级链在 chains 表里的键（sessionId 不可能为空串） */
const MACHINE_CHAIN = '';

/** 机器级事件类型：按类型而不是按 sessionId 有无判定，client 多带了 sessionId 也不当会话级处理 */
const MACHINE_LEVEL_TYPES = new Set<ClientToAgentEvent['type']>([
  'session.list.request',
  'session.create',
  'machine.rename',
  'machine.unpair',
  'machine.claude.update.request',
  'machine.claude.check.request',
  'machine.usage.request',
  'machine.agent.restart.request',
  'machine.stats.request',
  'cwd.list.request',
  'cwd.add',
  'cwd.remove',
  'cwd.setDefault',
  'cwd.pin',
  'ext.catalog.request',
  'ext.read',
  'ext.action.prepare',
  'ext.action.commit',
  'ext.action.cancel',
  'ext.action.status',
  'ext.config.set',
  'session.links.update',
  'ext.records.request',
]);

/** 扩展帧：机器级，但不占机器链（扩展进程可能跑好几秒），见 ext/service.ts */
const EXT_TYPES = new Set<ClientToAgentEvent['type']>([
  'ext.catalog.request',
  'ext.read',
  'ext.action.prepare',
  'ext.action.commit',
  'ext.action.cancel',
  'ext.action.status',
  'ext.config.set',
  'session.links.update',
  'ext.records.request',
]);

/**
 * 会话元数据命令：挂会话链、**不** resolveSession、应答走机器级
 * session.mutate.response（见文件头）
 */
const SESSION_META_TYPES = new Set<ClientToAgentEvent['type']>([
  'session.rename',
  'session.archive',
  'session.pin',
  'session.delete',
]);

/** 有副作用的会话级操作才 resume；这些只作用于**已活跃**的实例，没有就 log */
const ACTIVE_ONLY_TYPES = new Set<ClientToAgentEvent['type']>([
  'permission.respond',
  'run.stop',
  'input.recall',
]);

/**
 * 旁路截获 `session.capabilities`，给 mcp.status.request 答复用。
 * ClaudeSession 只在 SDK init 时吐一次能力清单，之后 client 随时可能问 MCP 状态，
 * 得有人记着。按 sid 覆盖式更新（一次 init 一份）。
 */
export class CapabilitiesCache {
  readonly #mcp = new Map<string, McpServerStatus[]>();

  observe(event: AgentToClientEvent): void {
    if (event.type !== 'session.capabilities' || event.sessionId === undefined) return;
    this.#mcp.set(event.sessionId, event.mcpServers);
  }

  mcpServers(sessionId: string): McpServerStatus[] | undefined {
    return this.#mcp.get(sessionId);
  }

  /** 会话被永久删除时清掉 */
  forget(sessionId: string): void {
    this.#mcp.delete(sessionId);
  }
}

export interface RouterDeps {
  manager: SessionManager;
  emitter: EventEmitter;
  state: AgentState;
  cwdStore: CwdStore;
  /** 会话标记（归档 / 墓碑 / 未落盘标题），与 manager 的 flags 是同一个实例 */
  flags: SessionFlagsStore;
  capabilities: CapabilitiesCache;
  /** 组当前 MachineInfo（machine.rename 后广播用） */
  machineInfo: () => MachineInfo;
  /** 改 identity.name 并落盘 */
  renameMachine: (name: string) => Promise<void>;
  /**
   * 跑一次 `claude update`（app 的 ClaudeUpdater：单飞、超时、跑完刷新版本并
   * 广播 machine.info）。不抛——失败以 outcome 表达；万一抛了 router 兜成 failed。
   */
  updateClaude: () => Promise<ClaudeUpdateOutcome>;
  /**
   * 查一次 claude 最新版本（app 的 ClaudeLatestChecker：单飞；查完先广播 machine.info）。
   * 不抛。不给 = 不支持（测试）。
   */
  checkClaude?: () => Promise<ClaudeCheckOutcome>;
  /**
   * 手动刷新订阅限额用量（app 的 PlanUsageTracker：单飞、超时；拿到后先广播
   * machine.info）。不抛——失败以 outcome 表达。不给 = 不支持（测试）。
   */
  refreshUsage?: () => Promise<PlanUsageRefreshOutcome>;
  /**
   * 重启 agent（machine.agent.restart.request，见 restart.ts）。不给 = 不支持（测试）。
   * schedule/now 在预检结束后才 resolve；cancel 同步
   */
  restartAgent?: (action: 'schedule' | 'now' | 'cancel') => Promise<RestartOutcome>;
  /** 资源数据（machine.stats.request，见 machine-stats.ts）。不给 = 不支持（测试） */
  machineStats?: Pick<MachineStatsWatcher, 'request'>;
  /** listSessions 查不到模型时的兜底 */
  defaultModel: string;
  now?: () => number;
  log?: (line: string) => void;
  /** 注入定时器（resumeAt），测试用 */
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  listCacheMs?: number;
  /** 读本机转录（session.history.request）；测试注入假实现，默认走 SDK */
  getSessionMessagesFn?: typeof getSessionMessages;
  /** 读子 agent 转录（subagent.history.request）；测试注入假实现，默认读本机文件 */
  readSubagentTranscriptFn?: typeof readSubagentTranscript;
  /**
   * 斜杠命令探测（session.commands.request，见 commands-probe.ts）。
   * 缺省 = 不探测、一律回空数组（测试 / 无 claude 场景）
   */
  commandsProbe?: { commands(cwd: string): Promise<SdkSlashCommand[]> };
  /** 附件（下载落盘 / 历史还原 / 按需重新上传）；缺省 = 带附件的消息一律拒收 */
  attachments?: AttachmentStore;
  /** 文件查看（fs.list / fs.read）；缺省 = 不支持或已关闭，回 unavailable */
  files?: FileService;
  /** 会话关联（扩展）；缺省 = 不支持扩展 */
  links?: SessionLinksStore;
  /** 时间线记录卡（扩展）；缺省 = 不支持，ext.records.request 回空 */
  records?: SessionRecordsStore;
  /** 本机 machineId（扩展上下文用） */
  machineId?: string;
}

type SessionEvent = Extract<ClientToAgentEvent, { sessionId?: string }>;
type SessionMetaEvent = Extract<
  ClientToAgentEvent,
  { type: 'session.rename' | 'session.archive' | 'session.pin' | 'session.delete' }
>;

/** listSessions 结果缓存的每条：resume 参数 + resume 时种进 meta 的字段 */
interface ListedSession {
  params: SessionParams;
  seed: SessionSeed;
}

export class Router {
  readonly #deps: RouterDeps;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #setTimeout: (fn: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #listCacheMs: number;

  /** 命令链：key = sessionId 或 MACHINE_CHAIN */
  readonly #chains = new Map<string, Promise<void>>();
  /** 正在 resume 中的会话（链外去重） */
  readonly #resolving = new Map<string, Promise<ClaudeSession | undefined>>();
  /** run.resumeAt 定时器，同会话覆盖 */
  readonly #resumeTimers = new Map<string, unknown>();
  #listCache: { at: number; promise: Promise<Map<string, ListedSession>> } | undefined =
    undefined;
  /**
   * 墓碑命中时上次为该会话广播 session.removed 的时刻：按 sid 限频
   * （REMOVED_ANNOUNCE_INTERVAL_MS），而不是整个进程只广播一次——评审 CM1：
   * 旧缓存的 web 深链回来又发消息时，第二次也得让它收到 removed 自清
   */
  readonly #removedAnnouncedAt = new Map<string, number>();
  readonly #mutations: SessionMutations;
  /** 链外执行中的长任务（claude update），idle() 也等它们 */
  readonly #background = new Set<Promise<void>>();
  /** 输入准备链（见文件头「带附件的 input.send」）：key = sessionId */
  readonly #inputPrep = new Map<string, Promise<void>>();
  /** 已准备好、等命令链 send 的附件内容：key = `${sessionId}\n${clientMsgId}` */
  readonly #prepared = new Map<string, PreparedInput>();
  /** 扩展服务：app 在构造后接上（它要用 extHost()） */
  #extensions: ExtensionService | undefined = undefined;

  constructor(deps: RouterDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#log = deps.log ?? (() => {});
    this.#setTimeout = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimeout = deps.clearTimeoutImpl ?? ((h) => clearTimeout(h as never));
    this.#listCacheMs = deps.listCacheMs ?? LIST_CACHE_MS;
    this.#mutations = new SessionMutations({
      manager: deps.manager,
      emitter: deps.emitter,
      state: deps.state,
      flags: deps.flags,
      capabilities: deps.capabilities,
      now: this.#now,
      log: this.#log,
      cancelPending: (sid) => this.#cancelPending(sid),
      setTimer: (fn, ms) => {
        const handle = this.#setTimeout(fn, ms);
        // 后台兜底，不拖住进程退出（真定时器才有 unref；测试注入的假句柄没有）
        (handle as { unref?: () => void } | null)?.unref?.();
        return handle;
      },
      clearTimer: (handle) => this.#clearTimeout(handle),
      onChain: (sid, task) => void this.#enqueue(sid, task),
    });
  }

  /**
   * 还在处理中的入站命令数：命令链上没跑完的、附件还在准备的、会话还在 resume 的。
   * agent 重启的排空要等它们归零——它们还没进 manager，busyCount 看不到（见 restart.ts）
   */
  get inFlight(): number {
    return this.#chains.size + this.#inputPrep.size + this.#resolving.size;
  }

  /** 删除后复查定时器数（测试用） */
  get pendingRecheckCount(): number {
    return this.#mutations.pendingRecheckCount;
  }

  /**
   * 复查一个已删除会话：转录又冒出来就再删（评审 CB1）。挂到该会话链上串行。
   * app 在启动 / 每日 sweep 时对全部墓碑调一次。
   */
  recheckDeleted(sessionId: string): Promise<void> {
    return this.#enqueue(sessionId, () => this.#mutations.recheckDeleted(sessionId));
  }

  /**
   * 入口：把一帧挂到对应命令链上。返回的 Promise 在该帧处理完后 resolve
   * （测试与 resumeAt 用；网络回调直接忽略返回值即可，异常已在链内兜住）。
   */
  handle(event: ClientToAgentEvent, sender: Recipient): Promise<void> {
    if (EXT_TYPES.has(event.type)) {
      const task = this.#handleExt(event, sender);
      this.#runBackground(task);
      return task.catch(() => {});
    }
    if (MACHINE_LEVEL_TYPES.has(event.type)) {
      return this.#enqueue(MACHINE_CHAIN, () => this.#handleMachine(event, sender));
    }
    const sessionId = event.sessionId;
    if (sessionId === undefined) {
      // 会话级事件缺 sessionId：schema 上 optional 是给机器级用的，这里是对端 bug
      this.#log(`[router] 丢弃缺 sessionId 的会话级事件 type=${event.type} from=${sender.deviceId}`);
      return Promise.resolve();
    }
    if (event.type === 'input.send') return this.#handleInput(sessionId, event, sender);
    return this.#enqueue(sessionId, () => this.#handleSession(sessionId, event, sender));
  }

  /** 等全部链跑空（测试用） */
  async idle(): Promise<void> {
    while (this.#chains.size > 0 || this.#background.size > 0 || this.#inputPrep.size > 0) {
      await Promise.all([...this.#chains.values(), ...this.#background, ...this.#inputPrep.values()]);
    }
  }

  /** input.send：没有附件、前面也没有在准备的 → 直接上命令链；否则走输入准备链 */
  #handleInput(
    sessionId: string,
    event: Extract<ClientToAgentEvent, { type: 'input.send' }>,
    sender: Recipient,
  ): Promise<void> {
    const refs = event.attachments ?? [];
    const pending = this.#inputPrep.get(sessionId);
    if (refs.length === 0 && pending === undefined) {
      return this.#enqueue(sessionId, () => this.#handleSession(sessionId, event, sender));
    }
    const next = (pending ?? Promise.resolve())
      .then(async () => {
        if (refs.length > 0 && !this.#deps.flags.isDeleted(sessionId)) {
          const prepared = await this.#prepareInput(sessionId, event);
          if (prepared === undefined) return;
          this.#prepared.set(`${sessionId}\n${event.clientMsgId}`, prepared);
        }
        await this.#enqueue(sessionId, () => this.#handleSession(sessionId, event, sender));
      })
      .catch((err: unknown) => {
        this.#log(`[router] 输入准备失败 session=${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
      });
    this.#inputPrep.set(sessionId, next);
    void next.finally(() => {
      if (this.#inputPrep.get(sessionId) === next) this.#inputPrep.delete(sessionId);
    });
    return next;
  }

  /** 下载落盘附件；失败回 input.rejected 并返回 undefined */
  async #prepareInput(
    sessionId: string,
    event: Extract<ClientToAgentEvent, { type: 'input.send' }>,
  ): Promise<PreparedInput | undefined> {
    const store = this.#deps.attachments;
    let reason: string;
    if (store === undefined) {
      reason = '这台 agent 没有启用附件';
    } else {
      try {
        return await store.prepare({
          sessionId,
          clientMsgId: event.clientMsgId,
          text: event.text,
          refs: event.attachments ?? [],
        });
      } catch (err) {
        reason = err instanceof AttachmentError ? err.message : `附件处理失败：${err instanceof Error ? err.message : String(err)}`;
        this.#log(`[router] 附件准备失败 session=${sessionId}: ${reason}`);
      }
    }
    this.#emitSession(sessionId, { type: 'input.rejected', clientMsgId: event.clientMsgId, reason: reason.slice(0, 300) });
    return undefined;
  }

  /**
   * manager 报「一轮跑完」时调（app 把 SessionManager 的 onRunEnd 接到这里）：
   * 有 pendingTitle 就挂到该会话链上补写。首条消息的转录要等子进程处理后才
   * 落盘，input.send 那一刻补写多半还找不到文件。
   */
  onRunEnd(sessionId: string): void {
    this.#extensions?.onRunEnd(sessionId);
    if (this.#deps.flags.pendingTitle(sessionId) === undefined) return;
    void this.#enqueue(sessionId, () => this.#mutations.flushPendingTitle(sessionId));
  }

  /**
   * manager 报「活跃会话权限模式变了」时调（app 接线）：写进 state.json。
   *
   * 与 `session.setPermissionMode` 分支写的是同一条 `state.updateSession` 路径；
   * 那条分支自己也写一次（幂等，rememberSession 值相同即不落盘），这里补上的是
   * **没有 client 命令经过 router** 的来源——CLI 在 ExitPlanMode 批准后自行
   * 切回 default / acceptEdits（session.ts #syncCliPermissionMode）。不落盘的话
   * state.json 停在 plan，下次 resume 会又以 plan 模式拉起。
   */
  onPermissionModeChange(sessionId: string, mode: PermissionMode): void {
    this.#deps.state.updateSession(sessionId, { permissionMode: mode });
  }

    /** 清掉 resumeAt 定时器与删除复查定时器（进程退出） */
  dispose(): void {
    for (const handle of this.#resumeTimers.values()) this.#clearTimeout(handle);
    this.#resumeTimers.clear();
    this.#mutations.dispose();
  }

  // -------------------------------------------------------------------------
  // 命令链
  // -------------------------------------------------------------------------

  #enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const prev = this.#chains.get(key) ?? Promise.resolve();
    // 每个任务自己兜异常：链上任何一环炸了都不能让后面的命令永远排不上
    const next = prev.then(task).catch((err: unknown) => this.#onChainError(key, err));
    this.#chains.set(key, next);
    void next.finally(() => {
      // 只有自己还是链尾时才收表，否则会把后来者的链头删掉
      if (this.#chains.get(key) === next) this.#chains.delete(key);
    });
    return next;
  }

  #onChainError(key: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.#log(`[router] 处理失败 chain=${key === MACHINE_CHAIN ? '(machine)' : key}: ${message}`);
    const body: EventBody = {
      type: 'error.fatal',
      kind: 'other',
      message: `agent 处理命令时出错：${message}`.slice(0, 300),
    };
    this.#deps.emitter.emit(body, key === MACHINE_CHAIN ? null : key);
  }

  // -------------------------------------------------------------------------
  // 会话级
  // -------------------------------------------------------------------------

  async #handleSession(
    sessionId: string,
    event: SessionEvent,
    sender: Recipient,
  ): Promise<void> {
    // 在链上判：排在 delete 后面的帧要看到它刚写的墓碑
    if (this.#deps.flags.isDeleted(sessionId)) {
      this.#onTombstoned(sessionId, event);
      return;
    }
    if (SESSION_META_TYPES.has(event.type)) {
      await this.#handleMetaCommand(sessionId, event as SessionMetaEvent);
      return;
    }
    if (ACTIVE_ONLY_TYPES.has(event.type)) {
      const session = this.#deps.manager.get(sessionId);
      if (session === undefined) {
        this.#log(`[router] ${event.type} 指向的会话 ${sessionId} 没有活跃实例，忽略`);
        return;
      }
      await this.#dispatchActive(session, event, sender);
      return;
    }
    if (event.type === 'run.resumeAt') {
      this.#scheduleResumeAt(sessionId, event.at);
      return;
    }
    if (event.type === 'bgtask.stop') {
      // 只作用于已活跃实例（不为它拉起会话——没有子进程就没有后台任务），
      // 但与 ACTIVE_ONLY 那三类不同，它有 reqId，必须应答（复用 mutate.response）
      await this.#stopBgTask(sessionId, event);
      return;
    }
    if (event.type === 'session.history.request') {
      // 必须在 resolveSession 之前拦截：只读转录，不拉起会话（见文件头）
      await this.#history(sessionId, event, sender);
      return;
    }
    if (event.type === 'subagent.history.request') {
      // 同上：只读子转录，不拉起会话
      await this.#subagentHistory(sessionId, event, sender);
      return;
    }
    if (event.type === 'attachment.fetch.request') {
      // 不拉起会话；上传放链外跑（见文件头）
      this.#runBackground(this.#fetchAttachment(sessionId, event, sender));
      return;
    }
    if (event.type === 'fs.list.request' || event.type === 'fs.read.request') {
      // 不拉起会话；读盘 / 上传放链外跑（见文件头）
      this.#runBackground(this.#files(sessionId, event, sender));
      return;
    }
    if (event.type === 'session.commands.request') {
      // 同上：不拉起会话；探测放链外跑，不堵同会话后续命令（见文件头）
      this.#runBackground(this.#commands(sessionId, event.reqId, sender));
      return;
    }

    const session = await this.resolveSession(sessionId);
    if (session === undefined) {
      // 回退带 reqId：resolve 失败（会话不存在 / 并发已满）也要应答，否则 client 干等到超时。
      // 走机器级（不为可能不存在的会话开 seq 流，见文件头）；client 只按 reqId 关联
      if (event.type === 'session.context.request') {
        this.#deps.emitter.emit(
          {
            type: 'session.context.response',
            reqId: event.reqId,
            ok: false,
            error: { code: 'not_found', message: '无法打开这个会话（会话不存在，或活跃会话已达上限）' },
          },
          null,
          { to: sender.deviceId },
        );
      }
      if (event.type === 'session.rewind.preview' || event.type === 'session.rewind') {
        this.#deps.emitter.emit(
          {
            type: event.type === 'session.rewind' ? 'session.rewind.response' : 'session.rewind.preview.response',
            reqId: event.reqId,
            ok: false,
            error: { code: 'not_found', message: '无法打开这个会话（会话不存在，或活跃会话已达上限）' },
          },
          null,
          { to: sender.deviceId },
        );
      }
      return;
    }

    switch (event.type) {
      case 'input.send': {
        const key = `${sessionId}\n${event.clientMsgId}`;
        const prepared = this.#prepared.get(key);
        this.#prepared.delete(key);
        // duplicate 由 session 内部回执处理，这里不区分
        const sent = session.send(event.clientMsgId, event.text, prepared);
        if (prepared !== undefined && sent.uuid !== undefined) {
          // 历史回看按转录 uuid 找回附件列表
          await this.#deps.attachments?.bindUuid(sessionId, event.clientMsgId, sent.uuid);
        }
        // 发过消息即有转录：之后（含重启后）对它都该 resume 而非新建
        this.#deps.state.updateSession(sessionId, { started: true });
        // 未落盘时设的标题：先试一次补写（转录多半还没写出来，那就等 onRunEnd）
        if (this.#deps.flags.pendingTitle(sessionId) !== undefined) {
          await this.#mutations.flushPendingTitle(sessionId);
        }
        return;
      }
      case 'session.setModel':
        await session.setModel(event.model);
        this.#deps.state.updateSession(sessionId, { model: event.model });
        return;
      case 'session.setPermissionMode':
        await session.setPermissionMode(event.mode);
        this.#deps.state.updateSession(sessionId, { permissionMode: event.mode });
        return;
      case 'session.setCwd':
        await this.#setCwd(sessionId, session, event.cwd);
        return;
      case 'session.status.request': {
        const meta = session.meta();
        // 实例刚 resume、还没取过时用 manager 缓存里上次的值
        const context = meta.context ?? this.#deps.manager.metaOf(sessionId)?.context;
        const info = this.#deps.machineInfo();
        this.#emitSession(sessionId, {
          type: 'session.status.response',
          reqId: event.reqId,
          model: meta.model,
          cwd: meta.cwd,
          permissionMode: meta.permissionMode,
          costUsd: meta.costUsd,
          // 最近一次已知的值（每轮结束 / 手动刷新时取）；还没取到为 0/0
          contextUsedTokens: context?.usedTokens ?? 0,
          contextLimitTokens: context?.maxTokens ?? 0,
          agentVersion: info.agentVersion,
          claudeVersion: info.claudeVersion,
        });
        // 状态同步顺带给一帧后台任务快照（可能为空）：client 据此对账落盘的陈旧快照
        this.#emitSession(sessionId, { type: 'bgtask.snapshot', tasks: session.bgTasks() });
        return;
      }
      case 'mcp.status.request':
        this.#emitSession(sessionId, {
          type: 'mcp.status.response',
          reqId: event.reqId,
          servers: this.#deps.capabilities.mcpServers(sessionId) ?? [],
        });
        return;
      case 'session.rewind.preview':
      case 'session.rewind':
        await this.#rewind(sessionId, session, event, sender);
        return;
      case 'session.context.request': {
        const reply = (body: EventBody): void => {
          this.#deps.emitter.emit(body, sessionId, { to: sender.deviceId });
        };
        try {
          const context = await session.refreshContextNow();
          reply({ type: 'session.context.response', reqId: event.reqId, ok: true, context });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.#log(`[router] 刷新 context 失败 session=${sessionId}: ${message}`);
          reply({
            type: 'session.context.response',
            reqId: event.reqId,
            ok: false,
            error: { code: 'failed', message: message.slice(0, 300) },
          });
        }
        return;
      }
      default:
        this.#log(`[router] 未处理的会话级事件 type=${event.type}`);
    }
  }

  /** rename / archive / pin / delete：业务结果与意外异常都收敛成一帧机器级应答 */
  async #handleMetaCommand(sessionId: string, event: SessionMetaEvent): Promise<void> {
    let outcome: MutationOutcome;
    try {
      switch (event.type) {
        case 'session.rename':
          outcome = await this.#mutations.rename(sessionId, event.title);
          break;
        case 'session.archive':
          outcome = await this.#mutations.archive(sessionId, event.archived);
          break;
        case 'session.pin':
          outcome = await this.#mutations.pin(sessionId, event.pinned);
          break;
        case 'session.delete':
          outcome = await this.#mutations.delete(sessionId);
          if (outcome.ok) {
            this.#deps.links?.forget(sessionId);
            this.#deps.records?.forget(sessionId);
            await this.#deps.attachments?.removeSession(sessionId).catch((err: unknown) => {
              this.#log(`[router] 清理会话附件失败 session=${sessionId}: ${String(err)}`);
            });
          }
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log(`[router] ${event.type} 失败 session=${sessionId}: ${message}`);
      outcome = { ok: false, code: 'io', message: `agent 处理失败：${message}`.slice(0, 300) };
    }
    this.#emitMutateResponse(event.reqId, sessionId, outcome);
  }

  /** 停止后台任务：SDK 结果 → 机器级 session.mutate.response（协议 §1.6） */
  async #stopBgTask(
    sessionId: string,
    event: Extract<ClientToAgentEvent, { type: 'bgtask.stop' }>,
  ): Promise<void> {
    const session = this.#deps.manager.get(sessionId);
    if (session === undefined) {
      this.#emitMutateResponse(event.reqId, sessionId, {
        ok: false,
        code: 'not_found',
        message: '会话没有活跃实例，后台任务已随子进程结束',
      });
      return;
    }
    const result = await session.stopBgTask(event.taskId);
    this.#emitMutateResponse(event.reqId, sessionId, result.ok ? { ok: true } : result);
  }

  #emitMutateResponse(reqId: string, sessionId: string, outcome: MutationOutcome): void {
    this.#emitMachine({
      type: 'session.mutate.response',
      reqId,
      targetSessionId: sessionId,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { error: { code: outcome.code, message: outcome.message } }),
    });
  }

  /** 墓碑命中（见文件头「墓碑」） */
  #onTombstoned(sessionId: string, event: SessionEvent): void {
    if ('reqId' in event) {
      this.#emitMutateResponse(event.reqId, sessionId, {
        ok: false,
        code: 'deleted',
        message: '该会话已被永久删除',
      });
      return;
    }
    this.#log(`[router] 忽略指向已删除会话 ${sessionId} 的 ${event.type}`);
    const now = this.#now();
    const last = this.#removedAnnouncedAt.get(sessionId);
    if (last === undefined || now - last >= REMOVED_ANNOUNCE_INTERVAL_MS) {
      this.#removedAnnouncedAt.set(sessionId, now);
      this.#emitMachine({ type: 'session.removed', targetSessionId: sessionId });
    }
  }

  /** 删除第 2 步：清 resumeAt 定时器与 in-flight resolve */
  #cancelPending(sessionId: string): void {
    const timer = this.#resumeTimers.get(sessionId);
    if (timer !== undefined) {
      this.#clearTimeout(timer);
      this.#resumeTimers.delete(sessionId);
    }
    this.#resolving.delete(sessionId);
  }

  /**
   * 历史回看：读转录 → HistoryItem[] → 按 before/limit 分页 + 体积封顶 → 定向回给请求方。
   *
   * 转录读取见 #readTranscript（为了一个 dir 去跑 listSessions 不值）。有待生效的
   * 回退截断点时先截掉被撤的尾巴。会话不存在 → 空页，不报错。
   * 读取抛错交给命令链兜底（error.fatal，现有惯例）。
   */
  async #history(
    sessionId: string,
    event: Extract<ClientToAgentEvent, { type: 'session.history.request' }>,
    sender: Recipient,
  ): Promise<void> {
    const pending = this.#deps.manager.get(sessionId)?.pendingRewind ?? this.#deps.state.pendingRewind(sessionId);
    const messages = cutAtRewind(await this.#readTranscript(sessionId), pending?.dropFrom);
    const attachments = (await this.#deps.attachments?.historyIndex(sessionId)) ?? new Map();
    const page = paginateHistory(toHistoryItems(messages, attachments), { before: event.before, limit: event.limit });
    this.#deps.emitter.emit(
      {
        type: 'session.history.response',
        reqId: event.reqId,
        items: page.items,
        hasMore: page.hasMore,
        ...(page.nextBefore === undefined ? {} : { nextBefore: page.nextBefore }),
      },
      sessionId,
      { to: sender.deviceId },
    );
  }

  /** 附件按需重新上传（见文件头），结果只发给请求方 */
  async #fetchAttachment(
    sessionId: string,
    event: Extract<ClientToAgentEvent, { type: 'attachment.fetch.request' }>,
    sender: Recipient,
  ): Promise<void> {
    let body: EventBody;
    const store = this.#deps.attachments;
    if (store === undefined) {
      body = {
        type: 'attachment.fetch.response',
        reqId: event.reqId,
        ok: false,
        error: { code: 'unavailable', message: '这台 agent 没有启用附件' },
      };
    } else {
      try {
        const attachment = await store.fetchRef(sessionId, event.messageId, event.index, async () => {
          const message = (await this.#readTranscript(sessionId)).find((m) => m.uuid === event.messageId);
          const raw = message?.message as { content?: unknown } | undefined;
          return message === undefined ? undefined : transcriptImages(raw?.content);
        });
        body = { type: 'attachment.fetch.response', reqId: event.reqId, ok: true, attachment };
      } catch (err) {
        const code = err instanceof AttachmentError ? err.code : 'io';
        const message = err instanceof Error ? err.message : String(err);
        this.#log(`[router] 附件拉取失败 session=${sessionId}: ${message}`);
        body = { type: 'attachment.fetch.response', reqId: event.reqId, ok: false, error: { code, message: message.slice(0, 300) } };
      }
    }
    this.#deps.emitter.emit(body, sessionId, { to: sender.deviceId });
  }

  /** 文件查看（见文件头），结果只发给请求方 */
  async #files(
    sessionId: string,
    event: Extract<ClientToAgentEvent, { type: 'fs.list.request' | 'fs.read.request' }>,
    sender: Recipient,
  ): Promise<void> {
    const files = this.#deps.files;
    const cwd = this.#deps.state.sessionParams(sessionId)?.cwd ?? this.#deps.manager.metaOf(sessionId)?.cwd;
    const fail = (code: FsErrorCode, message: string): EventBody =>
      event.type === 'fs.list.request'
        ? { type: 'fs.list.response', reqId: event.reqId, ok: false, error: { code, message } }
        : { type: 'fs.read.response', reqId: event.reqId, ok: false, error: { code, message } };
    let body: EventBody;
    if (files === undefined) {
      body = fail('unavailable', '这台 agent 关闭了文件查看');
    } else {
      try {
        if (event.type === 'fs.list.request') {
          const r = await files.list(cwd, event.path);
          body = { type: 'fs.list.response', reqId: event.reqId, ok: true, ...r };
        } else {
          body = { type: 'fs.read.response', reqId: event.reqId, ok: true, file: await files.read(cwd, event.path) };
        }
      } catch (err) {
        const code = err instanceof FileAccessError ? err.code : 'io';
        const message = err instanceof Error ? err.message : String(err);
        if (code === 'io') this.#log(`[router] 文件查看失败 session=${sessionId}: ${message}`);
        body = fail(code, message.slice(0, 300));
      }
    }
    this.#deps.emitter.emit(body, sessionId, { to: sender.deviceId });
  }

  /**
   * 读会话主链：cwd 只从零成本来源取（state.json / manager meta），拿不到就不传 dir、
   * 让 SDK 搜全部项目；给了 dir 却没读到（会话切过 cwd）再不带 dir 兜一次。
   */
  async #readTranscript(sessionId: string): Promise<SessionMessage[]> {
    const read = this.#deps.getSessionMessagesFn ?? getSessionMessages;
    const cwd = this.#deps.state.sessionParams(sessionId)?.cwd ?? this.#deps.manager.metaOf(sessionId)?.cwd;
    const messages = await read(sessionId, cwd === undefined || cwd === '' ? {} : { dir: cwd });
    if (messages.length === 0 && cwd !== undefined && cwd !== '') return read(sessionId, {});
    return messages;
  }

  /** 回退预览 / 执行（见文件头「回退」） */
  async #rewind(
    sessionId: string,
    session: ClaudeSession,
    event: Extract<ClientToAgentEvent, { type: 'session.rewind.preview' | 'session.rewind' }>,
    sender: Recipient,
  ): Promise<void> {
    const deps: RewindDeps = {
      readMessages: (sid) => this.#readTranscript(sid),
      setPendingRewind: (sid, point) => this.#deps.state.setPendingRewind(sid, point),
    };
    const reply = (body: EventBody): void => {
      this.#deps.emitter.emit(body, sessionId, { to: sender.deviceId });
    };
    const failed = (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.#log(`[router] ${event.type} 失败 session=${sessionId}: ${message}`);
      return { ok: false as const, error: { code: 'io' as const, message: `agent 处理失败：${message}`.slice(0, 300) } };
    };
    if (event.type === 'session.rewind.preview') {
      const result = await previewRewind(deps, session, event.targetMessageId).catch(failed);
      reply({ type: 'session.rewind.preview.response', reqId: event.reqId, ...result });
      return;
    }
    const result = await executeRewind(deps, session, event.targetMessageId, event.mode).catch(failed);
    if (!result.ok) {
      reply({ type: 'session.rewind.response', reqId: event.reqId, ok: false, error: result.error });
      return;
    }
    this.#log(`[router] 会话 ${sessionId} 已回退（${event.mode}）`);
    this.#emitSession(sessionId, { type: 'session.rewound', ...result.rewound });
    reply({
      type: 'session.rewind.response',
      reqId: event.reqId,
      ok: true,
      text: result.text,
      ...(result.files === undefined ? {} : { files: result.files }),
    });
  }

  /** 子 agent 过程回看（见文件头）：cwd 取法同 #history，猜不中由定位器扫描兜底 */
  async #subagentHistory(
    sessionId: string,
    event: Extract<ClientToAgentEvent, { type: 'subagent.history.request' }>,
    sender: Recipient,
  ): Promise<void> {
    const read = this.#deps.readSubagentTranscriptFn ?? readSubagentTranscript;
    const cwd = this.#deps.state.sessionParams(sessionId)?.cwd ?? this.#deps.manager.metaOf(sessionId)?.cwd;
    const lines = await read(sessionId, event.toolUseId, { cwd });
    const page = paginateHistory(toSubagentHistoryItems(lines), { limit: 500 });
    this.#deps.emitter.emit(
      {
        type: 'subagent.history.response',
        reqId: event.reqId,
        toolUseId: event.toolUseId,
        items: page.items,
        ...(page.hasMore ? { truncated: true } : {}),
      },
      sessionId,
      { to: sender.deviceId },
    );
  }

  /**
   * 斜杠命令清单：cwd 取法同 #history（零成本来源），都没有就用机器默认 cwd。
   * 探测失败 → 空数组（见文件头），source 统一 'project'（与 translate.ts 一致）。
   */
  async #commands(sessionId: string, reqId: string, sender: Recipient): Promise<void> {
    const known = this.#deps.state.sessionParams(sessionId)?.cwd ?? this.#deps.manager.metaOf(sessionId)?.cwd;
    const cwd = known === undefined || known === '' ? this.#deps.cwdStore.snapshot().defaultCwd : known;
    let slashCommands: SlashCommand[] = [];
    const probe = this.#deps.commandsProbe;
    if (probe !== undefined) {
      try {
        slashCommands = toSlashCommands(await probe.commands(cwd));
      } catch (err) {
        this.#log(
          `[router] session.commands.request 探测失败 session=${sessionId} cwd=${cwd}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.#deps.emitter.emit({ type: 'session.commands.response', reqId, slashCommands }, sessionId, {
      to: sender.deviceId,
    });
  }

  /** 链外任务：登记到 #background（idle() 等它），异常只 log */
  #runBackground(task: Promise<void>): void {
    const tracked = task.catch((err: unknown) => {
      this.#log(`[router] 后台任务失败：${err instanceof Error ? err.message : String(err)}`);
    });
    this.#background.add(tracked);
    void tracked.finally(() => this.#background.delete(tracked));
  }

  /** 只作用于已活跃实例的三类事件 */
  async #dispatchActive(
    session: ClaudeSession,
    event: SessionEvent,
    sender: Recipient,
  ): Promise<void> {
    switch (event.type) {
      case 'permission.respond': {
        const hit = session.respondPermission({
          requestId: event.requestId,
          verdict: event.verdict,
          ...(event.updatedInput === undefined ? {} : { updatedInput: event.updatedInput }),
          ...(event.remember === undefined ? {} : { remember: event.remember }),
          ...(event.message === undefined ? {} : { message: event.message }),
          ...(event.setMode === undefined ? {} : { setMode: event.setMode }),
          resolvedBy: sender.deviceId,
        });
        if (!hit) {
          this.#log(
            `[router] permission.respond 没命中挂起项 requestId=${event.requestId}（重复应答或已失效）`,
          );
        }
        return;
      }
      case 'run.stop':
        await session.stop();
        return;
      case 'input.recall': {
        const ok = session.recall(event.clientMsgId);
        // 成功由会话发 input.cancelled；未命中（多半已开始执行，回显早已发出）只 log
        if (!ok) this.#log(`[router] input.recall 未命中排队消息 clientMsgId=${event.clientMsgId}`);
        return;
      }
      default:
        return;
    }
  }

  /**
   * 切换工作目录 = 关掉当前实例再以新 cwd resume（SDK 的 cwd 是 query 级参数，
   * 运行中改不了）。运行中 / 等权限 / 有排队消息时拒绝：release 会作废挂起的
   * 权限请求、丢掉排队消息，那是「静默丢用户输入」，宁可让用户等跑完再切。
   */
  async #setCwd(sessionId: string, session: ClaudeSession, cwd: string): Promise<void> {
    const busy =
      session.state === 'running' ||
      session.state === 'waiting_permission' ||
      session.queueLength > 0;
    if (busy) {
      this.#emitSession(sessionId, {
        type: 'error.fatal',
        kind: 'config',
        message: '会话运行中或有排队消息，不能改工作目录；请等它跑完或先停止',
      });
      return;
    }
    const meta = session.meta();
    const { manager, state } = this.#deps;
    // 有转录才 resume；一条消息都没发过的新会话就以新建方式重开（会多广播一次
    // session.created，client 按 sessionId 幂等）。「发过消息」持久化在 state.sessions
    // 里（省略 = 历史会话，有转录），起过子进程也算
    const started = session.hasProcess || (state.sessionParams(sessionId)?.started ?? true);
    await manager.release(sessionId, '切换工作目录');
    const params: SessionParams = {
      cwd,
      model: meta.model,
      permissionMode: meta.permissionMode,
      started,
    };
    const rewindPoint = session.pendingRewind;
    manager.acquire({ sessionId, ...params, resume: started, ...(rewindPoint === undefined ? {} : { rewindPoint }) });
    state.rememberSession(sessionId, params);
    // acquire(resume:true) 不广播，这里手动发 session.updated 让所有 client 看到新 cwd
    const updated = manager.metaOf(sessionId);
    if (updated !== undefined) {
      this.#emitMachine({ type: 'session.updated', session: updated });
    }
  }

  #scheduleResumeAt(sessionId: string, at: number): void {
    const existing = this.#resumeTimers.get(sessionId);
    if (existing !== undefined) this.#clearTimeout(existing);
    const delay = Math.min(Math.max(at - this.#now(), 0), RESUME_AT_MAX_DELAY_MS);
    const handle = this.#setTimeout(() => {
      this.#resumeTimers.delete(sessionId);
      // 到点走正常命令链，与其他命令串行
      void this.#enqueue(sessionId, async () => {
        const session = await this.resolveSession(sessionId);
        session?.send(randomUUID(), RESUME_AT_PROMPT);
      });
    }, delay);
    this.#resumeTimers.set(sessionId, handle);
    this.#log(`[router] 已安排 ${Math.round(delay / 1000)}s 后自动续跑会话 ${sessionId}`);
  }

  /** 当前挂着的 resumeAt 定时器数（测试用） */
  get pendingResumeCount(): number {
    return this.#resumeTimers.size;
  }

  // -------------------------------------------------------------------------
  // resolveSession
  // -------------------------------------------------------------------------

  /**
   * 取活跃实例；没有就按需 resume（见文件头）。返回 undefined 表示已向 client
   * 报了机器级 error.fatal，调用方直接返回即可。
   */
  resolveSession(sessionId: string): Promise<ClaudeSession | undefined> {
    // 永久删除过的会话绝不复活（链上的帧已在 #handleSession 拦下，这里兜链外调用者）
    if (this.#deps.flags.isDeleted(sessionId)) {
      this.#log(`[router] 拒绝 resume 已删除的会话 ${sessionId}`);
      return Promise.resolve(undefined);
    }
    const existing = this.#deps.manager.get(sessionId);
    if (existing !== undefined) return Promise.resolve(existing);
    const inflight = this.#resolving.get(sessionId);
    if (inflight !== undefined) return inflight;

    const task = this.#resume(sessionId).finally(() => {
      this.#resolving.delete(sessionId);
    });
    this.#resolving.set(sessionId, task);
    return task;
  }

  async #resume(sessionId: string): Promise<ClaudeSession | undefined> {
    let params: SessionParams | undefined;
    try {
      params = await this.#lookupParams(sessionId);
    } catch (err) {
      // listSessions 抛错：**机器级** fatal。交给命令链的兜底会按 sid 发会话级
      // fatal，等于为一个尚不知存在与否的 sid 开了 seq 流（可被膨胀）
      this.#emitMachine({
        type: 'error.fatal',
        kind: 'other',
        message: `查询会话列表失败，无法恢复会话 ${sessionId}：${
          err instanceof Error ? err.message : String(err)
        }`.slice(0, 300),
      });
      return undefined;
    }
    if (params === undefined) {
      this.#emitMachine({
        type: 'error.fatal',
        kind: 'config',
        message: `会话 ${sessionId} 不存在`,
      });
      return undefined;
    }
    try {
      // started 省略 = 历史会话有转录 → resume；本进程 create 出来还没发过消息的
      // （started:false，进程重启后仍记着）→ 无转录，以新建方式起
      const resume = params.started !== false;
      // resume 历史会话：带上 title / firstPrompt 等，否则 meta 里这些是空的，
      // 第一次状态迁移就把空标题广播出去（评审 B3）
      const seed = resume ? await this.#seedFor(sessionId) : undefined;
      if (this.#deps.manager.has(sessionId)) return this.#deps.manager.get(sessionId);
      await this.#deps.manager.makeRoom();
      if (this.#deps.manager.has(sessionId)) return this.#deps.manager.get(sessionId);
      const rewindPoint = resume ? this.#deps.state.pendingRewind(sessionId) : undefined;
      const { session } = this.#deps.manager.acquire({
        sessionId,
        ...params,
        resume,
        ...(seed === undefined ? {} : { seed }),
        ...(rewindPoint === undefined ? {} : { rewindPoint }),
      });
      this.#deps.state.rememberSession(sessionId, params);
      return session;
    } catch (err) {
      if (err instanceof ConcurrencyLimitError) {
        this.#emitMachine({ type: 'error.fatal', kind: 'config', message: err.message });
        return undefined;
      }
      throw err;
    }
  }

  /** 三级参数来源：state.json → manager meta → listSessions（缓存 5s） */
  async #lookupParams(sessionId: string): Promise<SessionParams | undefined> {
    const local = this.#deps.state.sessionParams(sessionId);
    if (local !== undefined) return local;
    const meta = this.#deps.manager.metaOf(sessionId);
    if (meta !== undefined) {
      return {
        cwd: meta.cwd,
        model: meta.model || this.#deps.defaultModel,
        permissionMode: meta.permissionMode,
      };
    }
    const listed = await this.#listAll();
    return listed.get(sessionId)?.params;
  }

  /**
   * resume 种子：listSessions 缓存还新鲜就用它（#lookupParams 刚查过的情形），
   * 否则 getSessionInfo。都拿不到就不种——manager 会保留已有 meta 里的值。
   */
  async #seedFor(sessionId: string): Promise<SessionSeed | undefined> {
    const cache = this.#listCache;
    if (cache !== undefined && this.#now() - cache.at < this.#listCacheMs) {
      const hit = await cache.promise.then((m) => m.get(sessionId)).catch(() => undefined);
      if (hit !== undefined) return hit.seed;
    }
    try {
      const info = await this.#deps.manager.sessionInfo(sessionId);
      return info === undefined ? undefined : seedFromInfo(info);
    } catch (err) {
      this.#log(`[router] 查会话 ${sessionId} 的信息失败，resume 不带种子：${(err as Error).message}`);
      return undefined;
    }
  }

  #listAll(): Promise<Map<string, ListedSession>> {
    const now = this.#now();
    if (this.#listCache !== undefined && now - this.#listCache.at < this.#listCacheMs) {
      return this.#listCache.promise;
    }
    const promise = this.#deps.manager.list().then((sessions) => {
      const map = new Map<string, ListedSession>();
      for (const s of sessions) {
        // listSessions 不带模型（''），cwd 也可能缺——缺 cwd 的会话无法 resume，跳过
        if (s.cwd === '') continue;
        map.set(s.sessionId, {
          params: {
            cwd: s.cwd,
            model: s.model || this.#deps.defaultModel,
            permissionMode: s.permissionMode,
          },
          seed: {
            title: s.title,
            ...(s.firstPrompt === undefined ? {} : { firstPrompt: s.firstPrompt }),
            ...(s.gitBranch === undefined ? {} : { gitBranch: s.gitBranch }),
            ...(s.createdAt === undefined ? {} : { createdAt: s.createdAt }),
          },
        });
      }
      return map;
    });
    this.#listCache = { at: now, promise };
    // 查询失败不缓存，下次重试
    promise.catch(() => {
      if (this.#listCache?.promise === promise) this.#listCache = undefined;
    });
    return promise;
  }

  // -------------------------------------------------------------------------
  // 机器级
  // -------------------------------------------------------------------------

  async #handleMachine(event: ClientToAgentEvent, sender: Recipient): Promise<void> {
    const { manager, cwdStore } = this.#deps;
    switch (event.type) {
      case 'session.create': {
        let sessionId: string;
        try {
          sessionId = await this.#createSession(event.cwd, event.model, event.permissionMode);
        } catch (err) {
          if (err instanceof ConcurrencyLimitError) {
            this.#emitMachine({ type: 'error.fatal', kind: 'config', message: err.message });
            return;
          }
          throw err;
        }
        const meta = manager.metaOf(sessionId);
        if (meta === undefined) throw new Error('acquire 成功却没有 meta（不该发生）');
        // 机器级：与 bridge 自发的 session.created 各占一个机器级 seq，发起端按 sessionId 去重
        this.#emitMachine({
          type: 'session.create.response',
          reqId: event.reqId,
          session: meta,
        });
        return;
      }
      case 'session.list.request': {
        const sessions = await manager.list();
        this.#emitMachine({ type: 'session.list.response', reqId: event.reqId, sessions });
        return;
      }
      case 'cwd.list.request':
        this.#emitMachine({
          type: 'cwd.list.response',
          reqId: event.reqId,
          ...cwdStore.snapshot(),
        });
        return;
      case 'cwd.add':
        await cwdStore.add(event.path);
        this.#emitMachine({ type: 'cwd.updated', ...cwdStore.snapshot() });
        return;
      case 'cwd.remove':
        await cwdStore.remove(event.path);
        this.#emitMachine({ type: 'cwd.updated', ...cwdStore.snapshot() });
        return;
      case 'cwd.setDefault':
        await cwdStore.setDefault(event.path);
        this.#emitMachine({ type: 'cwd.updated', ...cwdStore.snapshot() });
        return;
      case 'cwd.pin':
        await cwdStore.setPinned(event.path, event.pinned, this.#now());
        // 幂等的重复请求也广播：发起端可能是因为本地状态过期才重发
        this.#emitMachine({ type: 'cwd.updated', ...cwdStore.snapshot() });
        return;
      case 'machine.rename':
        await this.#deps.renameMachine(event.name);
        this.#emitMachine({ type: 'machine.info', info: this.#deps.machineInfo() });
        return;
      case 'machine.claude.update.request': {
        // 不 await：见文件头「机器级链」的例外说明
        const task = this.#runClaudeUpdate(event.reqId);
        this.#background.add(task);
        void task.finally(() => this.#background.delete(task));
        return;
      }
      case 'machine.claude.check.request': {
        // 不 await：要等网络（最长 15 秒）
        const task = this.#runClaudeCheck(event.reqId);
        this.#background.add(task);
        void task.finally(() => this.#background.delete(task));
        return;
      }
      case 'machine.usage.request': {
        // 不 await：同 machine.claude.update.request
        const task = this.#runUsageRefresh(event.reqId);
        this.#background.add(task);
        void task.finally(() => this.#background.delete(task));
        return;
      }
      case 'machine.agent.restart.request': {
        // 不 await：预检要跑 bun install，别堵机器级链
        const task = this.#runAgentRestart(event.reqId, event.action);
        this.#background.add(task);
        void task.finally(() => this.#background.delete(task));
        return;
      }
      case 'machine.stats.request': {
        const watcher = this.#deps.machineStats;
        if (watcher === undefined) {
          this.#log('[router] 不支持 machine.stats.request，忽略');
          return;
        }
        // 不 await：首次采样要等约 1 秒，别堵机器级链
        const task = watcher.request(sender.deviceId, event.reqId, event.watch).catch((err: unknown) => {
          this.#log(`[router] machine.stats.request 失败：${err instanceof Error ? err.message : String(err)}`);
        });
        this.#background.add(task);
        void task.finally(() => this.#background.delete(task));
        return;
      }
      case 'machine.unpair':
        // 撤销流程未设计（DECISIONS backlog）：不动名册，只留痕
        this.#log(`[router] 收到 machine.unpair from=${sender.deviceId}，本版本不实现，忽略`);
        return;
      default:
        this.#log(`[router] 未处理的机器级事件 type=${event.type}`);
    }
  }

  /** 新建会话（session.create 与扩展的 session.create 效果共用）；满额抛 ConcurrencyLimitError */
  async #createSession(cwd: string, model: string, permissionMode: PermissionMode): Promise<string> {
    const sessionId = randomUUID();
    const params: SessionParams = {
      cwd,
      model,
      permissionMode,
      // 还没发过消息、SDK 侧无转录：之后若要重开必须以新建方式
      started: false,
    };
    await this.#deps.manager.makeRoom();
    this.#deps.manager.acquire({ sessionId, cwd, model, permissionMode });
    this.#deps.state.rememberSession(sessionId, params);
    return sessionId;
  }

  // -------------------------------------------------------------------------
  // 扩展（ext/service.ts；不占命令链，提交动作经 extHost 进链）
  // -------------------------------------------------------------------------

  attachExtensions(service: ExtensionService): void {
    this.#extensions = service;
  }

  async #handleExt(event: ClientToAgentEvent, sender: Recipient): Promise<void> {
    const service = this.#extensions;
    const deviceId = sender.deviceId;
    // 手动关联只要有 links store，不依赖扩展服务
    if (event.type === 'session.links.update') {
      await this.#updateLinks(event, deviceId);
      return;
    }
    if (event.type === 'ext.records.request') {
      await this.#replyRecords(event, deviceId);
      return;
    }
    if (service === undefined) {
      this.#log(`[router] 不支持扩展，忽略 ${event.type}`);
      return;
    }
    switch (event.type) {
      case 'ext.catalog.request':
        service.catalog(deviceId, event.reqId);
        return;
      case 'ext.read':
        await service.read(deviceId, event);
        return;
      case 'ext.action.prepare':
        await service.prepare(deviceId, event);
        return;
      case 'ext.action.commit':
        await service.commit(deviceId, event);
        return;
      case 'ext.action.cancel':
        service.cancel(deviceId, event.planId);
        return;
      case 'ext.action.status':
        service.status(deviceId, event);
        return;
      case 'ext.config.set':
        await service.setConfig(deviceId, event);
        return;
      default:
        return;
    }
  }

  /**
   * 某会话的时间线记录卡。会话已不存在时回空并清掉残留（例如回滚到旧版期间删掉的会话，
   * 旧版不认识记录文件、没替我们清）。
   */
  async #replyRecords(event: Extract<ClientToAgentEvent, { type: 'ext.records.request' }>, deviceId: string): Promise<void> {
    const sid = event.targetSessionId;
    const store = this.#deps.records;
    let records = store?.of(sid) ?? [];
    if (records.length > 0 && (this.#deps.flags.isDeleted(sid) || !(await this.#sessionKnown(sid)))) {
      store?.forget(sid);
      records = [];
    }
    this.#deps.emitter.emit({ type: 'ext.records.response', reqId: event.reqId, targetSessionId: sid, records }, null, { to: deviceId });
  }

  /** 本机认得这个会话：活跃实例、缓存的 meta、记过参数，或磁盘上有转录 */
  async #sessionKnown(sid: string): Promise<boolean> {
    return (
      this.#deps.manager.has(sid) ||
      this.#deps.manager.metaOf(sid) !== undefined ||
      this.#deps.state.sessionParams(sid) !== undefined ||
      (await this.#deps.manager.sessionInfo(sid).catch(() => undefined)) !== undefined
    );
  }

  /** 宿主界面上的手动关联：用户本人的操作，不受扩展权限约束（见协议注释） */
  async #updateLinks(event: Extract<ClientToAgentEvent, { type: 'session.links.update' }>, deviceId: string): Promise<void> {
    const reply = (body: Omit<EventBodyOf<'session.links.update.response'>, 'type' | 'reqId'>): void => {
      this.#deps.emitter.emit({ type: 'session.links.update.response', reqId: event.reqId, ...body }, null, { to: deviceId });
    };
    const links = this.#deps.links;
    const sid = event.targetSessionId;
    if (links === undefined) {
      reply({ ok: false, error: { code: 'unsupported', message: '这台 agent 不支持会话关联' } });
      return;
    }
    // 挂到会话链上：与同会话的删除串行（删了的会话不该再被关联上）
    await this.#enqueue(sid, async () => {
      if (this.#deps.flags.isDeleted(sid)) {
        reply({ ok: false, error: { code: 'not_found', message: '会话已删除' } });
        return;
      }
      if (!(await this.#sessionKnown(sid))) {
        reply({ ok: false, error: { code: 'not_found', message: '找不到会话' } });
        return;
      }
      try {
        const changed = await links.update(sid, event.ext, event.add ?? [], event.remove ?? [], this.#now());
        if (changed) {
          this.#extensions?.onLinksChanged(event.ext);
          await this.#broadcastSession(sid);
        }
        reply({ ok: true });
      } catch (err) {
        reply({
          ok: false,
          error: err instanceof LinkLimitError ? { code: 'denied', message: err.message } : { code: 'io', message: String(err).slice(0, 300) },
        });
      }
    });
  }

  async #broadcastSession(sessionId: string): Promise<void> {
    const meta = await this.#deps.manager.snapshot(sessionId).catch(() => undefined);
    if (meta !== undefined) this.#deps.emitter.emit({ type: 'session.updated', session: meta }, null);
  }

  /** 扩展服务用的宿主接口 */
  extHost(): ExtHost {
    const deps = this.#deps;
    return {
      machine: () => ({ id: deps.machineId ?? '', name: deps.machineInfo().name }),
      sessionMeta: (sid) => deps.manager.snapshot(sid).catch(() => undefined),
      cachedMeta: (sid) => deps.manager.metaOf(sid),
      isDeleted: (sid) => deps.flags.isDeleted(sid),
      broadcastSession: (sid) => this.#broadcastSession(sid),
      emitTo: (deviceId, body) => {
        deps.emitter.emit(body, null, { to: deviceId });
      },
      createSession: async (args) => {
        // 建会话占机器链（与 session.create 串行，名额判断才可靠）
        const sessionId = await this.#onChain(MACHINE_CHAIN, async () => {
          args.precheck?.();
          const sid = await this.#createSession(args.cwd, args.model, args.permissionMode);
          if (args.title !== undefined && args.title.trim() !== '') {
            await deps.flags.setPendingTitle(sid, args.title.trim().slice(0, 200), this.#now()).catch(() => {});
          }
          if (args.links.length > 0) await deps.links?.update(sid, args.ext, args.links, [], this.#now());
          await this.#broadcastSession(sid);
          return sid;
        });
        // 会话已建好：首条消息发送失败也保留会话（用户可在新会话里重发），不重新创建，失败原因交回调用方
        try {
          const sent = await this.#onChain(sessionId, () => this.#sendNow(sessionId, args.prompt));
          return { sessionId, clientMsgId: sent.clientMsgId };
        } catch (err) {
          this.#log(`[router] 扩展新建会话的首条消息发送失败 session=${sessionId}: ${String(err)}`);
          return { sessionId, sendError: err instanceof Error ? err.message : String(err) };
        }
      },
      // 在会话链上执行：前置条件复查与提交在同一环里，排在它前面的改权限 / 改目录 / 删除都已生效
      withSession: (sid, fn) =>
        this.#onChain(sid, () =>
          fn({
            meta: async () => (deps.flags.isDeleted(sid) ? undefined : deps.manager.snapshot(sid).catch(() => undefined)),
            send: (text) => this.#sendNow(sid, text),
          }),
        ),
    };
  }

  /** 把一个有返回值的任务挂到命令链上，失败原样抛给调用方（不走链的 error.fatal 兜底） */
  async #onChain<T>(key: string, task: () => Promise<T>): Promise<T> {
    let result: { value: T } | undefined;
    let failure: unknown;
    await this.#enqueue(key, async () => {
      try {
        result = { value: await task() };
      } catch (err) {
        failure = err;
      }
    });
    if (result === undefined) throw failure instanceof Error ? failure : new Error(String(failure));
    return result.value;
  }

  /** 代发一条消息（调用方已在该会话链上）：与 input.send 相同的路径 */
  async #sendNow(sessionId: string, text: string): Promise<{ clientMsgId: string; queued: boolean }> {
    if (this.#deps.flags.isDeleted(sessionId)) throw new Error('会话已删除');
    const session = await this.resolveSession(sessionId);
    if (session === undefined) throw new Error('无法打开这个会话（会话不存在，或活跃会话已达上限）');
    const clientMsgId = randomUUID();
    const queued = session.state === 'running' || session.state === 'waiting_permission';
    session.send(clientMsgId, text);
    this.#deps.state.updateSession(sessionId, { started: true });
    if (this.#deps.flags.pendingTitle(sessionId) !== undefined) await this.#mutations.flushPendingTitle(sessionId);
    return { clientMsgId, queued };
  }

  /** 跑 claude update 并回机器级应答（广播：别的设备按 reqId 对不上会忽略） */
  async #runClaudeUpdate(reqId: string): Promise<void> {
    let outcome: ClaudeUpdateOutcome;
    try {
      outcome = await this.#deps.updateClaude();
    } catch (err) {
      const version = this.#deps.machineInfo().claudeVersion;
      outcome = {
        ok: false,
        fromVersion: version,
        toVersion: version,
        output: '',
        outputTruncated: false,
        error: { code: 'failed', message: `agent 执行 claude update 出错：${(err as Error).message}`.slice(0, 300) },
      };
    }
    this.#emitMachine({
      type: 'machine.claude.update.response',
      reqId,
      ok: outcome.ok,
      fromVersion: outcome.fromVersion,
      toVersion: outcome.toVersion,
      output: outcome.output,
      ...(outcome.outputTruncated ? { outputTruncated: true } : {}),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    });
  }

  /** 查 claude 最新版本并回机器级应答（新结果已随 machine.info.claudeLatest 广播） */
  async #runClaudeCheck(reqId: string): Promise<void> {
    let outcome: ClaudeCheckOutcome;
    try {
      outcome = this.#deps.checkClaude === undefined
        ? { ok: false, message: '这个 agent 不支持检查 claude 最新版本' }
        : await this.#deps.checkClaude();
    } catch (err) {
      outcome = { ok: false, message: `agent 检查 claude 最新版本出错：${(err as Error).message}` };
    }
    this.#emitMachine({
      type: 'machine.claude.check.response',
      reqId,
      ok: outcome.ok,
      currentVersion: this.#deps.machineInfo().claudeVersion,
      ...(outcome.ok
        ? { latest: { version: outcome.version, channel: outcome.channel } }
        : { error: { code: 'failed', message: outcome.message.slice(0, 300) } }),
    });
  }

  /** 重启 agent 并回机器级应答（进度另随 machine.info.restart 广播） */
  async #runAgentRestart(reqId: string, action: 'schedule' | 'now' | 'cancel'): Promise<void> {
    let outcome: RestartOutcome;
    try {
      outcome = this.#deps.restartAgent === undefined
        ? { ok: false, code: 'unavailable', message: '这个 agent 不支持重启' }
        : await this.#deps.restartAgent(action);
    } catch (err) {
      outcome = { ok: false, code: 'failed', message: `agent 重启出错：${(err as Error).message}`.slice(0, 300) };
    }
    this.#emitMachine({
      type: 'machine.agent.restart.response',
      reqId,
      ok: outcome.ok,
      ...(outcome.ok
        ? { phase: outcome.phase, ...(outcome.toVersion === undefined ? {} : { toVersion: outcome.toVersion }) }
        : {
            error: {
              code: outcome.code,
              message: outcome.message.slice(0, 500),
              ...(outcome.output === undefined ? {} : { output: outcome.output }),
            },
          }),
    });
  }

  /**
   * 以用户消息的身份往会话里发一条（agent 重启后的续跑提示）：排在该会话的命令链上，
   * 与 input.send 同一条路径；会话不在内存里就 resume。
   */
  sendAsUser(sessionId: string, text: string): Promise<{ clientMsgId: string; queued: boolean }> {
    return this.#onChain(sessionId, () => this.#sendNow(sessionId, text));
  }

  /** 刷新订阅限额用量并回机器级应答（新数据已随 machine.info 广播） */
  async #runUsageRefresh(reqId: string): Promise<void> {
    let outcome: PlanUsageRefreshOutcome;
    try {
      outcome = this.#deps.refreshUsage === undefined
        ? { ok: false, code: 'failed', message: 'agent 不支持刷新用量' }
        : await this.#deps.refreshUsage();
    } catch (err) {
      outcome = { ok: false, code: 'failed', message: `agent 刷新用量出错：${(err as Error).message}`.slice(0, 300) };
    }
    this.#emitMachine({
      type: 'machine.usage.response',
      reqId,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { error: { code: outcome.code, message: outcome.message } }),
    });
  }

  // -------------------------------------------------------------------------

  #emitMachine(body: EventBody): void {
    this.#deps.emitter.emit(body, null);
  }

  #emitSession(sessionId: string, body: EventBody): void {
    this.#deps.emitter.emit(body, sessionId);
  }
}

/** SDK 命令清单 → 协议 SlashCommand：去重、空描述省略、长描述截断 */
export function toSlashCommands(commands: readonly SdkSlashCommand[]): SlashCommand[] {
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  for (const c of commands) {
    if (c.name === '' || seen.has(c.name)) continue;
    seen.add(c.name);
    const description = (c.description ?? '').trim();
    out.push({
      name: c.name,
      ...(description === ''
        ? {}
        : {
            description:
              description.length > COMMAND_DESCRIPTION_MAX
                ? `${description.slice(0, COMMAND_DESCRIPTION_MAX - 1)}…`
                : description,
          }),
      source: 'project',
    });
  }
  return out;
}

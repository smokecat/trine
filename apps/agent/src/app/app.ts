/**
 * agent 进程装配：把 net 层（AgentNode）与 bridge 层（SessionManager）接成一个
 * 可常驻运行的整体。cli.ts 只是它的薄壳。
 *
 * 接缝（node.ts 文件头点名的两处）：
 * - 出站：`EventEmitter.sink` → outbox 记一笔 → `node.publish(event, pushHint)`
 *   → state 记 seq → capabilities 旁路截获；
 * - 入站：`node.onEvent` → state 记游标 → `router.handle`。
 *
 * 其余都是围绕「进程会重启、网络会断」的补丁：state.json 快路径恢复 seq/游标，
 * outbox 兜底自愈，onOpen 重放会话状态与挂起权限。
 *
 * claude 可执行文件在这里解析一次（claude-cli.ts），会话、版本探测、远程
 * `claude update` 三处共用同一个路径。
 *
 * ## 可测性
 *
 * 一切外部依赖都可注入：假 ClaudeSession 工厂（不起真子进程）、假 listSessions、
 * 假 socket、假 fetch。集成测试用进程内真服务端 + 真 AgentNode + 假会话跑整条链。
 */
import { join, resolve } from 'node:path';
import type { AgentToClientEvent, MachineInfo, TransportFrame } from '@trine/core';
import type {
  deleteSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk';
import { BlobClient, httpBase } from '@trine/core/net';
import { AttachmentStore } from '../bridge/attachments.ts';
import { EventEmitter } from '../bridge/emitter.ts';
import { SessionManager, type CreateSessionArgs } from '../bridge/manager.ts';
import type { ClaudeSession } from '../bridge/session.ts';
import { createHeadlessProbe, type HeadlessProbe } from '../bridge/session-origin.ts';
import type { EventBody, OutboundEvent } from '../bridge/types.ts';
import { SessionLinksStore } from '../ext/links-store.ts';
import { recordLinkChanges, SessionRecordsStore } from '../ext/records-store.ts';
import { ExtensionRegistry } from '../ext/registry.ts';
import { ExtensionRunner } from '../ext/runner.ts';
import { ExtensionService } from '../ext/service.ts';
import { writeIdentity } from '../net/identity.ts';
import { AgentNode } from '../net/node.ts';
import type { PairingSession, PeerIdentity } from '../net/pairing.ts';
import type { Recipient } from '../net/recipients.ts';
import type { BackoffOptions, SocketLike } from '../net/ws-client.ts';
import { agentPaths, type AgentConfig } from './config.ts';
import { CommandsProbe } from './commands-probe.ts';
import { MachineStatsSampler, MachineStatsWatcher } from './machine-stats.ts';
import { PlanUsageTracker } from './plan-usage.ts';
import { CwdStore } from './cwd-store.ts';
import {
  ClaudeUpdater,
  detectClaudeVersion,
  resolveClaudeExecutable,
  type ClaudeUpdateOutcome,
  type SpawnFn,
} from './claude-cli.ts';
import { ClaudeLatestChecker } from './claude-latest.ts';
import { AGENT_VERSION, buildMachineInfo } from './machine-info.ts';
import {
  findUp,
  readGitHead,
  restartAvailability,
  RestartCoordinator,
  runPrecheck,
  takeRestartMarker,
  writeRestartMarker,
  type PrecheckResult,
  type RestartMarker,
  type RestartNotice,
  type RestartOutcome,
  type RestartRequest,
} from './restart.ts';
import { RESERVED_EXT_ID } from '../ext/registry.ts';
import { Outbox, pushHintFor } from './outbox.ts';
import { CapabilitiesCache, Router } from './router.ts';
import { FLAGS_SWEEP_INTERVAL_MS, SessionFlagsStore } from './session-flags.ts';
import { AgentState } from './state.ts';

/** 退出时给每个会话 drain 收尾的上限（整机退出总预算 10s 由 cli 兜底） */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 1_500;

function headlessProbeOption(deps: AgentAppDeps): { headlessProbe?: HeadlessProbe } {
  if (deps.headlessProbe !== undefined) return { headlessProbe: deps.headlessProbe };
  return deps.listSessionsFn === undefined ? { headlessProbe: createHeadlessProbe() } : {};
}

export interface AgentAppDeps {
  /** 注入假会话工厂（测试） */
  createSession?: (args: CreateSessionArgs) => ClaudeSession;
  listSessionsFn?: typeof listSessions;
  getSessionInfoFn?: typeof getSessionInfo;
  renameSessionFn?: typeof renameSession;
  deleteSessionFn?: typeof deleteSession;
  /**
   * 非交互会话探测（测试）。缺省：用真实 listSessions 时读 ~/.claude 转录开头；
   * 注入了假 listSessions 时不探测，免得测试去碰真 ~/.claude
   */
  headlessProbe?: HeadlessProbe;
  /** 注入假转录读取（测试）；默认走 SDK getSessionMessages */
  getSessionMessagesFn?: typeof getSessionMessages;
  /** 注入斜杠命令探测用的 query（测试）；默认走 SDK query */
  commandsQueryFn?: typeof query;
  /** 注入手动刷新限额用量时临时起的 query（测试用） */
  usageQueryFn?: typeof query;
  /** 资源采样器（测试注入假实现），默认读本机 */
  statsSampler?: Pick<MachineStatsSampler, 'sample'>;
  createSocket?: (url: string) => SocketLike;
  getInvitation?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  backoff?: BackoffOptions;
  /** 跳过 `claude --version` 探测（测试 / 无 claude 的机器） */
  claudeVersion?: string;
  /** 注入 PATH 查找（测试）；默认 Bun.which。返回 null = 找不到 */
  whichFn?: (cmd: string) => string | null;
  /** 注入子进程（`claude --version` / `claude update`，测试）；默认 Bun.spawn */
  spawnFn?: SpawnFn;
  /** `claude update` 超时（测试）；默认 5 分钟 */
  claudeUpdateTimeoutMs?: number;
  /** 查 claude 最新版本的 fetch 与 claude 配置目录（测试）；默认真网络、claudeConfigDir() */
  claudeLatest?: { fetchImpl?: typeof fetch; configDir?: string };
  /** 扩展进程执行（测试注入假 runner）；默认真起子进程 */
  extRunner?: Pick<ExtensionRunner, 'run'>;
  /** 首次生成身份时指定 machineId（测试） */
  machineId?: string;
  /**
   * agent 自重启（测试注入）：env 决定有没有 supervisor；precheck 替换真预检；
   * repoRoot 是读 git HEAD 的工作区（null = 不读）
   */
  restart?: {
    env?: Readonly<Record<string, string | undefined>>;
    precheck?: () => Promise<PrecheckResult>;
    repoRoot?: string | null;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    pollMs?: number;
    drainTimeoutMs?: number;
  };
  now?: () => number;
  log?: (line: string) => void;
}

export class AgentApp {
  /** 配对请求到达（只有本进程出过 QR 才可能匹配）——cli 据此展示 SAS 问用户 */
  onPairingRequest: ((session: PairingSession) => void) | undefined = undefined;
  /** client 放弃了一次本机发起的配对 */
  onPairingAborted: ((pairingToken: string) => void) | undefined = undefined;
  /**
   * 自重启：标记已写好，该退出了（cli 接上：优雅退出并以 RESTART_EXIT_CODE 结束进程）。
   * 没接上时重启请求会失败并取消。
   */
  onRestart: (() => void) | undefined = undefined;

  #firstOpen = true;
  #stopped = false;
  #flagsSweepTimer: ReturnType<typeof setInterval> | undefined = undefined;
  /** 由 create 在构造后接上（它的 onVersion 回调要写回本实例） */
  #updater!: ClaudeUpdater;
  #claudeLatest!: ClaudeLatestChecker;
  /** 斜杠命令探测（router 用；退出时收掉在跑的探测子进程） */
  #commandsProbe!: CommandsProbe;
  #planUsage!: PlanUsageTracker;
  #machineStats!: MachineStatsWatcher;
  #extRegistry!: ExtensionRegistry;
  #extLinks!: SessionLinksStore;
  #extRecords!: SessionRecordsStore;
  #extensions!: ExtensionService;
  #restart!: RestartCoordinator;
  /** 读 git HEAD 的工作区；undefined = 不是 git 工作区 */
  #repoRoot: string | undefined = undefined;
  /** 启动时的 git HEAD（运行中的代码版本） */
  #revision: string | undefined = undefined;
  /** 上次重启留下的标记：首次接入服务端后处理 */
  #restartMarker: RestartMarker | undefined = undefined;

  private constructor(
    readonly node: AgentNode,
    readonly manager: SessionManager,
    readonly emitter: EventEmitter,
    readonly router: Router,
    readonly state: AgentState,
    readonly outbox: Outbox,
    readonly cwdStore: CwdStore,
    readonly flags: SessionFlagsStore,
    private readonly log: (line: string) => void,
    private readonly now: () => number,
    private claudeVersion: string,
  ) {}

  static async create(config: AgentConfig, deps: AgentAppDeps = {}): Promise<AgentApp> {
    const log = deps.log ?? (() => {});
    const now = deps.now ?? (() => Date.now());
    const paths = agentPaths(config.home);

    // 显式覆盖不可执行 → 抛出，启动失败（见 claude-cli.ts 文件头）
    const claude = resolveClaudeExecutable(config.claudeBin, deps.whichFn);
    if (claude.path === undefined) {
      log('[app] PATH 上没找到 claude，会话回退 SDK 内置版本（远程更新不可用；可用 --claude-bin 指定）');
    } else {
      log(`[app] 会话使用 claude：${claude.path}${claude.source === 'override' ? '（--claude-bin）' : ''}`);
    }

    // 装配顺序受依赖关系约束：emitter 的 sink 要用到 outbox / node / state，
    // 而 manager 需要 emitter，node 又独立于两者——用 let 延迟绑定，sink 只在
    // 有事件发出时才执行，那时一切都已就位
    let node!: AgentNode;
    let outbox!: Outbox;
    let state!: AgentState;
    let router!: Router;
    const capabilities = new CapabilitiesCache();
    // 会话标记要在 manager 之前就位：manager 的每个 meta 出口都经它 decorate
    const flags = await SessionFlagsStore.load(paths.sessions, { log });
    const links = await SessionLinksStore.load(paths.sessionLinks, { log, now });
    const records = await SessionRecordsStore.load(paths.sessionRecords, { log, now });

    const emitter = new EventEmitter({
      now,
      sink: (out: OutboundEvent) => {
        outbox.remember(out);
        if (out.to === undefined) node.publish(out.event, pushHintFor(out.event));
        else node.publishTo(out.to, out.event, pushHintFor(out.event));
        state.noteOutSeq(out.scope, out.event.seq);
        capabilities.observe(out.event);
      },
    });

    // 附件：blob 走 relay 的 HTTP 端点，token 与 WS 同一套挑战-应答（node 晚于此创建，
    // 回调只在收到带附件的消息时才调用，那时早已就位）
    let blobClient: BlobClient | undefined;
    const attachments = new AttachmentStore({ root: paths.uploads, blobs: () => blobClient, now });

    const manager = new SessionManager({
      emitter,
      now,
      uploadsDir: (sessionId) => attachments.sessionDir(sessionId),
      // 会话里跑的 `trine-agent restart` 据此找到本 agent、认出发起的会话
      // home 转成绝对路径：子进程的 cwd 是会话目录，相对路径会指到别处
      sessionEnv: (sessionId) => ({ TRINE_HOME: resolve(config.home), TRINE_SESSION_ID: sessionId }),
      ...(config.maxSessions === undefined ? {} : { maxConcurrent: config.maxSessions }),
      ...(config.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: config.idleTimeoutMs }),
      ...(deps.listSessionsFn === undefined ? {} : { listSessionsFn: deps.listSessionsFn }),
      ...(deps.getSessionInfoFn === undefined ? {} : { getSessionInfoFn: deps.getSessionInfoFn }),
      ...(deps.renameSessionFn === undefined ? {} : { renameSessionFn: deps.renameSessionFn }),
      ...(deps.deleteSessionFn === undefined ? {} : { deleteSessionFn: deps.deleteSessionFn }),
      ...(deps.createSession === undefined ? {} : { createSession: deps.createSession }),
      ...(claude.path === undefined ? {} : { claudeExecutable: claude.path }),
      flags,
      sessionLinks: (sessionId) => links.of(sessionId),
      // state 晚于 manager 加载；只在列会话时查，那时早已就位
      rememberedParams: (sessionId) => state?.sessionParams(sessionId),
      // router 晚于 manager 构造；回调只在会话跑完一轮时触发，那时早已就位
      onRunEnd: (sessionId) => router.onRunEnd(sessionId),
      // 权限模式变化（含 CLI 自行切换）落盘到 state.json，下次 resume 按它起
      onPermissionModeChange: (sessionId, mode) => router.onPermissionModeChange(sessionId, mode),
      // 回退后的截断点生效了（新分支已落盘），清掉持久化的副本
      onRewindApplied: (sessionId) => state.setPendingRewind(sessionId, undefined),
      log,
      ...headlessProbeOption(deps),
      // app 晚于 manager 构造；回调只在会话收到 SDK 消息时触发，那时早已就位
      onRateLimits: (patch) => app.#planUsage.apply(patch),
    });

    // app 引用要给 node 的回调用，先占个位（回调只在 connect 之后才会触发）
    let app!: AgentApp;
    node = await AgentNode.create({
      serverUrl: config.serverUrl,
      identityPath: paths.identity,
      ...(deps.getInvitation === undefined ? {} : { getInvitation: deps.getInvitation }),
      recipientsPath: paths.recipients,
      ...(config.name === undefined ? {} : { name: config.name }),
      ...(deps.machineId === undefined ? {} : { machineId: deps.machineId }),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(deps.createSocket === undefined ? {} : { createSocket: deps.createSocket }),
      ...(deps.backoff === undefined ? {} : { backoff: deps.backoff }),
      now,
      log,
      onEvent: (event, sender) => app.#onInbound(event, sender),
      onInboundDropped: (failure, detail) => log(`[app] 丢弃入站帧 ${failure}: ${detail}`),
      onTransportFrame: (frame) => app.#onTransportFrame(frame),
      onPairingRequest: (session) => app.onPairingRequest?.(session),
      onPairingAborted: (token) => app.onPairingAborted?.(token),
      onOpen: () => app.#onOpen(),
    });

    let blobToken: { token: string; expiresAt: number } | undefined;
    blobClient = new BlobClient({
      baseUrl: httpBase(config.serverUrl),
      getToken: async (refresh) => {
        if (refresh || blobToken === undefined || blobToken.expiresAt - 60_000 < now()) {
          blobToken = await node.auth.authenticate({ signal: AbortSignal.timeout(15_000) });
        }
        return blobToken.token;
      },
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });

    state = await AgentState.load({ path: paths.state, machineId: node.machineId, log });
    // 快路径恢复：出站序列起点（+余量）、入站游标（原样）。都在任何帧收发之前
    emitter.restore(state.outSeqForRestore());
    node.cursors.restore(state.inCursorsForRestore());

    outbox = new Outbox({
      emitter,
      // 重发帧绕过了 sink，出站 seq 要在这里补记，否则 state.json 会落后于实际已用值
      publishTo: (recipient, event, hint) => {
        const ok = node.publishTo(recipient, event, hint);
        state.noteOutSeq(event.sessionId ?? null, event.seq);
        return ok;
      },
      recipientIds: () => node.recipients.list().map((r) => r.deviceId),
      pushHintFor,
      log,
    });

    const cwdStore = await CwdStore.load(paths.cwd, { log });
    const claudeVersion =
      deps.claudeVersion ??
      (await detectClaudeVersion(claude.path, deps.spawnFn === undefined ? {} : { spawn: deps.spawnFn }));

    // 与会话同一个本机 claude、同一套 settings 对齐（见 commands-probe.ts 文件头）
    const commandsProbe = new CommandsProbe({
      ...(claude.path === undefined ? {} : { pathToClaudeCodeExecutable: claude.path }),
      ...(deps.commandsQueryFn === undefined ? {} : { queryFn: deps.commandsQueryFn }),
      now,
      log,
    });

    const machineStats = new MachineStatsWatcher({
      sampler: deps.statsSampler ?? new MachineStatsSampler(),
      // 只发给订阅的设备（见 machine-stats.ts 文件头）
      emit: (to, stats, reqId) =>
        emitter.emit({ type: 'machine.stats', ...(reqId === undefined ? {} : { reqId }), stats }, null, { to }),
      now,
      log,
    });

    router = new Router({
      manager,
      emitter,
      state,
      cwdStore,
      flags,
      capabilities,
      defaultModel: config.defaultModel,
      machineInfo: () => app.machineInfo(),
      renameMachine: (name) => app.#rename(name, paths.identity),
      updateClaude: () => app.#updateClaude(),
      checkClaude: () => app.#claudeLatest.check(),
      refreshUsage: () => app.#planUsage.refresh(),
      restartAgent: async (action) => (action === 'cancel' ? app.cancelRestart() : app.restartAgent({ mode: action === 'now' ? 'now' : 'when_idle' })),
      machineStats,
      now,
      log,
      ...(deps.getSessionMessagesFn === undefined ? {} : { getSessionMessagesFn: deps.getSessionMessagesFn }),
      commandsProbe,
      attachments,
      links,
      records,
      machineId: node.machineId,
    });

    const extRegistry = await ExtensionRegistry.load(paths.extensions, { log, now });
    const extensions = new ExtensionService({
      registry: extRegistry,
      runner: deps.extRunner ?? new ExtensionRunner({ now }),
      links,
      records,
      host: router.extHost(),
      now,
      log,
    });
    router.attachExtensions(extensions);

    app = new AgentApp(
      node,
      manager,
      emitter,
      router,
      state,
      outbox,
      cwdStore,
      flags,
      log,
      now,
      claudeVersion,
    );
    app.#commandsProbe = commandsProbe;
    app.#machineStats = machineStats;
    app.#extRegistry = extRegistry;
    app.#extLinks = links;
    app.#extRecords = records;
    // 时间线记录卡：关联的增删（不论来源）都留一条，新记录广播给全部设备
    recordLinkChanges(links, records, (ext) => extRegistry.get(ext)?.manifest?.name ?? ext);
    records.onAppend((targetSessionId, record) => {
      app.#emitMachine({ type: 'ext.record', targetSessionId, record });
    });
    app.#extensions = extensions;
    // 目录变了：作废该扩展的 token / plan / 缓存，广播 machine.info（client 按 rev 重拉目录）
    extRegistry.onChange = (ext) => {
      extensions.invalidate(ext);
      app.#emitMachine({ type: 'machine.info', info: app.machineInfo() });
    };
    app.#planUsage = new PlanUsageTracker({
      liveUsage: () => manager.planUsage(),
      onChange: () => app.#emitMachine({ type: 'machine.info', info: app.machineInfo() }),
      ...(claude.path === undefined ? {} : { pathToClaudeCodeExecutable: claude.path }),
      ...(deps.usageQueryFn === undefined ? {} : { queryFn: deps.usageQueryFn }),
      now,
      log,
    });
    app.#updater = new ClaudeUpdater({
      executable: claude.path,
      currentVersion: () => app.claudeVersion,
      onVersion: (version) => {
        app.claudeVersion = version;
        app.#emitMachine({ type: 'machine.info', info: app.machineInfo() });
      },
      ...(deps.spawnFn === undefined ? {} : { spawn: deps.spawnFn }),
      ...(deps.claudeUpdateTimeoutMs === undefined ? {} : { timeoutMs: deps.claudeUpdateTimeoutMs }),
      log,
    });
    app.#claudeLatest = new ClaudeLatestChecker({
      onChange: () => app.#emitMachine({ type: 'machine.info', info: app.machineInfo() }),
      ...(deps.claudeLatest?.fetchImpl === undefined ? {} : { fetchImpl: deps.claudeLatest.fetchImpl }),
      ...(deps.claudeLatest?.configDir === undefined ? {} : { configDir: deps.claudeLatest.configDir }),
      now,
      log,
    });

    // ---- 自重启（见 restart.ts）----
    const restartDeps = deps.restart ?? {};
    // import.meta.dir = apps/agent/src/app
    const agentEntry = join(import.meta.dir, '..', 'cli.ts');
    app.#repoRoot = restartDeps.repoRoot === null ? undefined : (restartDeps.repoRoot ?? findUp(import.meta.dir, '.git'));
    app.#revision = app.#repoRoot === undefined ? undefined : readGitHead(app.#repoRoot);
    app.#restartMarker = await takeRestartMarker(paths.restartMarker, now(), log);
    const lockRoot = findUp(import.meta.dir, 'bun.lock');
    let precheckProc: { kill(signal?: NodeJS.Signals): void } | undefined;
    app.#restart = new RestartCoordinator({
      availability: restartAvailability(restartDeps.env ?? process.env),
      precheck:
        restartDeps.precheck ??
        (() =>
          runPrecheck({
            entry: agentEntry,
            execPath: process.execPath,
            repoRoot: lockRoot,
            onSpawn: (proc) => {
              precheckProc = proc;
            },
          }).finally(() => {
            precheckProc = undefined;
          })),
      busySessions: () => manager.busyCount + router.inFlight,
      exit: async (marker) => {
        if (app.onRestart === undefined) throw new Error('这个 agent 进程不支持自重启');
        await writeRestartMarker(paths.restartMarker, marker);
        app.onRestart();
      },
      onChange: () => app.#emitMachine({ type: 'machine.info', info: app.machineInfo() }),
      onCancelled: (notices, reason) => app.#noteRestart(notices, 'agent.restart.cancelled', '重启已取消', reason),
      fromVersion: AGENT_VERSION,
      fromRevision: app.#revision,
      now,
      ...(restartDeps.setTimer === undefined ? {} : { setTimer: restartDeps.setTimer }),
      ...(restartDeps.clearTimer === undefined ? {} : { clearTimer: restartDeps.clearTimer }),
      ...(restartDeps.pollMs === undefined ? {} : { pollMs: restartDeps.pollMs }),
      ...(restartDeps.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: restartDeps.drainTimeoutMs }),
      log,
    });
    app.#killPrecheck = () => precheckProc?.kill('SIGTERM');
    return app;
  }

  /** 退出时杀掉进行中的预检子进程 */
  #killPrecheck: () => void = () => {};

  /** 接入服务端并常驻（返回不代表已连上——WsClient 自己重连） */
  async start(): Promise<void> {
    this.#startFlagsSweeper();
    await this.node.connect();
  }

  /**
   * 会话标记的周期清理：过期墓碑（TTL 8 天）+ 归档标记惰性 GC（>30 天且 SDK
   * 查无此会话）+ 在期墓碑的残缺转录复查。启动时跑一次、之后每天一次；不 await、失败只 log——这是
   * 回收空间，不影响正确性。
   */
  async sweepFlags(): Promise<void> {
    const now = this.now();
    try {
      const tombstones = await this.flags.sweepTombstones(now);
      const exists = async (sid: string): Promise<boolean> => (await this.manager.sessionInfo(sid)) !== undefined;
      const archived = await this.flags.gcArchived(now, exists);
      const pinned = await this.flags.gcPinned(now, exists);
      if (tombstones + archived + pinned > 0) {
        this.log(
          `[app] 会话标记清理：过期墓碑 ${tombstones} 条，失效归档标记 ${archived} 条，失效置顶标记 ${pinned} 条`,
        );
      }
      // 仍在期内的墓碑逐个复查：删除后的 8s 复查若没来得及跑（agent 先退出了），
      // 子进程 re-stamp 重建的残缺转录在这里清掉（评审 CB1）
      for (const sid of this.flags.deletedIds()) await this.router.recheckDeleted(sid);
    } catch (err) {
      this.log(`[app] 会话标记清理失败：${(err as Error).message}`);
    }
  }

  #startFlagsSweeper(): void {
    if (this.#flagsSweepTimer !== undefined) return;
    void this.sweepFlags();
    this.#flagsSweepTimer = setInterval(() => void this.sweepFlags(), FLAGS_SWEEP_INTERVAL_MS);
    (this.#flagsSweepTimer as { unref?: () => void }).unref?.();
  }

  /**
   * 优雅退出：关会话（作废挂起权限、关子进程）→ 清定时器 → 落盘 → 断连。
   * 顺序有讲究：permission.invalidated 等收尾帧要在断连**前**发出去；断连本身
   * 也要等 socket 真正 close（上限 500ms）——`process.exit` 紧跟 `close()` 的话，
   * 刚 send 的那几帧可能还在内核缓冲里没出去。
   */
  async stop(reason = 'agent 正在退出'): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.manager.closeAll(reason, SHUTDOWN_DRAIN_TIMEOUT_MS);
    this.router.dispose();
    this.#updater.dispose();
    this.#claudeLatest.dispose();
    this.#commandsProbe.dispose();
    this.#planUsage.dispose();
    this.#machineStats.dispose();
    this.#extensions.dispose();
    this.#restart.dispose();
    this.#killPrecheck();
    if (this.#flagsSweepTimer !== undefined) {
      clearInterval(this.#flagsSweepTimer);
      this.#flagsSweepTimer = undefined;
    }
    await this.state.flush();
    await this.flags.flush();
    await this.#extLinks.flush();
    await this.#extRecords.flush();
    await this.#extRegistry.flush();
    await this.node.disconnect();
  }

  /**
   * 用户比对 SAS 一致后确认配对，**并立刻给新设备补一份 machine.info**。
   *
   * ## 为什么必须补这一发
   *
   * `machine.info` 只在 `#onOpen`（每次接入服务端）时广播一次，而 `publish`
   * 是按**当时**的名册逐收件人 seal 的。新设备是配对成功才进名册的，那一发
   * 早就过去了——于是它的机器卡一直空着，要等 agent 下次重连（可能是几天后）
   * 才填上。断线补发也救不了：服务端留存里压根没有发给这个新 deviceId 的帧。
   *
   * ## 为什么是广播而不是只发给新设备
   *
   * 机器级 seq 是**一条**序列，一个逻辑事件一个 seq、N 份密文
   * （见 emitter 的 `#takeSeq` 与 node.publish 的注释）。若在这里用
   * `publishTo` 单独给新设备发，要么绕过 emitter 自己编一个 seq（与共享序列
   * 打架），要么取一个 seq 却只发给一个人（别的设备那条流上就空了一号，
   * 它们的单调游标会卡在缺口前）。走正常 `emit` 则两个问题都不存在——
   * 名册此时**已经**写好了（`pairing.confirm` 先写名册再返回），新设备自然
   * 在收件人里。
   *
   * 代价是已在线的设备会多收一份 machine.info。它是一份完整状态快照、
   * 处理是幂等的（client 拿它覆盖机器卡），重复一次无害。
   */
  async confirmPairing(pairingToken: string, expected?: PeerIdentity): Promise<boolean> {
    const sent = await this.node.confirmPairing(pairingToken, expected);
    this.#emitMachine({ type: 'machine.info', info: this.machineInfo() });
    return sent;
  }

  /**
   * 从本机名册移除一台已配对设备：之后出站不再给它加密，它发来的入站帧也
   * 因找不到发送方而被丢弃（openInbound 只认名册里的设备）。立即生效，
   * 不需要重启。服务端那侧的设备登记不受影响。
   */
  async revokeDevice(deviceId: string): Promise<boolean> {
    const removed = await this.node.recipients.remove(deviceId);
    if (removed) {
      this.#extensions.forgetDevice(deviceId);
      this.log(`[app] 已移除配对设备 ${deviceId}`);
    }
    return removed;
  }

  machineInfo(): MachineInfo {
    return buildMachineInfo({
      name: this.node.identity.name,
      claudeVersion: this.claudeVersion,
      activeSessionCount: this.manager.activeCount,
      maxSessions: this.manager.maxConcurrent,
      rateLimits: this.#planUsage.current,
      extensions: this.#extRegistry === undefined ? undefined : { ...this.#extRegistry.summary(), records: true },
      restart: this.#restart === undefined ? undefined : this.#restartInfo(),
      claudeLatest: this.#claudeLatest?.current,
    });
  }

  #restartInfo(): NonNullable<MachineInfo['restart']> {
    const availability = this.#restart.availability;
    const workspaceRevision = this.#repoRoot === undefined ? undefined : readGitHead(this.#repoRoot);
    const pending = this.#restart.pending();
    return {
      available: availability.available,
      ...(availability.reason === undefined ? {} : { unavailableReason: availability.reason.slice(0, 300) }),
      ...(this.#revision === undefined ? {} : { revision: this.#revision }),
      ...(workspaceRevision === undefined ? {} : { workspaceRevision }),
      ...(pending === undefined ? {} : { pending }),
    };
  }

  /**
   * 重启 agent（网页的 machine.agent.restart.request 与控制通道的 restart 子命令共用）。
   * 见 restart.ts：预检 → 排空 → 退出由 supervisor 拉起。
   */
  restartAgent(request: RestartRequest): Promise<RestartOutcome> {
    return this.#restart.request(request);
  }

  cancelRestart(): RestartOutcome {
    return this.#restart.cancel('用户取消');
  }

  /** 给这些会话各留一条时间线记录卡（已删除的会话跳过） */
  #noteRestart(notices: readonly RestartNotice[], kind: string, label: string, message: string): void {
    for (const notice of notices) {
      if (this.flags.isDeleted(notice.sessionId)) continue;
      const note = notice.note === undefined || notice.note === '' ? message : `${message}（${notice.note}）`;
      try {
        this.#extRecords.append(notice.sessionId, {
          ext: RESERVED_EXT_ID,
          extName: 'trine',
          kind,
          label,
          message: note.slice(0, 500),
        });
      } catch (err) {
        this.log(`[restart] 写时间线记录失败：${(err as Error).message}`);
      }
    }
  }

  /**
   * 上次是自重启：给发起的会话留记录，带续跑提示的发一条消息进去（resume 接上原上下文）。
   * 首次接入服务端后调，帧才发得出去。
   */
  async #afterRestart(marker: RestartMarker): Promise<void> {
    const from = `${marker.fromVersion}${marker.fromRevision === undefined ? '' : ` (${marker.fromRevision})`}`;
    const to = `${AGENT_VERSION}${this.#revision === undefined ? '' : ` (${this.#revision})`}`;
    const summary = `${from} → ${to}`;
    this.log(`[restart] 已从 ${summary} 重启`);
    this.#noteRestart(marker.notices, 'agent.restart', 'agent 已重启', summary);
    for (const notice of marker.notices) {
      if (notice.continuePrompt === undefined || notice.continuePrompt.trim() === '') continue;
      if (this.flags.isDeleted(notice.sessionId)) continue;
      const text = `[trine] agent 已重启：${summary}。\n\n${notice.continuePrompt}`;
      try {
        await this.router.sendAsUser(notice.sessionId, text);
      } catch (err) {
        this.log(`[restart] 续跑消息发送失败 session=${notice.sessionId}：${(err as Error).message}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 回调
  // -------------------------------------------------------------------------

  #onInbound(event: Parameters<Router['handle']>[0], sender: Recipient): void {
    // 自重启已开始退出：不处理、也不记游标。游标停在这一帧之前落盘，重启后 relay 补发它，
    // 而不是在这里开了头又被退出打断（见 restart.ts）
    if (this.#restart?.exiting === true) {
      this.log(`[restart] 正在重启，${event.type} 留给重启后的新进程处理`);
      return;
    }
    // 游标已在 node 内推进（accept 通过才会到这），这里把快照记下来等 debounce 落盘
    this.state.setInCursors(this.node.cursors.snapshot());
    void this.router.handle(event, sender);
  }

  #onTransportFrame(frame: TransportFrame): void {
    if (frame.type === 'relay.reject') {
      this.outbox.onReject(frame);
      return;
    }
    // machine.status / parked.* / sync.done 等是发给 client 的，agent 收到
    // 不作处理。sync.done 是个例外情况：agent 自己也发 sync.request（重连
    // 补发 c2a），所以服务端**确实**会回它一帧——agent 的补发没有「live 帧
    // 与补发帧竞争」的问题（它是这条流的接收端，不是生产端），用不上这个
    // 标记，静默忽略即可，不该当异常告警。
  }

  /**
   * 每次（重）连上：广播 machine.info；对每个活跃会话重放 run.state 与挂起中的
   * permission.request（同 requestId，client 幂等）。agent 断线期间产出的 a2c 帧
   * 服务端从未收到、无从补发（既有设计边界），重放状态是对它的缓解。
   *
   * 首次接入额外对 state.json 里记着、但本进程没有实例的会话各发一条
   * `run.state: idle`：agent 崩溃重启后 pending 权限已不存在，client 上的卡片
   * 会挂着，这一条让它知道会话已不在等权限。
   */
  #onOpen(): void {
    this.#emitMachine({ type: 'machine.info', info: this.machineInfo() });

    for (const sessionId of this.manager.activeSessionIds) {
      const session = this.manager.get(sessionId);
      if (session === undefined) continue;
      this.emitter.emit({ type: 'run.state', state: session.state }, sessionId);
      for (const pending of session.permissions.snapshot()) {
        this.emitter.emit(
          {
            type: 'permission.request',
            requestId: pending.requestId,
            toolName: pending.toolName,
            input: pending.input,
            requestedAt: pending.requestedAt,
            ...(pending.suggestions === undefined ? {} : { suggestions: pending.suggestions }),
            ...(pending.parentToolUseId === undefined ? {} : { parentToolUseId: pending.parentToolUseId }),
          },
          sessionId,
        );
      }
    }

    if (this.#firstOpen) {
      this.#firstOpen = false;
      const marker = this.#restartMarker;
      this.#restartMarker = undefined;
      if (marker !== undefined) void this.#afterRestart(marker);
      for (const sessionId of Object.keys(this.state.sessions)) {
        if (this.manager.has(sessionId)) continue;
        this.emitter.emit({ type: 'run.state', state: 'idle' }, sessionId);
      }
    }
  }

  /** machine.rename：identity 整文件重写（单进程无锁可接受），name 不参与任何校验 */
  async #rename(name: string, identityPath: string): Promise<void> {
    const identity = this.node.identity;
    (identity as { name: string }).name = name;
    await writeIdentity(identity, identityPath);
    this.log(`[app] 机器已改名为 ${name}`);
  }

  /**
   * machine.claude.update.request：跑 `claude update`（单飞）。跑完后 updater 经
   * onVersion 刷新 claudeVersion 并广播 machine.info，router 再回应答——client
   * 收到应答时机器卡已是新版本。运行中的会话不重启（见 ClaudeUpdater）。
   */
  /** 本机扩展注册表（控制通道的 ext 子命令用） */
  get extensionRegistry(): ExtensionRegistry {
    return this.#extRegistry;
  }

  #updateClaude(): Promise<ClaudeUpdateOutcome> {
    return this.#updater.run();
  }

  /**
   * 开始自动检查 claude 最新版本（启动后约 30 秒、之后每 6 小时，见 claude-latest.ts）。
   * 只由 cli 调：测试里的 app 不碰网络。
   */
  startClaudeLatestChecks(): void {
    this.#claudeLatest.startAuto();
  }

  #emitMachine(body: EventBody): void {
    this.emitter.emit(body, null);
  }
}

export type { AgentToClientEvent };

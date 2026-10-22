/**
 * 测试用的假 Claude 会话与一键起 agent 的助手。
 *
 * 抽出来（原先埋在 app.integration.test.ts 里）是为了让 **web 的 in-process
 * e2e** 也能用：web 阶段 1 要验的是「真服务端 + 真 agent + web 的协议层」
 * 这条链，它需要一个行为确定、不依赖真 claude CLI 的 agent。复制一份假会话
 * 过去必然随 ClaudeSession 接口漂移，共用一份才不会。
 *
 * 这里刻意**只模拟少数行为**——「收到消息就回一句」、「权限请求挂起直到
 * 应答」，以及 plan 模式的 ExitPlanMode（批准后像真 CLI 一样自行切模式）。
 * SDK 相关的翻译逻辑在 bridge 层自己的测试里，不该在这里重演。
 */
import type { PreparedInput } from '../bridge/attachments.ts';
import type { getSessionMessages, listSessions, query } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode, SessionState } from '@trine/core';
import { waitingForTool } from '@trine/core/permission';
import type { CreateSessionArgs } from '../bridge/manager.ts';
import type { PendingPermissionSnapshot, PermissionVerdict } from '../bridge/permission.ts';
import type { ClaudeSession } from '../bridge/session.ts';
import type { EventBody } from '../bridge/types.ts';
import { AgentApp, type AgentAppDeps } from '../app/app.ts';
import type { SpawnFn } from '../app/claude-cli.ts';
import type { AgentConfig } from '../app/config.ts';
import { FakeTranscripts } from './fake-transcripts.ts';

/**
 * 收到消息立刻回 `echo: <text>`；`perm:` 开头的消息先挂一个 Bash 权限请求等应答；
 * `plan:` 开头的挂一个 ExitPlanMode（input.plan = 冒号后文本），批准后与真 CLI
 * 同形：权限模式切到 setMode（没给则 default）并回调 onMeta。
 */
export class EchoSession {
  state: SessionState = 'idle';
  costUsd = 0;
  /**
   * 真 `SessionManager` 每次活动都会把它推到当前时刻（manager.ts 的 `lastActivityAt`），
   * 会话列表的默认排序就建在这上面。假会话早先恒为 0，于是「按活跃度排序」
   * 这条在 e2e 里永远测不出来——按对端真实形状，这里也必须随活动推进。
   */
  lastActivityAt = 0;
  queueLength = 0;
  hasProcess = false;
  bgRunningCount = 0;
  closed = false;
  #pending: PendingPermissionSnapshot[] = [];
  #counter = 0;
  #permissionMode: PermissionMode;
  readonly permissions = { snapshot: () => this.#pending };

  constructor(
    readonly args: CreateSessionArgs,
    private readonly emit: (body: EventBody) => void,
    private readonly now: () => number = () => Date.now(),
    /** 给了就像真 CLI 一样：处理第一条消息时落转录，之后每条刷新 mtime */
    private readonly transcripts?: FakeTranscripts,
  ) {
    this.lastActivityAt = now();
    this.#permissionMode = args.permissionMode;
  }

  get sessionId(): string {
    return this.args.sessionId;
  }

  /** 收到的附件内容（clientMsgId → 交给 SDK 的 content），测试断言用 */
  readonly prepared = new Map<string, PreparedInput>();

  send(clientMsgId: string, text: string, prepared?: PreparedInput): { duplicate: boolean; uuid?: string } {
    this.hasProcess = true;
    this.lastActivityAt = this.now();
    this.transcripts?.write(this.sessionId, { firstPrompt: text, cwd: this.args.cwd });
    // 带附件的消息才给 uuid（按需拉附件要用）；不带的保持旧行为
    const uuid = prepared === undefined ? undefined : `echo-${clientMsgId}`;
    if (prepared !== undefined) this.prepared.set(clientMsgId, prepared);
    this.emit({
      type: 'user.message',
      messageId: clientMsgId,
      clientMsgId,
      text,
      ...(prepared === undefined || prepared.attachments.length === 0 ? {} : { attachments: prepared.attachments }),
      ...(uuid === undefined ? {} : { uuid }),
    });
    this.#setState('running');
    const ask =
      text.startsWith('perm:')
        ? { toolName: 'Bash', input: { command: text.slice(5) } }
        : text.startsWith('plan:')
          ? { toolName: 'ExitPlanMode', input: { plan: text.slice(5), planFilePath: '/tmp/plan.md' } }
          : undefined;
    if (ask !== undefined) {
      const requestId = `perm-${++this.#counter}`;
      this.#pending.push({ requestId, ...ask, requestedAt: 1 });
      this.#setState('waiting_permission');
      this.emit({ type: 'permission.request', requestId, ...ask, requestedAt: 1 });
      return { duplicate: false };
    }
    this.#finish(clientMsgId, text);
    return { duplicate: false, ...(uuid === undefined ? {} : { uuid }) };
  }

  respondPermission(verdict: PermissionVerdict): boolean {
    const idx = this.#pending.findIndex((p) => p.requestId === verdict.requestId);
    if (idx < 0) return false;
    const [entry] = this.#pending.splice(idx, 1);
    // 与真 PermissionBridge 同形：allow 且 updatedInput 是对象时，
    // resolved 带上实际执行的那份 input（验收 5）
    const updated = verdict.updatedInput;
    const usedUpdated =
      verdict.verdict === 'allow' && updated !== undefined && typeof updated === 'object' && updated !== null;
    // 附言 / 切模式与真 PermissionBridge 同口径：只回报实际生效的
    const message = verdict.verdict === 'deny' ? verdict.message?.trim() || undefined : undefined;
    const setMode = verdict.verdict === 'allow' ? verdict.setMode : undefined;
    this.emit({
      type: 'permission.resolved',
      requestId: verdict.requestId,
      verdict: verdict.verdict,
      ...(verdict.resolvedBy === undefined ? {} : { resolvedBy: verdict.resolvedBy }),
      ...(usedUpdated ? { updatedInput: updated } : {}),
      ...(message === undefined ? {} : { message }),
      ...(setMode === undefined ? {} : { setMode }),
    });
    // 真 CLI：ExitPlanMode 批准后自行切模式并发 system/status，会话层同步后回调 onMeta
    if (entry?.toolName === 'ExitPlanMode' && verdict.verdict === 'allow') {
      this.#permissionMode = setMode ?? 'default';
      this.args.onMeta?.(this.meta());
    }
    this.#setState('running');
    this.#finish('m-perm', `permission ${verdict.verdict}`);
    return true;
  }

  #finish(messageId: string, text: string): void {
    this.emit({ type: 'assistant.done', messageId: `a-${messageId}`, text: `echo: ${text}` });
    this.emit({ type: 'run.done', durationMs: 1, costUsd: 0, toolCount: 0, permissionCount: 0 });
    this.#setState('idle');
    this.args.onIdle?.();
  }

  #setState(state: SessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: 'run.state', state });
    // 与真 ClaudeSession 同形：每次状态迁移都回调 onMeta（manager 据此广播
    // session.updated、自动取消归档、判「一轮跑完」）
    this.args.onMeta?.(this.meta());
  }

  recall(): boolean {
    return false;
  }
  async stop(): Promise<void> {
    this.#setState('stopped');
  }
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async stopBgTask(): Promise<{ ok: false; code: 'not_found'; message: string }> {
    return { ok: false, code: 'not_found', message: '假会话没有后台任务' };
  }
  bgTasks(): [] {
    return [];
  }
  meta() {
    const first = this.#pending[0];
    return {
      sessionId: this.sessionId,
      state: this.state,
      costUsd: 0,
      lastActivityAt: this.lastActivityAt,
      cwd: this.args.cwd,
      model: this.args.model,
      permissionMode: this.#permissionMode,
      ...(this.state === 'waiting_permission' && first !== undefined
        ? { waitingFor: waitingForTool(first.toolName) }
        : {}),
      bgRunning: 0,
    };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// 一键起 agent
// ---------------------------------------------------------------------------

export interface StartEchoAgentOptions {
  getInvitation?: () => Promise<string>;
  /** 服务端根地址，如 `http://127.0.0.1:8787` */
  serverUrl: string;
  /** agent 的 home 目录（身份/名册/游标都落在这里，测试用临时目录） */
  home: string;
  /** 固定 machineId，省得每次随机；默认 'mbp' */
  machineId?: string;
  /** 展示名，默认 'Test MBP' */
  name?: string;
  /** 默认模型名，默认 'test-model' */
  defaultModel?: string;
  /**
   * claude 版本号。默认写死 'test' 而不是真去探测——测试不该依赖本机有没有
   * 装 claude（探测本身有兜底会回 'unknown'，但那样断言就得跟着环境变）。
   */
  claudeVersion?: string;
  /**
   * PATH 查找 claude。默认恒 null（= 没有全局 claude，会话走 SDK 内置、远程更新
   * 回 not_found）——测试不该因本机装没装 claude 而表现不同。
   */
  whichFn?: (cmd: string) => string | null;
  /** 假子进程（`claude --version` / `claude update`），配合 whichFn 测远程更新 */
  spawnFn?: SpawnFn;
  /** 日志出口，默认丢弃 */
  log?: (line: string) => void;
  /** 起好之后是否立刻接入服务端，默认 true */
  autoStart?: boolean;
  /**
   * 内存版转录目录。给了：会话处理消息时落转录，listSessions / rename / delete
   * 都作用于它；不给：listSessions 恒空、rename / delete 恒 not found（与早先
   * 行为一致）。无论给不给都**不会**碰真 ~/.claude。
   */
  transcripts?: FakeTranscripts;
  /**
   * 假的本机转录（session.history.request 读它）。默认一律空——测试绝不能去读
   * 真 `~/.claude/projects`。
   */
  getSessionMessagesFn?: typeof getSessionMessages;
  /**
   * 斜杠命令探测用的假 query（session.commands.request）。默认一个回空清单的桩——
   * 测试绝不能起真 claude。
   */
  commandsQueryFn?: typeof query;
  /**
   * agent 自重启的注入（见 AgentAppDeps.restart）。默认：没有 supervisor（不可用）、
   * 不读 git、预检直接失败——测试绝不能真跑 bun install 或退出进程。
   */
  restart?: AgentAppDeps['restart'];
  /**
   * 查 claude 最新版本（见 AgentAppDeps.claudeLatest）。默认：发布源一律不可达、配置目录
   * 用 agent home——测试绝不能碰网络或真 ~/.claude。
   */
  claudeLatest?: AgentAppDeps['claudeLatest'];
}

export interface EchoAgent {
  app: AgentApp;
  /** 实际注入的转录目录（没传 transcripts 时是一份不会被写入的空目录） */
  transcripts: FakeTranscripts;
  /** 优雅停掉（等价于 app.stop()，给调用方一个不必记住语义的名字） */
  stop: () => Promise<void>;
}

/**
 * 起一个注入 EchoSession 的 AgentApp。
 *
 * `autoStart` 默认 true：绝大多数用法要的就是「已经连上的 agent」。需要
 * 观察接入过程本身（或要在接入前先做点什么）时置 false，自己调 `app.start()`。
 *
 * 不负责建/删 home 目录——那是调用方的生命周期，测试通常用 `mkdtemp` +
 * `afterEach` 清理，在这里代劳反而会和调用方的清理逻辑打架。
 */
export async function startEchoAgent(
  options: StartEchoAgentOptions,
): Promise<EchoAgent> {
  const config: AgentConfig = {
    serverUrl: options.serverUrl,
    home: options.home,
    name: options.name ?? 'Test MBP',
    pair: false,
    defaultModel: options.defaultModel ?? 'test-model',
    maxSessions: undefined,
    idleTimeoutMs: undefined,
    claudeBin: undefined,
  };

  const recording = options.transcripts;
  const transcripts = recording ?? new FakeTranscripts();
  const app = await AgentApp.create(config, {
    machineId: options.machineId ?? 'mbp',
    ...(options.getInvitation === undefined ? {} : { getInvitation: options.getInvitation }),
    claudeVersion: options.claudeVersion ?? 'test',
    whichFn: options.whichFn ?? (() => null),
    ...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
    log: options.log ?? (() => {}),
    listSessionsFn:
      recording === undefined ? ((async () => []) as typeof listSessions) : transcripts.listSessions,
    getSessionInfoFn: transcripts.getSessionInfo,
    renameSessionFn: transcripts.renameSession,
    deleteSessionFn: transcripts.deleteSession,
    getSessionMessagesFn: options.getSessionMessagesFn ?? ((async () => []) as typeof getSessionMessages),
    commandsQueryFn:
      options.commandsQueryFn ??
      ((() => ({ supportedCommands: async () => [], close: () => {} })) as unknown as typeof query),
    createSession: (args) =>
      new EchoSession(args, args.emit, undefined, recording) as unknown as ClaudeSession,
    restart: options.restart ?? {
      env: {},
      repoRoot: null,
      precheck: async () => ({ ok: false, message: '测试里不跑预检', output: '' }),
    },
    claudeLatest: options.claudeLatest ?? {
      fetchImpl: (async () => {
        throw new Error('测试里不访问发布源');
      }) as unknown as typeof fetch,
      configDir: options.home,
    },
  });

  if (options.autoStart !== false) await app.start();

  return { app, transcripts, stop: () => app.stop() };
}

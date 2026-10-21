/**
 * 入站路由：路由表每一行、resolveSession 三级来源、并发去重、命令链串行、
 * 未知会话 / 满额 → 机器级 fatal、setCwd 忙时拒绝。
 *
 * 假 ClaudeSession 工厂注入 SessionManager，不起真子进程。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  getSessionMessages,
  listSessions,
  SessionMessage,
  SlashCommand as SdkSlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import type { ClientToAgentEvent, PermissionMode, SessionState } from '@trine/core';
import { sodiumReady } from '@trine/core/crypto';
import { AttachmentStore, type PreparedInput } from '../bridge/attachments.ts';
import { EventEmitter } from '../bridge/emitter.ts';
import { SessionManager, type CreateSessionArgs } from '../bridge/manager.ts';
import type { PendingPermissionSnapshot, PermissionVerdict } from '../bridge/permission.ts';
import type { ClaudeSession } from '../bridge/session.ts';
import type { OutboundEvent } from '../bridge/types.ts';
import type { Recipient } from '../net/recipients.ts';
import { FakeBlobs } from '../testing/fake-blobs.ts';
import { FakeTranscripts } from '../testing/fake-transcripts.ts';
import type { PlanUsageRefreshOutcome } from './plan-usage.ts';
import type { ClaudeUpdateOutcome } from './claude-cli.ts';
import { CwdStore } from './cwd-store.ts';
import {
  CapabilitiesCache,
  COMMAND_DESCRIPTION_MAX,
  REMOVED_ANNOUNCE_INTERVAL_MS,
  RESUME_AT_MAX_DELAY_MS,
  RESUME_AT_PROMPT,
  Router,
  toSlashCommands,
  type RouterDeps,
} from './router.ts';
import { SessionFlagsStore, TOMBSTONE_TTL_MS } from './session-flags.ts';
import {
  DELETE_RECHECK_DELAY_MS,
  DELETE_RESTAMP_SLACK_MS,
  DELETE_RESTAMP_WINDOW_MS,
  SELF_WRITE_MATCH_MS,
} from './session-mutations.ts';
import { AgentState } from './state.ts';
import { SessionLinksStore } from '../ext/links-store.ts';
import { SessionRecordsStore } from '../ext/records-store.ts';
import { ExtensionRegistry } from '../ext/registry.ts';
import { ExtensionService } from '../ext/service.ts';

/** 假会话：只实现 router / manager 会碰到的成员 */
class FakeSession {
  state: SessionState = 'idle';
  costUsd = 0;
  lastActivityAt = 0;
  queueLength = 0;
  bgRunningCount = 0;
  hasProcess = false;
  closed = false;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  readonly calls: string[] = [];
  readonly sent: { clientMsgId: string; text: string; prepared?: PreparedInput }[] = [];
  readonly verdicts: PermissionVerdict[] = [];
  pendingPermissions: PendingPermissionSnapshot[] = [];
  /** stop() 挂起直到测试手动放行（验证命令链串行） */
  releaseStop: (() => void) | undefined = undefined;
  blockStop = false;
  readonly permissions = {
    snapshot: () => this.pendingPermissions,
  };

  constructor(readonly args: CreateSessionArgs) {
    this.cwd = args.cwd;
    this.model = args.model;
    this.permissionMode = args.permissionMode;
  }
  get sessionId(): string {
    return this.args.sessionId;
  }
  send(clientMsgId: string, text: string, prepared?: PreparedInput): { duplicate: boolean; uuid?: string } {
    this.calls.push(`send:${clientMsgId}`);
    this.sent.push({ clientMsgId, text, ...(prepared === undefined ? {} : { prepared }) });
    return { duplicate: false, uuid: `uuid-${clientMsgId}` };
  }
  recall(clientMsgId: string): boolean {
    this.calls.push(`recall:${clientMsgId}`);
    return clientMsgId === 'queued-1';
  }
  respondPermission(verdict: PermissionVerdict): boolean {
    this.verdicts.push(verdict);
    return verdict.requestId === 'req-1';
  }
  async stop(): Promise<void> {
    this.calls.push('stop:begin');
    if (this.blockStop) {
      await new Promise<void>((resolve) => {
        this.releaseStop = resolve;
      });
    }
    this.calls.push('stop:end');
    this.state = 'stopped';
  }
  async setModel(model: string): Promise<void> {
    this.calls.push(`setModel:${model}`);
    this.model = model;
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.calls.push(`setPermissionMode:${mode}`);
    this.permissionMode = mode;
  }
  bgTasks(): { taskId: string; kind: 'bash'; description: string; status: 'running'; startedAt: number }[] {
    return [{ taskId: 'bg1', kind: 'bash', description: 'sleep', status: 'running', startedAt: 1 }];
  }
  async stopBgTask(taskId: string): Promise<{ ok: true } | { ok: false; code: 'not_found' | 'io'; message: string }> {
    this.calls.push(`stopBgTask:${taskId}`);
    if (taskId === 'gone') return { ok: false, code: 'not_found', message: '后台任务已结束（completed）' };
    if (taskId === 'boom') return { ok: false, code: 'io', message: '停止后台任务失败：SDK 炸了' };
    return { ok: true };
  }
  meta() {
    return {
      sessionId: this.sessionId,
      state: this.state,
      costUsd: this.costUsd,
      lastActivityAt: this.lastActivityAt,
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.permissionMode,
    };
  }
  close(reason?: string): Promise<void> {
    this.closed = true;
    this.calls.push(`close:${reason ?? ''}`);
    this.onClose?.();
    return Promise.resolve();
  }
  onClose: (() => void) | undefined = undefined;
  // —— 回退（rewind）——
  rewindBlockReason: string | undefined = undefined;
  rewindResult: { canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number } = {
    canRewind: true,
    filesChanged: ['/repo/src/a.ts', '/elsewhere/b.ts'],
    insertions: 3,
    deletions: 1,
  };
  readonly uuids = new Map<string, string>();
  pendingRewind: { resumeAt: string; dropFrom: string } | undefined = undefined;
  rewindBlocker(): string | undefined {
    return this.rewindBlockReason;
  }
  userMessageUuid(clientMsgId: string): string | undefined {
    return this.uuids.get(clientMsgId);
  }
  clientMsgIdOf(uuid: string): string | undefined {
    for (const [c, u] of this.uuids) if (u === uuid) return c;
    return undefined;
  }
  // —— 手动刷新 context ——
  contextResult: { usedTokens: number; maxTokens: number; percent: number; at: number } | Error = {
    usedTokens: 48_000,
    maxTokens: 200_000,
    percent: 24,
    at: 7,
  };
  async refreshContextNow() {
    this.calls.push('refreshContext');
    if (this.contextResult instanceof Error) throw this.contextResult;
    return this.contextResult;
  }
  async previewFiles(uuid: string) {
    this.calls.push(`rewindFiles:${uuid}:dry`);
    return this.rewindResult;
  }
  async restoreFiles(uuid: string) {
    this.calls.push(`rewindFiles:${uuid}:real`);
    return this.rewindResult;
  }
  rewindConversation(point: { resumeAt: string; dropFrom: string }): void {
    this.calls.push(`rewindConversation:${point.resumeAt}:${point.dropFrom}`);
    this.pendingRewind = point;
  }
  /** 像真 ClaudeSession 一样：状态迁移回调 onMeta（manager 广播 / 自动取消归档 / onRunEnd） */
  transition(state: SessionState): void {
    this.state = state;
    this.args.onMeta?.(this.meta());
  }
}

const phone: Recipient = { deviceId: 'phone', boxPubKey: 'B', signPubKey: 'S', pairedAt: 0 };
const c2a = (sessionId?: string) => ({
  ts: 1,
  seq: 1,
  dir: 'c2a' as const,
  ...(sessionId === undefined ? {} : { sessionId }),
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trine-router-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeHarness(options: {
  maxConcurrent?: number;
  listed?: Awaited<ReturnType<typeof listSessions>>;
  listThrows?: boolean;
  /** flags 文件路径（默认 dir/sessions.json）；测写盘失败时指到不可写目录 */
  flagsPath?: string;
  /** listSessions 也读内存假目录（默认只回 listed） */
  listFromTranscripts?: boolean;
  /** 假转录：sid → 行；dirs 记录每次调用带的 dir */
  transcripts?: Record<string, SessionMessage[]>;
  historyThrows?: boolean;
  /** 只在不带 dir 时才找得到（模拟会话切过 cwd） */
  transcriptOnlyWithoutDir?: boolean;
  /** 假子转录：`${sid}/${toolUseId}` → jsonl 行；subagentCalls 记每次调用 */
  subagentTranscripts?: Record<string, unknown[]>;
  /** 注入 claude update 执行（默认回 not_found） */
  updateClaude?: () => Promise<ClaudeUpdateOutcome>;
  /** 注入限额用量刷新；省略 = router 回「不支持」 */
  refreshUsage?: () => Promise<PlanUsageRefreshOutcome>;
  /** 注入资源订阅；省略 = router 忽略 machine.stats.request */
  machineStats?: RouterDeps['machineStats'];
  /** 注入斜杠命令探测；省略 = 不注入 probe（router 回空数组） */
  probeCommands?: (cwd: string) => Promise<SdkSlashCommand[]>;
  /** 附件存储；省略 = 不启用附件 */
  attachments?: AttachmentStore;
  /** 会话关联（扩展）；省略 = 不支持 */
  links?: SessionLinksStore;
  /** 时间线记录卡（扩展）；省略 = 不支持 */
  records?: SessionRecordsStore;
} = {}) {
  const probeCalls: string[] = [];
  const historyCalls: { sessionId: string; dir: string | undefined }[] = [];
  const subagentCalls: { sessionId: string; toolUseId: string; cwd: string | undefined }[] = [];
  const events: OutboundEvent[] = [];
  const created: FakeSession[] = [];
  const logs: string[] = [];
  let clock = 10_000;
  const now = () => clock;
  const emitter = new EventEmitter({ now, sink: (out) => events.push(out) });
  let listCalls = 0;
  // SDK 的 getSessionInfo / rename / delete 一律走内存假目录（绝不碰真 ~/.claude）；
  // listed 里的会话也放进去，两个入口看到同一份「磁盘」
  const transcripts = new FakeTranscripts(now);
  for (const info of options.listed ?? []) transcripts.write(info.sessionId, { ...info });
  const flags = await SessionFlagsStore.load(options.flagsPath ?? join(dir, 'sessions.json'));
  let router!: Router;
  const manager = new SessionManager({
    emitter,
    now,
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
    listSessionsFn: (async () => {
      listCalls++;
      if (options.listThrows) throw new Error('list 炸了');
      if (options.listFromTranscripts === true) return transcripts.listSessions();
      return options.listed ?? [];
    }) as typeof listSessions,
    getSessionInfoFn: transcripts.getSessionInfo,
    renameSessionFn: transcripts.renameSession,
    deleteSessionFn: transcripts.deleteSession,
    flags,
    ...(options.links === undefined ? {} : { sessionLinks: (sid: string) => options.links!.of(sid) }),
    onRunEnd: (sid) => router.onRunEnd(sid),
    createSession: (args) => {
      const fake = new FakeSession(args);
      created.push(fake);
      return fake as unknown as ClaudeSession;
    },
  });
  const state = await AgentState.load({ path: join(dir, 'state.json'), machineId: 'mbp', debounceMs: 5 });
  const cwdStore = await CwdStore.load(join(dir, 'cwd.json'), { defaultCwd: '/home/u' });
  const capabilities = new CapabilitiesCache();
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const renames: string[] = [];
  router = new Router({
    manager,
    emitter,
    state,
    cwdStore,
    flags,
    capabilities,
    defaultModel: 'default-model',
    machineInfo: () => ({
      name: renames.at(-1) ?? 'mbp',
      platform: 'darwin',
      osVersion: '25',
      agentVersion: '0.1.0',
      claudeVersion: '2.1',
      activeSessionCount: manager.activeCount,
    }),
    renameMachine: async (name) => {
      renames.push(name);
    },
    updateClaude:
      options.updateClaude ??
      (async () => ({
        ok: false,
        fromVersion: '2.1',
        toVersion: '2.1',
        output: '',
        outputTruncated: false,
        error: { code: 'not_found' as const, message: 'no claude' },
      })),
    ...(options.refreshUsage === undefined ? {} : { refreshUsage: options.refreshUsage }),
    ...(options.machineStats === undefined ? {} : { machineStats: options.machineStats }),
    now,
    log: (l) => logs.push(l),
    setTimeoutImpl: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeoutImpl: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    getSessionMessagesFn: (async (sessionId: string, opts?: { dir?: string }) => {
      historyCalls.push({ sessionId, dir: opts?.dir });
      if (options.historyThrows) throw new Error('读转录炸了');
      if (options.transcriptOnlyWithoutDir && opts?.dir !== undefined) return [];
      return options.transcripts?.[sessionId] ?? [];
    }) as typeof getSessionMessages,
    readSubagentTranscriptFn: async (sessionId, toolUseId, locator) => {
      subagentCalls.push({ sessionId, toolUseId, cwd: locator?.cwd });
      return options.subagentTranscripts?.[`${sessionId}/${toolUseId}`] ?? [];
    },
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.links === undefined ? {} : { links: options.links, machineId: 'mbp-id' }),
    ...(options.records === undefined ? {} : { records: options.records }),
    ...(options.probeCommands === undefined
      ? {}
      : {
          commandsProbe: {
            commands: (cwd: string) => {
              probeCalls.push(cwd);
              return options.probeCommands!(cwd);
            },
          },
        }),
  });
  const byType = (type: string) => events.filter((e) => e.event.type === type).map((e) => e.event);
  return {
    router,
    manager,
    emitter,
    state,
    cwdStore,
    flags,
    transcripts,
    capabilities,
    events,
    created,
    logs,
    timers,
    renames,
    byType,
    historyCalls,
    subagentCalls,
    probeCalls,
    advance: (ms: number) => {
      clock += ms;
    },
    get listCalls() {
      return listCalls;
    },
    /** 当前假时钟（函数而非 getter：archivedLive 等会 `...h` 展开，getter 会被冻住） */
    now,
  };
}

const params = { cwd: '/repo', model: 'claude-opus-4', permissionMode: 'default' as const };

describe('Router · resolveSession', () => {
  test('state.json 有参数 → 以 resume 方式 acquire，一次即可', async () => {
    const h = await makeHarness();
    h.state.rememberSession('s1', params);
    await h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c1', text: 'hi' }, phone);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.args).toMatchObject({ sessionId: 's1', ...params, resume: true });
    expect(h.created[0]!.sent).toEqual([{ clientMsgId: 'c1', text: 'hi' }]);
    // resume 不广播 session.created
    expect(h.byType('session.created')).toHaveLength(0);
    // 不查 listSessions
    expect(h.listCalls).toBe(0);
  });

  test('并发两帧同 sid 只 acquire 一次，且按序执行', async () => {
    const h = await makeHarness();
    h.state.rememberSession('s1', params);
    await Promise.all([
      h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c1', text: 'a' }, phone),
      h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c2', text: 'b' }, phone),
    ]);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.calls).toEqual(['send:c1', 'send:c2']);
  });

  test('链外并发 resolveSession 同 sid 也只 acquire 一次（in-flight 去重）', async () => {
    const h = await makeHarness({ listed: [listed('s1', '/repo')] });
    const [a, b] = await Promise.all([h.router.resolveSession('s1'), h.router.resolveSession('s1')]);
    expect(a).toBe(b);
    expect(h.created).toHaveLength(1);
    expect(h.listCalls).toBe(1);
  });

  test('来源二：manager meta（已 release 的会话）', async () => {
    const h = await makeHarness();
    h.manager.acquire({ sessionId: 's1', ...params });
    await h.manager.release('s1');
    expect(h.manager.has('s1')).toBe(false);
    await h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c1', text: 'hi' }, phone);
    expect(h.created).toHaveLength(2);
    expect(h.created[1]!.args).toMatchObject({ sessionId: 's1', cwd: '/repo', resume: true });
    expect(h.listCalls).toBe(0);
  });

  test('来源三：listSessions 兜底，模型缺失用 defaultModel，结果缓存 5s', async () => {
    const h = await makeHarness({ listed: [listed('old', '/proj')] });
    await h.router.handle({ type: 'input.send', ...c2a('old'), clientMsgId: 'c1', text: 'hi' }, phone);
    expect(h.created[0]!.args).toMatchObject({
      sessionId: 'old',
      cwd: '/proj',
      model: 'default-model',
      resume: true,
    });
    // 参数已进 state.json，下次不必再查
    expect(h.state.sessionParams('old')).toEqual({
      cwd: '/proj',
      model: 'default-model',
      permissionMode: 'default',
      started: true,
    });
    // 5s 内另一个未知 sid 复用缓存
    await h.router.handle({ type: 'input.send', ...c2a('nope'), clientMsgId: 'c2', text: 'x' }, phone);
    expect(h.listCalls).toBe(1);
    h.advance(6_000);
    await h.router.handle({ type: 'input.send', ...c2a('nope2'), clientMsgId: 'c3', text: 'x' }, phone);
    expect(h.listCalls).toBe(2);
  });

  test('哪都找不到 → 机器级 error.fatal(config)，不为该 sid 开 seq 流', async () => {
    const h = await makeHarness();
    await h.router.handle({ type: 'input.send', ...c2a('ghost'), clientMsgId: 'c1', text: 'hi' }, phone);
    expect(h.created).toHaveLength(0);
    const fatal = h.byType('error.fatal');
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({ kind: 'config', message: '会话 ghost 不存在' });
    expect(fatal[0]!.sessionId).toBeUndefined();
    // 会话级序列没被动过
    expect(h.emitter.peekSeq('ghost')).toBe(1);
  });

  test('listSessions 抛错 → **机器级** fatal（不为未知 sid 开 seq 流），且不缓存失败结果', async () => {
    const h = await makeHarness({ listThrows: true });
    await h.router.handle({ type: 'input.send', ...c2a('x'), clientMsgId: 'c1', text: 'hi' }, phone);
    const fatal = h.byType('error.fatal');
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({ kind: 'other' });
    expect((fatal[0] as { message: string }).message).toContain('list 炸了');
    expect(fatal[0]!.sessionId).toBeUndefined();
    expect(h.emitter.peekSeq('x')).toBe(1);
    await h.router.handle({ type: 'input.send', ...c2a('x'), clientMsgId: 'c2', text: 'hi' }, phone);
    expect(h.listCalls).toBe(2);
  });

  test('并发满额 → 回收空闲会话，给新会话让位', async () => {
    const h = await makeHarness({ maxConcurrent: 1 });
    h.state.rememberSession('s1', params);
    h.state.rememberSession('s2', params);
    await h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c1', text: 'a' }, phone);
    await h.router.handle({ type: 'input.send', ...c2a('s2'), clientMsgId: 'c2', text: 'b' }, phone);
    expect(h.created).toHaveLength(2);
    expect(h.created[0]!.closed).toBe(true);
    expect(h.manager.activeSessionIds).toEqual(['s2']);
    expect(h.byType('error.fatal')).toHaveLength(0);
  });

  test('并发满额且都在忙 → 机器级 fatal(config)', async () => {
    const h = await makeHarness({ maxConcurrent: 1 });
    h.state.rememberSession('s1', params);
    h.state.rememberSession('s2', params);
    await h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c1', text: 'a' }, phone);
    h.created[0]!.state = 'running';
    await h.router.handle({ type: 'input.send', ...c2a('s2'), clientMsgId: 'c2', text: 'b' }, phone);
    expect(h.created).toHaveLength(1);
    const fatal = h.byType('error.fatal');
    expect(fatal[0]).toMatchObject({ kind: 'config' });
    expect((fatal[0] as { message: string }).message).toContain('上限');
    expect(fatal[0]!.sessionId).toBeUndefined();
  });

  test('会话级事件缺 sessionId → 丢弃并 log', async () => {
    const h = await makeHarness();
    await h.router.handle({ type: 'input.send', ...c2a(), clientMsgId: 'c1', text: 'hi' }, phone);
    expect(h.created).toHaveLength(0);
    expect(h.logs.some((l) => l.includes('缺 sessionId'))).toBe(true);
  });
});

describe('Router · 命令链', () => {
  test('stop 未完成前，后到的 send 不执行', async () => {
    const h = await makeHarness();
    h.state.rememberSession('s1', params);
    await h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c0', text: 'warm' }, phone);
    const session = h.created[0]!;
    session.blockStop = true;

    const stop = h.router.handle({ type: 'run.stop', ...c2a('s1') }, phone);
    const send = h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c1', text: 'after' }, phone);
    await Bun.sleep(5);
    expect(session.calls).toEqual(['send:c0', 'stop:begin']);
    session.releaseStop!();
    await Promise.all([stop, send]);
    expect(session.calls).toEqual(['send:c0', 'stop:begin', 'stop:end', 'send:c1']);
  });

  test('链上异常转 error.fatal（会话级），链不断', async () => {
    const h = await makeHarness();
    h.state.rememberSession('s1', params);
    await h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c0', text: 'warm' }, phone);
    const session = h.created[0]!;
    session.setModel = async () => {
      throw new Error('SDK 拒绝');
    };
    await h.router.handle({ type: 'session.setModel', ...c2a('s1'), model: 'x' }, phone);
    const fatal = h.byType('error.fatal');
    expect(fatal[0]).toMatchObject({ kind: 'other', sessionId: 's1' });
    expect((fatal[0] as { message: string }).message).toContain('SDK 拒绝');
    // 后面的命令照常
    await h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c1', text: 'next' }, phone);
    expect(session.calls).toContain('send:c1');
  });

  test('不同 sid 的链互不阻塞', async () => {
    const h = await makeHarness();
    h.state.rememberSession('s1', params);
    h.state.rememberSession('s2', params);
    await h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c0', text: 'w' }, phone);
    h.created[0]!.blockStop = true;
    const stop = h.router.handle({ type: 'run.stop', ...c2a('s1') }, phone);
    await h.router.handle({ type: 'input.send', ...c2a('s2'), clientMsgId: 'c1', text: 'other' }, phone);
    expect(h.created[1]!.calls).toEqual(['send:c1']);
    h.created[0]!.releaseStop!();
    await stop;
  });
});

describe('Router · 路由表（会话级）', () => {
  async function withSession() {
    const h = await makeHarness();
    h.state.rememberSession('s1', params);
    await h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c0', text: 'warm' }, phone);
    return { ...h, session: h.created[0]! };
  }

  test('input.recall / run.stop / permission.respond 只作用于活跃实例，没有就 log', async () => {
    const h = await makeHarness();
    h.state.rememberSession('s1', params);
    await h.router.handle({ type: 'run.stop', ...c2a('s1') }, phone);
    await h.router.handle({ type: 'input.recall', ...c2a('s1'), clientMsgId: 'q' }, phone);
    await h.router.handle(
      { type: 'permission.respond', ...c2a('s1'), requestId: 'r', verdict: 'allow' },
      phone,
    );
    // 一个都没 resume
    expect(h.created).toHaveLength(0);
    expect(h.logs.filter((l) => l.includes('没有活跃实例'))).toHaveLength(3);
  });

  test('session.status.request 顺带发一帧 bgtask.snapshot（M2 对账点）', async () => {
    const h = await withSession();
    await h.router.handle({ type: 'session.status.request', ...c2a('s1'), reqId: 'st1' }, phone);
    expect(h.byType('session.status.response')).toHaveLength(1);
    expect(h.byType('bgtask.snapshot')).toMatchObject([{ sessionId: 's1', tasks: [{ taskId: 'bg1', status: 'running' }] }]);
  });

  test('bgtask.stop：只作用于活跃实例，应答走机器级 session.mutate.response', async () => {
    const h = await withSession();
    await h.router.handle({ type: 'bgtask.stop', ...c2a('s1'), reqId: 'b1', taskId: 'bd4zj554r' }, phone);
    await h.router.handle({ type: 'bgtask.stop', ...c2a('s1'), reqId: 'b2', taskId: 'gone' }, phone);
    await h.router.handle({ type: 'bgtask.stop', ...c2a('s1'), reqId: 'b3', taskId: 'boom' }, phone);
    expect(h.session.calls.filter((c) => c.startsWith('stopBgTask:'))).toEqual(['stopBgTask:bd4zj554r', 'stopBgTask:gone', 'stopBgTask:boom']);
    const responses = h.byType('session.mutate.response') as { reqId: string; ok: boolean; targetSessionId: string; sessionId?: string; error?: { code: string } }[];
    expect(responses).toMatchObject([
      { reqId: 'b1', ok: true, targetSessionId: 's1' },
      { reqId: 'b2', ok: false, targetSessionId: 's1', error: { code: 'not_found' } },
      { reqId: 'b3', ok: false, targetSessionId: 's1', error: { code: 'io' } },
    ]);
    // 机器级帧：不带 sessionId
    expect(responses.every((r) => r.sessionId === undefined)).toBe(true);
  });

  test('bgtask.stop：没有活跃实例不 resume，直接回 not_found', async () => {
    const h = await makeHarness();
    h.state.rememberSession('s1', params);
    await h.router.handle({ type: 'bgtask.stop', ...c2a('s1'), reqId: 'b1', taskId: 't' }, phone);
    expect(h.created).toHaveLength(0);
    expect(h.byType('session.mutate.response')).toMatchObject([{ reqId: 'b1', ok: false, error: { code: 'not_found' } }]);
  });

  test('permission.respond 透传 verdict 并带 resolvedBy=sender；未命中只 log', async () => {
    const h = await withSession();
    await h.router.handle(
      {
        type: 'permission.respond',
        ...c2a('s1'),
        requestId: 'req-1',
        verdict: 'allow',
        updatedInput: { command: 'ls' },
        remember: { scope: 'session', pattern: 'Bash(ls *)' },
      },
      phone,
    );
    expect(h.session.verdicts[0]).toEqual({
      requestId: 'req-1',
      verdict: 'allow',
      updatedInput: { command: 'ls' },
      remember: { scope: 'session', pattern: 'Bash(ls *)' },
      resolvedBy: 'phone',
    });
    await h.router.handle(
      { type: 'permission.respond', ...c2a('s1'), requestId: 'stale', verdict: 'deny' },
      phone,
    );
    expect(h.logs.some((l) => l.includes('没命中挂起项'))).toBe(true);
  });

  test('permission.respond 透传 message / setMode 到 PermissionVerdict', async () => {
    const h = await withSession();
    await h.router.handle(
      { type: 'permission.respond', ...c2a('s1'), requestId: 'req-1', verdict: 'deny', message: '继续规划' },
      phone,
    );
    await h.router.handle(
      { type: 'permission.respond', ...c2a('s1'), requestId: 'req-1', verdict: 'allow', setMode: 'acceptEdits' },
      phone,
    );
    expect(h.session.verdicts).toEqual([
      { requestId: 'req-1', verdict: 'deny', message: '继续规划', resolvedBy: 'phone' },
      { requestId: 'req-1', verdict: 'allow', setMode: 'acceptEdits', resolvedBy: 'phone' },
    ]);
  });

  test('onPermissionModeChange（manager 报 CLI 自行切换）写进 state.json', async () => {
    const h = await withSession();
    h.router.onPermissionModeChange('s1', 'acceptEdits');
    expect(h.state.sessionParams('s1')?.permissionMode).toBe('acceptEdits');
  });

  test('input.recall：命中与否都只 log（协议无回执帧）', async () => {
    const h = await withSession();
    await h.router.handle({ type: 'input.recall', ...c2a('s1'), clientMsgId: 'queued-1' }, phone);
    await h.router.handle({ type: 'input.recall', ...c2a('s1'), clientMsgId: 'nope' }, phone);
    expect(h.session.calls).toContain('recall:queued-1');
    expect(h.logs.filter((l) => l.includes('input.recall 未命中'))).toHaveLength(1);
  });

  test('setModel / setPermissionMode：await 对应方法并更新 state.json', async () => {
    const h = await withSession();
    await h.router.handle({ type: 'session.setModel', ...c2a('s1'), model: 'claude-opus-5' }, phone);
    await h.router.handle({ type: 'session.setPermissionMode', ...c2a('s1'), mode: 'plan' }, phone);
    expect(h.session.calls).toContain('setModel:claude-opus-5');
    expect(h.session.calls).toContain('setPermissionMode:plan');
    expect(h.state.sessionParams('s1')).toEqual({
      cwd: '/repo',
      model: 'claude-opus-5',
      permissionMode: 'plan',
      started: true,
    });
  });

  test('setCwd：运行中 / 等权限 / 有排队 → 会话级 fatal(config)，不动会话', async () => {
    const h = await withSession();
    for (const busy of [
      () => (h.session.state = 'running'),
      () => (h.session.state = 'waiting_permission'),
      () => {
        h.session.state = 'idle';
        h.session.queueLength = 1;
      },
    ]) {
      busy();
      await h.router.handle({ type: 'session.setCwd', ...c2a('s1'), cwd: '/elsewhere' }, phone);
    }
    const fatal = h.byType('error.fatal');
    expect(fatal).toHaveLength(3);
    expect(fatal.every((f) => f.sessionId === 's1' && (f as { kind: string }).kind === 'config')).toBe(true);
    expect(h.session.closed).toBe(false);
    expect(h.created).toHaveLength(1);
  });

  test('setCwd：空闲 → release + 以新 cwd resume + 广播 session.updated', async () => {
    const h = await withSession();
    h.session.hasProcess = true;
    await h.router.handle({ type: 'session.setCwd', ...c2a('s1'), cwd: '/elsewhere' }, phone);
    expect(h.session.closed).toBe(true);
    expect(h.created).toHaveLength(2);
    expect(h.created[1]!.args).toMatchObject({
      sessionId: 's1',
      cwd: '/elsewhere',
      model: 'claude-opus-4',
      resume: true,
    });
    expect(h.state.sessionParams('s1')?.cwd).toBe('/elsewhere');
    const updated = h.byType('session.updated').at(-1)!;
    expect(updated.sessionId).toBeUndefined();
    expect((updated as { session: { cwd: string } }).session.cwd).toBe('/elsewhere');
  });

  test('setCwd：新建且从未发过消息的会话 → 不 resume（SDK 无转录）；发过一条后 → resume', async () => {
    const h = await makeHarness();
    await h.router.handle(
      { type: 'session.create', ...c2a(), reqId: 'q', cwd: '/a', model: 'm', permissionMode: 'default' },
      phone,
    );
    const sid = h.created[0]!.sessionId;
    expect(h.state.sessionParams(sid)?.started).toBe(false);
    await h.router.handle({ type: 'session.setCwd', ...c2a(sid), cwd: '/b' }, phone);
    expect(h.created[1]!.args.resume).toBe(false);
    expect(h.state.sessionParams(sid)?.started).toBe(false);

    // 发过消息 → started 持久化为 true → 之后切目录走 resume
    await h.router.handle({ type: 'input.send', ...c2a(sid), clientMsgId: 'c1', text: 'hi' }, phone);
    expect(h.state.sessionParams(sid)?.started).toBe(true);
    await h.router.handle({ type: 'session.setCwd', ...c2a(sid), cwd: '/c' }, phone);
    expect(h.created[2]!.args.resume).toBe(true);
  });

  test('重启后（state 记着 started:false）对未发过消息的会话不 resume；历史会话省略 started → resume', async () => {
    const h = await makeHarness();
    h.state.rememberSession('fresh', { ...params, started: false });
    h.state.rememberSession('old', params);
    await h.router.handle({ type: 'session.setModel', ...c2a('fresh'), model: 'm2' }, phone);
    await h.router.handle({ type: 'session.setModel', ...c2a('old'), model: 'm2' }, phone);
    expect(h.created.find((c) => c.sessionId === 'fresh')!.args.resume).toBe(false);
    expect(h.created.find((c) => c.sessionId === 'old')!.args.resume).toBe(true);
  });

  test('session.context.request：定向回请求方；失败收敛成 failed；会话打不开回机器级 not_found', async () => {
    const h = await withSession();
    await h.router.handle({ type: 'session.context.request', ...c2a('s1'), reqId: 'c1' }, tablet);
    const [ok] = h.events.filter((e) => e.event.type === 'session.context.response');
    expect(ok!.to).toBe('tablet');
    expect(ok!.event).toMatchObject({ sessionId: 's1', reqId: 'c1', ok: true, context: { usedTokens: 48_000, maxTokens: 200_000 } });
    expect(h.session.calls).toContain('refreshContext');

    h.session.contextResult = new Error('读取 context 用量超时');
    await h.router.handle({ type: 'session.context.request', ...c2a('s1'), reqId: 'c2' }, phone);
    expect(h.byType('session.context.response')[1]).toMatchObject({
      reqId: 'c2',
      ok: false,
      error: { code: 'failed', message: '读取 context 用量超时' },
    });
    expect(h.byType('error.fatal')).toHaveLength(0);

    await h.router.handle({ type: 'session.context.request', ...c2a('ghost'), reqId: 'c3' }, phone);
    const [missing] = h.events.filter((e) => e.event.type === 'session.context.response' && e.event.reqId === 'c3');
    expect(missing!.scope).toBeNull();
    expect(missing!.event).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  test('session.status.request → 会话级 response，还没取到 context 时为 0/0', async () => {
    const h = await withSession();
    h.session.costUsd = 0.42;
    await h.router.handle({ type: 'session.status.request', ...c2a('s1'), reqId: 'q1' }, phone);
    const resp = h.byType('session.status.response')[0]!;
    expect(resp).toMatchObject({
      sessionId: 's1',
      reqId: 'q1',
      model: 'claude-opus-4',
      cwd: '/repo',
      permissionMode: 'default',
      costUsd: 0.42,
      contextUsedTokens: 0,
      contextLimitTokens: 0,
      agentVersion: '0.1.0',
      claudeVersion: '2.1',
    });
  });

  test('mcp.status.request → 会话级 response，取自 capabilities 旁路缓存', async () => {
    const h = await withSession();
    await h.router.handle({ type: 'mcp.status.request', ...c2a('s1'), reqId: 'q1' }, phone);
    expect(h.byType('mcp.status.response')[0]).toMatchObject({ reqId: 'q1', servers: [] });
    // 会话吐了能力清单后再问
    h.emitter.emit(
      {
        type: 'session.capabilities',
        slashCommands: [],
        models: ['m'],
        mcpServers: [{ name: 'fs', state: 'connected', toolCount: 0 }],
      },
      's1',
    );
    h.capabilities.observe(h.events.at(-1)!.event);
    await h.router.handle({ type: 'mcp.status.request', ...c2a('s1'), reqId: 'q2' }, phone);
    expect(h.byType('mcp.status.response')[1]).toMatchObject({
      reqId: 'q2',
      servers: [{ name: 'fs', state: 'connected', toolCount: 0 }],
    });
  });

  test('run.resumeAt：定时器 clamp 到 [0, 24h]，同会话覆盖，到点发续跑提示', async () => {
    const h = await withSession();
    await h.router.handle({ type: 'run.resumeAt', ...c2a('s1'), at: 10_000 + 5_000 }, phone);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(5_000);
    // 过去的时间 → 0；超过一天 → 一天
    await h.router.handle({ type: 'run.resumeAt', ...c2a('s1'), at: 1 }, phone);
    expect(h.timers[0]!.cleared).toBe(true);
    expect(h.timers[1]!.ms).toBe(0);
    await h.router.handle({ type: 'run.resumeAt', ...c2a('s1'), at: 10_000 + 10 * RESUME_AT_MAX_DELAY_MS }, phone);
    expect(h.timers[2]!.ms).toBe(RESUME_AT_MAX_DELAY_MS);
    expect(h.router.pendingResumeCount).toBe(1);

    h.timers[2]!.fn();
    await h.router.idle();
    expect(h.session.sent.at(-1)!.text).toBe(RESUME_AT_PROMPT);
    expect(h.router.pendingResumeCount).toBe(0);

    // dispose 清掉挂着的定时器
    await h.router.handle({ type: 'run.resumeAt', ...c2a('s1'), at: 10_000 + 99 }, phone);
    h.router.dispose();
    expect(h.timers.at(-1)!.cleared).toBe(true);
    expect(h.router.pendingResumeCount).toBe(0);
  });
});

describe('Router · 路由表（机器级）', () => {
  test('session.create → acquire + 机器级 session.create.response（reqId）+ 记 state', async () => {
    const h = await makeHarness();
    await h.router.handle(
      { type: 'session.create', ...c2a(), reqId: 'q1', cwd: '/a', model: 'm', permissionMode: 'plan' },
      phone,
    );
    expect(h.created).toHaveLength(1);
    const sid = h.created[0]!.sessionId;
    expect(h.created[0]!.args.resume).toBeUndefined();
    const resp = h.byType('session.create.response')[0]!;
    expect(resp.sessionId).toBeUndefined();
    expect(resp).toMatchObject({ reqId: 'q1', session: { sessionId: sid, cwd: '/a', model: 'm', permissionMode: 'plan' } });
    // bridge 自发的 session.created 也在（各占一个机器级 seq）
    expect(h.byType('session.created')).toHaveLength(1);
    expect(h.state.sessionParams(sid)).toEqual({ cwd: '/a', model: 'm', permissionMode: 'plan', started: false });
  });

  test('session.create 满额且都在忙 → 机器级 fatal(config)，无 response', async () => {
    const h = await makeHarness({ maxConcurrent: 1 });
    const create = (reqId: string) =>
      h.router.handle(
        { type: 'session.create', ...c2a(), reqId, cwd: '/a', model: 'm', permissionMode: 'default' },
        phone,
      );
    await create('q1');
    h.created[0]!.state = 'running';
    await create('q2');
    expect(h.byType('session.create.response')).toHaveLength(1);
    expect(h.byType('error.fatal')[0]).toMatchObject({ kind: 'config' });
  });

  test('session.list.request → 机器级 response', async () => {
    const h = await makeHarness({ listed: [listed('old', '/p')] });
    await h.router.handle({ type: 'session.list.request', ...c2a(), reqId: 'q1' }, phone);
    const resp = h.byType('session.list.response')[0]!;
    expect(resp.sessionId).toBeUndefined();
    expect((resp as { sessions: { sessionId: string }[] }).sessions.map((s) => s.sessionId)).toEqual(['old']);
  });

  test('cwd.*：list 回 response(reqId)，add/remove/setDefault 广播 cwd.updated 并落盘', async () => {
    const h = await makeHarness();
    await h.router.handle({ type: 'cwd.list.request', ...c2a(), reqId: 'q1' }, phone);
    expect(h.byType('cwd.list.response')[0]).toMatchObject({ reqId: 'q1', favorites: [], defaultCwd: '/home/u' });
    await h.router.handle({ type: 'cwd.add', ...c2a(), path: '/repo/a' }, phone);
    await h.router.handle({ type: 'cwd.add', ...c2a(), path: '/repo/b' }, phone);
    await h.router.handle({ type: 'cwd.setDefault', ...c2a(), path: '/repo/b' }, phone);
    await h.router.handle({ type: 'cwd.remove', ...c2a(), path: '/repo/a' }, phone);
    const updates = h.byType('cwd.updated');
    expect(updates).toHaveLength(4);
    expect(updates.at(-1)).toMatchObject({ favorites: ['/repo/b'], defaultCwd: '/repo/b' });
    expect((await CwdStore.load(join(dir, 'cwd.json'))).snapshot()).toEqual({
      favorites: ['/repo/b'],
      defaultCwd: '/repo/b',
      pinned: {},
    });
  });

  test('cwd.pin → 落盘 + 广播带 pinned 的 cwd.updated（重复请求也广播）', async () => {
    const h = await makeHarness();
    await h.router.handle({ type: 'cwd.pin', ...c2a(), path: '/repo/a', pinned: true }, phone);
    await h.router.handle({ type: 'cwd.pin', ...c2a(), path: '/repo/a', pinned: true }, phone);
    const updates = h.byType('cwd.updated');
    expect(updates).toHaveLength(2);
    expect(updates.at(-1)).toMatchObject({ pinned: { '/repo/a': expect.any(Number) } });
    await h.router.handle({ type: 'cwd.pin', ...c2a(), path: '/repo/a', pinned: false }, phone);
    expect(h.byType('cwd.updated').at(-1)).toMatchObject({ pinned: {} });
    expect((await CwdStore.load(join(dir, 'cwd.json'))).snapshot().pinned).toEqual({});
  });

  test('machine.rename → 落盘回调 + 广播 machine.info；machine.unpair 忽略', async () => {
    const h = await makeHarness();
    await h.router.handle({ type: 'machine.rename', ...c2a(), name: 'Studio' }, phone);
    expect(h.renames).toEqual(['Studio']);
    expect(h.byType('machine.info')[0]).toMatchObject({ info: { name: 'Studio' } });
    await h.router.handle({ type: 'machine.unpair', ...c2a() }, phone);
    expect(h.logs.some((l) => l.includes('machine.unpair'))).toBe(true);
    expect(h.events.filter((e) => e.event.type !== 'machine.info')).toHaveLength(0);
  });

  test('machine.claude.update.request：链外执行，不堵机器级链；跑完回机器级应答', async () => {
    let release!: (o: ClaudeUpdateOutcome) => void;
    const h = await makeHarness({
      updateClaude: () => new Promise<ClaudeUpdateOutcome>((r) => (release = r)),
    });
    await h.router.handle({ type: 'machine.claude.update.request', ...c2a(), reqId: 'u1' }, phone);
    // 更新还在跑：机器级链已空出来，session.list 照常应答
    await h.router.handle({ type: 'session.list.request', ...c2a(), reqId: 'l1' }, phone);
    expect(h.byType('session.list.response')).toHaveLength(1);
    expect(h.byType('machine.claude.update.response')).toHaveLength(0);

    release({
      ok: true,
      fromVersion: '2.1.251',
      toVersion: '2.1.282',
      output: 'updated',
      outputTruncated: false,
    });
    await h.router.idle();
    const [resp] = h.events.filter((e) => e.event.type === 'machine.claude.update.response');
    expect(resp!.scope).toBeNull();
    expect(resp!.event).toMatchObject({
      reqId: 'u1',
      ok: true,
      fromVersion: '2.1.251',
      toVersion: '2.1.282',
      output: 'updated',
    });
    expect(resp!.event).not.toHaveProperty('outputTruncated');
    expect(resp!.event).not.toHaveProperty('error');
  });

  test('machine.claude.update.request：失败原样转发；执行器抛了兜成 failed', async () => {
    const h = await makeHarness();
    await h.router.handle({ type: 'machine.claude.update.request', ...c2a(), reqId: 'u1' }, phone);
    await h.router.idle();
    expect(h.byType('machine.claude.update.response')[0]).toMatchObject({
      reqId: 'u1',
      ok: false,
      error: { code: 'not_found' },
    });

    const t = await makeHarness({
      updateClaude: async () => {
        throw new Error('boom');
      },
    });
    await t.router.handle({ type: 'machine.claude.update.request', ...c2a(), reqId: 'u2' }, phone);
    await t.router.idle();
    expect(t.byType('machine.claude.update.response')[0]).toMatchObject({
      reqId: 'u2',
      ok: false,
      fromVersion: '2.1',
      toVersion: '2.1',
      error: { code: 'failed' },
    });
    expect(t.byType('error.fatal')).toHaveLength(0);
  });

  test('machine.usage.request：链外执行；成功 / 失败 / 抛错 / 不支持都回机器级应答', async () => {
    let release!: (o: PlanUsageRefreshOutcome) => void;
    const h = await makeHarness({ refreshUsage: () => new Promise((r) => (release = r)) });
    await h.router.handle({ type: 'machine.usage.request', ...c2a(), reqId: 'r1' }, phone);
    await h.router.handle({ type: 'session.list.request', ...c2a(), reqId: 'l1' }, phone);
    expect(h.byType('session.list.response')).toHaveLength(1);
    release({ ok: true });
    await h.router.idle();
    const [resp] = h.events.filter((e) => e.event.type === 'machine.usage.response');
    expect(resp!.scope).toBeNull();
    expect(resp!.event).toMatchObject({ reqId: 'r1', ok: true });
    expect(resp!.event).not.toHaveProperty('error');

    const failed = await makeHarness({
      refreshUsage: async () => ({ ok: false, code: 'unavailable', message: 'no plan' }),
    });
    await failed.router.handle({ type: 'machine.usage.request', ...c2a(), reqId: 'r2' }, phone);
    await failed.router.idle();
    expect(failed.byType('machine.usage.response')[0]).toMatchObject({
      ok: false,
      error: { code: 'unavailable', message: 'no plan' },
    });

    const thrown = await makeHarness({
      refreshUsage: async () => {
        throw new Error('boom');
      },
    });
    await thrown.router.handle({ type: 'machine.usage.request', ...c2a(), reqId: 'r3' }, phone);
    await thrown.router.idle();
    expect(thrown.byType('machine.usage.response')[0]).toMatchObject({ ok: false, error: { code: 'failed' } });

    const none = await makeHarness();
    await none.router.handle({ type: 'machine.usage.request', ...c2a(), reqId: 'r4' }, phone);
    await none.router.idle();
    expect(none.byType('machine.usage.response')[0]).toMatchObject({ ok: false, error: { code: 'failed' } });
  });

  test('machine.stats.request：带发起设备与 watch 交给 watcher，链外执行；不支持时忽略', async () => {
    const calls: unknown[] = [];
    let release!: () => void;
    const h = await makeHarness({
      machineStats: {
        request: (deviceId, reqId, watch) => {
          calls.push({ deviceId, reqId, watch });
          return new Promise<void>((r) => (release = r));
        },
      },
    });
    const watch = { intervalMs: 5000, ttlMs: 60_000 };
    await h.router.handle({ type: 'machine.stats.request', ...c2a(), reqId: 's1', watch }, phone);
    await h.router.handle({ type: 'session.list.request', ...c2a(), reqId: 'l1' }, phone);
    expect(h.byType('session.list.response')).toHaveLength(1);
    expect(calls).toEqual([{ deviceId: 'phone', reqId: 's1', watch }]);
    release();
    await h.router.idle();

    const none = await makeHarness();
    await none.router.handle({ type: 'machine.stats.request', ...c2a(), reqId: 's2' }, phone);
    await none.router.idle();
    expect(none.events).toHaveLength(0);
  });

  test('机器级事件即便带了 sessionId 也按机器级处理', async () => {
    const h = await makeHarness();
    await h.router.handle({ type: 'cwd.list.request', ...c2a('s1'), reqId: 'q1' } as ClientToAgentEvent, phone);
    expect(h.byType('cwd.list.response')[0]!.sessionId).toBeUndefined();
    expect(h.created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// session-list-v2：rename / archive / delete
// ---------------------------------------------------------------------------

type Harness = Awaited<ReturnType<typeof makeHarness>>;

/** 取某 reqId 的机器级应答 */
function responseOf(h: Harness, reqId: string) {
  const all = h
    .byType('session.mutate.response')
    .filter((e) => (e as { reqId: string }).reqId === reqId);
  expect(all).toHaveLength(1);
  const resp = all[0] as {
    sessionId?: string;
    targetSessionId: string;
    ok: boolean;
    error?: { code: string; message: string };
  };
  // 机器级：信封 / 密文都不带 sessionId
  expect(resp.sessionId).toBeUndefined();
  return resp;
}

const rename = (sid: string, reqId: string, title: string) =>
  ({ type: 'session.rename', ...c2a(sid), reqId, title }) as ClientToAgentEvent;
const archive = (sid: string, reqId: string, archived = true) =>
  ({ type: 'session.archive', ...c2a(sid), reqId, archived }) as ClientToAgentEvent;
const pin = (sid: string, reqId: string, pinned = true) =>
  ({ type: 'session.pin', ...c2a(sid), reqId, pinned }) as ClientToAgentEvent;
const del = (sid: string, reqId: string) =>
  ({ type: 'session.delete', ...c2a(sid), reqId }) as ClientToAgentEvent;
const updatedSessions = (h: Harness) =>
  h.byType('session.updated').map((e) => (e as unknown as { session: Record<string, unknown> }).session);

/** 历史会话：磁盘上有转录（mtime 足够旧），本进程没有实例 */
async function withHistorical(sid = 'h1', options: Parameters<typeof makeHarness>[0] = {}) {
  const h = await makeHarness(options);
  h.transcripts.write(sid, { cwd: '/repo', firstPrompt: 'hello', lastModified: 0 });
  // 时钟拨到转录 mtime 两分钟之后：删除的「60s 内写过」检查不误伤
  h.advance(120_000);
  return h;
}

describe('Router · 元数据命令不 resolveSession（B2）', () => {
  test('对历史会话 rename / archive 不 acquire、不查 list、不占并发名额', async () => {
    const h = await makeHarness({ maxConcurrent: 1 });
    for (const sid of ['a', 'b', 'c']) h.transcripts.write(sid, { cwd: '/r', lastModified: 0 });
    h.state.rememberSession('live', params);
    await h.router.handle({ type: 'input.send', ...c2a('live'), clientMsgId: 'c', text: 'x' }, phone);
    expect(h.manager.activeCount).toBe(1);
    for (const sid of ['a', 'b', 'c']) {
      await h.router.handle(rename(sid, `r-${sid}`, `名字 ${sid}`), phone);
      await h.router.handle(archive(sid, `a-${sid}`), phone);
      expect(responseOf(h, `r-${sid}`).ok).toBe(true);
      expect(responseOf(h, `a-${sid}`).ok).toBe(true);
    }
    expect(h.created).toHaveLength(1);
    expect(h.manager.activeCount).toBe(1);
    expect(h.listCalls).toBe(0);
    expect(h.byType('error.fatal')).toHaveLength(0);
  });

  test('handler 内部异常转 io 应答，不走链兜底的会话级 error.fatal，链不断', async () => {
    const h = await withHistorical();
    h.transcripts.failNext = new Error('EACCES: permission denied');
    await h.router.handle(rename('h1', 'q1', 'x'), phone);
    const resp = responseOf(h, 'q1');
    expect(resp).toMatchObject({ ok: false, targetSessionId: 'h1', error: { code: 'io' } });
    expect(resp.error!.message).toContain('EACCES');
    expect(h.byType('error.fatal')).toHaveLength(0);
    // 同会话链上后续命令照常
    await h.router.handle(rename('h1', 'q2', 'y'), phone);
    expect(responseOf(h, 'q2').ok).toBe(true);
  });
});

describe('Router · session.rename', () => {
  test('历史会话：规范化后写转录，广播 updated（机器级）并应答 ok', async () => {
    const h = await withHistorical();
    await h.router.handle(rename('h1', 'q1', '  部署\u0000脚本\n  '), phone);
    expect(h.transcripts.calls).toContain('rename:h1:部署 脚本');
    expect(responseOf(h, 'q1')).toMatchObject({ ok: true, targetSessionId: 'h1' });
    expect(responseOf(h, 'q1').error).toBeUndefined();
    const updated = h.byType('session.updated').at(-1)!;
    expect(updated.sessionId).toBeUndefined();
    expect(updatedSessions(h).at(-1)).toMatchObject({ sessionId: 'h1', title: '部署 脚本', cwd: '/repo' });
    expect(h.created).toHaveLength(0);
  });

  test('规范化后为空 → invalid，不碰转录', async () => {
    const h = await withHistorical();
    await h.router.handle(rename('h1', 'q1', ' \u0001\u007f '), phone);
    expect(responseOf(h, 'q1')).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(h.transcripts.calls.filter((c) => c.startsWith('rename'))).toEqual([]);
    expect(h.byType('session.updated')).toHaveLength(0);
  });

  test('哪都找不到 → not_found', async () => {
    const h = await makeHarness();
    await h.router.handle(rename('ghost', 'q1', 'x'), phone);
    expect(responseOf(h, 'q1')).toMatchObject({ ok: false, targetSessionId: 'ghost', error: { code: 'not_found' } });
    expect(h.created).toHaveLength(0);
  });

  test('活跃会话改名后，resume / 状态迁移不再把标题冲掉（B3 回归）', async () => {
    const h = await withHistorical();
    h.state.rememberSession('h1', params);
    await h.router.handle(rename('h1', 'q1', '部署脚本'), phone);
    await h.router.handle({ type: 'input.send', ...c2a('h1'), clientMsgId: 'c1', text: 'go' }, phone);
    // resume 时带了种子（state.json 有参数 → 走 getSessionInfo，不查 list）
    expect(h.listCalls).toBe(0);
    expect(h.manager.metaOf('h1')).toMatchObject({ title: '部署脚本', firstPrompt: 'hello' });
    h.created[0]!.transition('running');
    h.created[0]!.transition('idle');
    for (const s of updatedSessions(h)) expect(s.title).toBe('部署脚本');
  });

  test('从没发过消息（started:false、无转录）→ 记 pendingTitle；首轮跑完后补写并清掉', async () => {
    const h = await makeHarness();
    await h.router.handle(
      { type: 'session.create', ...c2a(), reqId: 'mk', cwd: '/a', model: 'm', permissionMode: 'default' },
      phone,
    );
    const sid = h.created[0]!.sessionId;
    await h.router.handle(rename(sid, 'q1', '新会话'), phone);
    expect(responseOf(h, 'q1').ok).toBe(true);
    expect(h.transcripts.calls.filter((c) => c.startsWith('rename'))).toEqual([]);
    expect(h.flags.pendingTitle(sid)).toBe('新会话');
    expect(updatedSessions(h).at(-1)).toMatchObject({ sessionId: sid, title: '新会话' });
    expect((await h.manager.list()).find((s) => s.sessionId === sid)!.title).toBe('新会话');

    // 发首条消息：input.send 时转录还没落盘 → 补写找不到文件，pending 留着
    await h.router.handle({ type: 'input.send', ...c2a(sid), clientMsgId: 'c1', text: 'hi' }, phone);
    expect(h.transcripts.calls).toContain(`rename:${sid}:新会话`);
    expect(h.flags.pendingTitle(sid)).toBe('新会话');
    // 子进程处理消息、落转录（此时 SDK 摘要是 firstPrompt）；一轮跑完 → onRunEnd 补写
    h.transcripts.write(sid, { firstPrompt: 'hi', cwd: '/a' });
    expect((await h.manager.list()).find((s) => s.sessionId === sid)!.title).toBe('新会话');
    h.created[0]!.transition('running');
    h.created[0]!.transition('idle');
    await h.router.idle();
    expect(h.transcripts.info(sid)!.customTitle).toBe('新会话');
    expect(h.flags.pendingTitle(sid)).toBeUndefined();
    expect((await h.manager.list()).find((s) => s.sessionId === sid)!.title).toBe('新会话');
  });

  test('有活跃实例但转录尚未落盘（首条消息刚发出）→ 也记 pendingTitle 而非 not_found', async () => {
    const h = await makeHarness();
    h.state.rememberSession('s1', { ...params, started: false });
    await h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c1', text: 'hi' }, phone);
    expect(h.state.sessionParams('s1')?.started).toBe(true);
    await h.router.handle(rename('s1', 'q1', '赶早'), phone);
    expect(responseOf(h, 'q1').ok).toBe(true);
    expect(h.flags.pendingTitle('s1')).toBe('赶早');
  });

  test('转录已写成功时清掉旧 pendingTitle（否则 decorate 会拿旧名盖住新名）', async () => {
    const h = await withHistorical();
    await h.flags.setPendingTitle('h1', '旧名');
    await h.router.handle(rename('h1', 'q1', '新名'), phone);
    expect(h.flags.pendingTitle('h1')).toBeUndefined();
    expect(updatedSessions(h).at(-1)!.title).toBe('新名');
  });
});

describe('Router · 元数据命令广播带齐派生字段（验收 V1）', () => {
  /** 本进程新建、发过一条消息、没手动改过名：缓存 title 为 ''，从没被 list() 回填过 */
  async function chattedNew() {
    const h = await makeHarness();
    await h.router.handle(
      { type: 'session.create', ...c2a(), reqId: 'mk', cwd: '/a', model: 'm', permissionMode: 'default' },
      phone,
    );
    const session = h.created[0]!;
    const sid = session.sessionId;
    await h.router.handle({ type: 'input.send', ...c2a(sid), clientMsgId: 'c1', text: 'perm:ls -la' }, phone);
    h.transcripts.write(sid, { firstPrompt: 'perm:ls -la', cwd: '/a', gitBranch: 'main' });
    session.transition('running');
    session.transition('idle');
    await h.router.idle();
    expect(h.manager.metaOf(sid)!.title).toBe('');
    return { ...h, sid };
  }

  test('先发消息再归档：updated 带 firstPrompt 派生的标题与 lastEvent', async () => {
    const h = await chattedNew();
    await h.router.handle(archive(h.sid, 'q1'), phone);
    expect(responseOf(h, 'q1').ok).toBe(true);
    expect(updatedSessions(h).at(-1)).toMatchObject({
      sessionId: h.sid,
      title: 'perm:ls -la',
      lastEvent: 'perm:ls -la',
      firstPrompt: 'perm:ls -la',
      gitBranch: 'main',
      archived: true,
    });
    // 回填进了缓存：之后的状态迁移广播也不再贫瘠
    h.created[0]!.transition('running');
    expect(updatedSessions(h).at(-1)).toMatchObject({ title: 'perm:ls -la', lastEvent: 'perm:ls -la' });
  });

  test('先发消息再改名：updated 带新标题且保留 lastEvent', async () => {
    const h = await chattedNew();
    await h.router.handle(rename(h.sid, 'q1', '看目录'), phone);
    expect(updatedSessions(h).at(-1)).toMatchObject({ sessionId: h.sid, title: '看目录', lastEvent: 'perm:ls -la' });
  });

  test('resume 过的历史会话（种子有标题、无 lastEvent）归档：lastEvent 补齐', async () => {
    const h = await withHistorical();
    h.state.rememberSession('h1', params);
    await h.router.handle({ type: 'input.send', ...c2a('h1'), clientMsgId: 'c1', text: 'go' }, phone);
    await h.router.handle(archive('h1', 'q1'), phone);
    expect(updatedSessions(h).at(-1)).toMatchObject({ sessionId: 'h1', title: 'hello', lastEvent: 'hello' });
  });

  test('list() 回填只填缺的：缓存里刚改的名不被列表快照覆盖', async () => {
    const h = await makeHarness({ listFromTranscripts: true });
    h.transcripts.write('h1', { cwd: '/repo', firstPrompt: 'hello', lastModified: 0 });
    h.state.rememberSession('h1', params);
    await h.router.handle({ type: 'input.send', ...c2a('h1'), clientMsgId: 'c1', text: 'go' }, phone);
    h.manager.updateMeta('h1', { title: '缓存里的新名' });
    await h.manager.list();
    expect(h.manager.metaOf('h1')).toMatchObject({ title: '缓存里的新名', lastEvent: 'hello' });
  });
});

describe('Router · pendingTitle 不盖住别处写的正式标题（评审 minor 1）', () => {
  test('转录里已有 customTitle：列表不用 pending 覆盖；补写时放弃 pending', async () => {
    const h = await makeHarness({ listFromTranscripts: true });
    await h.router.handle(
      { type: 'session.create', ...c2a(), reqId: 'mk', cwd: '/a', model: 'm', permissionMode: 'default' },
      phone,
    );
    const session = h.created[0]!;
    const sid = session.sessionId;
    await h.router.handle(rename(sid, 'q1', 'A'), phone);
    expect(h.flags.pendingTitle(sid)).toBe('A');
    // 转录落盘后，用户在本机 CLI `/rename B`（补写还没轮到）
    h.transcripts.write(sid, { firstPrompt: 'hi', cwd: '/a' });
    h.advance(1_000);
    await h.transcripts.renameSession(sid, 'B');
    expect((await h.manager.list()).find((s) => s.sessionId === sid)!.title).toBe('B');
    // 一轮跑完触发补写：看到更新的 customTitle → 放弃 A，不写回
    session.transition('running');
    session.transition('idle');
    await h.router.idle();
    expect(h.flags.pendingTitle(sid)).toBeUndefined();
    expect(h.transcripts.info(sid)!.customTitle).toBe('B');
    expect(h.transcripts.calls).not.toContain(`rename:${sid}:A`);
    expect(h.manager.metaOf(sid)!.title).toBe('B');
  });
});

describe('Router · 删除的 60s 检查排除 trine 自己的写（评审 minor 2）', () => {
  test('刚用 trine 改完名马上删 → 允许；之后有外部写入 → busy（文案指本机终端）', async () => {
    const h = await withHistorical();
    await h.router.handle(archive('h1', 'qa'), phone);
    await h.router.handle(rename('h1', 'qr', '新名'), phone);
    expect(h.transcripts.info('h1')!.lastModified).toBe(h.now());
    await h.router.handle(del('h1', 'qd'), phone);
    expect(responseOf(h, 'qd').ok).toBe(true);

    const h2 = await makeHarness({ flagsPath: join(dir, 'other.json') });
    h2.transcripts.write('h2', { cwd: '/repo', lastModified: 0 });
    h2.advance(120_000);
    await h2.router.handle(archive('h2', 'qa'), phone);
    await h2.router.handle(rename('h2', 'qr', '新名'), phone);
    h2.advance(1_000);
    h2.transcripts.write('h2', {}); // 本机终端继续聊（mtime 晚于 trine 自己那次写）
    await h2.router.handle(del('h2', 'qd'), phone);
    const resp = responseOf(h2, 'qd');
    expect(resp).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(resp.error!.message).toContain('本机终端可能正在使用该会话');
  });
});

describe('Router · 自写豁免精确匹配（评审 N2）', () => {
  test('mtime 在 [自写时刻 - 1s, 自写时刻] → 豁免；更早 → 仍按 60s 规则 busy（更晚见上一条）', async () => {
    const h = await withHistorical();
    await h.router.handle(archive('h1', 'qa'), phone);
    await h.router.handle(rename('h1', 'qr', '新名'), phone);
    const self = h.flags.lastSelfWriteAt('h1')!;
    // 粗粒度文件系统把 mtime 向下取整：略早于自写时刻仍算自己
    h.transcripts.write('h1', { lastModified: self - SELF_WRITE_MATCH_MS });
    h.advance(10_000);
    await h.router.handle(del('h1', 'qd'), phone);
    expect(responseOf(h, 'qd').ok).toBe(true);

    const h2 = await makeHarness({ flagsPath: join(dir, 'other.json') });
    h2.transcripts.write('h2', { cwd: '/repo', lastModified: 0 });
    h2.advance(120_000);
    await h2.router.handle(archive('h2', 'qa'), phone);
    await h2.router.handle(rename('h2', 'qr', '新名'), phone);
    const self2 = h2.flags.lastSelfWriteAt('h2')!;
    // 60s 内的 mtime 却明显早于自写时刻：不是我们那次写留下的，不豁免
    h2.transcripts.write('h2', { lastModified: self2 - SELF_WRITE_MATCH_MS - 1 });
    await h2.router.handle(del('h2', 'qd'), phone);
    expect(responseOf(h2, 'qd')).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(h2.transcripts.has('h2')).toBe(true);
  });
});

describe('Router · 外部改名跟进（评审 N3 / N4）', () => {
  test('本机 CLI 改名后：list() 以 customTitle 覆盖缓存 title，随后的状态迁移广播也带新标题', async () => {
    const h = await makeHarness({ listFromTranscripts: true });
    h.transcripts.write('h1', { cwd: '/repo', firstPrompt: 'hello', lastModified: 0 });
    h.state.rememberSession('h1', params);
    await h.router.handle({ type: 'input.send', ...c2a('h1'), clientMsgId: 'c1', text: 'go' }, phone);
    await h.manager.list();
    expect(h.manager.metaOf('h1')!.title).toBe('hello');
    // 用户在本机 CLI `/rename B`
    await h.transcripts.renameSession('h1', 'B');
    expect((await h.manager.list()).find((s) => s.sessionId === 'h1')!.title).toBe('B');
    expect(h.manager.metaOf('h1')!.title).toBe('B');
    const session = h.created[0]!;
    session.transition('running');
    expect(updatedSessions(h).at(-1)).toMatchObject({ sessionId: 'h1', title: 'B' });
    session.transition('idle');
    await h.router.idle();
    expect(updatedSessions(h).at(-1)).toMatchObject({ sessionId: 'h1', title: 'B' });
    // 再改一次也跟进（覆盖，不只是缺失时回填）
    await h.transcripts.renameSession('h1', 'C');
    await h.manager.list();
    expect(h.manager.metaOf('h1')!.title).toBe('C');
  });

  test('flushPendingTitle 发现外部已改名而放弃 pending → 补发一次带外部标题的 updated', async () => {
    const h = await makeHarness({ listFromTranscripts: true });
    await h.router.handle(
      { type: 'session.create', ...c2a(), reqId: 'mk', cwd: '/a', model: 'm', permissionMode: 'default' },
      phone,
    );
    const session = h.created[0]!;
    const sid = session.sessionId;
    await h.router.handle(rename(sid, 'q1', 'A'), phone);
    h.transcripts.write(sid, { firstPrompt: 'hi', cwd: '/a' });
    h.advance(1_000);
    await h.transcripts.renameSession(sid, 'B');
    // 不经 list()：web 此前收到的都是 pending A
    session.transition('running');
    expect(updatedSessions(h).at(-1)).toMatchObject({ sessionId: sid, title: 'A' });
    const before = updatedSessions(h).length;
    session.transition('idle');
    await h.router.idle();
    expect(h.flags.pendingTitle(sid)).toBeUndefined();
    const after = updatedSessions(h).slice(before);
    expect(after.at(-1)).toMatchObject({ sessionId: sid, title: 'B' });
    expect(h.transcripts.calls).not.toContain(`rename:${sid}:A`);
  });
});

describe('Router · session.pin', () => {
  test('置顶写标记，updated 带 pinnedAt；重复置顶保留原时间；取消置顶反向', async () => {
    const h = await withHistorical();
    await h.router.handle(pin('h1', 'p1'), phone);
    expect(responseOf(h, 'p1').ok).toBe(true);
    expect(h.flags.pinnedAt('h1')).toBe(130_000);
    expect(updatedSessions(h).at(-1)).toMatchObject({ sessionId: 'h1', pinnedAt: 130_000 });
    h.advance(5);
    await h.router.handle(pin('h1', 'p2'), phone);
    expect(h.flags.pinnedAt('h1')).toBe(130_000);

    await h.router.handle(pin('h1', 'p3', false), phone);
    expect(responseOf(h, 'p3').ok).toBe(true);
    expect(h.flags.pinnedAt('h1')).toBeUndefined();
    expect(updatedSessions(h).at(-1)!.pinnedAt).toBeUndefined();
    expect(h.created).toHaveLength(0);
  });

  test('运行中也能置顶；未知会话 → not_found', async () => {
    const h = await makeHarness();
    h.state.rememberSession('s1', params);
    await h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c', text: 'x' }, phone);
    h.created[0]!.state = 'running';
    await h.router.handle(pin('s1', 'p1'), phone);
    expect(responseOf(h, 'p1').ok).toBe(true);
    await h.router.handle(pin('ghost', 'p2'), phone);
    expect(responseOf(h, 'p2')).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  test('归档清掉置顶，取消归档后不恢复', async () => {
    const h = await withHistorical();
    await h.router.handle(pin('h1', 'p1'), phone);
    await h.router.handle(archive('h1', 'a1'), phone);
    expect(h.flags.pinnedAt('h1')).toBeUndefined();
    expect(updatedSessions(h).at(-1)!.pinnedAt).toBeUndefined();
    await h.router.handle(archive('h1', 'a2', false), phone);
    expect(updatedSessions(h).at(-1)!.pinnedAt).toBeUndefined();
  });
});

describe('Router · session.archive', () => {
  test('历史会话归档：写标记，updated 带 archived/archivedAt；取消归档反向', async () => {
    const h = await withHistorical();
    await h.router.handle(archive('h1', 'q1'), phone);
    expect(responseOf(h, 'q1').ok).toBe(true);
    expect(h.flags.archivedAt('h1')).toBe(130_000);
    expect(updatedSessions(h).at(-1)).toMatchObject({ sessionId: 'h1', archived: true, archivedAt: 130_000 });
    expect(await h.manager.snapshot('h1')).toMatchObject({ archived: true, archivedAt: 130_000 });
    // 重复归档幂等，保留原 archivedAt
    h.advance(5);
    await h.router.handle(archive('h1', 'q2'), phone);
    expect(responseOf(h, 'q2').ok).toBe(true);
    expect(h.flags.archivedAt('h1')).toBe(130_000);

    await h.router.handle(archive('h1', 'q3', false), phone);
    expect(responseOf(h, 'q3').ok).toBe(true);
    expect(h.flags.archivedAt('h1')).toBeUndefined();
    expect(updatedSessions(h).at(-1)!.archived).toBeUndefined();
    expect(h.created).toHaveLength(0);
  });

  test('运行中 / 等批准 / 有排队 → busy，不写标记（与 setCwd 同口径，M3）', async () => {
    const h = await makeHarness();
    h.state.rememberSession('s1', params);
    await h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c', text: 'x' }, phone);
    const session = h.created[0]!;
    const cases: [string, () => void][] = [
      ['q-run', () => (session.state = 'running')],
      ['q-wait', () => (session.state = 'waiting_permission')],
      [
        'q-queue',
        () => {
          session.state = 'idle';
          session.queueLength = 2;
        },
      ],
    ];
    for (const [reqId, make] of cases) {
      make();
      await h.router.handle(archive('s1', reqId), phone);
      expect(responseOf(h, reqId)).toMatchObject({ ok: false, error: { code: 'busy' } });
    }
    expect(h.flags.archivedAt('s1')).toBeUndefined();
    // 空闲后可以归档（有实例、无转录也算已知会话）
    session.queueLength = 0;
    await h.router.handle(archive('s1', 'q-ok'), phone);
    expect(responseOf(h, 'q-ok').ok).toBe(true);
  });

  test('归档顺带回收空闲子进程；有后台任务的只归档不回收', async () => {
    const h = await makeHarness();
    h.state.rememberSession('s1', params);
    h.state.rememberSession('s2', params);
    await h.router.handle({ type: 'input.send', ...c2a('s1'), clientMsgId: 'c1', text: 'x' }, phone);
    await h.router.handle({ type: 'input.send', ...c2a('s2'), clientMsgId: 'c2', text: 'y' }, phone);
    expect(updatedSessions(h).filter((m) => m.sessionId === 's1').at(-1)?.live).toBe(true);
    h.created[1]!.bgRunningCount = 1;

    await h.router.handle(archive('s1', 'q1'), phone);
    await h.router.handle(archive('s2', 'q2'), phone);
    expect(responseOf(h, 'q1').ok).toBe(true);
    expect(responseOf(h, 'q2').ok).toBe(true);
    expect(h.created[0]!.closed).toBe(true);
    expect(h.created[1]!.closed).toBe(false);
    expect(h.manager.activeSessionIds).toEqual(['s2']);
    const last = (sid: string) => updatedSessions(h).filter((m) => m.sessionId === sid).at(-1)!;
    expect(last('s1')).toMatchObject({ archived: true });
    expect(last('s1').live).toBeUndefined();
    expect(last('s2')).toMatchObject({ archived: true, live: true });
  });

  test('未知会话 → not_found；取消归档时标记还在就清（即使转录已不在）', async () => {
    const h = await makeHarness();
    await h.router.handle(archive('ghost', 'q1'), phone);
    expect(responseOf(h, 'q1')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    await h.router.handle(archive('ghost', 'q2', false), phone);
    expect(responseOf(h, 'q2')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    await h.flags.setArchived('orphan', 1);
    await h.router.handle(archive('orphan', 'q3', false), phone);
    expect(responseOf(h, 'q3').ok).toBe(true);
    expect(h.flags.archivedAt('orphan')).toBeUndefined();
  });

  test('标记写盘失败 → io 应答，内存回滚、不广播', async () => {
    const ro = join(dir, 'ro');
    await mkdir(ro);
    const h = await withHistorical('h1', { flagsPath: join(ro, 'sessions.json') });
    await chmod(ro, 0o500);
    try {
      await h.router.handle(archive('h1', 'q1'), phone);
    } finally {
      await chmod(ro, 0o700);
    }
    expect(responseOf(h, 'q1')).toMatchObject({ ok: false, error: { code: 'io' } });
    expect(h.flags.archivedAt('h1')).toBeUndefined();
    expect(h.byType('session.updated')).toHaveLength(0);
  });

  test('已归档的活跃会话进入 running → 自动取消归档，随同一次 updated 广播（M1）', async () => {
    const h = await withHistorical();
    h.state.rememberSession('h1', params);
    await h.router.handle(archive('h1', 'q1'), phone);
    await h.router.handle({ type: 'input.send', ...c2a('h1'), clientMsgId: 'c1', text: 'again' }, phone);
    h.created[0]!.transition('running');
    expect(h.flags.archivedAt('h1')).toBeUndefined();
    const last = updatedSessions(h).at(-1)!;
    expect(last).toMatchObject({ sessionId: 'h1', state: 'running' });
    expect(last.archived).toBeUndefined();
    await h.flags.flush();
    expect((await SessionFlagsStore.load(join(dir, 'sessions.json'))).archivedAt('h1')).toBeUndefined();
  });

  test('resumeAt 唤醒已归档的历史会话 → 自动取消归档（M1：不经 input.send 分支也生效）', async () => {
    const h = await withHistorical();
    h.state.rememberSession('h1', params);
    await h.router.handle(archive('h1', 'q1'), phone);
    await h.router.handle({ type: 'run.resumeAt', ...c2a('h1'), at: 10_000 }, phone);
    h.timers.at(-1)!.fn();
    await h.router.idle();
    const session = h.created[0]!;
    expect(session.sent.at(-1)!.text).toBe(RESUME_AT_PROMPT);
    session.transition('running');
    expect(h.flags.archivedAt('h1')).toBeUndefined();
  });
});

describe('Router · session.delete', () => {
  /** 历史会话 + 已归档 + 有活跃实例（idle、有子进程） */
  async function archivedLive() {
    const h = await withHistorical('h1', { listFromTranscripts: true });
    h.state.rememberSession('h1', params);
    await h.router.handle({ type: 'input.send', ...c2a('h1'), clientMsgId: 'c0', text: 'x' }, phone);
    const session = h.created[0]!;
    session.hasProcess = true;
    // 有后台任务才会归档后仍留着实例（否则归档顺带回收子进程）
    session.bgRunningCount = 1;
    await h.router.handle(archive('h1', 'q-arch'), phone);
    session.bgRunningCount = 0;
    return { ...h, session };
  }

  test('未归档 → not_archived（协议层兜底），不删', async () => {
    const h = await withHistorical();
    await h.router.handle(del('h1', 'q1'), phone);
    expect(responseOf(h, 'q1')).toMatchObject({ ok: false, error: { code: 'not_archived' } });
    expect(h.transcripts.has('h1')).toBe(true);
  });

  test('忙 → busy；转录 60s 内被写过 → busy（本机可能正在用）', async () => {
    const h = await archivedLive();
    h.session.state = 'waiting_permission';
    await h.router.handle(del('h1', 'q1'), phone);
    expect(responseOf(h, 'q1')).toMatchObject({ ok: false, error: { code: 'busy' } });
    h.session.state = 'idle';
    h.transcripts.write('h1', { lastModified: 130_000 - 59_000 });
    await h.router.handle(del('h1', 'q2'), phone);
    const resp = responseOf(h, 'q2');
    expect(resp).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(resp.error!.message).toContain('本机');
    expect(h.transcripts.has('h1')).toBe(true);
    expect(h.session.closed).toBe(false);
  });

  // 这条只证明「release 的调用先于 deleteSession」。release **不等**子进程退出
  // （SDK close 2s 后才 SIGTERM），进程退出时的 re-stamp 由下面「删除后 8s 复查」兜底
  test('成功：release 调用先于删转录，级联清理，写墓碑，广播 removed + 应答 ok', async () => {
    const h = await archivedLive();
    await h.router.handle({ type: 'run.resumeAt', ...c2a('h1'), at: 130_000 + 60_000 }, phone);
    const resumeTimer = h.timers.at(-1)!;
    h.capabilities.observe(
      h.emitter.emit({ type: 'session.capabilities', slashCommands: [], models: [], mcpServers: [{ name: 'fs', state: 'connected', toolCount: 1 }] }, 'h1').event,
    );
    await h.flags.setPendingTitle('h1', 'p');
    // 删除时转录应当已不被子进程持有：close 发生在 deleteSession 之前
    let transcriptAtClose: boolean | undefined;
    h.session.onClose = () => {
      transcriptAtClose = h.transcripts.has('h1');
    };
    const seqBefore = h.emitter.peekSeq('h1');

    await h.router.handle(del('h1', 'q1'), phone);

    expect(responseOf(h, 'q1')).toMatchObject({ ok: true, targetSessionId: 'h1' });
    expect(transcriptAtClose).toBe(true);
    expect(h.session.closed).toBe(true);
    expect(h.transcripts.has('h1')).toBe(false);
    expect(h.manager.has('h1')).toBe(false);
    expect(h.manager.metaOf('h1')).toBeUndefined();
    expect(h.state.sessionParams('h1')).toBeUndefined();
    expect(h.capabilities.mcpServers('h1')).toBeUndefined();
    expect(h.flags.archivedAt('h1')).toBeUndefined();
    expect(h.flags.pendingTitle('h1')).toBeUndefined();
    expect(h.flags.isDeleted('h1')).toBe(true);
    expect(resumeTimer.cleared).toBe(true);
    expect(h.router.pendingResumeCount).toBe(0);
    const removed = h.byType('session.removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ targetSessionId: 'h1' });
    expect(removed[0]!.sessionId).toBeUndefined();
    // outSeq 不 dropScope
    expect(h.emitter.peekSeq('h1')).toBe(seqBefore);
    expect(h.byType('error.fatal')).toHaveLength(0);
  });

  test('子进程在 deleteSession 之后才退出、re-stamp 重建残缺转录 → 8s 复查再删，墓碑过期后也不复活（CB1）', async () => {
    const h = await archivedLive();
    // 真 CLI 的形状：close() 返回时进程还活着；它读到 stdin EOF 退出时追加
    // custom-title 等元数据（不带 onlyIfExists），文件不在就新建一个只含元数据的 jsonl
    // 真实残影（sdk-probe 实测）：只有 custom-title 行，SDK 读出来没有 cwd、没有 firstPrompt；
    // mtime ≈ 删除时刻 + 数秒（close 后 2s SIGTERM）
    let exitProcess: (() => void) | undefined;
    h.session.onClose = () => {
      exitProcess = () => h.transcripts.write('h1', { customTitle: '残缺' });
    };
    await h.router.handle(del('h1', 'q1'), phone);
    expect(responseOf(h, 'q1').ok).toBe(true);
    expect(h.transcripts.has('h1')).toBe(false);

    h.advance(2_500);
    exitProcess!();
    expect(h.transcripts.info('h1')!.cwd).toBeUndefined();
    expect(h.transcripts.info('h1')!.firstPrompt).toBeUndefined();
    // 复查前：SDK 能查到这个幽灵（本机 claude --resume 里也看得见），只靠墓碑挡着列表
    expect(await h.manager.sessionInfo('h1')).toBeDefined();
    expect(h.router.pendingRecheckCount).toBe(1);

    const recheck = h.timers.find((t) => t.ms === DELETE_RECHECK_DELAY_MS && !t.cleared)!;
    expect(recheck).toBeDefined();
    h.advance(DELETE_RECHECK_DELAY_MS - 2_500);
    recheck.fn();
    await h.router.idle();

    expect(h.router.pendingRecheckCount).toBe(0);
    expect(h.transcripts.has('h1')).toBe(false);
    expect(await h.manager.sessionInfo('h1')).toBeUndefined();
    expect(h.logs.some((l) => l.includes('又出现了'))).toBe(true);
    // 第 9 天墓碑被 sweep 掉之后列表里也没有它
    h.advance(TOMBSTONE_TTL_MS);
    expect(await h.flags.sweepTombstones(h.now())).toBe(1);
    expect((await h.manager.list()).map((s) => s.sessionId)).toEqual([]);
  });

  test('复查时转录已干净 → 不再删', async () => {
    const h = await archivedLive();
    await h.router.handle(del('h1', 'q1'), phone);
    const recheck = h.timers.find((t) => t.ms === DELETE_RECHECK_DELAY_MS)!;
    recheck.fn();
    await h.router.idle();
    expect(h.transcripts.calls.filter((c) => c === 'delete:h1')).toHaveLength(1);
  });

  test('dispose（进程退出）清掉未触发的复查定时器', async () => {
    const h = await archivedLive();
    await h.router.handle(del('h1', 'q1'), phone);
    expect(h.router.pendingRecheckCount).toBe(1);
    h.router.dispose();
    expect(h.router.pendingRecheckCount).toBe(0);
    expect(h.timers.find((t) => t.ms === DELETE_RECHECK_DELAY_MS)!.cleared).toBe(true);
  });

  test('recheckDeleted（启动 / 每日 sweep 对在期墓碑调）：残缺转录删掉；删除失败只 log', async () => {
    const h = await archivedLive();
    await h.router.handle(del('h1', 'q1'), phone);
    h.transcripts.write('h1', { customTitle: 'ghost' });
    h.transcripts.failNext = new Error('EBUSY: resource busy');
    await h.router.recheckDeleted('h1');
    expect(h.transcripts.has('h1')).toBe(true);
    expect(h.logs.some((l) => l.includes('EBUSY'))).toBe(true);
    await h.router.recheckDeleted('h1');
    expect(h.transcripts.has('h1')).toBe(false);
    // 没有墓碑的会话绝不碰
    h.transcripts.write('other', {});
    await h.router.recheckDeleted('other');
    expect(h.transcripts.has('other')).toBe(true);
  });

  test('复查：mtime 在删除时刻 15s 窗口内的残影删掉（窗口上沿）', async () => {
    const h = await archivedLive();
    await h.router.handle(del('h1', 'q1'), phone);
    const deletedAt = h.flags.deletedAt('h1')!;
    h.transcripts.write('h1', { customTitle: '残缺', lastModified: deletedAt + DELETE_RESTAMP_WINDOW_MS });
    h.advance(3_600_000); // 启动 / 每日 sweep 可能在很久之后才跑：看的是 mtime，不是复查时刻
    await h.router.recheckDeleted('h1');
    expect(h.transcripts.has('h1')).toBe(false);
    expect(h.flags.isDeleted('h1')).toBe(true);
  });

  test('复查：删除后本机又续聊过（mtime 在窗口外）→ 不删、撤墓碑、list 里重新可见（N1）', async () => {
    const h = await archivedLive();
    await h.router.handle(del('h1', 'q1'), phone);
    const deletedAt = h.flags.deletedAt('h1')!;
    // 用户几小时后在本机终端接着聊：CLI 重新写出带真实对话的转录
    h.advance(3 * 3_600_000);
    h.transcripts.write('h1', { cwd: '/repo', firstPrompt: '接着聊' });
    expect(h.transcripts.info('h1')!.lastModified - deletedAt).toBeGreaterThan(DELETE_RESTAMP_WINDOW_MS);
    await h.router.recheckDeleted('h1');
    expect(h.transcripts.has('h1')).toBe(true);
    expect(h.transcripts.calls.filter((c) => c === 'delete:h1')).toHaveLength(1);
    expect(h.flags.isDeleted('h1')).toBe(false);
    expect(h.flags.deletedAt('h1')).toBeUndefined();
    expect(h.logs.some((l) => l.includes('撤掉墓碑'))).toBe(true);
    expect((await h.manager.list()).map((s) => s.sessionId)).toEqual(['h1']);
    // 墓碑已撤，之后的复查不再碰它
    await h.router.recheckDeleted('h1');
    expect(h.transcripts.has('h1')).toBe(true);
    // 撤墓碑落了盘（重启后同样可见）
    await h.flags.flush();
    const reloaded = await SessionFlagsStore.load(join(dir, 'sessions.json'));
    expect(reloaded.isDeleted('h1')).toBe(false);
  });

  test('复查：mtime 远早于删除时刻（不是删后写出来的）→ 同样不删、撤墓碑', async () => {
    const h = await archivedLive();
    await h.router.handle(del('h1', 'q1'), phone);
    const deletedAt = h.flags.deletedAt('h1')!;
    h.transcripts.write('h1', { cwd: '/repo', firstPrompt: 'hello', lastModified: deletedAt - DELETE_RESTAMP_SLACK_MS - 1 });
    await h.router.recheckDeleted('h1');
    expect(h.transcripts.has('h1')).toBe(true);
    expect(h.flags.isDeleted('h1')).toBe(false);
    // 下沿容差内的仍按残影删
    const h2 = await archivedLive();
    await h2.router.handle(del('h1', 'q1'), phone);
    h2.transcripts.write('h1', { customTitle: 'x', lastModified: h2.flags.deletedAt('h1')! - DELETE_RESTAMP_SLACK_MS });
    await h2.router.recheckDeleted('h1');
    expect(h2.transcripts.has('h1')).toBe(false);
  });

  test('删除后 list 不复活——即便残缺转录又出现（re-stamp）或缓存 meta 残留（B4）', async () => {
    const h = await archivedLive();
    expect((await h.manager.list()).map((s) => s.sessionId)).toEqual(['h1']);
    await h.router.handle(del('h1', 'q1'), phone);
    expect((await h.manager.list()).map((s) => s.sessionId)).toEqual([]);
    h.transcripts.write('h1', { lastModified: 1 });
    expect((await h.manager.list()).map((s) => s.sessionId)).toEqual([]);
  });

  test('删除后对它的帧一律不 resolve：input.send 忽略、removed 按 sid 限频广播；带 reqId 的回 deleted（B4）', async () => {
    const h = await archivedLive();
    await h.router.handle(del('h1', 'q1'), phone);
    const createdBefore = h.created.length;
    await h.router.handle({ type: 'input.send', ...c2a('h1'), clientMsgId: 'c1', text: 'zombie' }, phone);
    await h.router.handle({ type: 'input.send', ...c2a('h1'), clientMsgId: 'c2', text: 'zombie' }, phone);
    await h.router.handle({ type: 'session.setModel', ...c2a('h1'), model: 'x' }, phone);
    expect(h.created.length).toBe(createdBefore);
    expect(h.byType('session.removed')).toHaveLength(2);
    expect(h.logs.filter((l) => l.includes('已删除会话 h1'))).toHaveLength(3);
    // 按 sid 限频而非整个进程只一次（CM1）：过了间隔再撞墓碑会再广播
    h.advance(REMOVED_ANNOUNCE_INTERVAL_MS);
    await h.router.handle({ type: 'input.send', ...c2a('h1'), clientMsgId: 'c3', text: 'zombie' }, phone);
    expect(h.byType('session.removed')).toHaveLength(3);
    await h.router.handle({ type: 'session.status.request', ...c2a('h1'), reqId: 'st' }, phone);
    expect(responseOf(h, 'st')).toMatchObject({ ok: false, error: { code: 'deleted' } });
    await h.router.handle(rename('h1', 'q2', 'x'), phone);
    expect(responseOf(h, 'q2')).toMatchObject({ ok: false, error: { code: 'deleted' } });
    expect(await h.router.resolveSession('h1')).toBeUndefined();
    expect(h.byType('error.fatal')).toHaveLength(0);
    // state.json 里也没了：重启后 #lookupParams 也找不到它
    expect(h.state.sessionParams('h1')).toBeUndefined();
  });

  test('同一批到达：delete 之后紧跟的 input.send 在链上看到墓碑，不复活', async () => {
    const h = await archivedLive();
    const createdBefore = h.created.length;
    await Promise.all([
      h.router.handle(del('h1', 'q1'), phone),
      h.router.handle({ type: 'input.send', ...c2a('h1'), clientMsgId: 'c9', text: 'late' }, phone),
    ]);
    expect(responseOf(h, 'q1').ok).toBe(true);
    expect(h.created.length).toBe(createdBefore);
    expect(h.session.sent.map((m) => m.clientMsgId)).not.toContain('c9');
  });

  test('从没发过消息的新会话（无转录）：deleteSession not found 视为成功', async () => {
    const h = await makeHarness();
    await h.router.handle(
      { type: 'session.create', ...c2a(), reqId: 'mk', cwd: '/a', model: 'm', permissionMode: 'default' },
      phone,
    );
    const sid = h.created[0]!.sessionId;
    await h.router.handle(archive(sid, 'qa'), phone);
    await h.router.handle(del(sid, 'qd'), phone);
    expect(responseOf(h, 'qd').ok).toBe(true);
    expect(h.transcripts.calls).toContain(`delete:${sid}`);
    expect(h.flags.isDeleted(sid)).toBe(true);
    expect(await h.manager.list()).toEqual([]);
  });

  test('发过消息却找不到转录 → not_found，不写墓碑；deleteSession 其他错误 → io', async () => {
    const h = await withHistorical();
    await h.flags.setArchived('gone', 1);
    await h.router.handle(del('gone', 'q1'), phone);
    expect(responseOf(h, 'q1')).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(h.flags.isDeleted('gone')).toBe(false);

    await h.router.handle(archive('h1', 'qa'), phone);
    h.transcripts.failNext = new Error('EBUSY: resource busy');
    await h.router.handle(del('h1', 'q2'), phone);
    expect(responseOf(h, 'q2')).toMatchObject({ ok: false, error: { code: 'io' } });
    expect(h.flags.isDeleted('h1')).toBe(false);
    expect(h.flags.archivedAt('h1')).toBeDefined();
  });

  test('墓碑跨重启生效：新 Router 读同一份 sessions.json 仍拒绝 resume', async () => {
    const h = await archivedLive();
    await h.router.handle(del('h1', 'q1'), phone);
    await h.flags.flush();
    const h2 = await makeHarness();
    // 模拟旧 state.json 残留（最坏情况）：墓碑照样挡住
    h2.state.rememberSession('h1', params);
    await h2.router.handle({ type: 'input.send', ...c2a('h1'), clientMsgId: 'c', text: 'x' }, phone);
    expect(h2.created).toHaveLength(0);
    expect(h2.byType('session.removed')).toHaveLength(1);
  });
});

/** 造一条 SDK listSessions 的返回项 */
function listed(sessionId: string, cwd: string) {
  return {
    sessionId,
    cwd,
    lastModified: 1,
    summary: 'old chat',
  } as unknown as Awaited<ReturnType<typeof listSessions>>[number];
}

// ---------------------------------------------------------------------------
// session.history.request
// ---------------------------------------------------------------------------

function tline(type: 'user' | 'assistant', uuid: string, message: unknown, i: number): SessionMessage {
  return {
    type,
    uuid,
    session_id: 'old',
    message,
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp: new Date(1_000_000 + i * 1000).toISOString(),
  } as unknown as SessionMessage;
}

/** n 轮「用户问 → 助手答」 */
function transcript(n: number): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(tline('user', `u${i}`, { role: 'user', content: `q${i}` }, i * 2));
    out.push(tline('assistant', `a${i}`, { id: `msg_${i}`, role: 'assistant', content: [{ type: 'text', text: `a${i}` }] }, i * 2 + 1));
  }
  return out;
}

const tablet: Recipient = { deviceId: 'tablet', boxPubKey: 'B2', signPubKey: 'S2', pairedAt: 0 };

describe('Router · session.history.request', () => {
  test('不 resolve、不拉起会话、不查 listSessions；响应定向给请求方', async () => {
    const h = await makeHarness({ transcripts: { old: transcript(2) } });
    await h.router.handle({ type: 'session.history.request', ...c2a('old'), reqId: 'h1' }, tablet);
    expect(h.created).toHaveLength(0);
    expect(h.manager.has('old')).toBe(false);
    expect(h.listCalls).toBe(0);
    const out = h.events.filter((e) => e.event.type === 'session.history.response');
    expect(out).toHaveLength(1);
    expect(out[0]!.to).toBe('tablet');
    expect(out[0]!.scope).toBe('old');
    const res = out[0]!.event as Extract<OutboundEvent['event'], { type: 'session.history.response' }>;
    expect(res.reqId).toBe('h1');
    expect(res.sessionId).toBe('old');
    expect(res.items.map((i) => `${i.kind}:${i.id}`)).toEqual(['user:u0', 'assistant:msg_0', 'user:u1', 'assistant:msg_1']);
    expect(res.hasMore).toBe(false);
    // 没有任何 fatal
    expect(h.byType('error.fatal')).toHaveLength(0);
  });

  test('cwd 已知（state.json）时带 dir；不带 dir 才找得到则兜底重读', async () => {
    const h = await makeHarness({ transcripts: { old: transcript(1) }, transcriptOnlyWithoutDir: true });
    h.state.rememberSession('old', params);
    await h.router.handle({ type: 'session.history.request', ...c2a('old'), reqId: 'h1' }, phone);
    expect(h.historyCalls).toEqual([
      { sessionId: 'old', dir: '/repo' },
      { sessionId: 'old', dir: undefined },
    ]);
    const [res] = h.byType('session.history.response');
    expect(res).toMatchObject({ items: [{ id: 'u0' }, { id: 'msg_0' }] });
    expect(h.created).toHaveLength(0);
  });

  test('cwd 未知：不带 dir 读一次', async () => {
    const h = await makeHarness({ transcripts: { old: transcript(1) } });
    await h.router.handle({ type: 'session.history.request', ...c2a('old'), reqId: 'h1' }, phone);
    expect(h.historyCalls).toEqual([{ sessionId: 'old', dir: undefined }]);
  });

  test('活跃会话也不受影响：不 acquire 第二个实例', async () => {
    const h = await makeHarness({ transcripts: { s1: transcript(1) } });
    h.manager.acquire({ sessionId: 's1', ...params });
    await h.router.handle({ type: 'session.history.request', ...c2a('s1'), reqId: 'h1' }, phone);
    expect(h.created).toHaveLength(1);
    expect(h.historyCalls[0]).toEqual({ sessionId: 's1', dir: '/repo' });
  });

  test('找不到会话 → 空 items、hasMore false，不报错', async () => {
    const h = await makeHarness();
    await h.router.handle({ type: 'session.history.request', ...c2a('ghost'), reqId: 'h1' }, phone);
    const [res] = h.byType('session.history.response');
    expect(res).toMatchObject({ reqId: 'h1', items: [], hasMore: false });
    expect(h.byType('error.fatal')).toHaveLength(0);
  });

  test('分页：limit + before 翻页', async () => {
    const h = await makeHarness({ transcripts: { old: transcript(5) } });
    await h.router.handle({ type: 'session.history.request', ...c2a('old'), reqId: 'h1', limit: 4 }, phone);
    const [p1] = h.byType('session.history.response') as Extract<OutboundEvent['event'], { type: 'session.history.response' }>[];
    expect(p1!.items.map((i) => i.id)).toEqual(['u3', 'msg_3', 'u4', 'msg_4']);
    expect(p1!.hasMore).toBe(true);
    expect(p1!.nextBefore).toBe('u3');
    await h.router.handle(
      { type: 'session.history.request', ...c2a('old'), seq: 2, reqId: 'h2', limit: 4, before: p1!.nextBefore! },
      phone,
    );
    const p2 = h.byType('session.history.response')[1] as typeof p1;
    expect(p2!.items.map((i) => i.id)).toEqual(['u1', 'msg_1', 'u2', 'msg_2']);
    expect(p2!.nextBefore).toBe('u1');
  });

  test('读取异常走命令链兜底：会话级 error.fatal，不拉起会话', async () => {
    const h = await makeHarness({ historyThrows: true });
    await h.router.handle({ type: 'session.history.request', ...c2a('old'), reqId: 'h1' }, phone);
    const fatals = h.byType('error.fatal');
    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toMatchObject({ sessionId: 'old', kind: 'other' });
    expect((fatals[0] as { message: string }).message).toContain('读转录炸了');
    expect(h.created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// subagent.history.request
// ---------------------------------------------------------------------------

describe('Router · subagent.history.request', () => {
  const subLines: unknown[] = [
    { type: 'user', uuid: 's0', message: { role: 'user', content: 'prompt' }, timestamp: '2026-09-28T15:18:00.000Z' },
    { type: 'attachment', uuid: 'att', attachment: {} },
    {
      type: 'assistant',
      uuid: 's1',
      message: { id: 'msg_s', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_c1', name: 'Bash', input: { command: 'echo SUB1' } }] },
      timestamp: '2026-09-28T15:18:01.000Z',
    },
    {
      type: 'user',
      uuid: 's2',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c1', content: 'SUB1' }] },
      timestamp: '2026-09-28T15:18:02.000Z',
    },
  ];

  test('不拉起会话；带已知 cwd 读子转录；只回工具项、定向给请求方', async () => {
    const h = await makeHarness({ subagentTranscripts: { old: [], 'old/toolu_p': subLines } });
    h.state.rememberSession('old', params);
    await h.router.handle({ type: 'subagent.history.request', ...c2a('old'), reqId: 'sh1', toolUseId: 'toolu_p' }, tablet);
    expect(h.created).toHaveLength(0);
    expect(h.subagentCalls).toEqual([{ sessionId: 'old', toolUseId: 'toolu_p', cwd: '/repo' }]);
    const out = h.events.filter((e) => e.event.type === 'subagent.history.response');
    expect(out).toHaveLength(1);
    expect(out[0]!.to).toBe('tablet');
    expect(out[0]!.event).toMatchObject({
      reqId: 'sh1',
      toolUseId: 'toolu_p',
      sessionId: 'old',
      items: [{ kind: 'tool', id: 'toolu_c1', toolName: 'Bash', argSummary: 'echo SUB1', status: 'ok', durationMs: 1000 }],
    });
    expect('truncated' in out[0]!.event).toBe(false);
  });

  test('找不到子转录 → 空 items，不报错', async () => {
    const h = await makeHarness();
    await h.router.handle({ type: 'subagent.history.request', ...c2a('ghost'), reqId: 'sh1', toolUseId: 'toolu_x' }, phone);
    const [res] = h.byType('subagent.history.response');
    expect(res).toMatchObject({ reqId: 'sh1', toolUseId: 'toolu_x', items: [] });
    expect(h.byType('error.fatal')).toHaveLength(0);
    expect(h.subagentCalls[0]!.cwd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// session.commands.request
// ---------------------------------------------------------------------------

const sdkCmd = (name: string, description = ''): SdkSlashCommand => ({ name, description, argumentHint: '' });
type CommandsResponse = Extract<OutboundEvent['event'], { type: 'session.commands.response' }>;

describe('Router · session.commands.request', () => {
  test('不 resolve、不拉起会话、不查 listSessions；cwd 取 state.json；响应定向给请求方', async () => {
    const h = await makeHarness({
      probeCommands: async () => [sdkCmd('babysit-pr', 'Monitor a PR'), sdkCmd('compact')],
    });
    h.state.rememberSession('old', params);
    await h.router.handle({ type: 'session.commands.request', ...c2a('old'), reqId: 'c1' }, tablet);
    await h.router.idle();
    expect(h.created).toHaveLength(0);
    expect(h.manager.has('old')).toBe(false);
    expect(h.listCalls).toBe(0);
    expect(h.probeCalls).toEqual(['/repo']);
    const out = h.events.filter((e) => e.event.type === 'session.commands.response');
    expect(out).toHaveLength(1);
    expect(out[0]!.to).toBe('tablet');
    expect(out[0]!.scope).toBe('old');
    const res = out[0]!.event as CommandsResponse;
    expect(res.reqId).toBe('c1');
    expect(res.slashCommands).toEqual([
      { name: 'babysit-pr', description: 'Monitor a PR', source: 'project' },
      { name: 'compact', source: 'project' },
    ]);
    expect(h.byType('error.fatal')).toHaveLength(0);
  });

  test('活跃会话：cwd 取 manager meta，不 acquire 第二个实例', async () => {
    const h = await makeHarness({ probeCommands: async () => [] });
    h.manager.acquire({ sessionId: 's1', ...params, cwd: '/active' });
    await h.router.handle({ type: 'session.commands.request', ...c2a('s1'), reqId: 'c1' }, phone);
    await h.router.idle();
    expect(h.created).toHaveLength(1);
    expect(h.probeCalls).toEqual(['/active']);
  });

  test('cwd 未知 → 回退机器默认 cwd', async () => {
    const h = await makeHarness({ probeCommands: async () => [sdkCmd('x')] });
    await h.router.handle({ type: 'session.commands.request', ...c2a('ghost'), reqId: 'c1' }, phone);
    await h.router.idle();
    expect(h.probeCalls).toEqual(['/home/u']);
    expect((h.byType('session.commands.response')[0] as CommandsResponse).slashCommands).toHaveLength(1);
  });

  test('探测失败 → 空数组，只 log，不发 error.fatal', async () => {
    const h = await makeHarness({
      probeCommands: async () => {
        throw new Error('探测炸了');
      },
    });
    await h.router.handle({ type: 'session.commands.request', ...c2a('old'), reqId: 'c1' }, phone);
    await h.router.idle();
    expect(h.byType('session.commands.response')).toMatchObject([{ reqId: 'c1', slashCommands: [] }]);
    expect(h.byType('error.fatal')).toHaveLength(0);
    expect(h.logs.some((l) => l.includes('探测炸了'))).toBe(true);
    expect(h.created).toHaveLength(0);
  });

  test('没注入 probe → 空数组', async () => {
    const h = await makeHarness();
    await h.router.handle({ type: 'session.commands.request', ...c2a('old'), reqId: 'c1' }, phone);
    await h.router.idle();
    expect(h.byType('session.commands.response')).toMatchObject([{ reqId: 'c1', slashCommands: [] }]);
  });

  test('探测在链外跑：不堵同会话随后的 input.send', async () => {
    let release!: (v: SdkSlashCommand[]) => void;
    const h = await makeHarness({
      probeCommands: () => new Promise((resolve) => (release = resolve)),
      listed: [listed('old', '/repo')],
    });
    await h.router.handle({ type: 'session.commands.request', ...c2a('old'), reqId: 'c1' }, phone);
    await h.router.handle(
      { type: 'input.send', ...c2a('old'), seq: 2, clientMsgId: 'm1', text: 'hi' },
      phone,
    );
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.sent).toEqual([{ clientMsgId: 'm1', text: 'hi' }]);
    expect(h.byType('session.commands.response')).toHaveLength(0);
    release([sdkCmd('late')]);
    await h.router.idle();
    expect(h.byType('session.commands.response')).toHaveLength(1);
  });

  test('墓碑会话：回 deleted 应答，不探测', async () => {
    const h = await makeHarness({ probeCommands: async () => [sdkCmd('x')] });
    await h.flags.markDeleted('gone', 10_000);
    await h.router.handle({ type: 'session.commands.request', ...c2a('gone'), reqId: 'c1' }, phone);
    await h.router.idle();
    expect(h.probeCalls).toHaveLength(0);
    expect(h.byType('session.commands.response')).toHaveLength(0);
    expect(h.byType('session.mutate.response')).toMatchObject([{ reqId: 'c1', ok: false }]);
  });
});

describe('toSlashCommands', () => {
  test('去重、空描述省略、长描述截断、source 统一 project', () => {
    const long = 'x'.repeat(COMMAND_DESCRIPTION_MAX + 50);
    const out = toSlashCommands([sdkCmd('a', '  '), sdkCmd('a', 'dup'), sdkCmd('b', long), sdkCmd('', 'noname')]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: 'a', source: 'project' });
    expect(out[1]!.description).toHaveLength(COMMAND_DESCRIPTION_MAX);
    expect(out[1]!.description!.endsWith('…')).toBe(true);
    expect(out[1]!.source).toBe('project');
  });
});

// ---------------------------------------------------------------------------
// 回退（session.rewind.preview / session.rewind）
// ---------------------------------------------------------------------------

describe('Router · 回退', () => {
  type Ev<T extends string> = Extract<OutboundEvent['event'], { type: T }>;

  async function rewindHarness() {
    const h = await makeHarness({ transcripts: { old: transcript(3) } });
    h.state.rememberSession('old', params);
    return h;
  }

  test('预览：定向回请求方；对话与代码都可用，路径相对 cwd，不改任何东西', async () => {
    const h = await rewindHarness();
    await h.router.handle({ type: 'session.rewind.preview', ...c2a('old'), reqId: 'p1', targetMessageId: 'u1' }, tablet);
    const out = h.events.filter((e) => e.event.type === 'session.rewind.preview.response');
    expect(out).toHaveLength(1);
    expect(out[0]!.to).toBe('tablet');
    expect(out[0]!.event).toMatchObject({
      reqId: 'p1',
      ok: true,
      text: 'q1',
      conversation: { available: true },
      files: { available: true, filesChanged: ['src/a.ts', '/elsewhere/b.ts'], insertions: 3, deletions: 1 },
    });
    const fake = h.created[0]!;
    expect(fake.calls).toContain('rewindFiles:u1:dry');
    expect(fake.calls.some((c) => c.startsWith('rewindConversation'))).toBe(false);
    expect(h.state.pendingRewind('old')).toBeUndefined();
    expect(h.byType('session.rewound')).toHaveLength(0);
  });

  test('预览第一条消息：对话不可回退（给原因），代码照常', async () => {
    const h = await rewindHarness();
    await h.router.handle({ type: 'session.rewind.preview', ...c2a('old'), reqId: 'p1', targetMessageId: 'u0' }, phone);
    const [res] = h.byType('session.rewind.preview.response') as Ev<'session.rewind.preview.response'>[];
    expect(res!.ok).toBe(true);
    expect(res!.conversation).toMatchObject({ available: false });
    expect(res!.conversation!.reason).toContain('第一条消息');
    expect(res!.files).toMatchObject({ available: true });
  });

  test('预览：没有快照 → files 不可用，请求本身仍成功', async () => {
    const h = await rewindHarness();
    await h.router.handle({ type: 'session.status.request', ...c2a('old'), reqId: 's' }, phone);
    h.created[0]!.rewindResult = { canRewind: false, error: 'No file checkpoint found' };
    await h.router.handle({ type: 'session.rewind.preview', ...c2a('old'), reqId: 'p1', targetMessageId: 'u1' }, phone);
    const [res] = h.byType('session.rewind.preview.response') as Ev<'session.rewind.preview.response'>[];
    expect(res).toMatchObject({ ok: true, files: { available: false } });
    expect(res!.files!.reason).toContain('No file checkpoint found');
  });

  test('执行 both：先还原文件、再落盘截断点并拆进程；广播 rewound 后定向应答', async () => {
    const h = await rewindHarness();
    await h.router.handle({ type: 'session.rewind', ...c2a('old'), reqId: 'r1', targetMessageId: 'u2', mode: 'both' }, phone);
    const fake = h.created[0]!;
    expect(fake.calls.filter((c) => c.startsWith('rewind'))).toEqual(['rewindFiles:u2:real', 'rewindConversation:a1:u2']);
    expect(h.state.pendingRewind('old')).toEqual({ resumeAt: 'a1', dropFrom: 'u2' });

    const rewound = h.events.filter((e) => e.event.type === 'session.rewound');
    expect(rewound).toHaveLength(1);
    expect(rewound[0]!.to).toBeUndefined();
    expect(rewound[0]!.event).toMatchObject({ sessionId: 'old', targetMessageIds: ['u2'], mode: 'both', filesChanged: 2 });

    const res = h.events.filter((e) => e.event.type === 'session.rewind.response');
    expect(res[0]!.to).toBe('phone');
    expect(res[0]!.event).toMatchObject({ reqId: 'r1', ok: true, text: 'q2', files: { filesChanged: ['src/a.ts', '/elsewhere/b.ts'] } });
    // 广播在应答之前
    expect(h.events.indexOf(rewound[0]!)).toBeLessThan(h.events.indexOf(res[0]!));
  });

  test('只回退对话：不碰文件；只回退代码：不动对话', async () => {
    const h = await rewindHarness();
    await h.router.handle({ type: 'session.rewind', ...c2a('old'), reqId: 'r1', targetMessageId: 'u1', mode: 'conversation' }, phone);
    const fake = h.created[0]!;
    expect(fake.calls.filter((c) => c.startsWith('rewind'))).toEqual(['rewindConversation:a0:u1']);
    const [res] = h.byType('session.rewind.response') as Ev<'session.rewind.response'>[];
    expect(res).toMatchObject({ ok: true });
    expect(res!.files).toBeUndefined();
    expect(h.byType('session.rewound')[0]).not.toHaveProperty('filesChanged');

    const h2 = await rewindHarness();
    await h2.router.handle({ type: 'session.rewind', ...c2a('old'), reqId: 'r1', targetMessageId: 'u0', mode: 'code' }, phone);
    expect(h2.created[0]!.calls.filter((c) => c.startsWith('rewind'))).toEqual(['rewindFiles:u0:real']);
    expect(h2.state.pendingRewind('old')).toBeUndefined();
    expect(h2.byType('session.rewound')[0]).toMatchObject({ mode: 'code', filesChanged: 2 });
  });

  test('失败：busy / not_found / 非用户消息与第一条消息回退对话 invalid / 没有快照 unavailable——都不改东西、不广播', async () => {
    const h = await rewindHarness();
    await h.router.handle({ type: 'session.status.request', ...c2a('old'), reqId: 's' }, phone);
    const fake = h.created[0]!;
    const run = async (targetMessageId: string, mode: 'both' | 'conversation' | 'code') => {
      await h.router.handle({ type: 'session.rewind', ...c2a('old'), reqId: `r-${targetMessageId}-${mode}`, targetMessageId, mode }, phone);
      return (h.byType('session.rewind.response') as Ev<'session.rewind.response'>[]).at(-1)!;
    };

    fake.rewindBlockReason = '会话正在运行';
    expect((await run('u1', 'both')).error).toEqual({ code: 'busy', message: '会话正在运行' });
    fake.rewindBlockReason = undefined;

    expect((await run('nope', 'both')).error?.code).toBe('not_found');
    // 不是用户说的话（助手回复）
    expect((await run('a1', 'both')).error?.code).toBe('invalid');
    expect((await run('u0', 'both')).error?.code).toBe('invalid');

    fake.rewindResult = { canRewind: false };
    expect((await run('u1', 'both')).error?.code).toBe('unavailable');

    expect(fake.calls.filter((c) => c.startsWith('rewindConversation'))).toEqual([]);
    expect(h.state.pendingRewind('old')).toBeUndefined();
    expect(h.byType('session.rewound')).toHaveLength(0);
    expect(h.byType('error.fatal')).toHaveLength(0);
  });

  test('目标给 clientMsgId：映射回转录 uuid，广播带上两种 id', async () => {
    const h = await rewindHarness();
    await h.router.handle({ type: 'session.status.request', ...c2a('old'), reqId: 's' }, phone);
    h.created[0]!.uuids.set('c-2', 'u2');
    await h.router.handle({ type: 'session.rewind', ...c2a('old'), reqId: 'r1', targetMessageId: 'c-2', mode: 'conversation' }, phone);
    expect(h.byType('session.rewound')[0]).toMatchObject({ targetMessageIds: ['c-2', 'u2'] });
    expect(h.state.pendingRewind('old')).toEqual({ resumeAt: 'a1', dropFrom: 'u2' });
  });

  test('已有待生效截断点：被撤的尾巴里的消息找不到；历史回看截掉尾巴', async () => {
    const h = await rewindHarness();
    await h.router.handle({ type: 'session.rewind', ...c2a('old'), reqId: 'r1', targetMessageId: 'u1', mode: 'conversation' }, phone);
    await h.router.handle({ type: 'session.rewind', ...c2a('old'), reqId: 'r2', targetMessageId: 'u2', mode: 'conversation' }, phone);
    const responses = h.byType('session.rewind.response') as Ev<'session.rewind.response'>[];
    expect(responses[1]!.error?.code).toBe('not_found');

    await h.router.handle({ type: 'session.history.request', ...c2a('old'), reqId: 'h1' }, phone);
    const [page] = h.byType('session.history.response') as Ev<'session.history.response'>[];
    expect(page!.items.map((i) => i.id)).toEqual(['u0', 'msg_0']);
  });

  test('agent 重启后：state.json 里的截断点用于历史截断，并在 resume 时交给会话', async () => {
    const h = await rewindHarness();
    h.state.setPendingRewind('old', { resumeAt: 'a0', dropFrom: 'u1' });
    await h.router.handle({ type: 'session.history.request', ...c2a('old'), reqId: 'h1' }, phone);
    const [page] = h.byType('session.history.response') as Ev<'session.history.response'>[];
    expect(page!.items.map((i) => i.id)).toEqual(['u0', 'msg_0']);
    expect(h.created).toHaveLength(0);

    await h.router.handle({ type: 'input.send', ...c2a('old'), clientMsgId: 'c1', text: 'hi' }, phone);
    expect(h.created[0]!.args.rewindPoint).toEqual({ resumeAt: 'a0', dropFrom: 'u1' });
  });

  test('会话不存在：仍定向回 not_found（不让 client 干等超时）', async () => {
    const h = await makeHarness();
    await h.router.handle({ type: 'session.rewind', ...c2a('ghost'), reqId: 'r1', targetMessageId: 'u1', mode: 'both' }, phone);
    const out = h.events.filter((e) => e.event.type === 'session.rewind.response');
    expect(out).toHaveLength(1);
    expect(out[0]!.to).toBe('phone');
    // 机器级：不为不存在的会话开 seq 流
    expect(out[0]!.scope).toBeNull();
    expect(out[0]!.event.sessionId).toBeUndefined();
    expect(out[0]!.event).toMatchObject({ reqId: 'r1', ok: false, error: { code: 'not_found' } });
  });

  test('读转录抛错 → io 应答，不发 error.fatal', async () => {
    const h = await makeHarness({ historyThrows: true });
    h.state.rememberSession('old', params);
    await h.router.handle({ type: 'session.rewind.preview', ...c2a('old'), reqId: 'p1', targetMessageId: 'u1' }, phone);
    const [res] = h.byType('session.rewind.preview.response') as Ev<'session.rewind.preview.response'>[];
    expect(res!.error?.code).toBe('io');
    expect(h.byType('error.fatal')).toHaveLength(0);
  });
});

describe('Router · 附件', () => {
  async function setup() {
    await sodiumReady();
    const blobs = new FakeBlobs();
    const attachments = new AttachmentStore({ root: join(dir, 'uploads'), blobs: () => blobs });
    const h = await makeHarness({
      attachments,
      transcripts: {
        s1: [
          {
            type: 'user',
            uuid: 'uuid-c1',
            session_id: 's1',
            parent_tool_use_id: null,
            message: { role: 'user', content: 'hi\n\n<attached-files>\n/x/a.txt\n</attached-files>' },
          } as unknown as SessionMessage,
          {
            type: 'user',
            uuid: 'cli-1',
            session_id: 's1',
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
            },
          } as unknown as SessionMessage,
        ],
      },
    });
    h.state.rememberSession('s1', params);
    const file = (name: string, bytes: number[]) => {
      const data = new Uint8Array(bytes);
      return { name, mime: 'text/plain', size: data.length, kind: 'file' as const, ...blobs.put(data) };
    };
    const send = (clientMsgId: string, text: string, refs?: ReturnType<typeof file>[]): ClientToAgentEvent => ({
      type: 'input.send',
      ...c2a('s1'),
      clientMsgId,
      text,
      ...(refs === undefined ? {} : { attachments: refs }),
    });
    return { ...h, blobs, attachments, file, send };
  }

  test('带附件：落盘后把内容交给会话，并按转录 uuid 记下附件', async () => {
    const h = await setup();
    const ref = h.file('a.txt', [1, 2, 3]);
    await h.router.handle(h.send('c1', 'hi', [ref]), phone);
    await h.router.idle();

    const sent = h.created[0]!.sent[0]!;
    expect(sent.clientMsgId).toBe('c1');
    expect(sent.prepared?.attachments).toEqual([ref]);
    expect(sent.prepared?.content).toMatch(/^hi\n\n<attached-files>\n.*a\.txt\n<\/attached-files>$/);
    expect((await h.attachments.historyIndex('s1')).get('uuid-c1')).toEqual([ref]);
  });

  test('准备失败回 input.rejected，不碰会话', async () => {
    const h = await setup();
    const ref = { ...h.file('a.txt', [1]), blobId: 'missing0000000000000000' };
    await h.router.handle(h.send('c1', 'hi', [ref]), phone);
    await h.router.idle();
    expect(h.created).toHaveLength(0);
    expect(h.byType('input.rejected')).toEqual([
      expect.objectContaining({ type: 'input.rejected', clientMsgId: 'c1', sessionId: 's1' }),
    ]);
  });

  test('没启用附件的 agent 也回 input.rejected', async () => {
    const h = await makeHarness();
    await h.router.handle(
      {
        type: 'input.send',
        ...c2a('s1'),
        clientMsgId: 'c1',
        text: '',
        attachments: [{ name: 'a', mime: '', size: 1, kind: 'file', blobId: 'b'.repeat(22), key: 'k'.repeat(43) }],
      },
      phone,
    );
    await h.router.idle();
    expect(h.byType('input.rejected')).toHaveLength(1);
  });

  test('附件还在下载时，后面的纯文本消息排在它后面', async () => {
    const h = await setup();
    let release!: () => void;
    h.blobs.gate = new Promise((r) => {
      release = r;
    });
    const first = h.router.handle(h.send('c1', 'with file', [h.file('a.txt', [1])]), phone);
    const second = h.router.handle(h.send('c2', 'plain'), phone);
    // 同会话的其他命令不被下载堵住
    await h.router.handle({ type: 'session.history.request', ...c2a('s1'), reqId: 'r1' }, phone);
    expect(h.byType('session.history.response')).toHaveLength(1);
    expect(h.created).toHaveLength(0);

    release();
    await Promise.all([first, second]);
    await h.router.idle();
    expect(h.created[0]!.sent.map((m) => m.clientMsgId)).toEqual(['c1', 'c2']);
  });

  test('历史带附件：trine 发的按 manifest，CLI 粘贴的取图片块；路径清单不外露', async () => {
    const h = await setup();
    const ref = h.file('a.txt', [1, 2, 3]);
    await h.router.handle(h.send('c1', 'hi', [ref]), phone);
    await h.router.idle();
    await h.router.handle({ type: 'session.history.request', ...c2a('s1'), reqId: 'r1' }, phone);
    const [res] = h.byType('session.history.response') as Extract<
      OutboundEvent['event'],
      { type: 'session.history.response' }
    >[];
    expect(res!.items).toEqual([
      expect.objectContaining({ kind: 'user', id: 'uuid-c1', text: 'hi', attachments: [ref] }),
      expect.objectContaining({
        kind: 'user',
        id: 'cli-1',
        text: '',
        attachments: [{ name: 'image-1.png', mime: 'image/png', size: 3, kind: 'image' }],
      }),
    ]);
  });

  test('attachment.fetch.request：重新上传，只回请求方', async () => {
    const h = await setup();
    await h.router.handle(
      { type: 'attachment.fetch.request', ...c2a('s1'), reqId: 'f1', messageId: 'cli-1', index: 0 },
      phone,
    );
    await h.router.idle();
    const out = h.events.filter((e) => e.event.type === 'attachment.fetch.response');
    expect(out).toHaveLength(1);
    expect(out[0]!.to).toBe('phone');
    expect(out[0]!.event).toMatchObject({ ok: true, attachment: { name: 'image-1.png', kind: 'image' } });
    // 不拉起会话
    expect(h.created).toHaveLength(0);

    await h.router.handle(
      { type: 'attachment.fetch.request', ...c2a('s1'), reqId: 'f2', messageId: 'nope', index: 0 },
      phone,
    );
    await h.router.idle();
    expect(h.byType('attachment.fetch.response').at(-1)).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

describe('Router · 扩展', () => {
  async function extHarness() {
    const links = await SessionLinksStore.load(join(dir, 'session-links.json'));
    const h = await makeHarness({ links });
    return { ...h, links };
  }

  test('session.links.update：手动关联写入并随 session.updated 广播；不存在的会话 not_found', async () => {
    const h = await extHarness();
    h.state.rememberSession('s1', params);
    await h.router.handle(
      { type: 'session.create', ...c2a(), reqId: 'c', ...params },
      phone,
    );
    const sid = (h.byType('session.create.response')[0] as { session: { sessionId: string } }).session.sessionId;
    await h.router.handle(
      { type: 'session.links.update', ...c2a(), reqId: 'l1', targetSessionId: sid, ext: 'tasks', add: [{ ref: 'a', label: 'A' }] },
      phone,
    );
    await h.router.idle();
    expect(h.byType('session.links.update.response').at(-1)).toMatchObject({ reqId: 'l1', ok: true });
    const updated = h.byType('session.updated').at(-1) as { session: { links?: unknown } };
    expect(updated.session.links).toEqual([{ ext: 'tasks', ref: 'a', label: 'A', at: expect.any(Number) }]);
    // 定向回请求设备
    expect(h.events.find((e) => e.event.type === 'session.links.update.response')!.to).toBe('phone');

    await h.router.handle(
      { type: 'session.links.update', ...c2a(), reqId: 'l2', targetSessionId: 'nope', ext: 'tasks', add: [{ ref: 'a', label: 'A' }] },
      phone,
    );
    await h.router.idle();
    expect(h.byType('session.links.update.response').at(-1)).toMatchObject({ reqId: 'l2', ok: false, error: { code: 'not_found' } });
  });

  test('ext.records.request：定向回该会话的记录卡；删除会话后清掉', async () => {
    const records = await SessionRecordsStore.load(join(dir, 'session-ext-records.json'));
    const h = await withHistorical('h1', { records });
    records.append('h1', { ext: 'tasks', extName: 'Tasks', kind: 'linked', label: 'A' });
    await h.router.handle({ type: 'ext.records.request', ...c2a(), reqId: 'r1', targetSessionId: 'h1' }, phone);
    await h.router.handle({ type: 'ext.records.request', ...c2a(), reqId: 'r2', targetSessionId: 'nope' }, phone);
    await h.router.idle();
    const [r1, r2] = h.byType('ext.records.response') as { reqId: string; targetSessionId: string; records: { label: string }[] }[];
    expect(r1).toMatchObject({ reqId: 'r1', targetSessionId: 'h1', records: [{ kind: 'linked', label: 'A' }] });
    expect(r2).toMatchObject({ reqId: 'r2', records: [] });
    expect(h.events.find((e) => e.event.type === 'ext.records.response')!.to).toBe('phone');

    await h.router.handle(archive('h1', 'q-arch'), phone);
    await h.router.handle(del('h1', 'q-del'), phone);
    await h.router.idle();
    expect(responseOf(h, 'q-del')).toMatchObject({ ok: true });
    expect(records.of('h1')).toEqual([]);
  });

  test('删除会话时清掉关联', async () => {
    const h = await extHarness();
    await h.links.update('gone', 'tasks', [{ ref: 'a', label: 'A' }], [], 1);
    h.links.forget('gone');
    expect(h.links.of('gone')).toBeUndefined();
  });

  test('extHost.createSession：建会话、写标题与关联、发首条消息；sendPrompt 走会话链', async () => {
    const h = await extHarness();
    const host = h.router.extHost();
    const created = await host.createSession({
      cwd: '/repo',
      model: 'opus',
      permissionMode: 'default',
      title: '接续 task-a',
      ext: 'tasks',
      links: [{ ref: 'task-a', label: 'Task A' }],
      prompt: '继续 task-a 任务',
    });
    await h.router.idle();
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.args).toMatchObject({ sessionId: created.sessionId, cwd: '/repo', model: 'opus', permissionMode: 'default' });
    expect(h.created[0]!.sent).toEqual([{ clientMsgId: created.clientMsgId!, text: '继续 task-a 任务' }]);
    expect(h.links.of(created.sessionId)).toMatchObject([{ ext: 'tasks', ref: 'task-a' }]);
    expect(h.flags.pendingTitle(created.sessionId)).toBe('接续 task-a');
    const updated = h.byType('session.updated').find(
      (e) => (e as { session: { sessionId: string } }).session.sessionId === created.sessionId,
    ) as { session: { links?: unknown; title: string } };
    expect(updated.session).toMatchObject({ title: '接续 task-a', links: [{ ref: 'task-a' }] });

    const sent = await host.withSession(created.sessionId, (api) => api.send('再来一条'));
    expect(sent.queued).toBe(false);
    expect(h.created[0]!.sent.at(-1)).toEqual({ clientMsgId: sent.clientMsgId, text: '再来一条' });
  });

  test('扩展帧不占机器链；没有扩展服务时忽略', async () => {
    const h = await extHarness();
    await h.router.handle({ type: 'ext.catalog.request', ...c2a(), reqId: 'k' }, phone);
    await h.router.idle();
    expect(h.byType('ext.catalog.response')).toHaveLength(0);
    const registry = await ExtensionRegistry.load(join(dir, 'extensions.json'));
    h.router.attachExtensions(
      new ExtensionService({ registry, links: h.links, host: h.router.extHost(), runner: { run: async () => ({ ok: true, output: {}, stderr: '', durationMs: 0 }) } }),
    );
    await h.router.handle({ type: 'ext.catalog.request', ...c2a(), reqId: 'k2' }, phone);
    await h.router.idle();
    expect(h.byType('ext.catalog.response').at(-1)).toMatchObject({ reqId: 'k2', items: [] });
  });
});

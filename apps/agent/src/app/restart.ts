/**
 * agent 自重启（agent-restart）：预检 → 排空 → 退出由 supervisor 拉起 → 新进程通知发起方。
 *
 * ## 为什么不能「直接 restart」
 *
 * 会话是 agent 的子进程（SDK `query()` 起 claude，经 stdio 管道通信），agent 一退出
 * 它们全部结束——包括正在执行重启命令的那个会话：命令本身被杀（137），这一轮也断了。
 * 子进程跨 agent 重启存活是做不到的（新进程接不回旧管道），所以改成**不在轮次中途重启**：
 *
 * 1. **预检**：在工作区跑 `bun install --frozen-lockfile` 和 `trine-agent selfcheck`
 *    （加载整个模块图）。不通过就不重启——不能把一个起不来的版本换上去。
 * 2. **排空**：等全部会话不在跑、没有排队消息和后台任务。发起重启的会话本轮会正常结束
 *    （命令立即返回「已排期」），然后才轮到重启。超过 RESTART_DRAIN_TIMEOUT_MS 仍有会话
 *    在忙就取消，避免一个挂着等权限的会话让重启无限期悬着；要硬重启用 `now`。
 * 3. **退出**：写 `<home>/restart.json` 标记，以 RESTART_EXIT_CODE 退出，由 supervisor 拉起
 *    （systemd `Restart=on-failure` 对非零退出会重启）。没有 supervisor 时退出就是停机，
 *    所以只在检测到 supervisor 时可用（见 restartAvailability）。
 * 4. **接续**：新进程读到标记后给发起会话留一条时间线记录；带了续跑提示的，以一条消息
 *    发进该会话（resume 接上原上下文），让 Claude 自己核实重启结果。
 *
 * agent 不做 git 操作：「升级」是触发方先把工作区更新好，agent 只负责安全地换上它。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AGENT_RESTART_OUTPUT_MAX, type AgentRestartErrorCode, type MachineRestartInfo } from '@trine/core';
import { z } from 'zod';
import { defaultSpawn, runCaptured, tailOutput, type SpawnFn } from './claude-cli.ts';

/** 重启时的退出码（EX_TEMPFAIL）：非零，supervisor 的 on-failure 策略会拉起 */
export const RESTART_EXIT_CODE = 75;
/** 排空上限：到点仍有会话在忙就取消这次重启 */
export const RESTART_DRAIN_TIMEOUT_MS = 15 * 60_000;
/** 排空时检查会话是否都空闲的间隔 */
export const RESTART_POLL_MS = 1_000;
/** 预检各步的超时 */
export const PRECHECK_INSTALL_TIMEOUT_MS = 5 * 60_000;
export const PRECHECK_SELFCHECK_TIMEOUT_MS = 60_000;
/** 标记超过这个年龄就不认了（上次重启失败、很久之后才被别的方式拉起） */
export const RESTART_MARKER_MAX_AGE_MS = 60 * 60_000;
/** 续跑提示 / 备注长度上限 */
export const RESTART_NOTE_MAX = 300;
export const RESTART_PROMPT_MAX = 4_000;

/** 重启后要通知的会话（发起方） */
export const RestartNoticeSchema = z.object({
  sessionId: z.string().min(1).max(128),
  note: z.string().max(RESTART_NOTE_MAX).optional(),
  /** 重启后以一条消息发进该会话 */
  continuePrompt: z.string().max(RESTART_PROMPT_MAX).optional(),
});
export type RestartNotice = z.infer<typeof RestartNoticeSchema>;

export const RestartMarkerSchema = z.object({
  v: z.literal(1),
  requestedAt: z.number(),
  fromVersion: z.string(),
  fromRevision: z.string().optional(),
  notices: z.array(RestartNoticeSchema).max(20),
});
export type RestartMarker = z.infer<typeof RestartMarkerSchema>;

export type PrecheckResult = { ok: true; version: string } | { ok: false; message: string; output: string };

export type RestartOutcome =
  | { ok: true; phase: 'draining' | 'restarting' | 'cancelled'; toVersion?: string }
  | { ok: false; code: AgentRestartErrorCode; message: string; output?: string };

export interface RestartAvailability {
  available: boolean;
  reason?: string;
}

/**
 * 有没有 supervisor 会在退出后拉起：systemd 给服务进程设 INVOCATION_ID；
 * 其他 supervisor（launchd、pm2、容器 restart 策略……）由用户设 TRINE_SUPERVISED=1 声明。
 */
export function restartAvailability(env: Readonly<Record<string, string | undefined>>): RestartAvailability {
  if (env['TRINE_SUPERVISED'] === '1') return { available: true };
  if (env['TRINE_SUPERVISED'] === '0') return { available: false, reason: 'TRINE_SUPERVISED=0：已声明没有 supervisor' };
  if ((env['INVOCATION_ID'] ?? '') !== '') return { available: true };
  return {
    available: false,
    reason: 'agent 不是由 supervisor 拉起的（退出后没人拉起）。用 systemd 等托管后再试，或设 TRINE_SUPERVISED=1',
  };
}

// ---------------------------------------------------------------------------
// 协调器
// ---------------------------------------------------------------------------

export interface RestartCoordinatorOptions {
  availability: RestartAvailability;
  precheck: () => Promise<PrecheckResult>;
  /** 还在忙的会话数（跑着轮次 / 有排队消息 / 有后台任务） */
  busySessions: () => number;
  /** 写好标记、开始退出（由 app 接到 cli）。只会调一次 */
  exit: (marker: RestartMarker) => Promise<void> | void;
  /** 状态变了（app 据此广播 machine.info） */
  onChange: () => void;
  /** 排空超时 / 被取消：通知等着的会话 */
  onCancelled?: (notices: readonly RestartNotice[], reason: string) => void;
  fromVersion: string;
  fromRevision?: string | undefined;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  pollMs?: number;
  drainTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface RestartRequest {
  /** when_idle：排空后重启；now：预检通过即重启 */
  mode: 'when_idle' | 'now';
  notice?: RestartNotice | undefined;
}

type Phase = 'idle' | 'checking' | 'draining' | 'exiting';

export class RestartCoordinator {
  readonly #opts: RestartCoordinatorOptions;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #log: (line: string) => void;
  #phase: Phase = 'idle';
  #requestedAt = 0;
  #deadline: number | undefined = undefined;
  #notices: RestartNotice[] = [];
  #toVersion: string | undefined = undefined;
  /** 预检期间收到 cancel：预检结束后不重启 */
  #cancelDuringCheck = false;
  /** 本次请求是 now：预检通过即退出 */
  #nowDuringCheck = false;
  #timer: unknown = undefined;
  #lastBusy = 0;
  #disposed = false;

  constructor(options: RestartCoordinatorOptions) {
    this.#opts = options;
    this.#now = options.now ?? (() => Date.now());
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as never));
    this.#log = options.log ?? (() => {});
  }

  /** 已决定退出（此后的入站命令留给新进程） */
  get exiting(): boolean {
    return this.#phase === 'exiting';
  }

  get availability(): RestartAvailability {
    return this.#opts.availability;
  }

  /** machine.info.restart.pending；没有进行中的重启 → undefined */
  pending(): MachineRestartInfo['pending'] {
    if (this.#phase !== 'checking' && this.#phase !== 'draining') return undefined;
    return {
      phase: this.#phase,
      requestedAt: this.#requestedAt,
      ...(this.#deadline === undefined ? {} : { deadline: this.#deadline }),
      busySessions: this.#phase === 'draining' ? this.#lastBusy : 0,
    };
  }

  async request(req: RestartRequest): Promise<RestartOutcome> {
    if (!this.#opts.availability.available) {
      return { ok: false, code: 'unavailable', message: this.#opts.availability.reason ?? '这个 agent 不能远程重启' };
    }
    switch (this.#phase) {
      case 'exiting':
        // 标记已经在写：这里再登记的通知存不进去，不能假装接下了
        return { ok: false, code: 'busy', message: 'agent 正在重启，重启完成后再试' };
      case 'checking':
        // 预检中：不起第二次预检，也不改上一次请求的方式（拒绝就是没有副作用）
        return { ok: false, code: 'busy', message: '正在预检上一次的重启请求，结束后再试' };
      case 'draining':
        this.#addNotice(req.notice);
        if (req.mode === 'now') {
          this.#exitSoon();
          return { ok: true, phase: 'restarting', ...this.#versionField() };
        }
        return { ok: true, phase: 'draining', ...this.#versionField() };
      case 'idle':
        break;
    }

    // 置位必须在任何 await 之前：同一宏任务里的第二个请求要看到它
    this.#phase = 'checking';
    this.#requestedAt = this.#now();
    this.#deadline = undefined;
    this.#notices = [];
    this.#addNotice(req.notice);
    this.#cancelDuringCheck = false;
    this.#nowDuringCheck = req.mode === 'now';
    this.#opts.onChange();
    this.#log('[restart] 收到重启请求，开始预检');

    let result: PrecheckResult;
    try {
      result = await this.#opts.precheck();
    } catch (err) {
      result = { ok: false, message: `预检出错：${(err as Error).message}`, output: '' };
    }
    if (this.#disposed) return { ok: false, code: 'failed', message: 'agent 正在退出' };

    if (this.#cancelDuringCheck) {
      this.#reset();
      this.#log('[restart] 预检期间被取消');
      return { ok: true, phase: 'cancelled' };
    }
    if (!result.ok) {
      this.#reset();
      this.#log(`[restart] 预检未通过，不重启：${result.message}`);
      const output = tailOutput(result.output, AGENT_RESTART_OUTPUT_MAX).text;
      return { ok: false, code: 'check_failed', message: result.message, ...(output === '' ? {} : { output }) };
    }

    this.#toVersion = result.version;
    if (this.#nowDuringCheck) {
      this.#exitSoon();
      return { ok: true, phase: 'restarting', toVersion: result.version };
    }
    this.#phase = 'draining';
    this.#deadline = this.#now() + (this.#opts.drainTimeoutMs ?? RESTART_DRAIN_TIMEOUT_MS);
    this.#lastBusy = this.#opts.busySessions();
    this.#log(`[restart] 预检通过（新版本 ${result.version}），等待会话空闲（当前 ${this.#lastBusy} 个在忙）`);
    this.#opts.onChange();
    // 不在这里同步检查：调用方要先把应答发出去，再轮到退出
    this.#schedule(0);
    return { ok: true, phase: 'draining', toVersion: result.version };
  }

  /** 取消还没执行的重启 */
  cancel(reason = '已取消'): RestartOutcome {
    if (this.#phase === 'checking') {
      this.#cancelDuringCheck = true;
      return { ok: true, phase: 'cancelled' };
    }
    if (this.#phase !== 'draining') {
      return { ok: false, code: 'not_pending', message: this.#phase === 'exiting' ? 'agent 已在重启' : '没有待执行的重启' };
    }
    const notices = this.#notices;
    this.#reset();
    this.#log(`[restart] 重启已取消：${reason}`);
    this.#opts.onCancelled?.(notices, reason);
    return { ok: true, phase: 'cancelled' };
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }

  #versionField(): { toVersion?: string } {
    return this.#toVersion === undefined ? {} : { toVersion: this.#toVersion };
  }

  #addNotice(notice: RestartNotice | undefined): void {
    if (notice === undefined) return;
    const index = this.#notices.findIndex((n) => n.sessionId === notice.sessionId);
    // 同一会话再次请求：以最新的为准
    if (index !== -1) this.#notices[index] = notice;
    else if (this.#notices.length < 20) this.#notices.push(notice);
  }

  #reset(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    this.#phase = 'idle';
    this.#deadline = undefined;
    this.#notices = [];
    this.#toVersion = undefined;
    this.#lastBusy = 0;
    this.#opts.onChange();
  }

  #schedule(ms: number): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      this.#tick();
    }, ms);
  }

  #tick(): void {
    if (this.#phase !== 'draining' || this.#disposed) return;
    const busy = this.#opts.busySessions();
    if (busy === 0) {
      void this.#exit();
      return;
    }
    if (this.#deadline !== undefined && this.#now() >= this.#deadline) {
      const minutes = Math.round((this.#opts.drainTimeoutMs ?? RESTART_DRAIN_TIMEOUT_MS) / 60_000);
      this.cancel(`等待会话空闲超过 ${minutes} 分钟（仍有 ${busy} 个在忙），可选择立即重启`);
      return;
    }
    if (busy !== this.#lastBusy) {
      this.#lastBusy = busy;
      this.#opts.onChange();
    }
    this.#schedule(this.#opts.pollMs ?? RESTART_POLL_MS);
  }

  /** 推迟到下一个宏任务再退出：本次请求的应答要先发出去 */
  #exitSoon(): void {
    this.#phase = 'draining';
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      void this.#exit();
    }, 0);
  }

  async #exit(): Promise<void> {
    if (this.#phase === 'exiting' || this.#disposed) return;
    this.#phase = 'exiting';
    const marker: RestartMarker = {
      v: 1,
      requestedAt: this.#requestedAt,
      fromVersion: this.#opts.fromVersion,
      ...(this.#opts.fromRevision === undefined ? {} : { fromRevision: this.#opts.fromRevision }),
      notices: this.#notices,
    };
    this.#log('[restart] 会话已空闲，agent 退出以便 supervisor 拉起新版本');
    try {
      await this.#opts.exit(marker);
    } catch (err) {
      this.#log(`[restart] 退出失败：${(err as Error).message}`);
      const notices = this.#notices;
      this.#reset();
      this.#opts.onCancelled?.(notices, `退出失败：${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 标记文件
// ---------------------------------------------------------------------------

export async function writeRestartMarker(path: string, marker: RestartMarker): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(marker, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * 读出并删掉标记（先删再处理：通知过程中崩溃也不会反复续跑）。
 * 没有 / 坏了 / 太旧 → undefined。
 */
export async function takeRestartMarker(
  path: string,
  now: number,
  log: (line: string) => void = () => {},
): Promise<RestartMarker | undefined> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  await unlink(path).catch(() => {});
  let marker: RestartMarker;
  try {
    marker = RestartMarkerSchema.parse(JSON.parse(raw));
  } catch {
    log('[restart] 重启标记无法解析，忽略');
    return undefined;
  }
  if (now - marker.requestedAt > RESTART_MARKER_MAX_AGE_MS) {
    log('[restart] 重启标记已过期，忽略');
    return undefined;
  }
  return marker;
}

// ---------------------------------------------------------------------------
// 预检
// ---------------------------------------------------------------------------

export interface PrecheckOptions {
  /** agent 入口（cli.ts）的绝对路径 */
  entry: string;
  /** bun 可执行文件 */
  execPath: string;
  /** 含 bun.lock 的仓库根；没有就跳过 install */
  repoRoot?: string | undefined;
  env?: Record<string, string | undefined>;
  spawn?: SpawnFn;
  installTimeoutMs?: number;
  selfcheckTimeoutMs?: number;
  /** 进行中的预检子进程（退出时杀掉） */
  onSpawn?: (proc: { kill(signal?: NodeJS.Signals): void }) => void;
}

/** selfcheck 子命令打印的那一行 */
export const SELFCHECK_PREFIX = 'trine-agent selfcheck ok ';

export async function runPrecheck(options: PrecheckOptions): Promise<PrecheckResult> {
  const spawn = options.spawn ?? defaultSpawn;
  const env = options.env ?? process.env;
  let output = '';

  if (options.repoRoot !== undefined) {
    const install = await runCaptured(spawn, [options.execPath, 'install', '--frozen-lockfile'], {
      env,
      cwd: options.repoRoot,
      timeoutMs: options.installTimeoutMs ?? PRECHECK_INSTALL_TIMEOUT_MS,
      ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
    });
    output += `$ bun install --frozen-lockfile\n${install.raw}\n`;
    const failure = describeFailure(install, 'bun install --frozen-lockfile');
    if (failure !== undefined) return { ok: false, message: failure, output };
  }

  const check = await runCaptured(spawn, [options.execPath, 'run', options.entry, 'selfcheck'], {
    env,
    cwd: dirname(dirname(options.entry)),
    timeoutMs: options.selfcheckTimeoutMs ?? PRECHECK_SELFCHECK_TIMEOUT_MS,
    ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
  });
  output += `$ trine-agent selfcheck\n${check.raw}\n`;
  const failure = describeFailure(check, '工作区代码加载（selfcheck）');
  if (failure !== undefined) return { ok: false, message: failure, output };
  const line = check.raw.split('\n').find((l) => l.startsWith(SELFCHECK_PREFIX));
  if (line === undefined) return { ok: false, message: 'selfcheck 没有报告版本（工作区是旧版本？）', output };
  return { ok: true, version: line.slice(SELFCHECK_PREFIX.length).trim() };
}

function describeFailure(run: Awaited<ReturnType<typeof runCaptured>>, what: string): string | undefined {
  switch (run.kind) {
    case 'exit':
      return run.code === 0 ? undefined : `${what} 失败（退出码 ${run.code}）`;
    case 'timeout':
      return `${what} 超时`;
    case 'spawn_error':
      return `无法执行 ${what}：${run.message}`;
  }
}

// ---------------------------------------------------------------------------
// 版本（git HEAD）
// ---------------------------------------------------------------------------

/** 从 start 往上找第一个含 name 的目录 */
export function findUp(start: string, name: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, name))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * 读工作区 git HEAD 的短 sha。只读文件、不起 git 进程（machine.info 每次广播都要读）。
 * 支持 worktree（`.git` 是文件）与 packed-refs；读不到 → undefined。
 */
export function readGitHead(repoRoot: string): string | undefined {
  try {
    let gitDir = join(repoRoot, '.git');
    if (statSync(gitDir).isFile()) {
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (match === null) return undefined;
      gitDir = resolve(repoRoot, match[1]!.trim());
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return SHA.test(head) ? head.slice(0, 7) : undefined;
    const ref = head.slice(4).trim();
    const commonFile = join(gitDir, 'commondir');
    const commonDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim()) : gitDir;
    for (const dir of [gitDir, commonDir]) {
      try {
        const sha = readFileSync(join(dir, ref), 'utf8').trim();
        if (SHA.test(sha)) return sha.slice(0, 7);
      } catch {
        // 不在这里：看下一个 / packed-refs
      }
    }
    for (const line of readFileSync(join(commonDir, 'packed-refs'), 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && sha !== undefined && SHA.test(sha)) return sha.slice(0, 7);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

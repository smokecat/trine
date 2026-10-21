/**
 * 本机 claude CLI：解析可执行文件 → 探测版本 → 远程 `claude update`。
 *
 * ## 为什么会话要用全局 claude
 *
 * SDK 不给 `pathToClaudeCodeExecutable` 时跑的是它自带的二进制（随 SDK 依赖
 * 版本钉死，如 0.3.251 → 2.1.251），而用户在本机终端里用的是全局安装的 claude
 * （自动更新，版本更新）。两者不一致时：machine.info 展示的版本不是会话实际跑
 * 的版本；远程 `claude update` 更新的是全局那份，对会话毫无作用。所以 agent
 * 启动时解析**一次**路径，会话、版本探测、更新三处用同一个。
 *
 * ## 解析顺序
 *
 * `--claude-bin` / `TRINE_CLAUDE_BIN` 显式覆盖 > PATH 上的 `claude` > 都没有则
 * undefined（会话回退 SDK 内置，打日志）。显式覆盖指向的文件不可执行 → 启动
 * 直接报错：用户明说了要用哪个，静默回退只会让他对着错的版本排查。
 *
 * **不做 realpath**：原生安装的 `~/.local/bin/claude` 是指向
 * `~/.local/share/claude/versions/<ver>` 的软链，`claude update` 换的是软链
 * 目标。保留软链路径，更新后新起的会话自然拿到新版；解析成真实路径则会钉死在旧版。
 */
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLAUDE_UPDATE_OUTPUT_MAX, type ClaudeUpdateErrorCode } from '@trine/core';
import { stripAnsi } from '../bridge/summarize.ts';

/** `claude update` 的超时上限（到点 SIGTERM，再等 KILL_GRACE_MS 不退就 SIGKILL） */
export const CLAUDE_UPDATE_TIMEOUT_MS = 5 * 60_000;
const KILL_GRACE_MS = 5_000;
/** 进程退出后等管道读完的上限：孙进程可能继承了管道一直不关 */
const DRAIN_GRACE_MS = 2_000;
/** 读输出时内存里最多留多少字符（最终只回尾部 CLAUDE_UPDATE_OUTPUT_MAX） */
const RAW_TAIL_KEEP = 64 * 1024;

// ---------------------------------------------------------------------------
// 子进程注入口
// ---------------------------------------------------------------------------

/** 用到的子进程面（Bun.spawn 返回值的子集），测试注入假实现 */
export interface SpawnedProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

/** 起子进程；起不来（ENOENT 等）直接抛 */
export type SpawnFn = (
  cmd: string[],
  options: { env: Record<string, string | undefined>; cwd?: string },
) => SpawnedProcess;

export const defaultSpawn: SpawnFn = (cmd, { env, cwd }) =>
  Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env, ...(cwd === undefined ? {} : { cwd }) });

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

export type ClaudeExecutableSource = 'override' | 'path' | 'sdk';

export interface ResolvedClaudeExecutable {
  /** undefined = 没找到全局 claude，会话用 SDK 内置 */
  path: string | undefined;
  source: ClaudeExecutableSource;
}

export class ClaudeExecutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeExecutableError';
  }
}

/**
 * 解析会话要用的 claude 可执行文件（见文件头）。
 * @throws {ClaudeExecutableError} 显式覆盖的路径不存在 / 不可执行
 */
export function resolveClaudeExecutable(
  override: string | undefined,
  which: (cmd: string) => string | null = (cmd) => Bun.which(cmd),
): ResolvedClaudeExecutable {
  if (override !== undefined) {
    const found = which(override);
    if (found === null) {
      throw new ClaudeExecutableError(`--claude-bin / TRINE_CLAUDE_BIN 指定的 ${override} 不存在或不可执行`);
    }
    return { path: found, source: 'override' };
  }
  const found = which('claude');
  return found === null ? { path: undefined, source: 'sdk' } : { path: found, source: 'path' };
}

// ---------------------------------------------------------------------------
// 版本探测
// ---------------------------------------------------------------------------

/**
 * 探测会话实际使用的 claude 版本：输出形如 `2.1.270 (Claude Code)`，取首行。
 * 超时 / 起不来 / 非零退出 → 'unknown'。
 *
 * `executable` 为 undefined（会话在用 SDK 内置二进制）时读 SDK 包里的
 * manifest.json，给 `2.1.251 (SDK 内置)`——展示的仍是会话真正跑的版本，
 * 读不到才退回 'unknown'。
 */
export async function detectClaudeVersion(
  executable: string | undefined,
  options: { spawn?: SpawnFn; timeoutMs?: number } = {},
): Promise<string> {
  if (executable === undefined) return sdkBundledVersion() ?? 'unknown';
  const spawn = options.spawn ?? defaultSpawn;
  try {
    const proc = spawn([executable, '--version'], { env: process.env });
    const timer = setTimeout(() => proc.kill(), options.timeoutMs ?? 3_000);
    // stderr 也得读掉，否则管道写满会把子进程卡住
    const [text, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0) return 'unknown';
    const line = text.split('\n')[0]?.trim() ?? '';
    return line === '' ? 'unknown' : line;
  } catch {
    return 'unknown';
  }
}

/** SDK 自带 claude 的版本（manifest.json 与 sdk.mjs 同目录）；读不到 → undefined */
export function sdkBundledVersion(): string | undefined {
  try {
    const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    const manifest = JSON.parse(readFileSync(join(dirname(entry), 'manifest.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof manifest.version === 'string' && manifest.version !== ''
      ? `${manifest.version} (SDK 内置)`
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 输出整理
// ---------------------------------------------------------------------------

/**
 * 原始输出 → 给人看的尾部：去 ANSI；每行只留最后一个 `\r` 之后的部分（进度条 /
 * spinner 用 `\r` 原地重绘，全留下来是一屏重复）；再截尾部至多 `max` 字符。
 */
export function tailOutput(raw: string, max = CLAUDE_UPDATE_OUTPUT_MAX): { text: string; truncated: boolean } {
  const cleaned = stripAnsi(raw)
    .split('\n')
    .map((line) => {
      const body = line.endsWith('\r') ? line.slice(0, -1) : line;
      const cut = body.lastIndexOf('\r');
      return cut === -1 ? body : body.slice(cut + 1);
    })
    .join('\n')
    .trim();
  if (cleaned.length <= max) return { text: cleaned, truncated: false };
  return { text: cleaned.slice(cleaned.length - max), truncated: true };
}

// ---------------------------------------------------------------------------
// claude update
// ---------------------------------------------------------------------------

export interface ClaudeUpdateOutcome {
  ok: boolean;
  fromVersion: string;
  toVersion: string;
  output: string;
  outputTruncated: boolean;
  error?: { code: ClaudeUpdateErrorCode; message: string };
}

export interface ClaudeUpdaterOptions {
  /** 解析出的可执行文件；undefined → 一律回 not_found */
  executable: string | undefined;
  /** agent 当前记着的版本（busy / not_found 时原样回报，探测失败时兜底） */
  currentVersion: () => string;
  /** 更新跑完（无论成败）后重新探测到的版本；app 据此刷新 claudeVersion 并广播 machine.info */
  onVersion?: (version: string) => void;
  spawn?: SpawnFn;
  /** 重新探测版本；默认 detectClaudeVersion(executable) */
  detectVersion?: () => Promise<string>;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * 单飞的 `claude update` 执行器。
 *
 * - **单飞不排队**：进行中再来的请求立刻回 `busy`——排队意味着第二个请求要等
 *   几分钟才有结果，而它要做的事第一次已经在做了。
 * - **继承 env**：代理变量（https_proxy 等）必须带上，否则国内出口下载必挂
 *   （子进程继承代理配置，避免网络出口与交互式 CLI 不一致）。
 * - **只影响新起的会话**：运行中的会话子进程不重启，仍是旧版；空闲回收后再
 *   resume、或新建的会话才会用上新版。
 */
export class ClaudeUpdater {
  readonly #opts: ClaudeUpdaterOptions;
  readonly #spawn: SpawnFn;
  readonly #log: (line: string) => void;
  #current: SpawnedProcess | undefined = undefined;
  #running = false;
  #disposed = false;

  constructor(options: ClaudeUpdaterOptions) {
    this.#opts = options;
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#log = options.log ?? (() => {});
  }

  get running(): boolean {
    return this.#running;
  }

  async run(): Promise<ClaudeUpdateOutcome> {
    const executable = this.#opts.executable;
    const current = this.#opts.currentVersion();
    if (this.#running) {
      return this.#refuse(current, 'busy', '已有一次 claude 更新在进行中，请等它结束');
    }
    if (executable === undefined) {
      return this.#refuse(
        current,
        'not_found',
        '未找到全局 claude：会话正在用 SDK 内置版本，无法更新（可用 --claude-bin 指定路径）',
      );
    }
    // 置位必须在任何 await 之前：同一宏任务里的第二个请求要看到它
    this.#running = true;
    try {
      const fromVersion = await this.#detect(current);
      this.#log(`[claude] 开始更新 ${executable}（当前 ${fromVersion}）`);
      const run = await this.#exec(executable);
      const toVersion = await this.#detect('unknown');
      if (!this.#disposed) this.#opts.onVersion?.(toVersion);
      const { text, truncated } = tailOutput(run.raw);
      const base = { fromVersion, toVersion, output: text, outputTruncated: truncated || run.rawTruncated };
      this.#log(`[claude] 更新结束 ${run.kind}${run.kind === 'exit' ? ` code=${run.code}` : ''}：${fromVersion} → ${toVersion}`);
      switch (run.kind) {
        case 'exit':
          return run.code === 0
            ? { ok: true, ...base }
            : { ok: false, ...base, error: { code: 'failed', message: `claude update 退出码 ${run.code}` } };
        case 'timeout':
          return {
            ok: false,
            ...base,
            error: { code: 'timeout', message: `claude update 超过 ${Math.round(this.#timeoutMs / 1000)}s 未结束，已终止` },
          };
        case 'spawn_error':
          return { ok: false, ...base, error: { code: 'failed', message: `无法启动 claude update：${run.message}` } };
      }
    } finally {
      this.#running = false;
      this.#current = undefined;
    }
  }

  /** agent 退出：杀掉进行中的更新（不等它） */
  dispose(): void {
    this.#disposed = true;
    this.#current?.kill('SIGTERM');
  }

  get #timeoutMs(): number {
    return this.#opts.timeoutMs ?? CLAUDE_UPDATE_TIMEOUT_MS;
  }

  #refuse(version: string, code: ClaudeUpdateErrorCode, message: string): ClaudeUpdateOutcome {
    return {
      ok: false,
      fromVersion: version,
      toVersion: version,
      output: '',
      outputTruncated: false,
      error: { code, message },
    };
  }

  async #detect(fallback: string): Promise<string> {
    const detect =
      this.#opts.detectVersion ??
      (() => detectClaudeVersion(this.#opts.executable, { spawn: this.#spawn }));
    const v = await detect();
    return v === 'unknown' ? fallback : v;
  }

  async #exec(executable: string): Promise<CapturedRun> {
    return runCaptured(this.#spawn, [executable, 'update'], {
      env: this.#opts.env ?? process.env,
      timeoutMs: this.#timeoutMs,
      onSpawn: (proc) => {
        this.#current = proc;
      },
    });
  }
}

// ---------------------------------------------------------------------------
// 跑子进程并收集输出尾部（claude update、agent 重启预检共用）
// ---------------------------------------------------------------------------

export type CapturedRun =
  | { kind: 'exit'; code: number; raw: string; rawTruncated: boolean }
  | { kind: 'timeout'; raw: string; rawTruncated: boolean }
  | { kind: 'spawn_error'; message: string; raw: string; rawTruncated: boolean };

/**
 * 起子进程，stdout + stderr 按到达顺序拼进同一个尾部缓冲（至多 RAW_TAIL_KEEP），
 * 超时 SIGTERM、再等 KILL_GRACE_MS 不退就 SIGKILL。不抛：起不来以 spawn_error 表达。
 */
export async function runCaptured(
  spawn: SpawnFn,
  cmd: string[],
  options: {
    env: Record<string, string | undefined>;
    cwd?: string;
    timeoutMs: number;
    /** 拿到子进程句柄（调用方要能在退出时杀掉它） */
    onSpawn?: (proc: SpawnedProcess) => void;
  },
): Promise<CapturedRun> {
  let proc: SpawnedProcess;
  try {
    proc = spawn(cmd, { env: options.env, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
  } catch (err) {
    return { kind: 'spawn_error', message: (err as Error).message, raw: '', rawTruncated: false };
  }
  options.onSpawn?.(proc);

  let raw = '';
  let rawTruncated = false;
  const append = (chunk: string): void => {
    raw += chunk;
    if (raw.length > RAW_TAIL_KEEP) {
      raw = raw.slice(raw.length - RAW_TAIL_KEEP);
      rawTruncated = true;
    }
  };
  const readers: { cancel(): Promise<void> }[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    readers.push(reader);
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        append(decoder.decode(value, { stream: true }));
      }
      append(decoder.decode());
    } catch {
      // 被 cancel 或管道异常：已读到的保留
    }
  };
  const drained = Promise.all([pump(proc.stdout), pump(proc.stderr)]);

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
    killTimer = setTimeout(() => proc.kill('SIGKILL'), KILL_GRACE_MS);
  }, options.timeoutMs);

  let code: number;
  try {
    code = await proc.exited;
  } finally {
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
  }

  // 孙进程可能还占着管道：等一小会儿就不等了
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    drained,
    new Promise<void>((resolve) => {
      graceTimer = setTimeout(resolve, DRAIN_GRACE_MS);
    }),
  ]);
  clearTimeout(graceTimer);
  for (const reader of readers) void reader.cancel().catch(() => {});

  return timedOut ? { kind: 'timeout', raw, rawTruncated } : { kind: 'exit', code, raw, rawTruncated };
}

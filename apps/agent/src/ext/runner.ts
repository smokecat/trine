/**
 * 扩展进程执行：一次调用一个进程，stdin 一个 JSON（写完即关），stdout 一个 JSON。
 *
 * - **进程组**：detached 起进程、自成一组；超时 / 取消 / agent 退出时先 SIGTERM 整组，宽限后
 *   SIGKILL。只杀主进程的话，扩展脚本里再起的子进程会变成孤儿继续跑。
 * - **限额**：stdout 边读边计，超上限立即终止（output_limit）；stderr 只留末尾一段供诊断。
 * - **环境变量白名单**：不继承凭据与 BASH_ENV / NODE_OPTIONS / LD_* 之类的注入入口。
 *   这不是沙箱：扩展以本用户身份运行，照样能读写文件（EXTENSIONS.md §信任边界）。
 * - **并发**：每个扩展、全局各有上限；用户动作排在刷新前面；排队太久报 busy。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { trustedPath } from './registry.ts';

export const READ_TIMEOUT_MS = 5_000;
export const ACTION_TIMEOUT_MS = 30_000;
export const KILL_GRACE_MS = 2_000;
export const MAX_STDIN_BYTES = 256 * 1024;
export const MAX_STDOUT_BYTES = 512 * 1024;
export const MAX_STDERR_TAIL = 8 * 1024;
export const PER_EXT_CONCURRENCY = 2;
export const GLOBAL_CONCURRENCY = 4;
export const PER_EXT_QUEUE = 8;
export const QUEUE_DEADLINE_MS = 10_000;

const ENV_ALLOW = ['HOME', 'USER', 'LOGNAME', 'LANG', 'TZ', 'TMPDIR', 'SHELL', 'TERM'];

export type RunFailureCode = 'timeout' | 'output_limit' | 'invalid_output' | 'busy' | 'not_found' | 'io';

export type RunResult =
  | { ok: true; output: unknown; stderr: string; durationMs: number }
  | { ok: false; code: RunFailureCode; message: string; stderr: string; durationMs: number };

export interface RunRequest {
  ext: string;
  argv: readonly string[];
  /** 扩展目录（TRINE_EXT_DIR） */
  dir: string;
  /** 工作目录：会话 / 工作区 cwd，只作数据上下文 */
  cwd: string;
  op: string;
  input: unknown;
  timeoutMs: number;
  /** 用户动作优先于刷新 */
  priority: 'action' | 'read';
}

/** 执行一个进程（不排队）。导出给 `trine-agent ext test` 直接用 */
export async function runProcess(
  request: Omit<RunRequest, 'ext' | 'priority'>,
  options: { env?: NodeJS.ProcessEnv; now?: () => number; killGraceMs?: number; signal?: AbortSignal } = {},
): Promise<RunResult> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const done = (r: Omit<Extract<RunResult, { ok: false }>, 'durationMs'> | Omit<Extract<RunResult, { ok: true }>, 'durationMs'>): RunResult =>
    ({ ...r, durationMs: now() - started }) as RunResult;

  const payload = JSON.stringify(request.input);
  if (Buffer.byteLength(payload) > MAX_STDIN_BYTES) {
    return done({ ok: false, code: 'io', message: '输入过大', stderr: '' });
  }
  try {
    if (!(await stat(request.cwd)).isDirectory()) throw new Error('不是目录');
  } catch (err) {
    return done({ ok: false, code: 'not_found', message: `工作目录不可用：${request.cwd}（${(err as Error).message}）`, stderr: '' });
  }

  const [program, ...args] = request.argv;
  if (program === undefined) return done({ ok: false, code: 'io', message: 'entry 为空', stderr: '' });

  let child: ChildProcess;
  try {
    child = spawn(program, [...args, request.op], {
      cwd: request.cwd,
      env: extensionEnv(options.env ?? process.env, request.dir),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (err) {
    return done({ ok: false, code: 'io', message: `启动扩展失败：${(err as Error).message}`, stderr: '' });
  }

  return new Promise<RunResult>((resolvePromise) => {
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = '';
    let settled = false;
    let failure: { code: RunFailureCode; message: string } | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (): void => {
      if (child.pid === undefined) return;
      signalGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (child.pid !== undefined) signalGroup(child.pid, 'SIGKILL');
      }, options.killGraceMs ?? KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const fail = (code: RunFailureCode, message: string): void => {
      if (failure !== undefined) return;
      failure = { code, message };
      killGroup();
    };

    const timer = setTimeout(() => fail('timeout', `扩展超过 ${request.timeoutMs}ms 没有返回`), request.timeoutMs);
    timer.unref?.();
    // agent 退出：杀掉整组，不留下继续运行的扩展进程
    const onAbort = (): void => {
      // 退出流程等不了宽限期：直接 SIGKILL 整组
      if (failure === undefined) failure = { code: 'io', message: 'agent 正在退出' };
      if (child.pid !== undefined) signalGroup(child.pid, 'SIGKILL');
    };
    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (failure !== undefined) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail('output_limit', `扩展输出超过 ${MAX_STDOUT_BYTES} 字节`);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR_TAIL);
    });
    child.stdin?.on('error', () => {
      // 扩展不读 stdin 就退出时写入会 EPIPE：以退出码为准
    });
    child.on('error', (err) => fail('io', `扩展进程出错：${err.message}`));
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      // 主进程退了，组里可能还有它起的子进程：收拾掉
      if (child.pid !== undefined) signalGroup(child.pid, 'SIGKILL');
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (failure !== undefined) {
        resolvePromise(done({ ok: false, ...failure, stderr: stderrTail }));
        return;
      }
      if (code !== 0) {
        resolvePromise(
          done({ ok: false, code: 'invalid_output', message: `扩展退出码 ${code ?? signal ?? '?'}`, stderr: stderrTail }),
        );
        return;
      }
      const text = Buffer.concat(stdout).toString('utf8').trim();
      try {
        resolvePromise(done({ ok: true, output: JSON.parse(text), stderr: stderrTail }));
      } catch {
        resolvePromise(done({ ok: false, code: 'invalid_output', message: '扩展输出不是单个合法 JSON', stderr: stderrTail }));
      }
    });
    child.stdin?.end(payload);
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // 组已经没了
  }
}

export function extensionEnv(source: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOW) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('LC_') && value !== undefined) env[key] = value;
  }
  env.PATH = trustedPath(source.PATH);
  env.TRINE_EXT_API = '1';
  env.TRINE_EXT_DIR = dir;
  return env;
}

interface Waiter {
  request: RunRequest;
  enqueuedAt: number;
  resolve: (result: RunResult) => void;
}

/** 排队、并发上限与优先级 */
export class ExtensionRunner {
  readonly #run: typeof runProcess;
  readonly #now: () => number;
  readonly #running = new Map<string, number>();
  #globalRunning = 0;
  readonly #queue: Waiter[] = [];
  readonly #abort = new AbortController();

  constructor(options: { run?: typeof runProcess; now?: () => number } = {}) {
    this.#run = options.run ?? runProcess;
    this.#now = options.now ?? (() => Date.now());
  }

  /** agent 退出：杀掉在跑的进程组，排队的全部以 busy 结束 */
  dispose(): void {
    this.#abort.abort();
    for (const waiter of this.#queue.splice(0)) {
      waiter.resolve({ ok: false, code: 'busy', message: 'agent 正在退出', stderr: '', durationMs: 0 });
    }
  }

  run(request: RunRequest): Promise<RunResult> {
    if (this.#abort.signal.aborted) {
      return Promise.resolve({ ok: false, code: 'busy', message: 'agent 正在退出', stderr: '', durationMs: 0 });
    }
    const queued = this.#queue.filter((w) => w.request.ext === request.ext).length;
    if (queued >= PER_EXT_QUEUE) {
      return Promise.resolve({ ok: false, code: 'busy', message: '扩展请求排队过多，请稍后再试', stderr: '', durationMs: 0 });
    }
    return new Promise<RunResult>((resolve) => {
      const waiter: Waiter = { request, enqueuedAt: this.#now(), resolve };
      // 用户动作插到第一个刷新请求前面
      if (request.priority === 'action') {
        const index = this.#queue.findIndex((w) => w.request.priority === 'read');
        if (index === -1) this.#queue.push(waiter);
        else this.#queue.splice(index, 0, waiter);
      } else {
        this.#queue.push(waiter);
      }
      this.#pump();
      // 排队期限要有人来检查：没有新请求进来时也按时报 busy
      const deadline = setTimeout(() => this.#pump(), QUEUE_DEADLINE_MS + 1);
      (deadline as { unref?: () => void }).unref?.();
    });
  }

  #pump(): void {
    // 先清掉排队超时的（不管有没有空位，都要按时报 busy）
    for (let i = 0; i < this.#queue.length; ) {
      const waiter = this.#queue[i]!;
      if (this.#now() - waiter.enqueuedAt > QUEUE_DEADLINE_MS) {
        this.#queue.splice(i, 1);
        waiter.resolve({ ok: false, code: 'busy', message: '扩展忙，排队超时', stderr: '', durationMs: 0 });
      } else {
        i++;
      }
    }
    for (let i = 0; i < this.#queue.length; ) {
      const waiter = this.#queue[i]!;
      if (this.#globalRunning >= GLOBAL_CONCURRENCY) return;
      const ext = waiter.request.ext;
      if ((this.#running.get(ext) ?? 0) >= PER_EXT_CONCURRENCY) {
        i++;
        continue;
      }
      this.#queue.splice(i, 1);
      this.#globalRunning++;
      this.#running.set(ext, (this.#running.get(ext) ?? 0) + 1);
      const { ext: _ext, priority: _priority, ...processRequest } = waiter.request;
      void this.#run(processRequest, { signal: this.#abort.signal })
        .catch((err: unknown): RunResult => ({
          ok: false,
          code: 'io',
          message: err instanceof Error ? err.message : String(err),
          stderr: '',
          durationMs: 0,
        }))
        .then((result) => {
          this.#globalRunning--;
          this.#running.set(ext, (this.#running.get(ext) ?? 1) - 1);
          waiter.resolve(result);
          this.#pump();
        });
    }
  }
}

/**
 * 斜杠命令探测：不拉起会话、不发消息，拿某个 cwd 下可用的命令清单。
 *
 * 背景：`session.capabilities` 只在会话的 SDK query 起来（首条消息）时由
 * system/init 翻译而来，web 刷新 / agent 重启后打开会话、发消息前斜杠菜单是空的。
 * 这里按 cwd 起一个**不发任何消息**的 query——prompt 是一个永不 yield 的
 * AsyncIterable，CLI 完成初始化握手后即可应答 `supportedCommands()` 控制请求，
 * 拿到 `{name, description, argumentHint}[]` 就立刻关进程。不发消息就不会有
 * 转录；另外显式 `persistSession: false` 双保险，不在 ~/.claude/projects 留文件。
 *
 * options 与 session.ts #startQuery 对齐（systemPrompt preset + settingSources
 * 三级 + 同一个本机 claude 可执行文件）：命令清单来自 settings / skills /
 * plugins 的发现逻辑，配置不对齐就会和真正会话里看到的不一致。
 *
 * - 按 cwd 缓存 TTL（默认 10 分钟）；失败不缓存
 * - 同 cwd 单飞：并发请求共用一个 promise
 * - 超时（默认 20s）：abort + close 子进程后 reject
 * - 无论成败都 abort + close，不泄漏子进程
 */
import { query, type Options, type SlashCommand as SdkSlashCommand } from '@anthropic-ai/claude-agent-sdk';

export const COMMANDS_CACHE_TTL_MS = 10 * 60 * 1000;
export const COMMANDS_PROBE_TIMEOUT_MS = 20_000;

export interface CommandsProbeOptions {
  /** 本机 claude；undefined = SDK 内置（与会话一致） */
  pathToClaudeCodeExecutable?: string;
  /** 注入 query（测试用），默认走 SDK */
  queryFn?: typeof query;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

interface CacheEntry {
  at: number;
  commands: SdkSlashCommand[];
}

export class CommandsProbe {
  readonly #queryFn: typeof query;
  readonly #claudeExecutable: string | undefined;
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<SdkSlashCommand[]>>();
  /** 在跑的探测的 abort 句柄（dispose 时统一收掉） */
  readonly #aborts = new Set<AbortController>();

  constructor(options: CommandsProbeOptions = {}) {
    this.#queryFn = options.queryFn ?? query;
    this.#claudeExecutable = options.pathToClaudeCodeExecutable;
    this.#ttlMs = options.ttlMs ?? COMMANDS_CACHE_TTL_MS;
    this.#timeoutMs = options.timeoutMs ?? COMMANDS_PROBE_TIMEOUT_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.log ?? (() => {});
  }

  /** 取 cwd 下的命令清单：命中缓存直接返回；否则探测（同 cwd 单飞）。失败 reject */
  commands(cwd: string): Promise<SdkSlashCommand[]> {
    const hit = this.#cache.get(cwd);
    if (hit !== undefined && this.#now() - hit.at < this.#ttlMs) return Promise.resolve(hit.commands);
    const running = this.#inflight.get(cwd);
    if (running !== undefined) return running;

    const promise = this.#probe(cwd).then(
      (commands) => {
        this.#cache.set(cwd, { at: this.#now(), commands });
        return commands;
      },
      (err: unknown) => {
        this.#log(`[commands] 探测失败 cwd=${cwd}: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      },
    );
    this.#inflight.set(cwd, promise);
    void promise.then(
      () => this.#inflight.delete(cwd),
      () => this.#inflight.delete(cwd),
    );
    return promise;
  }

  /** 关掉所有在跑的探测（进程退出） */
  dispose(): void {
    for (const abort of this.#aborts) abort.abort();
    this.#aborts.clear();
  }

  async #probe(cwd: string): Promise<SdkSlashCommand[]> {
    const abort = new AbortController();
    this.#aborts.add(abort);
    const options: Options = {
      // —— 与 session.ts #startQuery 对齐（CLAUDE.md 硬约束）——
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      ...(this.#claudeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.#claudeExecutable }),
      cwd,
      abortController: abort,
      // 不发消息本就不会有转录，这里再显式关持久化做双保险
      persistSession: false,
    };
    const q = this.#queryFn({ prompt: idleInput(abort.signal), options });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`supportedCommands 超时（${this.#timeoutMs}ms）`)),
          this.#timeoutMs,
        );
      });
      return await Promise.race([q.supportedCommands(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.#aborts.delete(abort);
      // abort 让输入流结束并通知 SDK 收子进程；close 强制清理（两者都做，互为兜底）
      abort.abort();
      try {
        q.close();
      } catch {
        // 已关闭 / 进程已退出，无所谓
      }
    }
  }
}

/**
 * 永不 yield 的输入流：next() 挂起直到 signal abort，然后正常结束。
 * 让 CLI 以流式输入模式起来（控制请求需要它），却一条用户消息也收不到。
 */
export function idleInput(signal: AbortSignal): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<never> {
      const done = (): IteratorResult<never> => ({ value: undefined as never, done: true });
      return {
        next(): Promise<IteratorResult<never>> {
          if (signal.aborted) return Promise.resolve(done());
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve(done()), { once: true });
          });
        },
        return(): Promise<IteratorResult<never>> {
          return Promise.resolve(done());
        },
      };
    },
  };
}

/**
 * 检查 claude 最新版本（claude-latest）：不安装，只查发布源上的版本号，供 web 与
 * claudeVersion 比较、提示「有新版本」。
 *
 * ## 查哪里
 *
 * claude 原生安装的自更新查的是 `downloads.claude.ai/claude-code-releases/<channel>`，
 * 返回体就是一个版本号（如 `2.1.308`）。这里查同一个地址，所以「有新版本」与
 * `claude update` 会装上的版本一致。渠道取 claude settings 的 `autoUpdatesChannel`
 * （`latest` | `stable`，默认 latest），每次检查都重读——用户可能在终端里改了。
 * npm / Homebrew 安装的 claude 由包管理器更新，版本发布可能晚一点，仍按同一个源提示。
 *
 * ## 什么时候查
 *
 * - 自动：`startAuto()` 后约 30 秒查一次，之后每 6 小时一次（只在 cli 里开，测试不开、
 *   不碰网络）。claude 自己关了非必要流量或自动更新（`DISABLE_AUTOUPDATER` /
 *   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`）时不自动查，与 claude 的选择一致。
 * - 手动：`machine.claude.check.request` → `check()`。
 *
 * 单飞：进行中再来的请求共用同一次查询的结果。代理变量由 Bun 的 fetch 自己读环境变量。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MachineClaudeLatest } from '@trine/core';

export const CLAUDE_RELEASES_BASE = 'https://downloads.claude.ai/claude-code-releases';
/** 自动检查的间隔 */
export const CLAUDE_LATEST_INTERVAL_MS = 6 * 60 * 60_000;
/** 启动后第一次自动检查的延迟：别和接入、会话恢复抢 */
export const CLAUDE_LATEST_FIRST_DELAY_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export type ClaudeUpdateChannel = MachineClaudeLatest['channel'];

export type ClaudeCheckOutcome =
  | { ok: true; version: string; channel: ClaudeUpdateChannel }
  | { ok: false; message: string };

/** claude 的配置目录：`CLAUDE_CONFIG_DIR`，否则 `~/.claude` */
export function claudeConfigDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir !== undefined && dir !== '' ? dir : join(homedir(), '.claude');
}

/** 读 `<configDir>/settings.json` 的 autoUpdatesChannel；读不到 / 不认识 → latest */
export async function readUpdateChannel(configDir: string): Promise<ClaudeUpdateChannel> {
  try {
    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8')) as {
      autoUpdatesChannel?: unknown;
    };
    return settings.autoUpdatesChannel === 'stable' ? 'stable' : 'latest';
  } catch {
    return 'latest';
  }
}

/** 环境里关了自动更新 / 非必要流量 → 不自动检查（手动仍可） */
export function autoCheckDisabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const on = (v: string | undefined): boolean => v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  return on(env.DISABLE_AUTOUPDATER) || on(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC);
}

/**
 * 查一次发布源。
 * @throws 网络错误 / 超时 / 非 2xx / 返回体不是版本号
 */
export async function fetchLatestClaudeVersion(
  channel: ClaudeUpdateChannel,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(`${CLAUDE_RELEASES_BASE}/${channel}`, {
    signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`发布源返回 HTTP ${res.status}`);
  const text = (await res.text()).trim();
  if (!VERSION_RE.test(text)) throw new Error('发布源返回的不是版本号');
  return text;
}

export interface ClaudeLatestCheckerOptions {
  /** 状态变了（查到新结果 / 失败原因变了）：app 广播 machine.info */
  onChange?: () => void;
  fetchImpl?: typeof fetch;
  /** claude 配置目录（读渠道）；默认 claudeConfigDir() */
  configDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  log?: (line: string) => void;
}

export class ClaudeLatestChecker {
  readonly #opts: ClaudeLatestCheckerOptions;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  #state: MachineClaudeLatest = { channel: 'latest' };
  #inflight: Promise<ClaudeCheckOutcome> | undefined = undefined;
  #timer: ReturnType<typeof setTimeout> | undefined = undefined;
  #disposed = false;

  constructor(options: ClaudeLatestCheckerOptions = {}) {
    this.#opts = options;
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.log ?? (() => {});
  }

  /** 当前状态（放进 machine.info.claudeLatest） */
  get current(): MachineClaudeLatest {
    return this.#state;
  }

  /** 查一次；进行中则共用。不抛 */
  check(): Promise<ClaudeCheckOutcome> {
    this.#inflight ??= this.#run().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  /** 开始自动检查（见文件头）；环境里关了就不开 */
  startAuto(firstDelayMs = CLAUDE_LATEST_FIRST_DELAY_MS, intervalMs = CLAUDE_LATEST_INTERVAL_MS): void {
    if (this.#disposed || this.#timer !== undefined) return;
    if (autoCheckDisabled(this.#opts.env)) {
      this.#log('[claude] 环境里关了自动更新 / 非必要流量，不自动检查最新版本');
      return;
    }
    const tick = (delay: number): void => {
      this.#timer = setTimeout(() => {
        void this.check().finally(() => {
          if (!this.#disposed) tick(intervalMs);
        });
      }, delay);
      (this.#timer as { unref?: () => void }).unref?.();
    };
    tick(firstDelayMs);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async #run(): Promise<ClaudeCheckOutcome> {
    const channel = await readUpdateChannel(this.#opts.configDir ?? claudeConfigDir(this.#opts.env));
    let outcome: ClaudeCheckOutcome;
    try {
      const version = await fetchLatestClaudeVersion(
        channel,
        this.#opts.fetchImpl === undefined ? {} : { fetchImpl: this.#opts.fetchImpl },
      );
      outcome = { ok: true, version, channel };
      this.#state = { channel, version, checkedAt: this.#now() };
    } catch (err) {
      const message = `检查 claude 最新版本失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
      outcome = { ok: false, message };
      // 失败保留上次查到的版本（仍有参考价值），只是渠道变了就不能再用
      const keep = this.#state.channel === channel ? this.#state : { channel };
      this.#state = {
        channel,
        ...(keep.version === undefined ? {} : { version: keep.version }),
        ...(keep.checkedAt === undefined ? {} : { checkedAt: keep.checkedAt }),
        error: message,
      };
      this.#log(`[claude] ${message}`);
    }
    if (!this.#disposed) this.#opts.onChange?.();
    return outcome;
  }
}

/**
 * 订阅限额用量（5 小时 / 7 天）的汇总与手动刷新（usage-display）。
 *
 * 限额是**账号级**数据：机器上所有会话共用一份，挂在 `machine.info.rateLimits` 上。
 *
 * - 自动：会话活动时 CLI 每次 API 请求都发 `rate_limit_event`（解析见 bridge/usage.ts），
 *   经 manager 汇到 `apply`。值变了才广播 machine.info；值不变但距上次广播超过
 *   `REBROADCAST_MS` 也广播一次，让 web 上的「更新于」不至于一直停在很久以前。
 * - 手动（`machine.usage.request`）：`refresh` 优先借活跃会话的 query 调 SDK 的 usage
 *   接口；没有活跃子进程才临时起一个不发消息的 claude（不占会话名额、带超时、用完即
 *   关）。起进程有开销，所以只给手动刷新用，不做定时轮询（用户决定）。单飞。
 *
 * 不落盘：agent 重启后要等下一次会话活动或手动刷新才有数据。
 */
import { tmpdir } from 'node:os';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { RateLimits, RateLimitWindow, UsageErrorCode } from '@trine/core';
import { idleInput } from '../bridge/idle-input.ts';
import { planUsageFrom, type RateLimitPatch } from '../bridge/usage.ts';

export const PLAN_USAGE_TIMEOUT_MS = 30_000;
/** 值没变时也重新广播的间隔 */
export const REBROADCAST_MS = 5 * 60 * 1000;

export type PlanUsageRefreshOutcome = { ok: true } | { ok: false; code: UsageErrorCode; message: string };

export interface PlanUsageTrackerOptions {
  /** 借活跃会话查 usage（manager.planUsage）；undefined = 没有活跃子进程 */
  liveUsage: () => Promise<unknown> | undefined;
  /** 用量有变化（或该重新广播了），app 据此广播 machine.info */
  onChange: () => void;
  /** 本机 claude；undefined = SDK 内置 */
  pathToClaudeCodeExecutable?: string;
  /** 注入 query（测试用），默认走 SDK */
  queryFn?: typeof query;
  timeoutMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

function sameWindow(a: RateLimitWindow | undefined, b: RateLimitWindow | undefined): boolean {
  return a?.percent === b?.percent && a?.resetsAt === b?.resetsAt;
}

export class PlanUsageTracker {
  readonly #liveUsage: () => Promise<unknown> | undefined;
  readonly #onChange: () => void;
  readonly #claudeExecutable: string | undefined;
  readonly #queryFn: typeof query;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  #current: RateLimits | undefined = undefined;
  #lastBroadcastAt = 0;
  #refreshing: Promise<PlanUsageRefreshOutcome> | undefined = undefined;
  readonly #aborts = new Set<AbortController>();

  constructor(options: PlanUsageTrackerOptions) {
    this.#liveUsage = options.liveUsage;
    this.#onChange = options.onChange;
    this.#claudeExecutable = options.pathToClaudeCodeExecutable;
    this.#queryFn = options.queryFn ?? query;
    this.#timeoutMs = options.timeoutMs ?? PLAN_USAGE_TIMEOUT_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.log ?? (() => {});
  }

  /** 当前已知的用量；还没拿到 / 账号没有订阅限额时 undefined */
  get current(): RateLimits | undefined {
    return this.#current;
  }

  /** 合并一次更新（只覆盖这次带了的窗口）；force = 无论变没变都广播 */
  apply(patch: RateLimitPatch, force = false): void {
    const previous = this.#current;
    const fiveHour = patch.fiveHour ?? previous?.fiveHour;
    const sevenDay = patch.sevenDay ?? previous?.sevenDay;
    const now = this.#now();
    this.#current = {
      ...(fiveHour === undefined ? {} : { fiveHour }),
      ...(sevenDay === undefined ? {} : { sevenDay }),
      updatedAt: now,
    };
    const changed =
      previous === undefined || !sameWindow(previous.fiveHour, fiveHour) || !sameWindow(previous.sevenDay, sevenDay);
    if (!force && !changed && now - this.#lastBroadcastAt < REBROADCAST_MS) return;
    this.#lastBroadcastAt = now;
    this.#onChange();
  }

  /** 手动刷新（单飞）。不抛：失败以 outcome 表达 */
  refresh(): Promise<PlanUsageRefreshOutcome> {
    if (this.#refreshing !== undefined) return this.#refreshing;
    const task = this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    this.#refreshing = task;
    return task;
  }

  /** 关掉在跑的临时进程（agent 退出） */
  dispose(): void {
    for (const abort of this.#aborts) abort.abort();
    this.#aborts.clear();
  }

  async #refresh(): Promise<PlanUsageRefreshOutcome> {
    let response: unknown;
    try {
      const live = this.#liveUsage();
      response = live === undefined ? await this.#probe() : await this.#withTimeout(live);
    } catch (err) {
      const message = `查询用量失败：${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
      this.#log(`[usage] ${message}`);
      return { ok: false, code: 'failed', message };
    }
    const parsed = planUsageFrom(response);
    if (parsed === undefined) {
      this.#log('[usage] 用量应答的形状不认识（SDK 的 usage 接口可能变了）');
      return { ok: false, code: 'failed', message: '用量数据的格式不认识，可能是 Claude Code 版本变化导致' };
    }
    if (!parsed.available) {
      if (this.#current !== undefined) {
        this.#current = undefined;
        this.#onChange();
      }
      return { ok: false, code: 'unavailable', message: '当前账号没有订阅限额（API key / Bedrock / Vertex 等）' };
    }
    this.apply(parsed.limits, true);
    return { ok: true };
  }

  #withTimeout<T>(pending: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`超时（${this.#timeoutMs}ms）`)), this.#timeoutMs);
    });
    return Promise.race([pending, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  /** 临时起一个不发消息的 claude 查 usage（带超时）；无论成败都关进程 */
  async #probe(): Promise<unknown> {
    const abort = new AbortController();
    this.#aborts.add(abort);
    const options: Options = {
      ...(this.#claudeExecutable === undefined ? {} : { pathToClaudeCodeExecutable: this.#claudeExecutable }),
      // 账号级数据与目录无关：用临时目录，不加载任何项目的设置
      cwd: tmpdir(),
      abortController: abort,
      persistSession: false,
    };
    const q = this.#queryFn({ prompt: idleInput(abort.signal), options });
    try {
      return await this.#withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET());
    } finally {
      this.#aborts.delete(abort);
      abort.abort();
      try {
        q.close();
      } catch {
        // 已关闭 / 进程已退出
      }
    }
  }
}

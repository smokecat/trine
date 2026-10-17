/**
 * 运行心跳（协议决策点 4：agent 周期发，2-5s，**仅运行中**）。
 *
 * 解决的是长任务的「看起来死掉了」焦虑——这是 feishu-claude-code 用户最买账的
 * 功能。footer 展示 `⏱ 总时长 · 🔧 当前工具+耗时 · ⚠️ 无输出 N 秒`，
 * 三个数据全部来自本模块维护的计时。
 *
 * ## 为什么由 agent 发而不是 client 本地推算
 *
 * client 本地推算更省流量，但「无输出 N 秒」在断连时会失真：client 分不清
 * 「Claude 真的卡住了」和「我掉线了」。agent 发心跳则两者可区分——
 * 心跳本身断了就是链路问题。
 *
 * ## 「仅运行中发」包含等待权限
 *
 * 协议给心跳定义了 `phase: run|tool|wait` 三档，其中 `wait` 就是「等人批权限」。
 * 所以 `waiting_permission` 期间**继续发**心跳——否则 `wait` 这一档永远不可达，
 * 而且权限卡上的「已等待 N 秒」会在最需要它的时候冻住（决策点 2：权限超时
 * 只计时不自动拒绝，那个计时正需要心跳来驱动）。
 * 真正停发的只有 run 结束之后（idle/error/stopped）。
 *
 * ## 生命周期
 *
 * `start()` 开始计时并起定时器，`stop()` 停。定时器用 unref（Bun/Node 都支持）
 * 避免拖住进程退出。
 */
import type { RunPhase } from '@trine/core';
import type { EventBody } from './types.ts';

/** 当前在跑的工具，心跳里展示 */
export interface HeartbeatTool {
  toolUseId: string;
  name: string;
  startedAt: number;
}

export interface HeartbeatOptions {
  emit: (body: EventBody) => void;
  /** 心跳间隔（毫秒）；协议给的区间是 2000-5000 */
  intervalMs?: number;
  now?: () => number;
  /** 定时器注入，测试用假时钟 */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const DEFAULT_INTERVAL_MS = 3000;

/**
 * 收成协议要求的非负整数毫秒。
 *
 * `RunHeartbeatSchema` 的三个时长字段都是 `z.number().int().nonnegative()`，
 * 而注入的 `now()` 不保证返回整数（比如换成 performance.now()）。不取整会让
 * 整帧被 client 的 schema 拒掉。
 */
function ms(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/**
 * 单会话的心跳发生器。
 */
export class Heartbeat {
  readonly #emit: (body: EventBody) => void;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #setInterval: (fn: () => void, ms: number) => unknown;
  readonly #clearInterval: (handle: unknown) => void;

  #handle: unknown = undefined;
  #runStartedAt = 0;
  /** 最近一次「有输出」的时刻，算 silentMs 用 */
  #lastActivityAt = 0;
  #currentTool: HeartbeatTool | undefined = undefined;
  #phase: RunPhase = 'run';

  constructor(options: HeartbeatOptions) {
    this.#emit = options.emit;
    this.#intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#setInterval =
      options.setInterval ??
      ((fn, ms) => {
        const handle = setInterval(fn, ms);
        // 心跳不该拖住进程退出
        (handle as { unref?: () => void }).unref?.();
        return handle;
      });
    this.#clearInterval =
      options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  get running(): boolean {
    return this.#handle !== undefined;
  }

  /** run 开始：重置计时并起定时器 */
  start(): void {
    if (this.#handle !== undefined) return;
    const now = this.#now();
    this.#runStartedAt = now;
    this.#lastActivityAt = now;
    this.#currentTool = undefined;
    this.#phase = 'run';
    this.#handle = this.#setInterval(() => this.tick(), this.#intervalMs);
  }

  /** run 结束：停表。停止后不再发心跳（协议：仅运行中发） */
  stop(): void {
    if (this.#handle === undefined) return;
    this.#clearInterval(this.#handle);
    this.#handle = undefined;
    this.#currentTool = undefined;
  }

  /** 有任何输出（文本增量/工具事件）时调用，重置「无输出」计时 */
  noteActivity(): void {
    this.#lastActivityAt = this.#now();
  }

  /** 工具开始：心跳进入 tool 阶段 */
  noteToolStart(toolUseId: string, name: string): void {
    this.#currentTool = { toolUseId, name, startedAt: this.#now() };
    this.#phase = 'tool';
    this.noteActivity();
  }

  /** 工具结束：回到 run 阶段 */
  noteToolEnd(toolUseId: string): void {
    if (this.#currentTool?.toolUseId === toolUseId) {
      this.#currentTool = undefined;
      this.#phase = 'run';
    }
    this.noteActivity();
  }

  /** 进入等待权限阶段（心跳 phase 变 wait，UI 可显示「等你批准」） */
  setPhase(phase: RunPhase): void {
    this.#phase = phase;
  }

  /** 立即发一帧心跳（定时器回调，也可手工触发） */
  tick(): void {
    const now = this.#now();
    const tool = this.#currentTool;
    this.#emit({
      type: 'run.heartbeat',
      runElapsedMs: ms(now - this.#runStartedAt),
      silentMs: ms(now - this.#lastActivityAt),
      phase: this.#phase,
      ...(tool === undefined
        ? {}
        : {
            currentTool: {
              toolUseId: tool.toolUseId,
              name: tool.name,
              elapsedMs: ms(now - tool.startedAt),
            },
          }),
    });
  }

  /** 本 run 已进行的毫秒数（run.done 兜底用） */
  elapsedMs(): number {
    return ms(this.#now() - this.#runStartedAt);
  }
}

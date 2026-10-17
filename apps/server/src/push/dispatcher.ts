/**
 * 推送分发器：判定是否该推 → 渲染脱敏文案 → 投给各渠道。
 *
 * ## 绝不阻塞主链路
 *
 * `dispatch()` 是同步返回的 void：判定与渲染都是纯内存操作，真正的 HTTP
 * 投递是 fire-and-forget。中转链路（hub 的帧处理路径）**从不 await 推送**
 * ——一个挂掉的 Bark 端点不该拖垮消息转发（这正是 feishu-claude-code 的
 * 「推送无超时永久定格」坑）。渠道自己负责超时（见 bark.ts）。
 *
 * ## 两道抑制闸门
 *
 * 1. **在线抑制**（默认开）：该机器有任意在线 client 连接时不推——人正
 *    盯着屏幕，再响一声只是噪音。env 可关。
 * 2. **去抖**：同一 (machineId, sessionId, hint) 在窗口内只推一次。权限
 *    请求可以在几秒内连发十几条（每个工具调用一次），不去抖就是刷屏。
 *    分桶带 sessionId：两个会话同时要权限是两件事，都该通知。
 */
import { renderPushMessage } from './text.ts';
import type { PushChannel, PushEvent } from './types.ts';

export interface DispatcherOptions {
  /** 在线抑制：该 machineId 有在线 client 时跳过推送。默认由调用方传入 */
  suppressWhenOnline: boolean;
  /** 查询该机器是否有在线 client（注册表注入，便于测试） */
  hasOnlineClient: (machineId: string) => boolean;
  /** 去抖窗口毫秒；0 表示关闭去抖 */
  dedupeWindowMs: number;
  /** 机器标识别名映射（用户知情配置的明文名） */
  aliases: Readonly<Record<string, string>>;
  now?: () => number;
  onError?: (channel: string, err: unknown) => void;
  log?: (line: string) => void;
}

/** 判定结果，供测试与日志观察（不含任何 E2E 内容） */
export type DispatchOutcome =
  | { kind: 'sent'; channels: number }
  | { kind: 'skipped'; reason: 'no_channel' | 'client_online' | 'deduped' };

const DEFAULT_OPTIONS = {
  suppressWhenOnline: true,
  hasOnlineClient: () => false,
  dedupeWindowMs: 30_000,
  aliases: {} as Record<string, string>,
} satisfies Partial<DispatcherOptions>;

/** 去抖表的清理阈值：条目多到这个数就顺手扫一遍过期项 */
const DEDUPE_SWEEP_THRESHOLD = 256;

export class PushDispatcher {
  private readonly channels: PushChannel[] = [];
  private readonly options: DispatcherOptions;
  private readonly now: () => number;
  private readonly onError: (channel: string, err: unknown) => void;
  /** 去抖记录：key = machineId|sessionId|hint → 上次推送时刻 */
  private readonly lastSentAt = new Map<string, number>();

  constructor(options: Partial<DispatcherOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.now = this.options.now ?? (() => Date.now());
    this.onError = this.options.onError ?? (() => {});
  }

  register(channel: PushChannel): void {
    this.channels.push(channel);
  }

  get channelNames(): string[] {
    return this.channels.map((c) => c.name);
  }

  get enabled(): boolean {
    return this.channels.length > 0;
  }

  /**
   * 触发推送。**同步返回**，投递异步进行——主链路不等推送。
   * 返回判定结果只为可观测性，调用方可以忽略。
   */
  dispatch(event: PushEvent): DispatchOutcome {
    if (this.channels.length === 0) {
      // 没配任何渠道 = 推送整体禁用，连去抖状态都不必记
      return { kind: 'skipped', reason: 'no_channel' };
    }

    if (
      this.options.suppressWhenOnline &&
      this.options.hasOnlineClient(event.machineId)
    ) {
      // 人在线：不推，也**不记去抖**——否则人一下线，本该推的第一条
      // 事件会被刚才那条「被抑制的」记录压掉
      return { kind: 'skipped', reason: 'client_online' };
    }

    if (this.isDeduped(event)) {
      return { kind: 'skipped', reason: 'deduped' };
    }

    const message = renderPushMessage(event, this.options.aliases);
    // 整个投递循环包一层：约定上渠道不得同步抛出，但真抛了也只能到此为止。
    // 调用链一路上溯是 hub.handleRelay ← server.ts 的 websocket.message()，
    // 那里没有 try/catch——一个渠道的同步异常会打穿到 WS 消息处理器。
    try {
      for (const channel of this.channels) {
        // 不 await：主链路不等 HTTP
        channel.send(message).catch((err) => {
          // onError 自身也可能抛（console 在 fd 异常时会抛），
          // 而这是在 Promise 的 catch 里——抛出去就是 unhandled rejection
          try {
            this.onError(channel.name, err);
          } catch {
            // 连报错都报不出来，只能咽下：推送是旁路，不值得升级成崩溃
          }
        });
      }
    } catch (err) {
      try {
        this.onError('dispatch', err);
      } catch {
        // 同上
      }
    }
    return { kind: 'sent', channels: this.channels.length };
  }

  /** 去抖判定；未命中则登记本次时刻 */
  private isDeduped(event: PushEvent): boolean {
    const window = this.options.dedupeWindowMs;
    if (window <= 0) return false;

    const now = this.now();
    const key = `${event.machineId}\u0000${event.sessionId ?? ''}\u0000${event.hint}`;
    const last = this.lastSentAt.get(key);
    if (last !== undefined && now - last < window) return true;

    this.lastSentAt.set(key, now);
    if (this.lastSentAt.size > DEDUPE_SWEEP_THRESHOLD) this.sweepDedupe(now);
    return false;
  }

  /** 清掉窗口外的去抖记录，防长期运行下 Map 无限增长 */
  private sweepDedupe(now: number): void {
    for (const [key, at] of this.lastSentAt) {
      if (now - at >= this.options.dedupeWindowMs) this.lastSentAt.delete(key);
    }
  }
}

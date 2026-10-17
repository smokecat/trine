/**
 * Bark 渠道（D6 的 MVP 实现）：HTTP 直推到 Bark 服务器（官方 api.day.app
 * 或自建 bark-server）。
 *
 * ## 请求形态
 *
 * 用 `POST <server>/push` + JSON body，而不是路径式的
 * `GET <server>/<key>/<title>/<body>`——路径式要求把文案 URL 编码塞进路径，
 * 中文与斜杠都得转义，且 device key 会进 URL（更容易被反代访问日志记下）。
 * POST 形式是 Bark 官方支持的等价接口，body 里带 `device_key`。
 *
 * ## 超时与重试（规避「推送无超时永久定格」）
 *
 * 每次请求 5s 硬超时（AbortSignal.timeout）；失败按 1s / 3s 退避重试 2 次，
 * 仍失败就记日志丢弃。推送是尽力而为的旁路，**永远不是主链路的一部分**。
 *
 * 4xx 不重试：device key 写错、请求体不合法这类问题重试多少次都是错的，
 * 只是白白拖住重试队列。5xx 与网络错误才重试。
 */
import type { PushChannel, PushMessage } from './types.ts';

/**
 * 「别再重试了」的信号，靠类型传递而不是错误消息文本。
 *
 * 曾经这里是 `err.message.includes('不重试')`——那意味着任何碰巧带上这三
 * 个字的错误（自建 bark-server 的中文错误页、企业代理的中文报错）都会被
 * 当成不可重试而静默放弃。判据必须是我们自己立的类型，不能是对端可控的文本。
 */
export class NonRetryableError extends Error {
  override readonly name = 'NonRetryableError';
}

export interface BarkOptions {
  /** Bark 服务器根地址，如 https://api.day.app 或自建地址 */
  serverUrl: string;
  /** 设备 key（凭据，绝不入日志） */
  deviceKey: string;
  /** 单次请求超时 */
  timeoutMs?: number;
  /** 重试退避序列（毫秒），长度 = 重试次数 */
  retryDelaysMs?: readonly number[];
  /** 注入点：测试替换 fetch */
  fetchImpl?: typeof fetch;
  /** 注入点：测试替换 sleep，避免真睡 */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export const BARK_DEFAULTS = {
  timeoutMs: 5_000,
  retryDelaysMs: [1_000, 3_000] as readonly number[],
} as const;

export class BarkChannel implements PushChannel {
  readonly name = 'bark';

  private readonly endpoint: string;
  private readonly deviceKey: string;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(options: BarkOptions) {
    this.endpoint = `${options.serverUrl.replace(/\/+$/, '')}/push`;
    this.deviceKey = options.deviceKey;
    this.timeoutMs = options.timeoutMs ?? BARK_DEFAULTS.timeoutMs;
    this.retryDelaysMs = options.retryDelaysMs ?? BARK_DEFAULTS.retryDelaysMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? (() => {});
  }

  /**
   * 构造 Bark 请求体。
   *
   * **脱敏自查点**：这里出现的每个字段都只来自 `PushMessage`（机器标识 +
   * 事件类型固定文案）或本渠道的常量。刻意不接收 `PushEvent`——连
   * sessionId 这样的路由字段都拿不到，也就不可能顺手塞进去。
   */
  buildPayload(message: PushMessage): Record<string, string> {
    return {
      device_key: this.deviceKey,
      title: message.title,
      body: message.body,
      // 同一台机器的通知在通知中心折叠成一组
      group: message.group,
      // 不作为持续响铃通知——权限确认不该把手机变成闹钟
      call: '0',
      // 存入 Bark 历史，方便回看漏掉的事件
      isArchive: '1',
      // ciphertext / sessionId / cwd / 会话名——一个都没有，也无处可填
    };
  }

  async send(message: PushMessage): Promise<void> {
    const body = JSON.stringify(this.buildPayload(message));
    let lastError: unknown;

    // 首次 + 每个退避档一次重试
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt++) {
      if (attempt > 0) await this.sleep(this.retryDelaysMs[attempt - 1]!);
      try {
        const res = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) return;

        // 4xx 是我们自己的配置/请求错，重试无意义——立刻放弃
        if (res.status >= 400 && res.status < 500) {
          throw new NonRetryableError(
            `bark 拒绝请求 status=${res.status}（不重试）`,
          );
        }
        lastError = new Error(`bark 服务端错误 status=${res.status}`);
      } catch (err) {
        // 用类型而非错误消息判定：自建 bark-server 的中文错误页、
        // 企业代理的中文报错都可能带上「不重试」三个字，靠 substring
        // 匹配会把本该重试的网络错误误判成放弃，且悄无声息
        if (err instanceof NonRetryableError) throw err;
        lastError = err;
      }
      this.log(
        `[push] bark 第 ${attempt + 1} 次投递失败：${describeError(lastError)}`,
      );
    }
    // 重试耗尽：抛给 dispatcher 的 onError 去记日志，事件本身丢弃
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/** 错误描述：只取消息文本，绝不 JSON.stringify 整个对象（可能带请求体） */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : '未知错误';
}

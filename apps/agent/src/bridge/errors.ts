/**
 * 错误分类：决定一次运行失败该「自动 resume 续跑」还是「报给人」。
 *
 * ## 为什么用黑名单而非白名单
 *
 * 借鉴 feishu-claude-code 踩过的坑：上游错误文案经常变（"rate limit" →
 * "usage limit" → "quota exceeded" …），维护「哪些错误可重试」的白名单必漏，
 * 一漏就是任务静默卡死。反过来只列举「重试无益」的错误——认证失败、额度墙、
 * 参数/配置错——其余一律当瞬时抖动自动续跑，漏判的代价只是多重试一次。
 *
 * ## 续跑语义（重要）
 *
 * 瞬时错误的正确恢复方式是**同 sessionId resume + 一句「继续」提示**，
 * 而不是重发原始用户消息：原消息可能已经被执行了一半（文件已写、命令已跑），
 * 重发会造成 double-write。写操作场景下续跑提示还要更保守（「先核实再继续」）。
 * 本模块只负责分类，续跑动作见 session.ts。
 */
import type { ErrorKind } from './types.ts';

/** 需要人介入的 fatal 分类 */
export interface FatalClassification {
  retryable: false;
  kind: ErrorKind;
  message: string;
  retryAt?: number;
}

/** 分类结果：可重试的瞬时错误，或需要人介入的 fatal 错误 */
export type ErrorClassification =
  | { retryable: true; reason: string }
  | FatalClassification;

/**
 * 分类输入是**上游任意错误文本**（`result.errors.join('; ')`），里面可能嵌着
 * 工具输出、URL、JSON 片段。所以模式必须足够「锚定」——宽泛子串会把可重试的
 * 错误误判成 fatal，而误判 fatal 的代价不是「多重试一次」，是**任务直接停死
 * 并给用户一个错误的归因**，正好与黑名单设计的初衷相反。
 *
 * 被这条规则否掉的几个曾经的宽泛模式（都实测误伤过）：
 * - `'billing'` → 命中 `.../v1/billing/meters` 这样的 URL（网络抖动被判成额度墙）
 * - `'enoent'` / `'no such file or directory'` → 命中工具读了个不存在的文件
 *   （任务本可以继续，却被判成配置错）
 * - `'unauthorized'` → 命中 `upstream connect error: unauthorized proxy CONNECT`
 * - `'invalid_request_error'` → 命中 5xx 响应体里的 JSON 片段
 */
const FATAL_PATTERNS: ReadonlyArray<{
  kind: ErrorKind;
  /** 全部为小写；命中任一即算该类 */
  patterns: readonly string[];
}> = [
  {
    kind: 'auth',
    patterns: [
      'invalid api key',
      'authentication_error',
      'authentication_failed',
      'authentication failed',
      '401 unauthorized',
      'oauth token has expired',
      'oauth_org_not_allowed',
      'please run /login',
      'invalid bearer token',
    ],
  },
  {
    kind: 'quota',
    patterns: [
      'usage limit reached',
      'quota exceeded',
      'credit balance is too low',
      'insufficient_quota',
      'exceeded your current quota',
      'billing_error',
      'account_on_hold',
    ],
  },
  {
    kind: 'config',
    patterns: [
      'is not a valid model',
      'model not found',
      'model_not_found',
      'unknown option',
      'cwd does not exist',
      'invalid settingsources',
      // 只认明确指向「claude 二进制起不来」的 ENOENT，不认工具读文件的 ENOENT
      'spawn claude enoent',
    ],
  },
];

/**
 * 5xx / 网络层错误的特征：命中即**强制判为可重试**，优先于上面的 fatal 表。
 *
 * 存在的理由：上游经常把 5xx 的响应体原样塞进错误文本，而响应体里可能带
 * `invalid_request_error` 之类的字样，光看子串会误判成 fatal。服务端错误
 * 按定义就是该重试的。
 */
const FORCE_RETRYABLE = [
  /\b5\d{2}\b/,
  /internal server error/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /overloaded/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /socket hang up/i,
  /connection reset/i,
] as const;

/**
 * 从 quota 类错误文本里捞额度重置时间，支撑 client 的「xx:xx 后自动续跑」。
 * 上游文案形如 `Your limit will reset at 2026-08-30T15:00:00Z` 或
 * `resets at 3pm`；只认可解析成绝对时间的那种，解析不出就不给（client 退化
 * 成普通 fatal 卡，不会显示错误的倒计时）。
 */
function extractRetryAt(text: string): number | undefined {
  const iso = text.match(
    /reset(?:s|ting)?\s+at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)/i,
  );
  if (iso?.[1]) {
    const parsed = Date.parse(iso[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  // Unix 秒级时间戳形式：`resets at 1756500000`
  const epoch = text.match(/reset(?:s|ting)?\s+at\s+(1[0-9]{9})\b/i);
  if (epoch?.[1]) return Number(epoch[1]) * 1000;
  return undefined;
}

/** 提取错误文本：Error 取 message，其余尽量字符串化 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * 分类一个运行期错误。
 *
 * @param err 抛出的错误（或 SDK result message 里的错误文本）
 * @returns 可重试 → `{ retryable: true }`；否则带 kind 的 fatal
 */
export function classifyError(err: unknown): ErrorClassification {
  const raw = errorText(err);
  const lower = raw.toLowerCase();

  // 5xx / 网络层优先：这类按定义就该重试，且上游常把响应体原样塞进错误文本，
  // 里面的 JSON 片段会误触 fatal 表（见 FORCE_RETRYABLE 注释）
  if (FORCE_RETRYABLE.some((re) => re.test(raw))) {
    return { retryable: true, reason: raw };
  }

  for (const { kind, patterns } of FATAL_PATTERNS) {
    if (patterns.some((p) => lower.includes(p))) {
      const result: ErrorClassification = { retryable: false, kind, message: raw };
      if (kind === 'quota') {
        const retryAt = extractRetryAt(raw);
        if (retryAt !== undefined) return { ...result, retryAt };
      }
      return result;
    }
  }

  return { retryable: true, reason: raw };
}

/**
 * 按 SDK 的 `SDKResultError.subtype` 分类——**优先于文本匹配**。
 *
 * 这几个 subtype 是结构化的确定信号，比猜文案可靠得多，而且其中三个
 * **重试有害**：max_turns / 超预算 / 结构化输出重试耗尽，原样重跑必然
 * 以同样的方式再失败一次，纯烧额度。
 *
 * @param subtype `SDKResultError.subtype`
 * @param detail 错误详情文本（errors 数组拼接）
 * @returns 该 subtype 有确定结论时返回分类；`error_during_execution`
 *   这种「泛执行错误」返回 undefined，交给 classifyError 按文本判
 */
export function classifyResultSubtype(
  subtype: string,
  detail: string,
): FatalClassification | undefined {
  switch (subtype) {
    case 'error_max_turns':
      return {
        retryable: false,
        kind: 'config',
        message: detail === '' ? '已达最大轮次上限（maxTurns）' : detail,
      };
    case 'error_max_budget_usd':
      return {
        retryable: false,
        kind: 'quota',
        message: detail === '' ? '已达本次运行的预算上限' : detail,
      };
    case 'error_max_structured_output_retries':
      return {
        retryable: false,
        kind: 'config',
        message: detail === '' ? '结构化输出重试次数已耗尽' : detail,
      };
    default:
      // error_during_execution 等：泛执行错误，交给文本分类
      return undefined;
  }
}

/**
 * 是否是「我们自己主动中止」——不属于错误，绝不自动续跑。
 *
 * **只认 `err.name === 'AbortError'`，不做文本匹配。** 早先版本用
 * `message.includes('aborted')` 猜，结果把上游的瞬时错误当成主动中止吞掉了
 * （实测 `Request aborted by upstream gateway after 30s`、
 * `The connection was aborted due to a network error` 都会命中）。
 * 而命中的后果是**静默丢弃**：不发任何事件、不续跑、状态直接回 idle，
 * 用户看到任务凭空消失——最难排查的一类故障。
 *
 * 判断中止应当依据**本端状态**（我们的 AbortController 是否真的 abort 过），
 * 调用方可用 `signal` 参数把这个事实传进来，而不是猜上游文案。
 *
 * @param err 待判断的错误
 * @param signal 本端的中止信号；给了就以它为准（aborted 才算中止）
 */
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  const named = err instanceof Error && err.name === 'AbortError';
  if (signal !== undefined) {
    // 有本端信号时以它为准：只有我们确实 abort 过，才认这次中止是自己发起的
    return named && signal.aborted;
  }
  return named;
}

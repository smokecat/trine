/**
 * 会话成本估算的价目表（trine 侧自己算，不经 Claude Code）。
 *
 * ## 为什么需要自己算
 *
 * SDK 的 `total_cost_usd` 是按模型名查 Claude Code **内置的 Anthropic 价目表**。
 * 走网关接第三方模型（`deepseek-*` / `glm-*`）时，模型名匹配不到任何内置行，
 * CC 就退回 canonical 模型（modelPicker 的 `behavesAs`，默认 sonnet）的价目：
 * 实测一条 26.9 万 input 的 DeepSeek 请求被报成 $0.54，真实 $0.081（高估 6.7 倍）；
 * 没写 `behavesAs` 时它又按默认档猜（≈$5/M），同样不准。
 *
 * 这里按 `{home}/pricing.json` 的价目，用 result 消息里 **跨 turn 累计** 的
 * `modelUsage` token 数自己算美元。没配价目表 = 完全保持原行为（仍用 SDK 的数）。
 *
 * ## 峰谷价
 *
 * 部分厂商按时段两档计价（DeepSeek 峰时是错峰的两倍）。价目项可写成
 * `{ peak, offPeak }`，时段由顶层 `peakHoursUtc` 决定（UTC 小时，左闭右开）。
 * 只写一组单价 = 全天同价。价目表单位：**美元 / 百万 token**。
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const RatesSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});

const EntrySchema = z.union([
  RatesSchema,
  z.object({ peak: RatesSchema, offPeak: RatesSchema }),
]);

export const PriceTableSchema = z.object({
  /** UTC 峰时区间 [起, 止)，左闭右开；默认 DeepSeek 的 [[1,4],[6,10]] */
  peakHoursUtc: z
    .array(z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(24)]))
    .default([[1, 4], [6, 10]]),
  /** 峰时只在周一到周五；默认 true（DeepSeek 的规则；法定假日不建模） */
  peakWeekdaysOnly: z.boolean().default(true),
  models: z.record(z.string(), EntrySchema),
});

export type PriceRates = z.infer<typeof RatesSchema>;
export type PriceEntry = z.infer<typeof EntrySchema>;
export type PriceTable = z.infer<typeof PriceTableSchema>;

/** 一轮（或累计）的 token 数 */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * 读价目表。文件不存在 / 解析失败 → undefined（调用方回退 SDK 的成本），
 * 坏文件只 warn 不阻止会话启动——成本显示不准不该让会话起不来。
 */
export function loadPriceTable(
  path: string,
  log: (line: string) => void = () => {},
): PriceTable | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log(`[pricing] 读取 ${path} 失败，回退 SDK 成本：${(err as Error).message}`);
    return undefined;
  }
  try {
    return PriceTableSchema.parse(JSON.parse(raw));
  } catch (err) {
    log(`[pricing] ${path} 格式不对，回退 SDK 成本：${(err as Error).message}`);
    return undefined;
  }
}

/** at 时刻是否落在峰时（UTC；周末按 peakWeekdaysOnly 排除） */
export function isPeak(at: number, table: PriceTable): boolean {
  const date = new Date(at);
  const day = date.getUTCDay(); // 0 = 周日
  if (table.peakWeekdaysOnly && (day === 0 || day === 6)) return false;
  const hour = date.getUTCHours();
  return table.peakHoursUtc.some(([from, to]) => hour >= from && hour < to);
}

/** 取 at 时刻适用的单价（未配峰谷 = 全天同价） */
export function ratesFor(entry: PriceEntry, at: number, table: PriceTable): PriceRates {
  return 'peak' in entry ? (isPeak(at, table) ? entry.peak : entry.offPeak) : entry;
}

/** token 数 × 单价 → 美元 */
export function costOfTokens(tokens: TokenCounts, rates: PriceRates): number {
  return (
    (tokens.input * rates.input +
      tokens.output * rates.output +
      tokens.cacheRead * rates.cacheRead +
      tokens.cacheWrite * rates.cacheWrite) /
    1_000_000
  );
}

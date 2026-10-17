/**
 * 展示用格式化。纯函数、零 React、零浏览器全局，`bun test` 直接覆盖。
 *
 * 阶段 2a 定稿的共享件——2b 两组都会用，**只加不改**（改签名会同时打断两路）。
 *
 * 口径约定（照原型 prototype.html 的文案）：
 * - 时间一律相对（「2 分钟前」），因为远程操控的场景里「多久之前」比
 *   绝对时刻有用；超过 7 天才退回绝对日期。
 * - 耗时用 `m:ss`（原型心跳 footer 的 `⏱ 2:34`），不足 1 分钟给 `12s`。
 * - 金额固定两位小数加 `$` 前缀（原型会话卡的 `$0.21`）。
 * - 字节/行数走三位有效数字的紧凑写法，避免卡片被长数字撑开。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 相对时间：「刚刚 / N 分钟前 / N 小时前 / N 天前」，超过 7 天给绝对日期。
 *
 * `now` 可注入，测试不依赖真实时钟。未来时间（设备间时钟漂移）一律按
 * 「刚刚」处理——给用户看「-3 分钟前」毫无意义。
 */
export function formatRelativeTime(at: number, now: number = Date.now()): string {
  const diff = now - at;
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  const d = new Date(at);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  // 跨年才带年份，否则「03-14」够用且更短
  return d.getFullYear() === new Date(now).getFullYear()
    ? `${mm}-${dd}`
    : `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 耗时：`m:ss`（≥1 分钟）或 `Ns`（<1 分钟）。原型心跳 footer 与完成卡用。
 *
 * 超过 1 小时给 `h:mm:ss`——一次 run 跑过小时的情况不常见但存在，
 * 显示成 `73:20` 会让人误读成 73 秒。
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours === 0) return `${minutes}:${ss}`;
  return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
}

/**
 * 秒级耗时（心跳里「无输出 N 秒」这类只要整秒的地方）。
 */
export function formatSeconds(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

/**
 * 美元成本：`$0.21`。两位小数是原型的口径。
 *
 * 特例：非 0 但小于 $0.005 的会被四舍五入成 `$0.00`，看着像「没花钱」，
 * 所以这一档给 `<$0.01`——「花了一点点」与「没花」是不同的信息。
 */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd > 0 && usd < 0.005) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * 字节数：B / KB / MB / GB，三位有效数字左右。
 * 工具卡的 outputPreview 摘要、附件大小用。
 */
export function formatBytes(bytes: number): string {
  const n = Math.max(0, bytes);
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // <10 给一位小数（1.5 MB），≥10 取整（256 KB）——位数稳定，卡片不抖
  const text = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${text} ${units[unit]}`;
}

/**
 * 行数增删摘要：`+9 −2`（原型工具卡 Edit 那行）。
 * 用的是 U+2212 减号而不是连字符，等宽数字下对齐更好看。
 */
export function formatLineDelta(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`−${removed}`);
  return parts.length === 0 ? '无改动' : parts.join(' ');
}

/**
 * 行数：`1,234 行`。千分位让长输出的行数一眼能读。
 */
export function formatLines(count: number): string {
  return `${Math.max(0, Math.round(count)).toLocaleString('en-US')} 行`;
}

/**
 * 单行化：把多行文本压成一行预览（会话卡的 lastEvent、工具卡的参数摘要）。
 * 超长截断加省略号；`max` 按字符数算。
 */
export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  // 截到 max-1 再补省略号，保证结果长度恰好是 max
  return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

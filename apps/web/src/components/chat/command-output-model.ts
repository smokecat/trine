/**
 * 本地斜杠命令输出卡的纯逻辑（CommandOutputCard 的模型）。零 React 依赖，`bun test` 覆盖。
 *
 * 命令输出是 CLI 给终端排版的纯文本：换行、缩进都有意义，所以默认按等宽原样显示。
 * `/usage` 单独解析成结构（用量窗口 → 进度条，「Last 24h」之类的分组 → 列表），文本
 * 形状随 Claude Code 版本可能变：认不出任何用量窗口就返回 null，卡片回落原样显示。
 *
 * `/usage` 的文本形状（Claude Code 2.1.304 实测）：
 *
 * ```
 * You are currently using your subscription to power your Claude Code usage
 *
 * Current session: 69% used · resets Oct 20, 2:39pm (Asia/Singapore)
 * Current week (all models): 16% used · resets Oct 26, 3:59am (Asia/Singapore)
 * Current week (Fable): 0% used · resets Oct 26, 4am (Asia/Singapore)
 *
 * What's contributing to your limits usage?
 * Approximate, based on local sessions on this machine — …
 *
 * Last 24h · 1815 requests · 31 sessions
 *   80% of your usage was at >150k context
 *   Top skills: /marginalia-task 4%, /local-deploy-prod 1%
 * ```
 */

export interface UsageWindowLine {
  /** 显示名（已本地化：「5 小时窗口」「本周 · 全部模型」…） */
  label: string;
  percent: number;
  /** 「Oct 20, 2:39pm」；没有重置时间时省略 */
  resets?: string;
  /** 原始的重置描述（带时区），悬停提示用 */
  resetsFull?: string;
}

export interface UsageSection {
  title: string;
  /** 不缩进的说明行 */
  notes: string[];
  /** 缩进的条目行（已去掉缩进） */
  items: string[];
}

export interface UsageReport {
  /** 用量窗口之前的说明（「You are currently using your subscription…」） */
  intro: string[];
  windows: UsageWindowLine[];
  sections: UsageSection[];
}

const WINDOW_LINE = /^(.+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+))?$/i;

/** CLI 的窗口名 → 界面文案；认不出的原样 */
export function usageWindowLabel(raw: string): string {
  if (/^current session$/i.test(raw)) return '5 小时窗口';
  const week = /^current week \((.+)\)$/i.exec(raw);
  if (week !== null) return `本周 · ${/^all models$/i.test(week[1]!) ? '全部模型' : week[1]}`;
  if (/^current week$/i.test(raw)) return '本周';
  return raw;
}

/** 按空行切块，块内保留原行 */
function blocks(lines: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length > 0) out.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function parseUsageReport(text: string): UsageReport | null {
  const intro: string[] = [];
  const windows: UsageWindowLine[] = [];
  const sections: UsageSection[] = [];
  for (const block of blocks(text.split('\n'))) {
    const parsed = block.map((line) => WINDOW_LINE.exec(line.trim()));
    if (parsed.every((m) => m !== null)) {
      for (const m of parsed) {
        const resetsFull = m![3]?.trim();
        const resets = resetsFull?.replace(/\s*\([^)]*\)\s*$/, '');
        windows.push({
          label: usageWindowLabel(m![1]!.trim()),
          percent: Number(m![2]),
          ...(resets === undefined || resets === '' ? {} : { resets }),
          ...(resetsFull === undefined || resetsFull === '' ? {} : { resetsFull }),
        });
      }
      continue;
    }
    if (windows.length === 0) {
      intro.push(...block.map((line) => line.trim()));
      continue;
    }
    const [title, ...rest] = block;
    const section: UsageSection = { title: title!.trim(), notes: [], items: [] };
    for (const line of rest) {
      if (/^\s/.test(line)) section.items.push(line.trim());
      else section.notes.push(line.trim());
    }
    sections.push(section);
  }
  return windows.length === 0 ? null : { intro, windows, sections };
}

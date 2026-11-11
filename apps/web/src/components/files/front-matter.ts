/**
 * 文件预览里 Markdown 开头的 YAML front matter：首行 `---`，到下一个 `---` 或 `...` 为止。
 *
 * 不用 YAML 库、不执行任何东西：只按行认简单的 `key: value`，认不出来（多行值、列表、缩进）
 * 就原样当代码块显示。正文里 front matter 的位置换成同样多的空行——Markdown 解析结果不变，
 * 而 mdast 的行号（滚动锚点的 `data-src-line`）仍是文件里的行号，源码 / 渲染切换照样对齐。
 */

export interface FrontMatterEntry {
  key: string;
  value: string;
}

export interface FrontMatter {
  /** 两条分隔线之间的原文 */
  raw: string;
  /** 简单的 `key: value` 列表；认不出来时为 null（原样显示） */
  entries: FrontMatterEntry[] | null;
  /** 去掉 front matter 的正文，开头补同样多的空行（行号不变） */
  body: string;
}

const KEY_VALUE = /^([A-Za-z0-9_][\w.-]*)[ \t]*:(?:[ \t]+(.*)|)$/;

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** 没有 front matter（首行不是 `---`，或没有结束行）返回 undefined */
export function splitFrontMatter(text: string): FrontMatter | undefined {
  const lines = text.split('\n');
  if (lines.length < 2 || stripCr(lines[0]!).trimEnd() !== '---') return undefined;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = stripCr(lines[i]!).trimEnd();
    if (line === '---' || line === '...') {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;
  const inner = lines.slice(1, end).map(stripCr);
  return {
    raw: inner.join('\n'),
    entries: parseEntries(inner),
    body: '\n'.repeat(end + 1) + lines.slice(end + 1).join('\n'),
  };
}

function parseEntries(lines: readonly string[]): FrontMatterEntry[] | null {
  const out: FrontMatterEntry[] = [];
  for (const line of lines) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const m = KEY_VALUE.exec(line);
    if (m === null) return null;
    // `key:` 后面没有值也行；嵌套结构的下一行是缩进的，上面就会认不出来、整体按原样显示
    const value = (m[2] ?? '').trim();
    out.push({ key: m[1]!, value: unquote(value) });
  }
  return out;
}

/** 只去掉成对的外层引号，不解释转义 */
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

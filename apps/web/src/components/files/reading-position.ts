/**
 * 阅读位置在「渲染 ↔ 源码」之间换算（像素位置在两种模式下没有可比性）。
 *
 * 对应关系按**标题序号**：渲染后的第 k 个标题 ↔ 源码里第 k 个标题行。不按 slug 比，
 * 因为渲染文本与源码文本（`**粗**`、链接、行内代码）不同。认的标题行：ATX（`# x`）、
 * Setext（下一行是 `===` / `---`）、单行 raw HTML（`<h2 …>`）；代码围栏里的不算。
 */

/** 源码里各标题所在的行号（0 起，文档顺序） */
export function markdownHeadingLines(text: string): number[] {
  const lines = text.split('\n');
  const out: number[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f !== null) {
      const mark = f[1]!;
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (/^ {0,3}#{1,6}(\s|$)/.test(line) || /^ {0,3}<h[1-6][\s>]/i.test(line)) {
      out.push(i);
      continue;
    }
    const next = lines[i + 1];
    // Setext：上一行是正文（非空、不是列表/引用等也无所谓，宁可多认），下一行全是 = 或 -
    if (next !== undefined && line.trim() !== '' && /^ {0,3}(=+|-+)\s*$/.test(next) && !/^ {0,3}([-*_]\s*){3,}$/.test(line)) {
      out.push(i);
      i += 1;
    }
  }
  return out;
}

/** 某一行之前（含）最后一个标题的序号；在第一个标题之前返回 -1 */
export function headingOrdinalAtLine(headingLines: readonly number[], line: number): number {
  let k = -1;
  for (let i = 0; i < headingLines.length; i += 1) {
    if (headingLines[i]! <= line) k = i;
    else break;
  }
  return k;
}

/**
 * 单调函数上的二分：找满足 `top(i) <= y` 的最大 i（0..n-1），都不满足返回 0。
 * 用来从 scrollTop 反查源码行。
 */
export function lastAtOrAbove(n: number, top: (i: number) => number, y: number): number {
  let lo = 0;
  let hi = n - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (top(mid) <= y) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

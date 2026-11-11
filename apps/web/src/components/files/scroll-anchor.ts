/**
 * 文件预览的滚动锚点：布局变化（源码 / 渲染切换、宽度变化与重排、外壳重挂）前后保持阅读位置。
 *
 * 锚点 = 视口顶部第一个**开始于视口内**的块 + 它相对视口顶部的偏移。块用**源码行号**标识
 * （渲染时由 rehype 插件把 mdast position 写进 `data-src-line`；源码视图就是行本身），
 * 所以两种模式之间可以互相映射。没有块开始于视口内（一个长块盖满整屏）时取跨过顶部的那个块，
 * 偏移为负。
 *
 * 为什么不用「当前节标题」：标题被滚到顶部后阅读线算法可能判成上一节，每次往前偏一节，
 * 来回切换会累积漂移。按块 + 偏移恢复是幂等的。
 */

export interface ScrollAnchor {
  /** 源码行号（1 起） */
  line: number;
  /** 块顶部相对视口顶部的偏移（px，负 = 块跨过顶部） */
  offset: number;
}

function previewRoot(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-file-preview]');
}

function sourcePre(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="file-text"]');
}

/** 当前承载正文的元素（渲染预览根或源码 pre）：给 ResizeObserver 观察 */
export function anchorContent(container: HTMLElement): HTMLElement | null {
  return previewRoot(container) ?? sourcePre(container);
}

/** 相对滚动内容顶部的位置 */
function contentTop(container: HTMLElement, rect: { top: number }): number {
  return rect.top - container.getBoundingClientRect().top + container.scrollTop;
}

/** 单调函数上的二分：满足 `top(i) <= y` 的最大 i（0..n-1），都不满足返回 0 */
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

/**
 * 源码里像块开头的行（0 起）：从来没渲染过时（直接以源码打开）的兜底。规则：非空行，且是首行、
 * 前一行为空、或本行是标题 / 列表项 / 引用 / 围栏开头。
 */
export function guessBlockStarts(text: string): number[] {
  const lines = text.split('\n');
  const out: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const prev = i === 0 ? '' : lines[i - 1]!;
    if (prev.trim() === '' || /^ {0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~)/.test(line)) out.push(i);
  }
  return out;
}

// ---- 渲染视图 ----

function renderedBlocks(container: HTMLElement): HTMLElement[] {
  const root = previewRoot(container);
  return root === null ? [] : [...root.querySelectorAll<HTMLElement>('[data-src-line]')];
}

function lineOf(el: HTMLElement): number {
  return Number(el.dataset['srcLine']);
}

/** 渲染视图里出现过的块的行号（0 起，升序去重）：之后在源码视图里只认这些行当锚点 */
export function renderedBlockStarts(container: HTMLElement): number[] | null {
  const blocks = renderedBlocks(container);
  if (blocks.length === 0) return null;
  return [...new Set(blocks.map((b) => lineOf(b) - 1))].sort((a, b) => a - b);
}

function captureRendered(container: HTMLElement): ScrollAnchor | null {
  const vt = container.getBoundingClientRect().top;
  let spanning: { el: HTMLElement; top: number } | null = null;
  for (const el of renderedBlocks(container)) {
    const r = el.getBoundingClientRect();
    if (r.top >= vt - 0.5) return { line: lineOf(el), offset: r.top - vt };
    if (r.bottom > vt) spanning = { el, top: r.top };
  }
  return spanning === null ? null : { line: lineOf(spanning.el), offset: spanning.top - vt };
}

/** 渲染视图里锚点对应的 scrollTop：同一行的块，没有则行号不超过它的最后一个块 */
function resolveRendered(container: HTMLElement, anchor: ScrollAnchor): number | null {
  let best: HTMLElement | null = null;
  for (const el of renderedBlocks(container)) {
    const l = lineOf(el);
    if (l === anchor.line) {
      best = el;
      break;
    }
    if (l < anchor.line) best = el;
    else break;
  }
  if (best === null) return null;
  return contentTop(container, best.getBoundingClientRect()) - anchor.offset;
}

// ---- 源码视图 ----

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') out.push(i + 1);
  return out;
}

/**
 * 源码第 i 行（0 起）相对滚动内容顶部的位置：Range 量真实位置（自动换行折行也准）；
 * 量不出来（测试环境）按行号比例估。
 */
function sourceLineTop(container: HTMLElement, pre: HTMLElement, starts: readonly number[], i: number): number {
  const node = pre.firstChild;
  if (node !== null && node.nodeType === 3 && typeof document.createRange === 'function') {
    try {
      const len = (node.textContent ?? '').length;
      const at = Math.min(starts[i] ?? 0, len);
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, Math.min(at + 1, len));
      const rect = range.getBoundingClientRect();
      if (rect.height > 0) return contentTop(container, rect);
    } catch {
      // 落到比例估算
    }
  }
  const preTop = contentTop(container, pre.getBoundingClientRect());
  return preTop + (i / Math.max(1, starts.length)) * pre.scrollHeight;
}

function captureSource(container: HTMLElement, blockStarts: readonly number[] | null): ScrollAnchor | null {
  const pre = sourcePre(container);
  if (pre === null) return null;
  const starts = lineStarts(pre.textContent ?? '');
  const top = (i: number): number => sourceLineTop(container, pre, starts, i);
  const y = container.scrollTop;
  const first = lastAtOrAbove(starts.length, top, y + 0.5);
  const blocks = blockStarts ?? guessBlockStarts(pre.textContent ?? '');
  // 视口顶部之后第一个块开头的行；在视口内就用它，否则用顶部所在的行
  const next = blocks.find((b) => b >= first && top(b) >= y - 0.5);
  const line = next !== undefined && top(next) < y + container.clientHeight ? next : first;
  return { line: line + 1, offset: top(line) - y };
}

function resolveSource(container: HTMLElement, anchor: ScrollAnchor): number | null {
  const pre = sourcePre(container);
  if (pre === null) return null;
  const starts = lineStarts(pre.textContent ?? '');
  const i = Math.min(Math.max(0, anchor.line - 1), starts.length - 1);
  return sourceLineTop(container, pre, starts, i) - anchor.offset;
}

// ---- 对外 ----

/** 记下当前锚点（按此刻 DOM 里是渲染还是源码） */
export function captureAnchor(container: HTMLElement, blockStarts: readonly number[] | null): ScrollAnchor | null {
  return previewRoot(container) !== null ? captureRendered(container) : captureSource(container, blockStarts);
}

/** 按锚点设回 scrollTop；找不到目标返回 false */
export function restoreAnchor(container: HTMLElement, anchor: ScrollAnchor): boolean {
  const top = previewRoot(container) !== null ? resolveRendered(container, anchor) : resolveSource(container, anchor);
  if (top === null) return false;
  const next = Math.max(0, Math.round(top));
  if (Math.abs(container.scrollTop - next) >= 1) container.scrollTop = next;
  return true;
}

/**
 * 源码 / 渲染切换时保持阅读位置（DOM 部分；换算规则见 reading-position.ts）。
 *
 * 切换前在旧模式里取「当前读到第几个标题」（阅读线以上最后一个），切换后在新模式里把
 * 同一序号的标题（渲染）或标题行（源码）放到容器顶部。还没读到第一个标题时按滚动比例。
 */
import { previewHeadings } from './MarkdownToc.tsx';
import { headingOrdinalAtLine, lastAtOrAbove, markdownHeadingLines } from './reading-position.ts';

export interface ModeMark {
  /** 第几个标题（-1 = 第一个标题之前） */
  ordinal: number;
  /** 兜底：scrollTop / scrollHeight */
  ratio: number;
}

/** 与目录高亮同一条阅读线 */
const READING_LINE = 96;
/** 目标放到容器顶部往下这么多（与锚点跳转一致） */
const TOP_GAP = 8;

function relTop(container: HTMLElement, el: Element): number {
  return el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
}

function sourcePre(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="file-text"]');
}

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') out.push(i + 1);
  return out;
}

/**
 * 源码第 i 行在容器里的位置：用 Range 量真实位置（自动换行折行也准）；量不出来时
 * （测试环境、没有文本节点）按行号比例估。
 */
function sourceLineTop(container: HTMLElement, pre: HTMLElement, starts: readonly number[], i: number): number {
  const node = pre.firstChild;
  if (node !== null && node.nodeType === 3 && typeof document.createRange === 'function') {
    try {
      const range = document.createRange();
      const len = (node.textContent ?? '').length;
      const at = Math.min(starts[i] ?? 0, len);
      range.setStart(node, at);
      range.setEnd(node, Math.min(at + 1, len));
      const rect = range.getBoundingClientRect();
      if (rect.height > 0) return rect.top - container.getBoundingClientRect().top + container.scrollTop;
    } catch {
      // 落到比例估算
    }
  }
  return relTop(container, pre) + (i / Math.max(1, starts.length)) * pre.scrollHeight;
}

function ratioOf(container: HTMLElement): number {
  return container.scrollHeight > 0 ? container.scrollTop / container.scrollHeight : 0;
}

function line(container: HTMLElement): number {
  return container.scrollTop + Math.min(READING_LINE, container.clientHeight * 0.3);
}

/** 渲染模式下的阅读位置 */
export function captureRendered(container: HTMLElement): ModeMark {
  const y = line(container);
  const tops = previewHeadings(container).map((h) => relTop(container, h));
  let ordinal = -1;
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i]! <= y) ordinal = i;
    else break;
  }
  return { ordinal, ratio: ratioOf(container) };
}

/** 源码模式下的阅读位置：阅读线所在的源码行之前最后一个标题 */
export function captureSource(container: HTMLElement, text: string): ModeMark {
  const pre = sourcePre(container);
  if (pre === null) return { ordinal: -1, ratio: ratioOf(container) };
  const shown = pre.textContent ?? '';
  const starts = lineStarts(shown);
  const at = lastAtOrAbove(starts.length, (i) => sourceLineTop(container, pre, starts, i), line(container));
  return { ordinal: headingOrdinalAtLine(markdownHeadingLines(text), at), ratio: ratioOf(container) };
}

function scrollToTop(container: HTMLElement, top: number): void {
  container.scrollTop = Math.max(0, top);
}

export function applyRendered(container: HTMLElement, mark: ModeMark): void {
  const h = mark.ordinal >= 0 ? previewHeadings(container)[mark.ordinal] : undefined;
  if (h !== undefined) scrollToTop(container, relTop(container, h) - TOP_GAP);
  else scrollToTop(container, mark.ratio * container.scrollHeight);
}

export function applySource(container: HTMLElement, text: string, mark: ModeMark): void {
  const pre = sourcePre(container);
  const lineNo = mark.ordinal >= 0 ? markdownHeadingLines(text)[mark.ordinal] : undefined;
  if (pre === null || lineNo === undefined) {
    scrollToTop(container, mark.ratio * container.scrollHeight);
    return;
  }
  const starts = lineStarts(pre.textContent ?? '');
  // 源码只显示了开头（超大文件）：目标行不在显示范围内就按比例
  if (lineNo >= starts.length) scrollToTop(container, mark.ratio * container.scrollHeight);
  else scrollToTop(container, sourceLineTop(container, pre, starts, lineNo) - TOP_GAP);
}

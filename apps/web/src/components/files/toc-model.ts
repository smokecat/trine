/**
 * Markdown 文件预览的标题锚点与目录（方案 §6）的纯逻辑：
 * - slug：GitHub 风格（小写、去标点、空格变 `-`，保留中文等各种文字），重复的加 `-1`、`-2`；
 * - 锚点匹配：链接里的 `#x` 可能是原文、百分号编码、或手写的大小写/空格，统一换算后找 slug；
 * - 目录：h1–h4，至少 3 个标题才显示。
 */
import { decodeHref } from './file-model.ts';

export interface TocItem {
  slug: string;
  text: string;
  level: number;
}

/** 目录收录的最深一级 */
export const TOC_MAX_LEVEL = 4;
/** 少于这么多标题不显示目录 */
export const TOC_MIN_ITEMS = 3;

/** 标点、符号一律去掉；字母（含 CJK）、数字、组合符、连接符、`-`、空格保留 */
const STRIP = /[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu;

export function slugify(text: string): string {
  return text.trim().toLowerCase().replace(STRIP, '').replace(/ /g, '-');
}

/**
 * 一次文档转换用一个 slugger（与 github-slugger 同算法）：同名标题依次得到 `x`、`x-1`、`x-2`，
 * 而且不会和原本就叫 `x-1` 的标题撞上。空标题（只有标点）记作 `section`。
 */
export function createSlugger(): (text: string) => string {
  const occurrences = new Map<string, number>();
  return (text) => {
    const base = slugify(text) || 'section';
    let slug = base;
    while (occurrences.has(slug)) {
      const n = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, n);
      slug = `${base}-${n}`;
    }
    occurrences.set(slug, 0);
    return slug;
  };
}

/**
 * 把链接里的锚点换算成文档里的 slug：先按原文（解码后）比，再按小写、slugify 后比，
 * 也认 GitHub 渲染出的 `user-content-` 前缀。找不到返回 undefined。
 */
export function matchFragment(fragment: string, slugs: readonly string[]): string | undefined {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  const decoded = decodeHref(raw).trim();
  if (decoded === '') return undefined;
  const bare = decoded.replace(/^user-content-/i, '');
  const set = new Set(slugs);
  for (const c of [decoded, bare, decoded.toLowerCase(), bare.toLowerCase(), slugify(decoded), slugify(bare)]) {
    if (c !== '' && set.has(c)) return c;
  }
  return undefined;
}

/** 链接的原始 href（未解码）→ 路径部分与锚点（锚点已解码）。`%23` 是文件名里的 `#`，不切 */
export function splitHref(href: string): { path: string; fragment: string | undefined } {
  const hash = href.indexOf('#');
  const fragment = hash === -1 ? undefined : decodeHref(href.slice(hash + 1));
  return { path: decodeHref(href.replace(/[?#].*$/, '')), fragment: fragment === '' ? undefined : fragment };
}

/** 目录项：只要 h1–h4；不足 TOC_MIN_ITEMS 个返回空（不显示目录） */
export function tocItems(headings: readonly TocItem[]): TocItem[] {
  const items = headings.filter((h) => h.level <= TOC_MAX_LEVEL);
  return items.length >= TOC_MIN_ITEMS ? items : [];
}

/**
 * 当前节：顶端越过阅读线（容器顶部往下 `line` 像素）的最后一个标题；一个都没越过取第一个。
 * `tops` 是各标题相对容器顶部的位置（按文档顺序）。
 */
export function activeIndex(tops: readonly number[], line: number): number {
  let current = 0;
  for (let i = 0; i < tops.length; i += 1) {
    if (tops[i]! <= line) current = i;
    else break;
  }
  return current;
}

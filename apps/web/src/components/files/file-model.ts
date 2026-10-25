/**
 * 文件查看的纯逻辑：消息里的路径识别、路径拼接、按扩展名选高亮语言。
 *
 * 路径识别宁可漏、不可滥：误报会把版本号、域名、`and/or` 变成死链接。规则：
 * - 不含空白、引号、括号、通配符，不带协议（`https:`、`mailto:`），不以 `@` 开头（npm scope / 别名）
 * - 末段带扩展名（扩展名里至少一个字母：排除 `0.20.0`），或以 `/` 结尾（目录）
 * - 不含 `/` 的裸文件名（`README.md`）只认常见文档 / 源码扩展名，避免 `example.com`、`e.g`
 * - 可带 `:行号[:列号]` 或 `#L行号` 后缀（打开时忽略）
 */
import type { FsEntry } from '@trine/core';

const BARE_EXT = new Set(
  'md markdown mdx txt pdf json jsonc yaml yml toml ini csv tsv log ts tsx js jsx mjs cjs py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh sql html css scss vue svelte ipynb lock xml png jpg jpeg gif webp svg'.split(
    ' ',
  ),
);
const FORBIDDEN = /[\s`'"<>|*?(){}[\]\\,;]/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LINE_SUFFIX = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/;

export interface DetectedPath {
  /** 去掉行号后缀后的路径 */
  path: string;
  /** 以 `/` 结尾：目录 */
  dir: boolean;
}

export function detectPath(raw: string): DetectedPath | undefined {
  const text = raw.trim();
  if (text === '' || text.length > 1024 || FORBIDDEN.test(text)) return undefined;
  if (text.startsWith('@') || text.startsWith('//')) return undefined;
  const path = text.replace(LINE_SUFFIX, '');
  // Windows 盘符之外的协议一律不要（`C:/x` 也不认：agent 侧不支持 Windows）
  if (SCHEME.test(path)) return undefined;
  if (path.endsWith('/')) {
    // 目录：至少有一段像名字的东西（排除单独的 `/`、`./`）
    return /[\p{L}\p{N}_]/u.test(path) && path.length > 1 ? { path, dir: true } : undefined;
  }
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  if (dot <= 0 && !last.startsWith('.')) return undefined;
  const ext = dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
  if (ext === '' || ext.length > 10 || !/[a-z]/.test(ext) || !/^[a-z0-9_+-]+$/.test(ext)) return undefined;
  if (!path.includes('/') && !BARE_EXT.has(ext)) return undefined;
  return { path, dir: false };
}

/**
 * Markdown 文件里的相对链接：相对的是**这个文件所在的目录**，不是会话 cwd。
 * 绝对路径与 `~` 原样返回；去掉 `#锚点` 与 `?查询`。
 */
export function resolveRelative(fromFile: string, href: string): string {
  const clean = href.replace(/[?#].*$/, '');
  if (clean.startsWith('/') || clean === '~' || clean.startsWith('~/')) return clean;
  const baseDir = fromFile.slice(0, fromFile.lastIndexOf('/'));
  const parts = baseDir.split('/');
  for (const seg of clean.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 1) parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/') || '/';
}

/**
 * 链接 href 是否指向本地文件（没有协议、不是纯锚点）。含反斜杠的不算：浏览器把 `/\host`
 * 当协议相对地址（`//host`）。
 */
export function isLocalHref(href: string): boolean {
  return href !== '' && !href.startsWith('#') && !href.startsWith('//') && !href.includes('\\') && !SCHEME.test(href.trim());
}

/** 相对根目录的展示路径（不在根下就原样返回） */
export function displayPath(path: string, root: string | undefined): string {
  if (root === undefined || root === '') return path;
  if (path === root) return '.';
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** 面包屑：从根开始逐级（根本身显示为其目录名） */
export function breadcrumbs(path: string, root: string): { label: string; path: string }[] {
  const rootName = root.slice(root.lastIndexOf('/') + 1) || root;
  const out = [{ label: rootName, path: root }];
  const rel = displayPath(path, root);
  if (rel === '.' || rel === path) return out;
  let cur = root;
  for (const seg of rel.split('/')) {
    cur = `${cur.endsWith('/') ? cur : `${cur}/`}${seg}`;
    out.push({ label: seg, path: cur });
  }
  return out;
}

export function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** 文件浏览器里的可见条目：默认隐藏点开头的 */
export function visibleEntries(entries: readonly FsEntry[], showHidden: boolean): FsEntry[] {
  return showHidden ? [...entries] : entries.filter((e) => !e.name.startsWith('.'));
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  json: 'json',
  jsonc: 'jsonc',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  vue: 'vue',
  svelte: 'svelte',
  diff: 'diff',
  patch: 'diff',
  md: 'markdown',
  dockerfile: 'dockerfile',
  ini: 'ini',
};

/** 按文件名选 shiki 语言；认不出返回 undefined（纯文本） */
export function languageOf(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  const dot = lower.lastIndexOf('.');
  return dot === -1 ? undefined : LANG_BY_EXT[lower.slice(dot + 1)];
}

/** 超过这么大的文本不做语法高亮（shiki 在手机上会卡），也不做 markdown 渲染 */
export const HIGHLIGHT_MAX_BYTES = 256 * 1024;

/**
 * 把源码包成 markdown 代码围栏交给 Streamdown 高亮：围栏要比内容里最长的连续反引号更长，
 * 否则内容里的 ``` 会提前关掉围栏。
 */
export function fenceCode(text: string, lang: string | undefined): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang ?? ''}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n`;
}

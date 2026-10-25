/**
 * 文件预览方式与 mime：先看扩展名，认不出来再嗅探内容（没有 NUL 且是合法 UTF-8 → 文本）。
 *
 * mime 只给浏览器建 Blob 用；`text/html`、`image/svg+xml` 这类能带脚本的类型由 web 决定怎么
 * 显示（html 一律按源码、svg 只进 `<img>`），这里照实报。
 */
import { extname } from 'node:path';
import type { FsFileKind } from '@trine/core';

const MARKDOWN = new Set(['.md', '.markdown', '.mdx', '.mdown', '.mkd']);
const IMAGE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};
const TEXT_MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
};
/** 常见的文本 / 源码扩展名（不在这里的也会被内容嗅探认成文本，这张表只是省一次嗅探） */
const TEXT_EXT = new Set([
  ...Object.keys(TEXT_MIME),
  ...'.ts .tsx .jsx .cjs .mts .cts .py .rb .go .rs .java .kt .kts .swift .c .h .cc .cpp .hpp .cs .php .sh .bash .zsh .fish .ps1 .sql .toml .ini .cfg .conf .env.example .gitignore .dockerignore .lock .vue .svelte .scss .less .graphql .proto .tf .lua .r .pl .dart .scala .ex .exs .erl .hs .ml .zig .nim .jsonc .json5 .rst .adoc .tex .patch .diff .properties .gradle .cmake .mk .el .vim .nix .bat .cmd'.split(
    ' ',
  ),
]);
/** 没有扩展名但通常是文本的文件名 */
const TEXT_NAMES = new Set(['makefile', 'dockerfile', 'license', 'readme', 'changelog', 'procfile', 'gemfile', 'rakefile', 'justfile']);

export interface KindInfo {
  kind: FsFileKind;
  mime: string;
}

/** 只凭文件名能确定的；返回 undefined 表示要嗅探内容 */
export function kindByName(name: string): KindInfo | undefined {
  const ext = extname(name).toLowerCase();
  if (MARKDOWN.has(ext)) return { kind: 'markdown', mime: 'text/markdown' };
  if (ext === '.pdf') return { kind: 'pdf', mime: 'application/pdf' };
  const image = IMAGE[ext];
  if (image !== undefined) return { kind: 'image', mime: image };
  if (TEXT_EXT.has(ext) || TEXT_NAMES.has(name.toLowerCase())) return { kind: 'text', mime: TEXT_MIME[ext] ?? 'text/plain' };
  return undefined;
}

/** 嗅探前多少字节 */
export const SNIFF_BYTES = 8192;

/** 内容看起来是不是文本：没有 NUL，且（截断处的半个字符除外）是合法 UTF-8 */
export function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

const BINARY: KindInfo = { kind: 'binary', mime: 'application/octet-stream' };

/** 文本类扩展名也要过一遍嗅探：`.ts` 可能是视频（MPEG-TS），`.lock` 可能是二进制 */
export function detectKind(name: string, head: Uint8Array): KindInfo {
  const byName = kindByName(name);
  if (byName !== undefined && byName.kind !== 'text') return byName;
  if (!looksLikeText(head)) return BINARY;
  return byName ?? { kind: 'text', mime: 'text/plain' };
}

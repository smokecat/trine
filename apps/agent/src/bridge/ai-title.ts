/**
 * CC 自动生成的会话标题（转录里的 `{"type":"ai-title","aiTitle":"…"}` 记录）。
 *
 * ## 为什么需要单独读
 *
 * SDK 的 `listSessions()` / `getSessionInfo()` 只暴露：
 * - `customTitle`：用户 `/rename` 写的标题；
 * - `summary`：**没有自定义标题时不是自动标题，而是最后一条用户消息**。
 *
 * 于是 trine 列表里显示的是「最后一个问题」，和终端 `/resume` 里那行
 * Claude Code 起的标题对不上。ai-title 记录就在转录文件里，直接补读。
 *
 * ## 读法与缓存
 *
 * 每个会话只读文件**尾部 64KB**（ai-title 会随标题更新反复追加，最后一条最新），
 * 按 `(size, mtimeMs)` 缓存：列表刷新时没有新内容就只做一次 stat，不反复读盘。
 * 读不到（老会话没有这条记录）返回 undefined，调用方回退 summary。
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TAIL_BYTES = 64 * 1024;
/** 列表批量读时的并发上限：避免一次打开几百个文件 */
const MAX_CONCURRENCY = 8;

interface CacheEntry {
  size: number;
  mtimeMs: number;
  title: string | undefined;
}

const cache = new Map<string, CacheEntry>();

function projectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * 工作目录 → `~/.claude/projects` 下的目录名。
 * CC 的编码是「非字母数字一律换成 '-'」：`E:\agent-cluster\carl` → `E--agent-cluster-carl`。
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** 会话转录路径：先按 cwd 直接命中，失败再扫一遍目录（worktree、旧编码等） */
async function resolveTranscriptPath(sessionId: string, cwd: string | undefined): Promise<string | undefined> {
  const root = projectsDir();
  if (cwd !== undefined && cwd !== '') {
    const direct = join(root, encodeProjectDir(cwd), `${sessionId}.jsonl`);
    try {
      await fs.access(direct);
      return direct;
    } catch {
      /* 落到全目录扫描 */
    }
  }
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(root);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* 下一个 */
    }
  }
  return undefined;
}

/**
 * 从转录文本里取**最后一条** ai-title。
 * 逐行 JSON.parse：文件尾可能被截断（正在写入），坏行跳过即可。
 */
export function lastAiTitle(text: string): string | undefined {
  let title: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.includes('ai-title')) continue;
    try {
      const record = JSON.parse(line) as { type?: unknown; aiTitle?: unknown };
      if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim() !== '') {
        title = record.aiTitle.trim();
      }
    } catch {
      /* 截断行，跳过 */
    }
  }
  return title;
}

/** 读一个会话的 ai-title；没有 / 读不到 → undefined */
export async function readAiTitle(sessionId: string, cwd?: string): Promise<string | undefined> {
  const path = await resolveTranscriptPath(sessionId, cwd);
  if (path === undefined) return undefined;
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    return undefined;
  }
  const hit = cache.get(path);
  if (hit !== undefined && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.title;

  let title: string | undefined;
  try {
    const length = Math.min(stat.size, TAIL_BYTES);
    const handle = await fs.open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stat.size - length);
      title = lastAiTitle(buffer.toString('utf8'));
    } finally {
      await handle.close();
    }
  } catch {
    /* 读失败按没有处理，下次 stat 变化会重试 */
  }
  cache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, title });
  return title;
}

/** 批量读（列表用）：返回 sessionId → aiTitle，没有的不放进 map */
export async function readAiTitles(
  items: readonly { sessionId: string; cwd?: string }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = [...items];
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      const title = await readAiTitle(item.sessionId, item.cwd);
      if (title !== undefined) out.set(item.sessionId, title);
    }
  });
  await Promise.all(workers);
  return out;
}

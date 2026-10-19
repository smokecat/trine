/**
 * 会话来源探测：是不是 `claude -p` 之类脚本跑出来的**非交互**会话（SessionMeta.headless）。
 *
 * ## 依据（真 claude 2.1.301 实测）
 *
 * 转录每条 user / assistant 行都带顶层 `entrypoint`，取值是 CLI 的
 * `CLAUDE_CODE_ENTRYPOINT`：
 *
 * - `cli`：终端里交互运行；
 * - `sdk-ts`：TS Agent SDK——**trine 自己开的会话就是这个**；
 * - `sdk-cli`：`claude -p` / `--print`；`sdk-py`：Python SDK。
 *
 * 后两种算非交互（HEADLESS_ENTRYPOINTS）。取**第一条**带 entrypoint 的行：之后
 * 在 trine 里 resume 一个 `-p` 会话，后续行会变成 `sdk-ts`，但会话的出身不变。
 * SDK 的 listSessions 不给这个字段，所以自己读 jsonl 开头。
 *
 * ## 转录在哪
 *
 * `<配置目录>/projects/<项目目录名>/<sessionId>.jsonl`，目录名规则与猜不中时的
 * 扫描兜底同 subagent-history.ts。
 *
 * 结论按 sessionId 永久缓存（出身不会变）；文件没找到不缓存，下次再试。
 * 读 / 解析失败一律当「不知道」（不标 headless），不抛。
 */
import { open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultProjectsDir, projectDirName } from './subagent-history.ts';

export const HEADLESS_ENTRYPOINTS: ReadonlySet<string> = new Set(['sdk-cli', 'sdk-py']);

/** 最多读转录开头这么多字节（首条 user 行可能带很长的粘贴内容） */
const MAX_HEAD_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

/** jsonl 开头文本 → 第一条带顶层 entrypoint 的行的值；只看完整的行 */
export function firstEntrypoint(text: string): string | undefined {
  const lines = text.split('\n');
  // 最后一段可能是被截断的半行
  lines.pop();
  for (const line of lines) {
    if (!line.includes('"entrypoint"')) continue;
    try {
      const value = (JSON.parse(line) as Record<string, unknown>)['entrypoint'];
      if (typeof value === 'string' && value !== '') return value;
    } catch {
      // 坏行跳过
    }
  }
  return undefined;
}

/** 读文件开头，按块往后读，直到找到 entrypoint 或读满上限 / 到文件尾 */
export async function readEntrypoint(path: string): Promise<string | undefined> {
  const handle = await open(path, 'r');
  try {
    const decoder = new TextDecoder();
    const buf = new Uint8Array(CHUNK_BYTES);
    let text = '';
    let offset = 0;
    while (offset < MAX_HEAD_BYTES) {
      const { bytesRead } = await handle.read(buf, 0, CHUNK_BYTES, offset);
      if (bytesRead === 0) return firstEntrypoint(`${text}${decoder.decode()}\n`);
      offset += bytesRead;
      text += decoder.decode(buf.subarray(0, bytesRead), { stream: true });
      const found = firstEntrypoint(text);
      if (found !== undefined) return found;
      // 已扫过的完整行不必留着
      const cut = text.lastIndexOf('\n');
      if (cut >= 0) text = text.slice(cut + 1);
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

export interface SessionRef {
  sessionId: string;
  cwd?: string | undefined;
}

/** 批量探测：返回已知结论的 sessionId → headless；不知道的不在表里 */
export type HeadlessProbe = (sessions: readonly SessionRef[]) => Promise<ReadonlyMap<string, boolean>>;

async function exists(path: string): Promise<boolean> {
  try {
    await (await open(path, 'r')).close();
    return true;
  } catch {
    return false;
  }
}

/** cwd 猜的候选路径（字面 + realpath 两种目录名） */
async function guessPaths(projects: string, ref: SessionRef): Promise<string[]> {
  if (ref.cwd === undefined || ref.cwd === '') return [];
  const names = new Set([projectDirName(ref.cwd)]);
  try {
    names.add(projectDirName(await realpath(ref.cwd)));
  } catch {
    // cwd 已不存在：只用字面值猜
  }
  return [...names].map((name) => join(projects, name, `${ref.sessionId}.jsonl`));
}

/** 扫一遍 projects 下所有目录，给猜不中的会话找转录 */
async function scanPaths(projects: string, wanted: ReadonlySet<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    let files: string[];
    try {
      files = await readdir(join(projects, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const id = file.slice(0, -'.jsonl'.length);
      if (wanted.has(id) && !out.has(id)) out.set(id, join(projects, dir, file));
    }
    if (out.size === wanted.size) break;
  }
  return out;
}

export function createHeadlessProbe(options: { projectsDir?: string } = {}): HeadlessProbe {
  const cache = new Map<string, boolean>();
  return async (sessions) => {
    const projects = options.projectsDir ?? defaultProjectsDir();
    const pending = sessions.filter((s) => !cache.has(s.sessionId));
    const located = new Map<string, string>();
    await Promise.all(
      pending.map(async (ref) => {
        for (const path of await guessPaths(projects, ref)) {
          if (await exists(path)) {
            located.set(ref.sessionId, path);
            return;
          }
        }
      }),
    );
    const missing = new Set(pending.map((s) => s.sessionId).filter((id) => !located.has(id)));
    if (missing.size > 0) {
      for (const [id, path] of await scanPaths(projects, missing)) located.set(id, path);
    }
    await Promise.all(
      [...located].map(async ([id, path]) => {
        try {
          const entrypoint = await readEntrypoint(path);
          cache.set(id, entrypoint !== undefined && HEADLESS_ENTRYPOINTS.has(entrypoint));
        } catch {
          // 读失败：不缓存，下次再试
        }
      }),
    );
    const out = new Map<string, boolean>();
    for (const s of sessions) {
      const v = cache.get(s.sessionId);
      if (v !== undefined) out.set(s.sessionId, v);
    }
    return out;
  };
}

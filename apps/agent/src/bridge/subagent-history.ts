/**
 * 子 agent 转录的定位与读取（`subagent.history.request`）——纯文件读，不拉起会话。
 *
 * ## 转录在哪（真 claude 2.1.283 实测）
 *
 * `<配置目录>/projects/<项目目录名>/<sessionId>/subagents/agent-<agentId>.jsonl`，
 * 旁边 `agent-<agentId>.meta.json` = `{agentType, description, toolUseId, spawnDepth, …}`。
 * 嵌套子 agent 可能在 subagents 下的子目录里（SDK 内部的 agentRelPath），所以递归找。
 * 靠 meta.json 的 `toolUseId`（= 父 Agent/Task 工具调用的 tool_use id）对上请求。
 *
 * - 配置目录：`CLAUDE_CONFIG_DIR`，缺省 `~/.claude`（与 CLI 一致）；
 * - 项目目录名：cwd 把非字母数字换成 `-`（SDK 同款规则）。CLI 用的是 realpath
 *   （macOS 上 `/var/…` 落盘成 `-private-var-…`），长路径还会被截断加哈希——所以
 *   cwd 猜不中就扫一遍 projects 下所有目录找 `<sessionId>/`，与 SDK 不给 dir 时同理。
 *
 * 找不到 → undefined（router 回空 items）。读 / 解析失败的单个文件跳过，不抛。
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 递归找 meta.json 的深度上限（嵌套子 agent 很少超过两三层） */
const MAX_WALK_DEPTH = 6;
/** 一个 subagents 目录下最多看这么多个 meta.json（防病态目录拖慢） */
const MAX_META_FILES = 2000;

export interface SubagentTranscriptLocator {
  /** 会话 cwd（state.json / manager meta）；省略则直接扫全部项目目录 */
  cwd?: string | undefined;
  /** `projects` 目录；测试注入，缺省按 CLAUDE_CONFIG_DIR / ~/.claude 推 */
  projectsDir?: string;
}

/** 与 SDK 同款的项目目录名规则 */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function defaultProjectsDir(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  return join(configDir !== undefined && configDir !== '' ? configDir : join(homedir(), '.claude'), 'projects');
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 会话目录（含 subagents/ 的那个）候选：cwd 猜的在前，扫描兜底在后 */
async function sessionDirs(sessionId: string, locator: SubagentTranscriptLocator): Promise<string[]> {
  const projects = locator.projectsDir ?? defaultProjectsDir();
  const out: string[] = [];
  const cwd = locator.cwd;
  if (cwd !== undefined && cwd !== '') {
    const names = new Set([projectDirName(cwd)]);
    try {
      names.add(projectDirName(await realpath(cwd)));
    } catch {
      // cwd 已不存在：只用字面值猜
    }
    for (const name of names) {
      const dir = join(projects, name, sessionId);
      if (await isDir(join(dir, 'subagents'))) out.push(dir);
    }
    if (out.length > 0) return out;
  }
  let entries: string[];
  try {
    entries = await readdir(projects);
  } catch {
    return out;
  }
  for (const name of entries) {
    const dir = join(projects, name, sessionId);
    if (await isDir(join(dir, 'subagents'))) out.push(dir);
  }
  return out;
}

/** 在 subagents 目录下递归找 toolUseId 对得上的 meta.json，返回同名 jsonl 路径 */
async function findByToolUseId(root: string, toolUseId: string): Promise<string | undefined> {
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<string | undefined> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        subdirs.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.meta.json')) continue;
      if (++seen > MAX_META_FILES) return undefined;
      const path = join(dir, entry.name);
      try {
        const meta = JSON.parse(await readFile(path, 'utf8')) as { toolUseId?: unknown };
        if (meta.toolUseId === toolUseId) return path.slice(0, -'.meta.json'.length) + '.jsonl';
      } catch {
        // 坏 meta：跳过
      }
    }
    if (depth >= MAX_WALK_DEPTH) return undefined;
    for (const sub of subdirs) {
      const hit = await walk(sub, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  return walk(root, 0);
}

/** 找到某次 Agent/Task 调用的子转录文件路径；找不到 undefined */
export async function findSubagentTranscript(
  sessionId: string,
  toolUseId: string,
  locator: SubagentTranscriptLocator = {},
): Promise<string | undefined> {
  // sessionId / toolUseId 都会拼进路径或参与匹配：只认安全字符，防 `../` 之类
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return undefined;
  for (const dir of await sessionDirs(sessionId, locator)) {
    const hit = await findByToolUseId(join(dir, 'subagents'), toolUseId);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** 读 jsonl → 每行 JSON.parse（坏行跳过）；文件不在返回 [] */
export async function readJsonlLines(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 写到一半的尾行 / 坏行：跳过
    }
  }
  return out;
}

/** 定位 + 读：找不到返回 []（调用方回空 items） */
export async function readSubagentTranscript(
  sessionId: string,
  toolUseId: string,
  locator: SubagentTranscriptLocator = {},
): Promise<unknown[]> {
  const path = await findSubagentTranscript(sessionId, toolUseId, locator);
  return path === undefined ? [] : readJsonlLines(path);
}

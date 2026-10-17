/**
 * 真 SDK 探针脚本：由 sdk-probe.test.ts 在**子进程**里跑，环境变量
 * CLAUDE_CONFIG_DIR 指向一个临时目录（绝不碰真 ~/.claude）。
 *
 * 为什么放子进程：bun test 所有文件同进程，SDK 若在首次调用时缓存了配置目录，
 * 进程内改 env 既可能不生效、也可能污染别的测试。子进程的 env 从一开始就是隔离的。
 *
 * 输出一行 JSON（ProbeResult）到 stdout，断言在测试文件里做。
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSessionInfo, listSessions, renameSession, deleteSession } from '@anthropic-ai/claude-agent-sdk';
import { isSessionNotFound, normalizeSessionTitle } from '../app/session-mutations.ts';

export interface ProbeResult {
  configDir: string;
  notFound: { op: string; message: string; matched: boolean }[];
  roundtrip: { name: string; normalized: string; readBack: string | undefined }[];
  rawReadBack: { raw: string; readBack: string | undefined };
  metadataOnly: {
    listed: boolean;
    summary: string | undefined;
    infoFound: boolean;
    /** SDK 读出的残影形状：没有 cwd、没有 firstPrompt（复查测试的假文件按这个造） */
    cwd: string | undefined;
    firstPrompt: string | undefined;
    /** deleteSession 能删掉它（CB1 复查再删的前提）：不抛、文件没了、再查为空 */
    deleteError: string | undefined;
    fileExistsAfterDelete: boolean;
    infoFoundAfterDelete: boolean;
  };
  traversal: { renameError: string | undefined; info: unknown };
  listedIds: string[];
}

const configDir = process.env.CLAUDE_CONFIG_DIR;
if (configDir === undefined || configDir === '') throw new Error('必须设置 CLAUDE_CONFIG_DIR（临时目录）');

const project = join(configDir, 'projects', '-tmp-trine-probe');
await mkdir(project, { recursive: true });
const file = (sid: string) => join(project, `${sid}.jsonl`);
const sidN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const userLine = (sid: string) =>
  `${JSON.stringify({
    type: 'user',
    sessionId: sid,
    cwd: '/tmp/trine-probe',
    message: { role: 'user', content: 'probe' },
    uuid: `u-${sid}`,
    timestamp: new Date(0).toISOString(),
  })}\n`;

async function errorOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// 1. not-found 文本：不存在的会话 rename / delete；0 字节文件 rename
const notFound: ProbeResult['notFound'] = [];
const missing = sidN(1);
const empty = sidN(2);
await writeFile(file(empty), '');
for (const [op, fn] of [
  ['rename:missing', () => renameSession(missing, 'x')],
  ['delete:missing', () => deleteSession(missing)],
  ['rename:empty-file', () => renameSession(empty, 'x')],
] as const) {
  const message = (await errorOf(fn)) ?? '(没有抛错)';
  notFound.push({ op, message, matched: isSessionNotFound(new Error(message)) });
}

// 2. normalize → rename → getSessionInfo 逐字相等
const cases: [string, string][] = [
  ['emoji', `  ${'😀'.repeat(250)}  `],
  ['long', `${'标题'.repeat(80)}\u0000${'x'.repeat(100)}`],
  ['whitespace', '  部署\n\t脚本​   v2  '],
];
const roundtrip: ProbeResult['roundtrip'] = [];
let n = 10;
for (const [name, raw] of cases) {
  const sid = sidN(n++);
  await writeFile(file(sid), userLine(sid));
  const normalized = normalizeSessionTitle(raw);
  await renameSession(sid, normalized);
  roundtrip.push({ name, normalized, readBack: (await getSessionInfo(sid))?.customTitle });
}

// 2b. SDK 读取时**不**规范化：原样写进去的控制字符原样读回（评审 minor 5 的事实依据）
const rawSid = sidN(20);
await writeFile(file(rawSid), userLine(rawSid));
const raw = 'a\u0000b\n\tc';
await renameSession(rawSid, raw);
const rawReadBack = { raw, readBack: (await getSessionInfo(rawSid))?.customTitle };

// 3. 只含一行 custom-title 的 jsonl（CLI 退出 re-stamp 重建出的残缺转录）会被列出，
//    且 deleteSession 能删掉它
const ghost = sidN(30);
await writeFile(file(ghost), `${JSON.stringify({ type: 'custom-title', customTitle: 'ghost', sessionId: ghost })}\n`);
const listed = await listSessions({});
const ghostListed = listed.find((s) => s.sessionId === ghost);
const ghostInfo = await getSessionInfo(ghost);
const ghostDeleteError = await errorOf(() => deleteSession(ghost));
const metadataOnly: ProbeResult['metadataOnly'] = {
  listed: ghostListed !== undefined,
  summary: ghostListed?.summary,
  infoFound: ghostInfo !== undefined,
  cwd: ghostInfo?.cwd,
  firstPrompt: ghostInfo?.firstPrompt,
  deleteError: ghostDeleteError,
  fileExistsAfterDelete: existsSync(file(ghost)),
  infoFoundAfterDelete: (await getSessionInfo(ghost)) !== undefined,
};

// 4. sessionId 路径穿越
const traversal = {
  renameError: await errorOf(() => renameSession('../victim', 'x')),
  info: (await getSessionInfo('../victim')) ?? null,
};

const result: ProbeResult = {
  configDir,
  notFound,
  roundtrip,
  rawReadBack,
  metadataOnly,
  traversal,
  listedIds: listed.map((s) => s.sessionId).sort(),
};
process.stdout.write(`${JSON.stringify(result)}\n`);

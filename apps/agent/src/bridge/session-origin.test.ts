/**
 * 会话来源探测：entrypoint 解析、转录定位（cwd 猜 + 扫描兜底）、缓存。
 *
 * 转录行用合成数据，只保留与探测相关的字段形状（queue-operation 行在前、
 * user 行顶层带 entrypoint）。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHeadlessProbe, firstEntrypoint, readEntrypoint } from './session-origin.ts';
import { projectDirName } from './subagent-history.ts';

const tmpRoots: string[] = [];
afterAll(async () => {
  for (const d of tmpRoots) await rm(d, { recursive: true, force: true });
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'trine-origin-'));
  tmpRoots.push(root);
  return root;
}

function transcript(sessionId: string, entrypoint: string | undefined, prompt = 'hello'): string {
  const lines: unknown[] = [
    { type: 'queue-operation', operation: 'enqueue', sessionId, content: prompt },
    {
      type: 'user',
      message: { role: 'user', content: prompt },
      sessionId,
      ...(entrypoint === undefined ? {} : { entrypoint }),
    },
    { type: 'assistant', message: { role: 'assistant', content: 'ok' }, sessionId, entrypoint: 'sdk-ts' },
  ];
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

async function writeTranscript(projects: string, dir: string, sessionId: string, body: string): Promise<string> {
  await mkdir(join(projects, dir), { recursive: true });
  const path = join(projects, dir, `${sessionId}.jsonl`);
  await writeFile(path, body);
  return path;
}

describe('firstEntrypoint', () => {
  test('取第一条带顶层 entrypoint 的完整行；末尾半行不解析', () => {
    expect(firstEntrypoint(transcript('s', 'sdk-cli'))).toBe('sdk-cli');
    expect(firstEntrypoint('{"type":"user","entrypoint":"cli"}')).toBeUndefined();
    expect(firstEntrypoint('{"type":"user","entrypoint":"cli"}\n')).toBe('cli');
  });

  test('只在正文里出现的 "entrypoint" 字样不算', () => {
    const line = JSON.stringify({ type: 'user', message: { content: '"entrypoint":"sdk-cli"' } });
    expect(firstEntrypoint(`${line}\n{"entrypoint":"cli"}\n`)).toBe('cli');
  });

  test('坏行跳过', () => {
    expect(firstEntrypoint('{"entrypoint":\n{"entrypoint":"sdk-py"}\n')).toBe('sdk-py');
  });
});

describe('readEntrypoint', () => {
  test('首条 user 行超过一个读块也能读到', async () => {
    const root = await tmpRoot();
    const path = await writeTranscript(root, 'p', 's1', transcript('s1', 'sdk-cli', 'x'.repeat(200_000)));
    expect(await readEntrypoint(path)).toBe('sdk-cli');
  });

  test('没有 entrypoint → undefined', async () => {
    const root = await tmpRoot();
    const path = await writeTranscript(root, 'p', 's1', '{"type":"summary"}\n');
    expect(await readEntrypoint(path)).toBeUndefined();
  });
});

describe('createHeadlessProbe', () => {
  test('sdk-cli / sdk-py 算非交互；cli / sdk-ts / 无 entrypoint 不算', async () => {
    const projects = join(await tmpRoot(), 'projects');
    const cwd = '/work/repo';
    const dir = projectDirName(cwd);
    await writeTranscript(projects, dir, 'p1', transcript('p1', 'sdk-cli'));
    await writeTranscript(projects, dir, 'p2', transcript('p2', 'sdk-py'));
    await writeTranscript(projects, dir, 'i1', transcript('i1', 'cli'));
    await writeTranscript(projects, dir, 't1', transcript('t1', 'sdk-ts'));
    await writeTranscript(projects, dir, 'n1', transcript('n1', undefined));
    const probe = createHeadlessProbe({ projectsDir: projects });
    const result = await probe(['p1', 'p2', 'i1', 't1', 'n1'].map((sessionId) => ({ sessionId, cwd })));
    expect(Object.fromEntries(result)).toEqual({ p1: true, p2: true, i1: false, t1: false, n1: false });
  });

  test('cwd 猜不中（目录名截断 / 未知 cwd）时扫描 projects 兜底；找不到的不在结果里', async () => {
    const projects = join(await tmpRoot(), 'projects');
    await writeTranscript(projects, '-some-truncated-name-abc123', 'p1', transcript('p1', 'sdk-cli'));
    const probe = createHeadlessProbe({ projectsDir: projects });
    const result = await probe([
      { sessionId: 'p1', cwd: '/elsewhere' },
      { sessionId: 'gone' },
    ]);
    expect(Object.fromEntries(result)).toEqual({ p1: true });
  });

  test('结论按 sessionId 缓存：文件之后被删也照旧；没找到的下次再试', async () => {
    const projects = join(await tmpRoot(), 'projects');
    const path = await writeTranscript(projects, 'd', 'p1', transcript('p1', 'sdk-cli'));
    const probe = createHeadlessProbe({ projectsDir: projects });
    expect((await probe([{ sessionId: 'p1' }, { sessionId: 'later' }])).get('later')).toBeUndefined();
    await rm(path);
    await writeTranscript(projects, 'd', 'later', transcript('later', 'sdk-cli'));
    const again = await probe([{ sessionId: 'p1' }, { sessionId: 'later' }]);
    expect(Object.fromEntries(again)).toEqual({ p1: true, later: true });
  });

  test('projects 目录不存在 → 空结果，不抛', async () => {
    const probe = createHeadlessProbe({ projectsDir: join(await tmpRoot(), 'nope') });
    expect((await probe([{ sessionId: 'x', cwd: '/a' }])).size).toBe(0);
  });
});

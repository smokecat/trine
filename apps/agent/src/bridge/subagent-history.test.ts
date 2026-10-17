/**
 * 子 agent 转录：定位（meta.json 的 toolUseId）+ 解析（toSubagentHistoryItems）。
 *
 * fixture 使用合成路径、标识和时间；保留转录的 parentUuid 与 attachment 链结构，
 * 用于覆盖 SDK getSubagentMessages 被 attachment 打断、只返回最后 1 条的回归。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryItemSchema } from '@trine/core';
import { toSubagentHistoryItems } from './history.ts';
import { findSubagentTranscript, projectDirName, readJsonlLines, readSubagentTranscript } from './subagent-history.ts';

const FIXTURE_DIR = join(import.meta.dir, '..', 'testing', 'fixtures', 'subagent');
const FIXTURE = join(FIXTURE_DIR, 'agent-a000000000000001.jsonl');
const PARENT = 'toolu_fixture0002';
const SID = '00000000-0000-0000-0000-000000000014';

const tmpRoots: string[] = [];
afterAll(async () => {
  for (const d of tmpRoots) await rm(d, { recursive: true, force: true });
});

/** 造一个假 projects 目录：<projects>/<projectDir>/<sid>/subagents/<rel>/ 放 fixture */
async function fakeProjects(projectDir: string, rel = ''): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'trine-sub-'));
  tmpRoots.push(root);
  const projects = join(root, 'projects');
  const sub = join(projects, projectDir, SID, 'subagents', rel);
  await mkdir(sub, { recursive: true });
  await cp(FIXTURE_DIR, sub, { recursive: true });
  return projects;
}

describe('toSubagentHistoryItems（合成子转录形状）', () => {
  test('读出 3 个工具项（Bash / Write / Read），状态与摘要已配好；prompt 与报告不进', async () => {
    const items = toSubagentHistoryItems(await readJsonlLines(FIXTURE));
    expect(items.map((i) => (i.kind === 'tool' ? [i.toolName, i.argSummary, i.status] : [i.kind]))).toEqual([
      ['Bash', 'echo SUB1', 'ok'],
      ['Write', '…/trine-fixture/sub.txt', 'ok'],
      ['Read', '…/trine-fixture/sub.txt', 'ok'],
    ]);
    expect(items[0]).toMatchObject({ id: 'toolu_fixture0001', outputPreview: 'SUB1' });
    for (const item of items) {
      expect(HistoryItemSchema.safeParse(item).success).toBe(true);
      expect(item.kind === 'tool' && typeof item.durationMs === 'number').toBe(true);
    }
  });

  test('坏行 / 非对象 / 缺 uuid 的行跳过，不抛', () => {
    expect(toSubagentHistoryItems([null, 3, 'x', { type: 'user' }, { type: 'attachment', uuid: 'a' }])).toEqual([]);
  });
});

describe('findSubagentTranscript', () => {
  test('按 cwd 推项目目录名，找 meta.json 的 toolUseId 对上的 jsonl', async () => {
    const cwd = '/Users/u/my repo';
    const projects = await fakeProjects(projectDirName(cwd));
    const path = await findSubagentTranscript(SID, PARENT, { cwd, projectsDir: projects });
    expect(path).toBe(join(projects, projectDirName(cwd), SID, 'subagents', 'agent-a000000000000001.jsonl'));
    const lines = await readSubagentTranscript(SID, PARENT, { cwd, projectsDir: projects });
    expect(toSubagentHistoryItems(lines)).toHaveLength(3);
  });

  test('cwd 猜不中（realpath / 长路径哈希）→ 扫描全部项目目录兜底；嵌套子目录也找得到', async () => {
    const projects = await fakeProjects('-private-var-folders-x', 'nested/deeper');
    expect(await findSubagentTranscript(SID, PARENT, { cwd: '/var/folders/x', projectsDir: projects })).toBe(
      join(projects, '-private-var-folders-x', SID, 'subagents', 'nested', 'deeper', 'agent-a000000000000001.jsonl'),
    );
    expect(await findSubagentTranscript(SID, PARENT, { projectsDir: projects })).toBeDefined();
  });

  test('toolUseId 不匹配 / 会话不存在 / projects 目录不存在 / 非法 sessionId → undefined 或 []', async () => {
    const projects = await fakeProjects('-repo');
    expect(await findSubagentTranscript(SID, 'toolu_other', { projectsDir: projects })).toBeUndefined();
    expect(await findSubagentTranscript('ghost', PARENT, { projectsDir: projects })).toBeUndefined();
    expect(await findSubagentTranscript(SID, PARENT, { projectsDir: join(projects, 'nope') })).toBeUndefined();
    expect(await findSubagentTranscript('../x', PARENT, { projectsDir: projects })).toBeUndefined();
    expect(await readSubagentTranscript('ghost', PARENT, { projectsDir: projects })).toEqual([]);
  });

  test('坏 meta.json 跳过，继续找别的', async () => {
    const projects = await fakeProjects('-repo');
    await writeFile(join(projects, '-repo', SID, 'subagents', 'agent-bad.meta.json'), '{not json');
    expect(await findSubagentTranscript(SID, PARENT, { projectsDir: projects })).toBeDefined();
  });
});

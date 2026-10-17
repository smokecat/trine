/**
 * 真 SDK 探针（评审「测试质量」：仓库里此前没有任何测试调用真 SDK 的
 * renameSession / deleteSession / getSessionInfo / listSessions，e2e 全走
 * FakeTranscripts）。固化 reviewer 手工验证过的几条事实，SDK 升级时第一时间暴露偏差：
 *
 * - not-found 错误文本能被 `isSessionNotFound` 匹配（rename / delete 的业务分支靠它）；
 * - normalize → rename → getSessionInfo 逐字相等（emoji / 超长 / 空白三组）；
 * - SDK 读取 customTitle 时不做规范化（session-mutations.ts 注释的依据）；
 * - 只含一行 custom-title 的 jsonl 会被 listSessions / getSessionInfo 列出——这正是
 *   删除后 8s 复查（CB1）存在的理由；deleteSession 也能删掉它（复查再删的前提）；
 * - sessionId 路径穿越被 SDK 拒绝。
 *
 * 在子进程里跑（见 testing/sdk-probe-script.ts 文件头），CLAUDE_CONFIG_DIR 指向
 * 临时目录，结束 rm -rf。SDK 这几个函数是纯 JS 文件操作，不需要 claude 二进制与网络；
 * 只有 SDK 包本身装不上时才跳过。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProbeResult } from '../testing/sdk-probe-script.ts';

const sdkAvailable = (() => {
  try {
    require.resolve('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
})();

let configDir: string;
let result: ProbeResult;

beforeAll(async () => {
  if (!sdkAvailable) return;
  configDir = await mkdtemp(join(tmpdir(), 'trine-sdk-probe-'));
  const script = join(import.meta.dir, '..', 'testing', 'sdk-probe-script.ts');
  const proc = Bun.spawn([process.execPath, script], {
    cwd: join(import.meta.dir, '..', '..'),
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`探针子进程退出码 ${code}：${stderr}`);
  result = JSON.parse(stdout.trim().split('\n').at(-1)!) as ProbeResult;
}, 30_000);

afterAll(async () => {
  if (configDir !== undefined) await rm(configDir, { recursive: true, force: true });
});

describe.skipIf(!sdkAvailable)('真 SDK 探针（临时 CLAUDE_CONFIG_DIR）', () => {
  test('只读写了临时目录：列出的会话全是探针自己造的', () => {
    expect(result.configDir).toBe(configDir);
    expect(existsSync(join(configDir, 'projects', '-tmp-trine-probe'))).toBe(true);
    for (const id of result.listedIds) expect(id.startsWith('00000000-0000-4000-8000-')).toBe(true);
  });

  test('not-found 错误文本能被 isSessionNotFound 匹配（含 0 字节文件）', () => {
    expect(result.notFound.map((r) => r.op)).toEqual(['rename:missing', 'delete:missing', 'rename:empty-file']);
    for (const r of result.notFound) {
      expect(r.message).toContain('not found');
      expect(r.matched).toBe(true);
    }
  });

  test('normalize → rename → getSessionInfo 逐字相等（emoji / 超长 / 空白）', () => {
    expect(result.roundtrip.map((r) => r.name)).toEqual(['emoji', 'long', 'whitespace']);
    for (const r of result.roundtrip) {
      expect(r.normalized).not.toBe('');
      expect(r.readBack).toBe(r.normalized);
    }
    expect([...result.roundtrip[0]!.normalized]).toHaveLength(200);
  });

  test('SDK 读取 customTitle 时不做规范化（原样读回）', () => {
    expect(result.rawReadBack.readBack).toBe(result.rawReadBack.raw);
  });

  test('只含 custom-title 一行的 jsonl 会被列出（CB1 删除后复查的理由）', () => {
    const { listed, summary, infoFound, cwd, firstPrompt } = result.metadataOnly;
    expect({ listed, summary, infoFound }).toEqual({ listed: true, summary: 'ghost', infoFound: true });
    // 残影形状：没有 cwd、没有 firstPrompt（router.test 的复查用例按这个造假文件）
    expect(cwd).toBeUndefined();
    expect(firstPrompt).toBeUndefined();
  });

  test('deleteSession 能删掉只含元数据的 jsonl（CB1 复查再删的前提）', () => {
    expect(result.metadataOnly.deleteError).toBeUndefined();
    expect(result.metadataOnly.fileExistsAfterDelete).toBe(false);
    expect(result.metadataOnly.infoFoundAfterDelete).toBe(false);
  });

  test('sessionId 路径穿越被拒绝', () => {
    expect(result.traversal.renameError).toMatch(/Invalid sessionId/i);
    expect(result.traversal.info).toBeNull();
  });
});

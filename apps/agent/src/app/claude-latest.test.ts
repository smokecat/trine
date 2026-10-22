import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  autoCheckDisabled,
  CLAUDE_RELEASES_BASE,
  ClaudeLatestChecker,
  claudeConfigDir,
  fetchLatestClaudeVersion,
  readUpdateChannel,
} from './claude-latest.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trine-claude-latest-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 假发布源：按渠道回版本；urls 记录每次请求 */
function fakeReleases(versions: Record<string, string | Error>) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const channel = url.slice(CLAUDE_RELEASES_BASE.length + 1);
    const v = versions[channel];
    if (v instanceof Error) throw v;
    if (v === undefined) return new Response('not found', { status: 404 });
    return new Response(`${v}\n`);
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe('readUpdateChannel', () => {
  test('读 autoUpdatesChannel；缺文件 / 坏 JSON / 不认识的值 → latest', async () => {
    expect(await readUpdateChannel(dir)).toBe('latest');
    await writeFile(join(dir, 'settings.json'), '{ broken');
    expect(await readUpdateChannel(dir)).toBe('latest');
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'beta' }));
    expect(await readUpdateChannel(dir)).toBe('latest');
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }));
    expect(await readUpdateChannel(dir)).toBe('stable');
  });

  test('配置目录：CLAUDE_CONFIG_DIR 优先', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/x/cfg' })).toBe('/x/cfg');
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' }).endsWith('.claude')).toBe(true);
  });
});

describe('fetchLatestClaudeVersion', () => {
  test('按渠道请求，返回去空白的版本号', async () => {
    const { fetchImpl, urls } = fakeReleases({ stable: '2.1.300' });
    expect(await fetchLatestClaudeVersion('stable', { fetchImpl })).toBe('2.1.300');
    expect(urls).toEqual([`${CLAUDE_RELEASES_BASE}/stable`]);
  });

  test('非 2xx / 返回体不是版本号 → 抛', async () => {
    await expect(fetchLatestClaudeVersion('latest', fakeReleases({}))).rejects.toThrow('HTTP 404');
    await expect(fetchLatestClaudeVersion('latest', fakeReleases({ latest: '<html>' }))).rejects.toThrow('不是版本号');
  });
});

test('autoCheckDisabled：claude 自己关了自动更新 / 非必要流量', () => {
  expect(autoCheckDisabled({})).toBe(false);
  expect(autoCheckDisabled({ DISABLE_AUTOUPDATER: '0' })).toBe(false);
  expect(autoCheckDisabled({ DISABLE_AUTOUPDATER: '1' })).toBe(true);
  expect(autoCheckDisabled({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 'true' })).toBe(true);
});

describe('ClaudeLatestChecker', () => {
  test('成功：记下版本、渠道与时间，通知变化', async () => {
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }));
    let changes = 0;
    const checker = new ClaudeLatestChecker({
      ...fakeReleases({ stable: '2.1.300' }),
      configDir: dir,
      now: () => 1000,
      onChange: () => changes++,
    });
    expect(checker.current).toEqual({ channel: 'latest' });
    expect(await checker.check()).toEqual({ ok: true, version: '2.1.300', channel: 'stable' });
    expect(checker.current).toEqual({ channel: 'stable', version: '2.1.300', checkedAt: 1000 });
    expect(changes).toBe(1);
  });

  test('单飞：并发的检查共用一次请求', async () => {
    const releases = fakeReleases({ latest: '2.1.308' });
    const checker = new ClaudeLatestChecker({ ...releases, configDir: dir });
    const [a, b] = await Promise.all([checker.check(), checker.check()]);
    expect(a).toEqual(b);
    expect(releases.urls).toHaveLength(1);
    await checker.check();
    expect(releases.urls).toHaveLength(2);
  });

  test('失败：保留上次的版本并带上原因；再成功清掉原因；渠道变了不留旧版本', async () => {
    let next: string | Error = '2.1.300';
    const fetchImpl = (async () => {
      if (next instanceof Error) throw next;
      return new Response(next);
    }) as unknown as typeof fetch;
    let t = 1000;
    const checker = new ClaudeLatestChecker({ fetchImpl, configDir: dir, now: () => t });
    await checker.check();

    next = new Error('network down');
    t = 2000;
    const failed = await checker.check();
    expect(failed.ok).toBe(false);
    expect(checker.current).toMatchObject({ channel: 'latest', version: '2.1.300', checkedAt: 1000 });
    expect(checker.current.error).toContain('network down');

    next = '2.1.308';
    await checker.check();
    expect(checker.current).toEqual({ channel: 'latest', version: '2.1.308', checkedAt: 2000 });

    await writeFile(join(dir, 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }));
    next = new Error('again');
    await checker.check();
    expect(checker.current).toMatchObject({ channel: 'stable' });
    expect(checker.current.version).toBeUndefined();
  });

  test('startAuto：按延迟查、之后按间隔再查；关闭后停止；环境关了就不开', async () => {
    const releases = fakeReleases({ latest: '2.1.308' });
    const checker = new ClaudeLatestChecker({ ...releases, configDir: dir, env: {} });
    checker.startAuto(5, 20);
    await Bun.sleep(60);
    checker.dispose();
    const seen = releases.urls.length;
    expect(seen).toBeGreaterThanOrEqual(2);
    await Bun.sleep(40);
    expect(releases.urls).toHaveLength(seen);

    const off = fakeReleases({ latest: '2.1.308' });
    const disabled = new ClaudeLatestChecker({ ...off, configDir: dir, env: { DISABLE_AUTOUPDATER: '1' } });
    disabled.startAuto(1, 1);
    await Bun.sleep(20);
    disabled.dispose();
    expect(off.urls).toHaveLength(0);
  });
});

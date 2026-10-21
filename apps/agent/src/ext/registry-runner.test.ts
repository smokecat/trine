import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionLinksStore } from './links-store.ts';
import { ExtensionRegistry, inspectExtensionDir, ManifestError, MANIFEST_FILE, trustedPath } from './registry.ts';
import { ExtensionRunner, extensionEnv, runProcess, type RunResult } from './runner.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'trine-ext-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 在临时目录里造一个扩展：manifest + 可执行脚本 */
async function makeExtension(
  name: string,
  script: string,
  manifest: Record<string, unknown> = {},
): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(join(dir, 'bin', 'run'), `#!/bin/sh\n${script}\n`);
  await chmod(join(dir, 'bin', 'run'), 0o755);
  await writeFile(
    join(dir, MANIFEST_FILE),
    JSON.stringify({
      apiVersion: 1,
      id: name,
      name: `Ext ${name}`,
      version: '1.0.0',
      entry: ['bin/run'],
      contributes: { sessionPanel: { title: 'T' } },
      capabilities: ['prompt.insert'],
      ...manifest,
    }),
  );
  return dir;
}

describe('inspectExtensionDir', () => {
  test('相对入口按扩展目录解析，不受调用 cwd 影响', async () => {
    const dir = await makeExtension('alpha', 'echo {}');
    const inspected = await inspectExtensionDir(dir);
    expect(inspected.argv).toEqual([join(inspected.dir, 'bin', 'run')]);
  });

  test('裸命令名在可信 PATH 里找；./ 开头的参数按扩展目录解析', async () => {
    const dir = await makeExtension('beta', 'echo {}', { entry: ['sh', './bin/run', '--flag'] });
    const inspected = await inspectExtensionDir(dir, (cmd) => (cmd === 'sh' ? '/bin/sh' : null));
    expect(inspected.argv).toEqual(['/bin/sh', join(inspected.dir, 'bin', 'run'), '--flag']);
  });

  test('manifest 不合法 / apiVersion 不支持 / 入口不可执行 → ManifestError', async () => {
    const bad = await makeExtension('gamma', 'echo {}', { id: 'Bad Id' });
    await expect(inspectExtensionDir(bad)).rejects.toThrow(ManifestError);
    const future = await makeExtension('delta', 'echo {}', { apiVersion: 2 });
    await expect(inspectExtensionDir(future)).rejects.toThrow(/apiVersion/);
    const noexec = await makeExtension('eps', 'echo {}', { entry: ['bin/missing'] });
    await expect(inspectExtensionDir(noexec)).rejects.toThrow(/不可执行/);
  });

  test('trustedPath 去掉空段、. 和相对段', () => {
    expect(trustedPath('/usr/bin::.:rel/bin:/bin')).toBe('/usr/bin:/bin');
  });
});

describe('ExtensionRegistry', () => {
  test('add → 落盘、catalog；重载后保留；remove', async () => {
    const dir = await makeExtension('alpha', 'echo {}');
    const path = join(root, 'extensions.json');
    const registry = await ExtensionRegistry.load(path);
    const changes: string[] = [];
    registry.onChange = (id) => changes.push(id);
    const rev0 = registry.rev;
    await registry.add(dir);
    expect(registry.rev).not.toBe(rev0);
    expect(changes).toEqual(['alpha']);
    expect(registry.catalog()).toMatchObject([{ id: 'alpha', enabled: true, status: 'ok', policy: { trust: 'custom' } }]);
    const reloaded = await ExtensionRegistry.load(path);
    expect(reloaded.usable('alpha')?.argv?.[0]).toEndWith('/bin/run');
    expect(await reloaded.remove('alpha')).toBe(true);
    expect(reloaded.list()).toEqual([]);
  });

  test('权限：未声明能力 deny；自定义按缺省；全托管全部 allow', async () => {
    const dir = await makeExtension('alpha', 'echo {}', { capabilities: ['prompt.insert', 'prompt.send'] });
    const registry = await ExtensionRegistry.load(join(root, 'extensions.json'));
    await registry.add(dir);
    expect(registry.decide('alpha', 'session.create')).toBe('deny');
    expect(registry.decide('alpha', 'prompt.insert')).toBe('allow');
    expect(registry.decide('alpha', 'prompt.send')).toBe('confirm');
    await registry.setConfig('alpha', { policy: { trust: 'custom', capabilities: { 'prompt.send': 'deny' } } });
    expect(registry.decide('alpha', 'prompt.send')).toBe('deny');
    await registry.setConfig('alpha', { policy: { trust: 'full', capabilities: {} } });
    expect(registry.decide('alpha', 'prompt.send')).toBe('allow');
    expect(registry.fullTrust('alpha')).toBe(true);
    // 未声明的仍然 deny（全托管只覆盖声明过的能力）
    expect(registry.decide('alpha', 'session.create')).toBe('deny');
  });

  test('setConfig 只保留已知能力名；generation 变化', async () => {
    const dir = await makeExtension('alpha', 'echo {}');
    const path = join(root, 'extensions.json');
    const registry = await ExtensionRegistry.load(path);
    await registry.add(dir);
    const before = registry.get('alpha')!.generation;
    await registry.setConfig('alpha', {
      enabled: false,
      policy: { trust: 'custom', capabilities: { 'prompt.send': 'allow', __proto__: 'allow', bogus: 'allow' } as never },
    });
    expect(registry.get('alpha')!.generation).toBeGreaterThan(before);
    expect(registry.usable('alpha')).toBeUndefined();
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.items[0].policy.capabilities).toEqual({ 'prompt.send': 'allow' });
  });

  test('manifest 坏了：保留注册，状态 error，不可用', async () => {
    const dir = await makeExtension('alpha', 'echo {}');
    const path = join(root, 'extensions.json');
    const registry = await ExtensionRegistry.load(path);
    await registry.add(dir);
    await writeFile(join(dir, MANIFEST_FILE), '{bad');
    const reloaded = await ExtensionRegistry.load(path, { log: () => {} });
    expect(reloaded.catalog()[0]).toMatchObject({ id: 'alpha', status: 'error' });
    expect(reloaded.usable('alpha')).toBeUndefined();
  });

  test('注册表文件损坏：留底后按空启动，不回退成任何默认允许', async () => {
    const path = join(root, 'extensions.json');
    await writeFile(path, 'not json');
    const registry = await ExtensionRegistry.load(path, { log: () => {} });
    expect(registry.list()).toEqual([]);
  });
});

describe('runProcess', () => {
  const cwd = () => root;

  test('stdin 收到输入，stdout 的 JSON 原样返回；op 作为最后一个参数', async () => {
    const dir = await makeExtension('alpha', 'read line; printf \'{"op":"%s","in":%s}\' "$1" "$line"');
    const { argv } = await inspectExtensionDir(dir);
    const result = await runProcess({ argv, dir, cwd: cwd(), op: 'view', input: { a: 1 }, timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: true, output: { op: 'view', in: { a: 1 } } });
  });

  test('工作目录是会话 cwd', async () => {
    const dir = await makeExtension('alpha', 'printf \'{"cwd":"%s"}\' "$(pwd -P)"');
    const { argv } = await inspectExtensionDir(dir);
    const work = await mkdir(join(root, 'work'), { recursive: true }).then(() => join(root, 'work'));
    const result = (await runProcess({ argv, dir, cwd: work, op: 'view', input: {}, timeoutMs: 5_000 })) as Extract<RunResult, { ok: true }>;
    expect((result.output as { cwd: string }).cwd).toEndWith('/work');
  });

  test('非法 JSON / 非 0 退出 → invalid_output；stderr 保留末尾', async () => {
    const dir = await makeExtension('alpha', 'echo oops >&2; echo notjson');
    const { argv } = await inspectExtensionDir(dir);
    const result = await runProcess({ argv, dir, cwd: cwd(), op: 'view', input: {}, timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: false, code: 'invalid_output' });
    expect(result.stderr).toContain('oops');
    const exit = await makeExtension('beta', 'exit 3');
    const r2 = await runProcess({ argv: (await inspectExtensionDir(exit)).argv, dir: exit, cwd: cwd(), op: 'view', input: {}, timeoutMs: 5_000 });
    expect(r2).toMatchObject({ ok: false, code: 'invalid_output', message: expect.stringContaining('3') });
  });

  test('超时：整组被杀（含扩展起的子进程）', async () => {
    const marker = join(root, 'child-alive');
    const dir = await makeExtension('alpha', `(sleep 3; touch ${marker}) & sleep 30`);
    const { argv } = await inspectExtensionDir(dir);
    const result = await runProcess({ argv, dir, cwd: cwd(), op: 'view', input: {}, timeoutMs: 300 }, { killGraceMs: 200 });
    expect(result).toMatchObject({ ok: false, code: 'timeout' });
    await Bun.sleep(3_500);
    expect(await Bun.file(marker).exists()).toBe(false);
  }, 10_000);

  test('输出超限 → output_limit', async () => {
    const dir = await makeExtension('alpha', 'head -c 700000 /dev/zero | tr "\\0" a');
    const { argv } = await inspectExtensionDir(dir);
    const result = await runProcess({ argv, dir, cwd: cwd(), op: 'view', input: {}, timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: false, code: 'output_limit' });
  });

  test('cwd 不存在 → not_found，不起进程', async () => {
    const dir = await makeExtension('alpha', 'echo {}');
    const { argv } = await inspectExtensionDir(dir);
    const result = await runProcess({ argv, dir, cwd: join(root, 'nope'), op: 'view', input: {}, timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });

  test('环境变量白名单：不继承凭据与注入入口', () => {
    const env = extensionEnv(
      { HOME: '/h', PATH: '/usr/bin::.', LC_ALL: 'C', ANTHROPIC_API_KEY: 'x', BASH_ENV: '/evil', NODE_OPTIONS: '--require x', LD_PRELOAD: 'y' },
      '/ext',
    );
    expect(env).toEqual({ HOME: '/h', PATH: '/usr/bin', LC_ALL: 'C', TRINE_EXT_API: '1', TRINE_EXT_DIR: '/ext' });
  });
});

describe('ExtensionRunner', () => {
  test('每扩展并发上限；用户动作排在刷新前面', async () => {
    const order: string[] = [];
    const gates: (() => void)[] = [];
    const runner = new ExtensionRunner({
      run: (req) =>
        new Promise<RunResult>((resolve) => {
          order.push(req.op);
          gates.push(() => resolve({ ok: true, output: {}, stderr: '', durationMs: 0 }));
        }),
    });
    const base = { ext: 'a', argv: ['x'], dir: '/', cwd: '/', input: {}, timeoutMs: 1 };
    const p = [
      runner.run({ ...base, op: 'r1', priority: 'read' }),
      runner.run({ ...base, op: 'r2', priority: 'read' }),
      runner.run({ ...base, op: 'r3', priority: 'read' }),
      runner.run({ ...base, op: 'act', priority: 'action' }),
    ];
    expect(order).toEqual(['r1', 'r2']);
    gates.shift()!();
    await Bun.sleep(0);
    expect(order).toEqual(['r1', 'r2', 'act']);
    while (gates.length > 0) {
      gates.shift()!();
      await Bun.sleep(0);
    }
    await Promise.all(p);
    expect(order).toEqual(['r1', 'r2', 'act', 'r3']);
  });
});

describe('SessionLinksStore', () => {
  test('add 去重并更新 label；remove 只动指定扩展；重载保留；forget', async () => {
    const path = join(root, 'session-links.json');
    const store = await SessionLinksStore.load(path);
    expect(await store.update('s1', 'm', [{ ref: 'a', label: 'A' }], [], 1)).toBe(true);
    expect(await store.update('s1', 'other', [{ ref: 'a', label: 'X' }], [], 2)).toBe(true);
    expect(await store.update('s1', 'm', [{ ref: 'a', label: 'A2' }], [], 3)).toBe(true);
    expect(await store.update('s1', 'm', [{ ref: 'a', label: 'A2' }], [], 4)).toBe(false);
    expect(store.of('s1')).toEqual([
      { ext: 'm', ref: 'a', label: 'A2', at: 1 },
      { ext: 'other', ref: 'a', label: 'X', at: 2 },
    ]);
    await store.update('s1', 'm', [], ['a'], 5);
    expect(store.of('s1')).toEqual([{ ext: 'other', ref: 'a', label: 'X', at: 2 }]);
    expect(store.sessionsWith('other')).toEqual(['s1']);
    const reloaded = await SessionLinksStore.load(path);
    expect(reloaded.of('s1')).toHaveLength(1);
    reloaded.forget('s1');
    expect(reloaded.of('s1')).toBeUndefined();
  });

  test('写盘失败回滚并 reject', async () => {
    const dir = join(root, 'ro');
    await mkdir(dir);
    const store = await SessionLinksStore.load(join(dir, 'session-links.json'), { log: () => {} });
    await chmod(dir, 0o500);
    try {
      await expect(store.update('s1', 'm', [{ ref: 'a', label: 'A' }], [], 1)).rejects.toThrow();
      expect(store.of('s1')).toBeUndefined();
    } finally {
      await chmod(dir, 0o700);
    }
  });

  test('__proto__ 当会话 id 不污染原型', async () => {
    const store = await SessionLinksStore.load(join(root, 'l.json'));
    await store.update('__proto__', 'm', [{ ref: 'a', label: 'A' }], [], 1);
    expect(store.of('__proto__')).toHaveLength(1);
    expect(({} as Record<string, unknown>).ext).toBeUndefined();
  });
});

describe('评审回归：解释器后的脚本路径', () => {
  test('["sh", "bin/run"]：存在于扩展目录的相对参数按扩展目录解析', async () => {
    const dir = await makeExtension('interp', 'echo {}', { entry: ['sh', 'bin/run', 'view-flag'] });
    const inspected = await inspectExtensionDir(dir, (cmd) => (cmd === 'sh' ? '/bin/sh' : null));
    expect(inspected.argv).toEqual(['/bin/sh', join(inspected.dir, 'bin', 'run'), 'view-flag']);
  });
});

describe('评审回归（第二轮）', () => {
  test('不含 / 的参数原样保留（python3 -m pkg）', async () => {
    const dir = await makeExtension('pyish', 'echo {}', { entry: ['python3', '-m', 'bin', 'bin/run'] });
    await mkdir(join(dir, 'bin', 'sub'), { recursive: true });
    const inspected = await inspectExtensionDir(dir, (cmd) => (cmd === 'python3' ? '/bin/sh' : null));
    expect(inspected.argv).toEqual(['/bin/sh', '-m', 'bin', join(inspected.dir, 'bin', 'run')]);
  });

  test('links flush 等排队中的更新写完', async () => {
    const path = join(root, 'session-links.json');
    const store = await SessionLinksStore.load(path);
    void store.update('s1', 'm', [{ ref: 'a', label: 'A' }], [], 1);
    void store.update('s1', 'm', [{ ref: 'b', label: 'B' }], [], 2);
    await store.flush();
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.links.s1).toHaveLength(2);
  });
});

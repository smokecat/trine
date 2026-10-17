import { expect, test } from 'bun:test';

/**
 * `bun run --filter` 把子进程 stdin 换成非 TTY、cwd 换成包目录：--enroll 隐藏输入立刻读到 EOF，
 * --pair 的 SAS 确认也无法交互，README 里相对仓库根的 `.dev/` 路径还会落到各包目录下。
 */
test('root dev scripts run entrypoints directly from the repository root', async () => {
  const pkg = await Bun.file(new URL('../../../package.json', import.meta.url)).json();
  expect(pkg.scripts['dev:agent']).toBe('bun run apps/agent/src/cli.ts');
  expect(pkg.scripts['dev:server']).toBe('bun run apps/server/src/index.ts');
});

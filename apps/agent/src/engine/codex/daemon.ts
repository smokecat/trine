/**
 * 机器上的 Codex 常驻 daemon（`codex app-server daemon`，本机 Codex TUI 经 unix socket 连它）。
 *
 * trine 不接这个 daemon（见 app-server.ts），只在机器页「重启 Codex」时顺手重启它：换账号后它和
 * trine 自己的 app-server 一样不重新读登录。没在跑就不动——不替用户拉起一个从没用过的 daemon。
 * 旧版 codex 没有 daemon 子命令：`version` 失败按没在跑处理。
 */
import { defaultSpawn, type SpawnFn } from '../../app/claude-cli.ts';

const VERSION_TIMEOUT_MS = 10_000;
/** restart 要等旧进程退出、新进程起来 */
const RESTART_TIMEOUT_MS = 60_000;

export type CodexDaemonRestart = { status: 'restarted' | 'not_running' } | { status: 'failed'; message: string };

async function run(
  spawn: SpawnFn,
  cmd: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const proc = spawn(cmd, { env: process.env });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/** 输出里最后一个带 status 的 JSON 行（restart 先打进度事件，最后一行才是结论） */
export function lastStatus(output: string): string | undefined {
  const lines = output.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as { status?: unknown };
      if (typeof parsed.status === 'string') return parsed.status;
    } catch {
      // 不是 JSON，跳过
    }
  }
  return undefined;
}

function tail(text: string): string {
  const line = text.trim().split('\n').filter((l) => l.trim() !== '').at(-1) ?? '';
  return line.slice(0, 200);
}

/** 在跑就重启；不抛 */
export async function restartCodexDaemon(
  codexPath: string,
  options: { spawn?: SpawnFn; versionTimeoutMs?: number; restartTimeoutMs?: number } = {},
): Promise<CodexDaemonRestart> {
  const spawn = options.spawn ?? defaultSpawn;
  try {
    const version = await run(spawn, [codexPath, 'app-server', 'daemon', 'version'], options.versionTimeoutMs ?? VERSION_TIMEOUT_MS);
    if (version.code !== 0 || lastStatus(version.stdout) !== 'running') return { status: 'not_running' };
    const restart = await run(spawn, [codexPath, 'app-server', 'daemon', 'restart'], options.restartTimeoutMs ?? RESTART_TIMEOUT_MS);
    if (restart.timedOut) return { status: 'failed', message: 'daemon 重启超时' };
    if (restart.code === 0 && lastStatus(restart.stdout) === 'restarted') return { status: 'restarted' };
    const detail = tail(restart.stderr) || tail(restart.stdout);
    return { status: 'failed', message: `daemon 重启失败（退出码 ${restart.code ?? '?'}）${detail === '' ? '' : `：${detail}`}` };
  } catch (err) {
    return { status: 'failed', message: `daemon 重启出错：${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  }
}

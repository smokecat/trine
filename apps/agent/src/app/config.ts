/**
 * agent 进程配置：env + argv → `AgentConfig`。
 *
 * 刻意**不做配置文件**（方案 §5）：agent 的可调项就这几个，env 足够，
 * 多一个文件格式就多一份「到底哪个生效」的困惑。argv 只覆盖几个启动时
 * 常用的开关（--pair / --server / --home / --name / --claude-bin），其余走 env。
 */
import { assertEnrollmentUrl, httpBase } from '@trine/core/net';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentConfig {
  /** 服务端根地址（https:// 或 wss://；本地开发允许 http://） */
  serverUrl: string;
  /** 身份 / 名册 / 状态 / 目录收藏的落盘目录，默认 `~/.trine` */
  home: string;
  /** 首次生成身份时的展示名；已有身份时忽略 */
  name: string | undefined;
  /** 启动后立刻发起一次配对（打 QR） */
  pair: boolean;
  enroll?: boolean;
  /** resume 历史会话时若查不到模型（SDK listSessions 不带模型）就用它 */
  defaultModel: string;
  /** 并发活跃会话上限；undefined = SessionManager 默认 */
  maxSessions: number | undefined;
  /** 空闲回收阈值；undefined = SessionManager 默认 */
  idleTimeoutMs: number | undefined;
  /**
   * 会话 / 版本探测 / 远程更新用的 claude 可执行文件；undefined = 按 PATH 找
   * `claude`，再找不到回退 SDK 内置（见 claude-cli.ts）
   */
  claudeBin: string | undefined;
}

/**
 * 未指明模型时的兜底。历史会话经 SDK `listSessions` 列出来时**不带模型**
 * （bridge/manager.ts list() 里 model 是 `cached?.model ?? ''`），远端点开
 * 一个老会话总得给 SDK 一个模型名。可用 env TRINE_DEFAULT_MODEL 覆盖。
 * 用家族别名而不是具体 ID：由 Claude Code 解析到该家族最新版本，模型升级后
 * 不用改这里（SDK 的 `supportedModels()` 里能看到 `opus` → 具体 ID 的映射）。
 * `[1m]` = 1M 上下文窗口：兜底场景多是重开老会话，转录可能已经很长。
 */
export const DEFAULT_MODEL = 'opus[1m]';

/** home 目录下各文件的固定名字 */
export function agentPaths(home: string): {
  identity: string;
  recipients: string;
  state: string;
  cwd: string;
  sessions: string;
} {
  return {
    identity: join(home, 'identity.json'),
    recipients: join(home, 'recipients.json'),
    state: join(home, 'state.json'),
    cwd: join(home, 'cwd.json'),
    sessions: join(home, 'sessions.json'),
  };
}

export const USAGE = `用法：trine-agent [--enroll] [--pair] [--server URL] [--home DIR] [--name NAME] [--claude-bin PATH]

  --enroll        未注册时从隐藏终端输入（或 stdin 一行）读取短期邀请，不保存
  --pair          启动后打出配对二维码，等 client 扫码并在终端确认 SAS
  --server URL    服务端地址（或 env TRINE_SERVER；二者必填其一）
  --home DIR      身份/名册/状态目录（或 env TRINE_HOME；默认 ~/.trine）
  --name NAME     首次生成身份时的机器展示名（或 env TRINE_NAME）
  --claude-bin PATH  会话使用的 claude 可执行文件（或 env TRINE_CLAUDE_BIN；
                  默认 PATH 上的 claude，找不到则用 SDK 内置）

env：TRINE_DEFAULT_MODEL  TRINE_MAX_SESSIONS  TRINE_IDLE_TIMEOUT_MS`;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * 解析 argv + env。argv 优先于 env。
 *
 * 未知开关直接报错而不是忽略：`--sever` 这种拼错被静默吞掉，用户会盯着
 * 一个连不上的 agent 找半天。
 */
export function loadAgentConfig(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): AgentConfig {
  const flags = parseArgv(argv);

  const serverUrl = flags.get('server') ?? env['TRINE_SERVER'];
  if (serverUrl === undefined || serverUrl === '') {
    throw new ConfigError('缺少服务端地址：请传 --server URL 或设 TRINE_SERVER');
  }
  try {
    assertEnrollmentUrl(httpBase(serverUrl));
  } catch {
    throw new ConfigError('服务端地址必须为 HTTPS/WSS（回环可用 HTTP/WS），不能含用户名、密码、查询参数或 fragment');
  }

  const home = flags.get('home') ?? env['TRINE_HOME'] ?? join(homedir(), '.trine');
  const name = flags.get('name') ?? env['TRINE_NAME'];
  const claudeBin = nonEmpty(flags.get('claude-bin') ?? env['TRINE_CLAUDE_BIN']);

  return {
    serverUrl,
    home,
    name: name === '' ? undefined : name,
    pair: flags.has('pair'),
    enroll: flags.has('enroll'),
    defaultModel: nonEmpty(env['TRINE_DEFAULT_MODEL']) ?? DEFAULT_MODEL,
    maxSessions: envInt(env, 'TRINE_MAX_SESSIONS'),
    idleTimeoutMs: envInt(env, 'TRINE_IDLE_TIMEOUT_MS'),
    claudeBin,
  };
}

/** `--flag`、`--flag value`、`--flag=value` 三种写法都收 */
function parseArgv(argv: readonly string[]): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  const takesValue = new Set(['server', 'home', 'name', 'claude-bin']);
  const boolean = new Set(['pair', 'enroll']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      throw new ConfigError(`不认识的参数：${arg}\n\n${USAGE}`);
    }
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (boolean.has(key)) {
      if (eq !== -1) throw new ConfigError(`--${key} 不接受值`);
      out.set(key, undefined);
      continue;
    }
    if (!takesValue.has(key)) {
      throw new ConfigError(`不认识的开关：--${key}\n\n${USAGE}`);
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '') {
      throw new ConfigError(`--${key} 需要一个值`);
    }
    out.set(key, value);
  }
  return out;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function envInt(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): number | undefined {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`环境变量 ${name} 必须是正整数，实际：${raw}`);
  }
  return n;
}

/**
 * agent 进程配置：env + argv → `AgentConfig`。
 *
 * 刻意**不做配置文件**（方案 §5）：agent 的可调项就这几个，env 足够，
 * 多一个文件格式就多一份「到底哪个生效」的困惑。argv 只覆盖几个启动时
 * 常用的开关（--pair / --server / --home / --name / --claude-bin），其余走 env。
 */
import { assertEnrollmentUrl, httpBase } from '@trine/core/net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Subcommand } from '../control/commands.ts';

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
  uploads: string;
  extensions: string;
  sessionLinks: string;
  sessionRecords: string;
  restartMarker: string;
} {
  return {
    identity: join(home, 'identity.json'),
    recipients: join(home, 'recipients.json'),
    state: join(home, 'state.json'),
    cwd: join(home, 'cwd.json'),
    sessions: join(home, 'sessions.json'),
    /** 用户消息附件（见 bridge/attachments.ts） */
    uploads: join(home, 'uploads'),
    /** 扩展注册表与会话关联（见 ext/） */
    extensions: join(home, 'extensions.json'),
    sessionLinks: join(home, 'session-links.json'),
    sessionRecords: join(home, 'session-ext-records.json'),
    /** 自重启时留给新进程的标记（见 app/restart.ts） */
    restartMarker: join(home, 'restart.json'),
  };
}

export const USAGE = `用法：trine-agent [--enroll] [--pair] [--server URL] [--home DIR] [--name NAME] [--claude-bin PATH]
      trine-agent <pair | devices [list] | devices revoke DEVICE | status> [--home DIR]
      trine-agent ext <list | add DIR | remove ID | reload [ID] | validate DIR | test ID OP [...]> [--home DIR]
      trine-agent restart [--now] [--note TEXT] [--continue PROMPT] [--session ID] [--home DIR]
      trine-agent restart cancel [--home DIR]

  --enroll        未注册时从隐藏终端输入（或 stdin 一行）读取短期邀请，不保存
  --pair          启动后打出配对二维码，等 client 扫码并在终端确认 SAS
                  （agent 已在运行时改用 pair 子命令，同一身份不能起两个进程）
  --server URL    服务端地址（或 env TRINE_SERVER；二者必填其一）
  --home DIR      身份/名册/状态目录（或 env TRINE_HOME；默认 ~/.trine）
  --name NAME     首次生成身份时的机器展示名（或 env TRINE_NAME）
  --claude-bin PATH  会话使用的 claude 可执行文件（或 env TRINE_CLAUDE_BIN；
                  默认 PATH 上的 claude，找不到则用 SDK 内置）

子命令（操作同一 --home 下正在运行的 agent，无需停机）：
  pair            给运行中的 agent 配对一个新浏览器，在本终端比对校验码
  devices [list]  列出已配对设备
  devices revoke DEVICE  移除一台已配对设备（完整 deviceId 或唯一前缀）
  status          查看运行中的 agent
  ext list        列出已注册的扩展（扩展契约见 docs/EXTENSIONS.md）
  ext add DIR     注册扩展目录（装扩展 = 信任它的代码，以本用户身份运行）
  ext remove ID   移除扩展（它写下的会话关联保留）
  ext reload [ID] 扩展升级后重读 manifest
  ext validate DIR  只校验 manifest 与入口，不运行
  ext test ID OP [--point P] [--cwd DIR] [--session ID] [--args JSON] [--allow-write]
                  用合成上下文跑一次扩展（OP：view / badge / pick / action；action 需 --allow-write）
  restart         预检工作区代码，等全部会话空闲后重启 agent（需由 systemd 等 supervisor 托管）。
                  在 trine 会话里运行也安全：命令立即返回，本轮结束后才重启
    --now           预检通过即重启，不等会话空闲（进行中的轮次会被打断）
    --note TEXT     重启后在发起会话的时间线记录里附上的说明
    --continue PROMPT  重启后把这段话作为一条消息发进发起会话（让 Claude 接着核实）
    --session ID    发起会话（默认取会话里的 env TRINE_SESSION_ID）
  restart cancel  取消还没执行的重启
  selfcheck       加载全部代码后退出（重启预检用）

env：TRINE_DEFAULT_MODEL  TRINE_MAX_SESSIONS  TRINE_IDLE_TIMEOUT_MS`;

export interface SubcommandInvocation {
  command: Subcommand;
  home: string;
}

/**
 * 识别子命令：第一个参数不是 `--` 开头就是子命令，否则返回 null（常驻进程）。
 * 子命令只认 `--home`——它们操作的是本机某个身份目录下运行着的 agent，
 * 服务端地址等由那个 agent 自己决定。
 */
export function parseSubcommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): SubcommandInvocation | null {
  const first = argv[0];
  if (first === undefined || first.startsWith('--')) return null;

  const positional: string[] = [];
  const extFlags: Record<string, string> = {};
  let allowWrite = false;
  let home: string | undefined;
  const isExtTest = first === 'ext' && argv[1] === 'test';
  const isRestart = first === 'restart';
  const restartFlags: Record<string, string> = {};
  let restartNow = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--home' || arg.startsWith('--home=')) {
      home = arg === '--home' ? argv[++i] : arg.slice('--home='.length);
      if (home === undefined || home === '') throw new ConfigError('--home 需要一个值');
      continue;
    }
    if (isExtTest && arg === '--allow-write') {
      allowWrite = true;
      continue;
    }
    if (isExtTest && ['--point', '--cwd', '--session', '--args'].includes(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new ConfigError(`${arg} 需要一个值`);
      extFlags[arg.slice(2)] = value;
      continue;
    }
    if (isRestart && arg === '--now') {
      restartNow = true;
      continue;
    }
    if (isRestart && ['--note', '--continue', '--session'].includes(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new ConfigError(`${arg} 需要一个值`);
      restartFlags[arg.slice(2)] = value;
      continue;
    }
    if (arg.startsWith('--')) throw new ConfigError(`子命令不认识的开关：${arg}\n\n${USAGE}`);
    positional.push(arg);
  }

  const [name, ...rest] = positional;
  let command: Subcommand | undefined;
  if (name === 'pair' && rest.length === 0) command = { name: 'pair' };
  else if (name === 'status' && rest.length === 0) command = { name: 'status' };
  else if (name === 'selfcheck' && rest.length === 0) command = { name: 'selfcheck' };
  else if (name === 'restart' && rest.length === 1 && rest[0] === 'cancel') {
    if (restartNow || Object.keys(restartFlags).length > 0) throw new ConfigError('restart cancel 不带其他开关');
    command = { name: 'restart.cancel' };
  } else if (name === 'restart' && rest.length === 0) {
    const sessionId = restartFlags.session ?? nonEmptyEnv(env['TRINE_SESSION_ID']);
    command = {
      name: 'restart',
      now: restartNow,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(restartFlags.note === undefined ? {} : { note: restartFlags.note }),
      ...(restartFlags.continue === undefined ? {} : { continuePrompt: restartFlags.continue }),
    };
    if ((command.note !== undefined || command.continuePrompt !== undefined) && sessionId === undefined) {
      throw new ConfigError('--note / --continue 要发到某个会话：在 trine 会话里运行，或用 --session ID 指定');
    }
  }
  else if (name === 'devices' && (rest.length === 0 || (rest.length === 1 && rest[0] === 'list'))) {
    command = { name: 'devices.list' };
  } else if (name === 'devices' && rest[0] === 'revoke' && rest.length === 2) {
    command = { name: 'devices.revoke', device: rest[1]! };
  } else if (name === 'ext') {
    const [verb, ...args] = rest;
    if (verb === 'list' && args.length === 0) command = { name: 'ext.list' };
    // 路径在这里解析成绝对路径：控制通道那头的 agent 不知道本终端的 cwd
    else if (verb === 'add' && args.length === 1) command = { name: 'ext.add', path: resolve(args[0]!) };
    else if (verb === 'remove' && args.length === 1) command = { name: 'ext.remove', id: args[0]! };
    else if (verb === 'reload' && args.length <= 1) command = args[0] === undefined ? { name: 'ext.reload' } : { name: 'ext.reload', id: args[0] };
    else if (verb === 'validate' && args.length === 1) command = { name: 'ext.validate', path: resolve(args[0]!) };
    else if (verb === 'test' && args.length === 2) {
      command = {
        name: 'ext.test',
        id: args[0]!,
        op: args[1]!,
        allowWrite,
        ...(extFlags.point === undefined ? {} : { point: extFlags.point }),
        ...(extFlags.cwd === undefined ? {} : { cwd: resolve(extFlags.cwd) }),
        ...(extFlags.session === undefined ? {} : { session: extFlags.session }),
        ...(extFlags.args === undefined ? {} : { args: extFlags.args }),
      };
    }
  }
  if (command === undefined) {
    throw new ConfigError(`不认识的子命令：${positional.join(' ')}\n\n${USAGE}`);
  }
  return { command, home: home ?? env['TRINE_HOME'] ?? join(homedir(), '.trine') };
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

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

/**
 * @trine/agent 入口：常驻进程。
 *
 *   trine-agent [--pair] [--server URL] [--home DIR] [--name NAME] [--claude-bin PATH]
 *   trine-agent <pair | devices [list] | devices revoke ID | status> [--home DIR]
 *   env: TRINE_SERVER TRINE_HOME TRINE_NAME TRINE_DEFAULT_MODEL
 *        TRINE_MAX_SESSIONS TRINE_IDLE_TIMEOUT_MS TRINE_CLAUDE_BIN
 *
 * 常驻进程持有 `<home>/agent.lock`（同一身份只许一个进程）并在
 * `<home>/control.sock` 上开控制通道；子命令经它操作运行中的进程，
 * 配对新浏览器不必停机（见 control/）。
 *
 * 进程存活靠 WS 长连与 WsClient 的重连定时器；manager 的空闲回收定时器是
 * unref 的，不影响。SIGINT/SIGTERM → AgentApp.stop()，总上限 10s 兜底强退。
 *
 * `--pair`：连上后打 QR，**不退出**。收到配对请求时若 stdin 是 TTY 就问 SAS
 * 是否一致（y/n）→ confirm/abort；非 TTY 无法确认，只 log、不 abort（token 自然
 * 过期，用户可在有效期内以 TTY 重跑）。agent 已在运行时用 `pair` 子命令。
 */
import { AuthClientError } from '@trine/core/net';
import { readInvitation } from './enrollment-input.ts';
import { createInterface } from 'node:readline/promises';
import { AgentApp } from './app/app.ts';
import { installProcessGuards } from './app/process-guards.ts';
import { ConfigError, loadAgentConfig, parseSubcommand, USAGE } from './app/config.ts';
import { acquireInstanceLock, InstanceLockError } from './app/instance-lock.ts';
import { controlSocketPath, runSubcommand, type CommandIO } from './control/commands.ts';
import { attachControlServer } from './control/host.ts';
import type { ControlServer } from './control/server.ts';
import type { PairingSession } from './net/pairing.ts';
import { formatPairingPrompt, renderPairingPayload } from './net/qr.ts';
import { logTime } from './log-time.ts';

/** 优雅退出的总时限，超过就强退（可能留孤儿子进程，记遗留） */
const SHUTDOWN_HARD_LIMIT_MS = 10_000;

const color = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function log(line: string): void {
  console.log(`${color.dim(logTime())} ${line}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let config;
  try {
    const sub = parseSubcommand(argv, process.env);
    if (sub) {
      process.exit(await runCommand(sub.command, sub.home));
    }
    config = loadAgentConfig(argv, process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(color.red(err.message));
      if (!err.message.includes(USAGE)) console.error(`\n${USAGE}`);
      process.exit(2);
    }
    throw err;
  }

  // 先拿锁再碰身份文件：两个进程同时 --enroll 也不会各写一份身份
  let lock;
  try {
    lock = acquireInstanceLock(config.home);
  } catch (err) {
    if (err instanceof InstanceLockError) {
      console.error(color.red(err.message));
      console.error(
        color.yellow(
          `要给运行中的 agent 配对新浏览器，不必停机：trine-agent pair --home ${config.home}\n` +
            '（仓库里运行：bun run dev:agent -- pair --home ...）',
        ),
      );
      process.exit(1);
    }
    throw err;
  }
  process.on('exit', () => lock.release());

  const app = await AgentApp.create(config, { log, ...(config.enroll ? { getInvitation: readInvitation } : {}) });
  log(
    `${color.bold('trine-agent')} machine=${app.node.machineId} name=${app.node.identity.name} ` +
      `${color.dim(`server=${config.serverUrl} home=${config.home} 已配对 ${app.node.recipients.size} 台`)}`,
  );

  // 下面接上；先声明是因为退出处理要用到它，而信号可能在接上之前就到
  let control: ControlServer | null = null;

  // ---- 退出 ----
  let exiting = false;
  const shutdown = (signal: string): void => {
    if (exiting) return;
    exiting = true;
    log(`收到 ${signal}，正在退出（关会话 → 落盘 → 断连）`);
    const hard = setTimeout(() => {
      console.error(color.red(`退出超时 ${SHUTDOWN_HARD_LIMIT_MS}ms，强制结束（可能留有 claude 子进程）`));
      process.exit(1);
    }, SHUTDOWN_HARD_LIMIT_MS);
    (control?.close() ?? Promise.resolve())
      .then(() => app.stop())
      .then(() => {
        clearTimeout(hard);
        log('已退出');
        process.exit(0);
      })
      .catch((err: unknown) => {
        console.error(color.red(`退出出错：${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  installProcessGuards(process, (line) => console.error(color.red(line)));

  // ---- 控制通道 + 配对 ----
  // 控制通道发起的配对由它接手；其余（本进程 --pair 打的码）交给本终端
  try {
    control = await attachControlServer(app, controlSocketPath(config.home), {
      log,
      onOtherPairingRequest: (session) => {
        if (config.pair) void handlePairingRequest(app, session);
      },
    });
  } catch (err) {
    // 控制通道起不来不影响 agent 本职工作，只是 pair/devices 子命令用不了
    log(color.yellow(`控制通道启动失败（pair/devices 子命令不可用）：${err instanceof Error ? err.message : String(err)}`));
  }

  await app.start();

  if (config.pair) {
    const session = app.node.startPairing();
    console.log(formatPairingPrompt(await renderPairingPayload(session.payload)));
    log(color.dim('等待 client 扫码……（配对码 5 分钟内有效；agent 不会退出）'));
  }
}

/** 收到 pair.begin：展示 SAS，TTY 下问用户，非 TTY 只提示 */
async function handlePairingRequest(app: AgentApp, session: PairingSession): Promise<void> {
  const peer = session.pending;
  if (!peer) return;
  // 用户比对的是**这一个**对端：确认时据此核对，期间被新请求覆盖则拒绝
  const seen = {
    clientDeviceId: peer.clientDeviceId,
    clientPubKey: peer.clientPubKey,
    clientSignPubKey: peer.clientSignPubKey,
  };
  console.log(
    `\n${color.bold('配对请求')} 来自设备 ${color.cyan(peer.clientDeviceId)}\n` +
      `${color.bold('本端校验码')} ${color.cyan(peer.sas.digits)}  ${peer.sas.emoji.join(' ')}\n`,
  );
  if (!process.stdin.isTTY) {
    log(
      color.yellow(
        '当前不是交互式终端，无法确认校验码；请在配对码有效期内以终端方式重跑 --pair。' +
          '本次请求不会被自动确认或中止。',
      ),
    );
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = (await rl.question('对端显示的校验码与上面**完全一致**吗？(y/N) ')).trim().toLowerCase();
  } finally {
    rl.close();
  }
  if (answer !== 'y' && answer !== 'yes') {
    app.node.abortPairing(session.pairingToken, 'SAS mismatch');
    log(color.yellow('已中止配对。校验码不一致意味着中间有人在替换密钥——请重新扫码。'));
    return;
  }
  // 走 app 而不是 app.node：app 那层会顺带给新设备补一份 machine.info
  let sent: boolean;
  try {
    sent = await app.confirmPairing(session.pairingToken, seen);
  } catch (err) {
    log(color.yellow(`未能确认：${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  log(
    sent
      ? color.green(`已配对 ${peer.clientDeviceId}，client 现在可以接入了`)
      : color.yellow('确认帧发送失败（连接中断？）名册已写入，请让 client 重试配对'),
  );
}

/** 子命令：终端 IO 接到 readline 上 */
async function runCommand(command: Parameters<typeof runSubcommand>[0], home: string): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // readline 接管终端后 Ctrl-C 不再产生进程级 SIGINT；不处理的话只会暂停输入
  rl.on('SIGINT', () => {
    rl.close();
    process.exit(130);
  });
  // 输入结束（Ctrl-D / 管道读完）时，挂着的 question 一律当作没有回答
  const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
  const io: CommandIO = {
    print: (line) => console.log(line),
    interactive: process.stdin.isTTY === true,
    ask: (prompt, signal) =>
      Promise.race([rl.question(prompt, signal ? { signal } : {}).catch(() => null), closed]),
  };
  try {
    return await runSubcommand(command, home, io);
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  if (err instanceof AuthClientError) {
    const guidance: Record<string, string> = {
      invalid_invitation: '邀请已过期、撤销、使用或不属于此 relay；请签发新邀请，保留原 --home 后重试 --enroll。',
      registration_closed: '新 agent 必须使用邀请；请先升级 relay 和 agent，然后用 --enroll 重试。',
      rate_limited: '请求过于频繁；请等一分钟再试。',
      device_exists_with_other_key: '设备 ID 与已有公钥冲突；请检查身份备份与服务端，不要覆盖原身份。',
      role_mismatch: '设备角色冲突；请检查 --home 和 --server。',
      device_revoked: '此设备身份已撤销；邀请不能恢复被撤销的身份。',
      bad_signature: '身份认证失败；请检查身份文件与服务端登记的公钥。',
    };
    if (guidance[err.reason]) console.error(color.yellow(guidance[err.reason]!));
  }
  console.error(color.red(`启动失败：${err instanceof Error ? err.message : String(err)}`));

  process.exit(1);
});

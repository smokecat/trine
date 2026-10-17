/**
 * 网络层手工演示：接入服务端并发起一次配对，把 QR 打在终端上。
 *
 * 跑法（先起一个本地服务端 `bun run --filter @trine/server dev`）：
 *
 *   TRINE_SERVER=http://127.0.0.1:8787 bun run apps/agent/src/net-demo.ts
 *
 * 身份与名册默认落在 `~/.trine/`；想用一次性目录不污染真实身份：
 *
 *   TRINE_HOME=/tmp/trine-demo bun run apps/agent/src/net-demo.ts
 *
 * 本脚本**只做配对与收发骨架**，不驱动 claude（那是 bridge 层，
 * 两者的接线属后续任务）。收到 client 的密文时原样打印事件类型。
 */
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AgentNode } from './net/index.ts';
import { formatPairingPrompt, renderPairingPayload } from './net/qr.ts';

const SERVER = process.env['TRINE_SERVER'] ?? 'http://127.0.0.1:8787';
const HOME = process.env['TRINE_HOME'];

const color = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

async function main(): Promise<void> {
  const node = await AgentNode.create({
    serverUrl: SERVER,
    ...(HOME
      ? {
          identityPath: join(HOME, 'identity.json'),
          recipientsPath: join(HOME, 'recipients.json'),
        }
      : {}),
    onEvent: (event, sender) => {
      console.log(
        `${color.green('← 入站')} ${event.type} ${color.dim(`from ${sender.deviceId}`)}`,
      );
    },
    onInboundDropped: (failure, detail) => {
      console.log(`${color.yellow('⚠ 丢弃入站帧')} ${failure}: ${detail}`);
    },
    log: (line) => console.log(color.dim(line)),
  });

  console.log(
    `${color.bold('machineId')} = ${node.machineId}  ` +
      `${color.dim(`(已配对设备 ${node.recipients.size} 台)`)}`,
  );

  await node.connect();
  // 建连是异步的，给它一点时间把 hello 走完再往下
  await new Promise((r) => setTimeout(r, 500));
  console.log(node.online ? color.green('✓ 已接入服务端') : color.yellow('… 正在重连'));

  const session = node.startPairing();
  console.log(formatPairingPrompt(await renderPairingPayload(session.payload)));

  // 等对端扫码并发来 pair.begin
  const peer = await waitForPeer(node, session.pairingToken);
  if (!peer) {
    console.log(color.yellow('配对码已过期（5 分钟），请重新运行'));
    node.disconnect();
    return;
  }

  console.log(
    `\n${color.bold('对端设备')} ${peer.clientDeviceId}\n` +
      `${color.bold('本端 SAS')} ${color.cyan(peer.sas.digits)}  ${peer.sas.emoji.join(' ')}\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (
    await rl.question('对端显示的校验码与上面完全一致吗？(yes/no) ')
  ).trim().toLowerCase();
  rl.close();

  if (answer !== 'yes' && answer !== 'y') {
    node.abortPairing(session.pairingToken, 'SAS mismatch');
    console.log(
      color.yellow(
        '已中止。校验码不一致意味着中间有人在替换密钥——请重新扫码配对。',
      ),
    );
    node.disconnect();
    return;
  }

  await node.confirmPairing(session.pairingToken);
  console.log(color.green(`✓ 已配对 ${peer.clientDeviceId}，等待密文往返（Ctrl-C 退出）`));

  process.on('SIGINT', () => {
    node.disconnect();
    process.exit(0);
  });
}

/** 轮询等 pair.begin 落到会话上；配对码过期即返回 null */
async function waitForPeer(node: AgentNode, pairingToken: string) {
  for (;;) {
    const session = node.pairing.get(pairingToken);
    if (!session) return null;
    if (session.pending) return session.pending;
    await new Promise((r) => setTimeout(r, 300));
  }
}

main().catch((err) => {
  console.error('演示失败：', err);
  process.exit(1);
});

/**
 * 子命令：`trine-agent pair | devices [list] | devices revoke <id> | status`。
 *
 * 优先连正在运行的 agent 的控制通道；连不上时：
 * - 锁文件显示 agent 仍在运行 → 多半是不带控制通道的旧版本，提示重启它；
 * - agent 没在运行 → devices 直接读写名册文件（先拿单实例锁，防止 agent 恰好
 *   此时启动），pair/status 提示先启动 agent。
 *
 * 终端交互经 `CommandIO` 注入，测试里用脚本化的输入驱动。
 */
import { join } from 'node:path';
import { sodiumReady } from '@trine/core/crypto';
import { acquireInstanceLock, InstanceLockError, lockHolder } from '../app/instance-lock.ts';
import { agentPaths } from '../app/config.ts';
import { RecipientBookStore } from '../net/recipients.ts';
import { formatPairingPrompt, renderPairingPayload } from '../net/qr.ts';
import { ControlClient } from './client.ts';
import { printExtList, runExtLocal, runExtOffline, type ExtSubcommand } from '../ext/commands.ts';
import { CONTROL_SOCKET, type ControlEvent, type DeviceInfo } from './protocol.ts';
import { AGENT_VERSION } from '../app/machine-info.ts';
import { SELFCHECK_PREFIX } from '../app/restart.ts';

export type Subcommand =
  | { name: 'pair' }
  | { name: 'status' }
  | { name: 'devices.list' }
  | { name: 'devices.revoke'; device: string }
  | { name: 'selfcheck' }
  | { name: 'restart'; now: boolean; sessionId?: string; note?: string; continuePrompt?: string }
  | { name: 'restart.cancel' }
  | ExtSubcommand;

export interface CommandIO {
  print(line: string): void;
  /** 读一行输入；被 signal 中止或输入结束（EOF）时返回 null */
  ask(prompt: string, signal?: AbortSignal): Promise<string | null>;
  /** 是否交互式终端：pair 必须有人看着比对校验码 */
  interactive: boolean;
  now?: () => number;
  /** 测试注入：拿到 ControlClient 后回调（例如模拟 Ctrl-C 时关掉它） */
  onConnected?: (client: ControlClient) => void;
}

/** 配对码到期前多久提醒一次 */
export const EXPIRY_REMINDER_MS = 60_000;

export function controlSocketPath(home: string): string {
  return join(home, CONTROL_SOCKET);
}

export async function runSubcommand(command: Subcommand, home: string, io: CommandIO): Promise<number> {
  if (command.name === 'pair' && !io.interactive) {
    io.print('pair 需要在交互式终端里运行：配对必须由人比对两端的校验码后确认。');
    return 2;
  }

  // selfcheck：能跑到这里说明整个模块图都加载成功了（cli.ts 静态导入了全部代码）
  if (command.name === 'selfcheck') {
    io.print(`${SELFCHECK_PREFIX}${AGENT_VERSION}`);
    return 0;
  }

  // validate / test 不需要 agent：直接看目录、直接起扩展进程
  if (command.name === 'ext.validate' || command.name === 'ext.test') {
    return runExtLocal(command, agentPaths(home).extensions, (line) => io.print(line));
  }

  const client = await ControlClient.connect(controlSocketPath(home));
  if (client) {
    io.onConnected?.(client);
    try {
      return await runOnline(command, client, io);
    } finally {
      client.close();
    }
  }

  const pid = lockHolder(home);
  if (pid !== null) {
    io.print(
      `agent 正在运行（PID ${pid}），但连不上它的控制通道 ${controlSocketPath(home)}。\n` +
        '多半是还没有控制通道的旧版本：升级后重启它（例如 systemctl --user restart trine-agent）再试。',
    );
    return 1;
  }
  return runOffline(command, home, io);
}

// ---------------------------------------------------------------------------
// agent 在运行：走控制通道
// ---------------------------------------------------------------------------

async function runOnline(command: Subcommand, client: ControlClient, io: CommandIO): Promise<number> {
  switch (command.name) {
    case 'status': {
      const event = await client.request({ op: 'status' });
      if (event?.ev !== 'status') return unexpected(event, io);
      io.print(
        `agent 运行中（PID ${event.pid}）machine=${event.machineId} name=${event.name}\n` +
          `服务端连接：${event.online ? '已接入' : '未连接（正在重连）'}　已配对设备：${event.devices} 台`,
      );
      return 0;
    }
    case 'devices.list': {
      const event = await client.request({ op: 'devices.list' });
      if (event?.ev !== 'devices') return unexpected(event, io);
      printDevices(event.devices, io);
      return 0;
    }
    case 'devices.revoke': {
      const list = await client.request({ op: 'devices.list' });
      if (list?.ev !== 'devices') return unexpected(list, io);
      const deviceId = resolveDevice(list.devices, command.device, io);
      if (deviceId === null) return 1;
      const event = await client.request({ op: 'devices.revoke', deviceId });
      if (event?.ev !== 'revoked') return unexpected(event, io);
      printRevoked(deviceId, event.removed, true, io);
      return event.removed ? 0 : 1;
    }
    case 'pair':
      return runPair(client, io);
    case 'ext.list': {
      const event = await client.request({ op: 'ext.list' });
      if (event?.ev !== 'ext.list') return unexpected(event, io);
      printExtList(event.items, (l) => io.print(l));
      return 0;
    }
    case 'ext.add': {
      const event = await client.request({ op: 'ext.add', path: command.path });
      if (event?.ev !== 'ext.added') return unexpected(event, io);
      io.print(`已注册扩展 ${event.item.id}（${event.item.name} ${event.item.version}），已生效。`);
      return 0;
    }
    case 'ext.remove': {
      const event = await client.request({ op: 'ext.remove', id: command.id });
      if (event?.ev !== 'ext.removed') return unexpected(event, io);
      io.print(event.removed ? `已移除扩展 ${command.id}。` : `没有扩展 ${command.id}。`);
      return event.removed ? 0 : 1;
    }
    case 'ext.reload': {
      const event = await client.request({ op: 'ext.reload', ...(command.id === undefined ? {} : { id: command.id }) });
      if (event?.ev !== 'ext.reloaded') return unexpected(event, io);
      printExtList(event.items, (l) => io.print(l));
      return 0;
    }
    case 'restart':
    case 'restart.cancel':
      return runRestart(command, client, io);
    default:
      return 2;
  }
}

async function runRestart(
  command: Extract<Subcommand, { name: 'restart' | 'restart.cancel' }>,
  client: ControlClient,
  io: CommandIO,
): Promise<number> {
  if (command.name === 'restart') io.print('正在预检工作区代码（bun install --frozen-lockfile、加载检查）……');
  const event = await client.request(
    command.name === 'restart.cancel'
      ? { op: 'restart.cancel' }
      : {
          op: 'restart',
          now: command.now,
          ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
          ...(command.note === undefined ? {} : { note: command.note }),
          ...(command.continuePrompt === undefined ? {} : { continuePrompt: command.continuePrompt }),
        },
  );
  if (event?.ev !== 'restart.result') return unexpected(event, io);
  if (!event.ok) {
    io.print(`没有重启：${event.message ?? event.code ?? '未知原因'}`);
    if (event.output !== undefined && event.output !== '') io.print(`\n预检输出（尾部）：\n${event.output}`);
    return 1;
  }
  const version = event.toVersion === undefined ? '' : `（新版本 ${event.toVersion}）`;
  switch (event.phase) {
    case 'cancelled':
      io.print('已取消重启。');
      return 0;
    case 'restarting':
      io.print(`预检通过${version}，agent 马上重启。`);
      return 0;
    default: {
      const busy = event.busySessions ?? 0;
      const deadline = event.deadline === undefined ? '' : `；到 ${clock(event.deadline)} 仍有会话在忙就取消`;
      io.print(
        `预检通过${version}，已排期：等全部会话空闲后重启（当前 ${busy} 个在忙${deadline}）。\n` +
          (command.name === 'restart' && command.sessionId !== undefined
            ? '在 trine 会话里运行时：本轮结束后才会重启，重启后会在本会话留一条记录' +
              (command.continuePrompt === undefined ? '。' : '，并把 --continue 的内容作为新消息发进来。')
            : '取消：trine-agent restart cancel'),
      );
      return 0;
    }
  }
}

function unexpected(event: ControlEvent | null, io: CommandIO): number {
  if (event === null) io.print('agent 断开了连接。');
  else if (event.ev === 'error') io.print(`agent 报错：${event.message}`);
  else io.print(`agent 回了意外的消息：${event.ev}`);
  return 1;
}

// ---------------------------------------------------------------------------
// 配对
// ---------------------------------------------------------------------------

type RoundResult = 'done' | 'retry' | 'closed' | 'quit';

/** 正在问用户的那一条配对请求 */
interface Asking {
  requestId: number;
  abort: AbortController;
  answer: Promise<string | null>;
}

type Step = { kind: 'event'; event: ControlEvent | null } | { kind: 'answer'; answer: string | null };

async function runPair(client: ControlClient, io: CommandIO): Promise<number> {
  for (;;) {
    const result = await pairRound(client, io);
    if (result === 'done') return 0;
    if (result !== 'retry') return 1;
    const again = await io.ask('按 Enter 重新生成配对码，输入 q 退出：');
    if (again === null || again.trim().toLowerCase() === 'q') return 1;
  }
}

/** 一轮 = 一个配对码，从生成到完成/作废 */
async function pairRound(client: ControlClient, io: CommandIO): Promise<RoundResult> {
  const now = io.now ?? (() => Date.now());
  client.send({ op: 'pair.start' });
  let reminder: ReturnType<typeof setTimeout> | null = null;
  let asking: Asking | null = null;
  // 只在需要时才取下一条：提前挂一个 next() 再 return 的话，它会吞掉下一轮的第一条事件
  let nextEvent: Promise<ControlEvent | null> | null = null;

  try {
    for (;;) {
      nextEvent ??= client.next();
      // asking 只在 switch 里赋值，TS 的循环内收窄会把它误判为恒 null
      const current = asking as Asking | null;
      const step: Step = current
        ? await Promise.race([
            nextEvent.then((event) => ({ kind: 'event' as const, event })),
            current.answer.then((answer) => ({ kind: 'answer' as const, answer })),
          ])
        : { kind: 'event' as const, event: await nextEvent };

      if (step.kind === 'answer') {
        asking = null;
        if (step.answer === null) return 'quit';
        const confirm = /^y(es)?$/i.test(step.answer.trim());
        client.send({ op: 'pair.answer', requestId: current!.requestId, confirm });
        if (confirm) io.print('正在确认……');
        continue;
      }

      nextEvent = null;
      const event: ControlEvent | null = step.event;
      if (event === null) {
        io.print('agent 断开了连接（agent 退出了？），配对未完成。');
        return 'closed';
      }
      switch (event.ev) {
        case 'pair.started': {
          io.print(formatPairingPrompt(await renderPairingPayload(event.payload)));
          const remaining = event.expiresAt - now();
          io.print(`配对码 ${Math.round(remaining / 60_000)} 分钟内有效（至 ${clock(event.expiresAt)}）。等待浏览器扫码……`);
          if (remaining > EXPIRY_REMINDER_MS * 1.5) {
            reminder = setTimeout(() => io.print('配对码还剩 1 分钟。'), remaining - EXPIRY_REMINDER_MS);
          }
          break;
        }
        case 'pair.request': {
          if (asking) {
            asking.abort.abort();
            io.print('\n收到新的配对请求，上一条作废——请以下面这组校验码为准。');
          }
          io.print(
            `\n配对请求来自设备 ${event.peer.clientDeviceId}\n` +
              `本端校验码 ${event.peer.digits}  ${event.peer.emoji.join(' ')}\n`,
          );
          const abort = new AbortController();
          asking = {
            requestId: event.requestId,
            abort,
            answer: io.ask('浏览器上显示的校验码与上面完全一致吗？(y/N) ', abort.signal),
          };
          break;
        }
        case 'pair.done':
          io.print(
            event.sent
              ? `已配对 ${event.clientDeviceId}，浏览器现在可以接入了。`
              : `已在本机登记 ${event.clientDeviceId}，但确认没能发给服务端（agent 正在重连？）；请在浏览器上重新配对。`,
          );
          return 'done';
        case 'pair.aborted':
          io.print(`配对已中止：${event.reason}。`);
          return 'retry';
        case 'pair.expired':
          io.print('配对码已过期。');
          return 'retry';
        case 'error':
          io.print(`agent 报错：${event.message}`);
          if (event.fatal === true) return 'closed';
          break;
        default:
          break;
      }
    }
  } finally {
    if (reminder !== null) clearTimeout(reminder);
    asking?.abort.abort();
  }
}

// ---------------------------------------------------------------------------
// agent 没在运行：直接操作文件
// ---------------------------------------------------------------------------

async function runOffline(command: Subcommand, home: string, io: CommandIO): Promise<number> {
  if (command.name === 'restart' || command.name === 'restart.cancel') {
    io.print('agent 没有在运行，无需重启。启动它即可（例如 systemctl --user start trine-agent）。');
    return 1;
  }
  if (command.name === 'pair' || command.name === 'status') {
    io.print(
      'agent 没有在运行。先启动它（例如 systemctl --user start trine-agent），' +
        (command.name === 'pair' ? '再运行 pair；或者前台运行 trine-agent --pair。' : '再查看状态。'),
    );
    return 1;
  }

  let lock;
  try {
    lock = acquireInstanceLock(home);
  } catch (err) {
    if (err instanceof InstanceLockError) {
      io.print(`${err.message}\n请稍后重试。`);
      return 1;
    }
    throw err;
  }
  try {
    if (command.name.startsWith('ext.')) {
      return await runExtOffline(command as ExtSubcommand, agentPaths(home).extensions, (line) => io.print(line));
    }
    await sodiumReady(); // 名册落盘的临时文件名用到 randomToken
    const book = await RecipientBookStore.load(agentPaths(home).recipients);
    const devices = book.list().map((r) => ({ deviceId: r.deviceId, pairedAt: r.pairedAt }));
    if (command.name === 'devices.list') {
      printDevices(devices, io);
      return 0;
    }
    if (command.name !== 'devices.revoke') return 2;
    const deviceId = resolveDevice(devices, command.device, io);
    if (deviceId === null) return 1;
    const removed = await book.remove(deviceId);
    printRevoked(deviceId, removed, false, io);
    return removed ? 0 : 1;
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// 展示
// ---------------------------------------------------------------------------

/** 完整 deviceId 或唯一前缀 → deviceId；找不到 / 不唯一时打印原因并返回 null */
export function resolveDevice(devices: DeviceInfo[], query: string, io: CommandIO): string | null {
  const exact = devices.find((d) => d.deviceId === query);
  if (exact) return exact.deviceId;
  const matches = devices.filter((d) => d.deviceId.startsWith(query));
  if (matches.length === 1) return matches[0]!.deviceId;
  if (matches.length === 0) {
    io.print(`没有已配对设备匹配「${query}」。用 devices list 查看。`);
  } else {
    io.print(`「${query}」匹配到多台设备，请写得更完整：\n${matches.map((d) => `  ${d.deviceId}`).join('\n')}`);
  }
  return null;
}

function printDevices(devices: DeviceInfo[], io: CommandIO): void {
  if (devices.length === 0) {
    io.print('还没有已配对的设备。');
    return;
  }
  const sorted = [...devices].sort((a, b) => a.pairedAt - b.pairedAt);
  io.print(
    `已配对 ${devices.length} 台设备：\n` +
      sorted.map((d) => `  ${d.deviceId}  配对于 ${dateTime(d.pairedAt)}`).join('\n'),
  );
}

function printRevoked(deviceId: string, removed: boolean, live: boolean, io: CommandIO): void {
  if (!removed) {
    io.print(`${deviceId} 不在名册里（可能刚被移除）。`);
    return;
  }
  io.print(
    `已移除 ${deviceId}${live ? '（运行中的 agent 已立即生效）' : ''}。\n` +
      '本机不再给它加密事件，它发来的消息也会被丢弃；服务端上的设备登记不受影响。' +
      '要恢复使用需重新配对。',
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function dateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

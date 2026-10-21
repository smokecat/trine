import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock } from '../app/instance-lock.ts';
import type { RestartNotice, RestartOutcome } from '../app/restart.ts';
import { agentPaths } from '../app/config.ts';
import type { PairingSession, PeerIdentity } from '../net/pairing.ts';
import { RecipientBookStore } from '../net/recipients.ts';
import { ScriptIO } from '../testing/script-io.ts';
import { controlSocketPath, runSubcommand, type Subcommand } from './commands.ts';
import { ControlServer, type ControlHost } from './server.ts';

let dir: string;
let home: string;
let server: ControlServer | null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trine-ctl-'));
  home = join(dir, 'h');
  await mkdir(home, { mode: 0o700 });
  server = null;
});

afterEach(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

/** 假 daemon：记录调用，配对会话由测试手动推进 */
class FakeHost implements ControlHost {
  devices = [
    { deviceId: 'web-aaaa-1111', pairedAt: Date.UTC(2026, 9, 1) },
    { deviceId: 'web-aaab-2222', pairedAt: Date.UTC(2026, 9, 2) },
    { deviceId: 'phone-3333', pairedAt: Date.UTC(2026, 9, 3) },
  ];
  sessions: PairingSession[] = [];
  aborted: { token: string; reason: string }[] = [];
  confirmed: { token: string; expected: PeerIdentity }[] = [];
  ttlMs = 5 * 60_000;
  confirmError: Error | null = null;
  restartRequests: { now: boolean; notice?: RestartNotice }[] = [];
  restartOutcome: RestartOutcome = { ok: true, phase: 'draining', toVersion: '0.19.0' };
  restart = {
    request: async (req: { now: boolean; notice?: RestartNotice }): Promise<RestartOutcome> => {
      this.restartRequests.push(req);
      return this.restartOutcome;
    },
    cancel: (): RestartOutcome => ({ ok: true, phase: 'cancelled' }),
    pending: () => ({ busySessions: 1, deadline: Date.UTC(2026, 9, 21, 4, 30) }),
  };

  status() {
    return { machineId: 'm-test', name: 'test-box', online: true, devices: this.devices.length };
  }
  listDevices() {
    return this.devices;
  }
  async revokeDevice(deviceId: string) {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
    return this.devices.length !== before;
  }
  startPairing(): PairingSession {
    const n = this.sessions.length + 1;
    const session: PairingSession = {
      pairingToken: `token-${n}`,
      qrSecret: 'secret',
      payload: `trine-pair-test-${n}`,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      pending: null,
    };
    this.sessions.push(session);
    return session;
  }
  async confirmPairing(token: string, expected: PeerIdentity) {
    if (this.confirmError) throw this.confirmError;
    this.confirmed.push({ token, expected });
    return true;
  }
  abortPairing(token: string, reason: string) {
    this.aborted.push({ token, reason });
  }

  /** 模拟收到 pair.begin：给最近一次会话填上对端 */
  begin(deviceId: string, digits: string): PairingSession {
    const session = this.sessions.at(-1)!;
    session.pending = {
      clientDeviceId: deviceId,
      clientPubKey: `box-${deviceId}`,
      clientSignPubKey: `sign-${deviceId}`,
      sas: { digits, emoji: ['🐶', '🐱', '🦊', '🐼'] },
      receivedAt: Date.now(),
    };
    return session;
  }
}

async function startServer(host: ControlHost): Promise<ControlServer> {
  server = new ControlServer(host, { pid: 4242 });
  await server.listen(controlSocketPath(home));
  return server;
}

function run(command: Subcommand, io: ScriptIO): Promise<number> {
  return runSubcommand(command, home, io);
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('控制通道：查询与设备管理（agent 在运行）', () => {
  test('socket 权限 0600', async () => {
    await startServer(new FakeHost());
    expect(statSync(controlSocketPath(home)).mode & 0o777).toBe(0o600);
  });

  test('status', async () => {
    await startServer(new FakeHost());
    const io = new ScriptIO([]);
    expect(await run({ name: 'status' }, io)).toBe(0);
    expect(io.output).toContain('PID 4242');
    expect(io.output).toContain('machine=m-test');
    expect(io.output).toContain('已配对设备：3 台');
  });

  test('devices list 按配对时间排序', async () => {
    await startServer(new FakeHost());
    const io = new ScriptIO([]);
    expect(await run({ name: 'devices.list' }, io)).toBe(0);
    const out = io.output;
    expect(out).toContain('已配对 3 台设备');
    expect(out.indexOf('web-aaaa-1111')).toBeLessThan(out.indexOf('phone-3333'));
  });

  test('devices revoke：唯一前缀命中即移除，立即生效', async () => {
    const host = new FakeHost();
    await startServer(host);
    const io = new ScriptIO([]);
    expect(await run({ name: 'devices.revoke', device: 'phone' }, io)).toBe(0);
    expect(host.devices.map((d) => d.deviceId)).not.toContain('phone-3333');
    expect(io.output).toContain('已移除 phone-3333（运行中的 agent 已立即生效）');
  });

  test('devices revoke：前缀不唯一 / 不存在 → 不动名册', async () => {
    const host = new FakeHost();
    await startServer(host);
    const ambiguous = new ScriptIO([]);
    expect(await run({ name: 'devices.revoke', device: 'web-aaa' }, ambiguous)).toBe(1);
    expect(ambiguous.output).toContain('匹配到多台设备');
    const missing = new ScriptIO([]);
    expect(await run({ name: 'devices.revoke', device: 'nope' }, missing)).toBe(1);
    expect(host.devices).toHaveLength(3);
  });

  test('无法解析的请求 → fatal error 并断开', async () => {
    await startServer(new FakeHost());
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(controlSocketPath(home), () => socket.write('{"op":"bogus"}\n'));
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (data += chunk));
      socket.on('close', () => resolve(data));
    });
    expect(JSON.parse(reply)).toMatchObject({ ev: 'error', fatal: true });
  });

  test('listen 接管崩溃留下的陈旧 socket', async () => {
    const path = controlSocketPath(home);
    // 子进程监听后被 kill -9：socket 文件留在原地，没人在听
    const child = Bun.spawn(['bun', '-e', `require('node:net').createServer().listen(${JSON.stringify(path)})`]);
    for (let i = 0; i < 200 && !existsSync(path); i++) await tick();
    child.kill('SIGKILL');
    await child.exited;
    expect(existsSync(path)).toBe(true);

    await startServer(new FakeHost());
    const io = new ScriptIO([]);
    expect(await run({ name: 'status' }, io)).toBe(0);
  });

  test('不覆盖同名的普通文件', async () => {
    const path = controlSocketPath(home);
    writeFileSync(path, 'not a socket');
    const s = new ControlServer(new FakeHost());
    await expect(s.listen(path)).rejects.toThrow(/不是 socket/);
  });
});

describe('控制通道：重启', () => {
  test('restart：带上发起会话与续跑提示，报告排期', async () => {
    const host = new FakeHost();
    await startServer(host);
    const io = new ScriptIO([]);
    expect(await run({ name: 'restart', now: false, sessionId: 's1', continuePrompt: '核实' }, io)).toBe(0);
    expect(host.restartRequests).toEqual([{ now: false, notice: { sessionId: 's1', continuePrompt: '核实' } }]);
    expect(io.output).toContain('新版本 0.19.0');
    expect(io.output).toContain('当前 1 个在忙');
    expect(io.output).toContain('本轮结束后才会重启');
  });

  test('预检失败：退出码 1，打印输出尾部', async () => {
    const host = new FakeHost();
    host.restartOutcome = { ok: false, code: 'check_failed', message: 'bun install 失败', output: 'lockfile mismatch' };
    await startServer(host);
    const io = new ScriptIO([]);
    expect(await run({ name: 'restart', now: true }, io)).toBe(1);
    expect(host.restartRequests).toEqual([{ now: true }]);
    expect(io.output).toContain('没有重启：bun install 失败');
    expect(io.output).toContain('lockfile mismatch');
  });

  test('restart cancel', async () => {
    await startServer(new FakeHost());
    const io = new ScriptIO([]);
    expect(await run({ name: 'restart.cancel' }, io)).toBe(0);
    expect(io.output).toContain('已取消重启');
  });

  test('agent 没在运行：提示无需重启', async () => {
    const io = new ScriptIO([]);
    expect(await run({ name: 'restart', now: false }, io)).toBe(1);
    expect(io.output).toContain('没有在运行');
  });

  test('selfcheck 不连 agent，打印版本', async () => {
    const io = new ScriptIO([]);
    expect(await run({ name: 'selfcheck' }, io)).toBe(0);
    expect(io.output).toMatch(/^trine-agent selfcheck ok \d+\.\d+\.\d+/);
  });
});

describe('控制通道：配对', () => {
  test('完整流程：出码 → 收到请求 → 用户确认 → 绑定用户看到的对端', async () => {
    const host = new FakeHost();
    const srv = await startServer(host);
    const io = new ScriptIO([
      async () => 'y',
    ]);
    const done = run({ name: 'pair' }, io);
    await io.waitFor('等待浏览器扫码');
    expect(io.output).toContain('trine-pair-test-1');
    expect(srv.onPairingRequest(host.begin('web-new', '123456'))).toBe(true);

    expect(await done).toBe(0);
    expect(io.output).toContain('本端校验码 123456');
    expect(io.output).toContain('已配对 web-new');
    expect(host.confirmed).toEqual([
      { token: 'token-1', expected: { clientDeviceId: 'web-new', clientPubKey: 'box-web-new', clientSignPubKey: 'sign-web-new' } },
    ]);
  });

  test('不是本通道发起的配对 → onPairingRequest 返回 false（交给前台 --pair）', async () => {
    const host = new FakeHost();
    const srv = await startServer(host);
    const session = host.startPairing();
    session.pending = host.begin('x', '000000').pending;
    expect(srv.onPairingRequest(session)).toBe(false);
  });

  test('比对期间来了新请求 → 旧问题作废，确认绑定到最新对端', async () => {
    const host = new FakeHost();
    const srv = await startServer(host);
    const io = new ScriptIO([
      undefined, // 第一条一直不答，直到被新请求中止
      async () => 'y',
    ]);
    const done = run({ name: 'pair' }, io);
    await io.waitFor('等待浏览器扫码');
    srv.onPairingRequest(host.begin('web-a', '111111'));
    await io.waitFor('本端校验码 111111');
    srv.onPairingRequest(host.begin('web-b', '222222'));

    expect(await done).toBe(0);
    expect(io.output).toContain('上一条作废');
    expect(host.confirmed.map((c) => c.expected.clientDeviceId)).toEqual(['web-b']);
  });

  test('daemon 侧：过时 requestId 的确认被拒（纵深防御）', async () => {
    const host = new FakeHost();
    const srv = await startServer(host);
    const events: string[] = [];
    const socket = connect(controlSocketPath(home));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => events.push(...chunk.trim().split('\n')));
    await new Promise((r) => socket.once('connect', r));
    socket.write('{"op":"pair.start"}\n');
    await tick();
    srv.onPairingRequest(host.begin('web-a', '111111'));
    srv.onPairingRequest(host.begin('web-b', '222222'));
    await tick();
    const firstId = JSON.parse(events.find((e) => e.includes('111111'))!).requestId;
    socket.write(`{"op":"pair.answer","requestId":${firstId},"confirm":true}\n`);
    await tick();
    socket.destroy();
    expect(host.confirmed).toEqual([]);
    expect(events.at(-1)).toContain('已被新请求取代');
  });

  test('用户判定不一致 → 中止；选择不重试则退出码 1', async () => {
    const host = new FakeHost();
    const srv = await startServer(host);
    const io = new ScriptIO([async () => 'n', 'q']);
    const done = run({ name: 'pair' }, io);
    await io.waitFor('等待浏览器扫码');
    srv.onPairingRequest(host.begin('web-x', '999999'));
    expect(await done).toBe(1);
    expect(host.aborted).toContainEqual({ token: 'token-1', reason: 'SAS mismatch' });
    expect(host.confirmed).toEqual([]);
    expect(io.output).toContain('校验码不一致');
  });

  test('过期 → 提示并可按 Enter 重新生成新码', async () => {
    const host = new FakeHost();
    host.ttlMs = 30;
    const srv = await startServer(host);
    const io = new ScriptIO([
      async () => {
        host.ttlMs = 5 * 60_000;
        return '';
      },
      async () => 'y',
    ]);
    const done = run({ name: 'pair' }, io);
    await io.waitFor('配对码已过期');
    await io.waitFor('trine-pair-test-2');
    srv.onPairingRequest(host.begin('web-late', '424242'));
    expect(await done).toBe(0);
    expect(host.aborted).toContainEqual({ token: 'token-1', reason: 'expired' });
    expect(host.confirmed[0]?.token).toBe('token-2');
  });

  test('对端取消 → 通知子命令', async () => {
    const host = new FakeHost();
    const srv = await startServer(host);
    const io = new ScriptIO(['q']);
    const done = run({ name: 'pair' }, io);
    await io.waitFor('等待浏览器扫码');
    expect(srv.onPairingAborted('token-1')).toBe(true);
    expect(await done).toBe(1);
    expect(io.output).toContain('对端取消了配对');
  });

  test('子命令断开（Ctrl-C）→ daemon 中止该配对', async () => {
    const host = new FakeHost();
    await startServer(host);
    const io = new ScriptIO([]);
    const done = run({ name: 'pair' }, io);
    await io.waitFor('等待浏览器扫码');
    io.client!.close();
    expect(await done).toBe(1);
    await tick();
    expect(host.aborted).toContainEqual({ token: 'token-1', reason: 'pairing cancelled on agent' });
  });

  test('确认失败（如期间过期）→ 报错，不算成功', async () => {
    const host = new FakeHost();
    host.confirmError = new Error('配对码已过期（5 分钟），请重新生成');
    const srv = await startServer(host);
    const io = new ScriptIO([async () => 'y']);
    const done = run({ name: 'pair' }, io);
    await io.waitFor('等待浏览器扫码');
    srv.onPairingRequest(host.begin('web-x', '555555'));
    await io.waitFor('agent 报错：配对码已过期');
    io.client!.close();
    expect(await done).toBe(1);
  });

  test('非交互终端拒绝 pair', async () => {
    await startServer(new FakeHost());
    const io = new ScriptIO([]);
    io.interactive = false;
    expect(await run({ name: 'pair' }, io)).toBe(2);
  });
});

describe('agent 没在运行', () => {
  /** 直接写文件而不经 RecipientBookStore.add：不替被测代码初始化 libsodium */
  async function seedRecipients(): Promise<void> {
    const recipients = [
      { deviceId: 'web-old', boxPubKey: 'b', signPubKey: 's', pairedAt: 1 },
      { deviceId: 'web-new', boxPubKey: 'b', signPubKey: 's', pairedAt: 2 },
    ];
    writeFileSync(agentPaths(home).recipients, JSON.stringify({ v: 1, recipients }));
  }

  test('devices list / revoke 直接读写名册，且用完释放锁', async () => {
    // 本文件不调 sodiumReady()：离线 revoke 落盘要用 randomToken，必须自己初始化
    await seedRecipients();
    const list = new ScriptIO([]);
    expect(await run({ name: 'devices.list' }, list)).toBe(0);
    expect(list.output).toContain('已配对 2 台设备');

    const revoke = new ScriptIO([]);
    expect(await run({ name: 'devices.revoke', device: 'web-old' }, revoke)).toBe(0);
    const reloaded = await RecipientBookStore.load(agentPaths(home).recipients);
    expect(reloaded.list().map((r) => r.deviceId)).toEqual(['web-new']);
    expect(revoke.output).not.toContain('立即生效');
    // 锁已释放：agent 随后能正常启动
    acquireInstanceLock(home).release();
  });

  test('pair / status 提示先启动 agent', async () => {
    const pair = new ScriptIO([]);
    expect(await run({ name: 'pair' }, pair)).toBe(1);
    expect(pair.output).toContain('agent 没有在运行');
    const status = new ScriptIO([]);
    expect(await run({ name: 'status' }, status)).toBe(1);
  });

  test('锁显示 agent 在跑但没有控制通道 → 提示是旧版本、需重启', async () => {
    const lock = acquireInstanceLock(home); // 本测试进程 = 「在跑的旧版 agent」
    try {
      const io = new ScriptIO([]);
      expect(await run({ name: 'devices.list' }, io)).toBe(1);
      expect(io.output).toContain(`PID ${process.pid}`);
      expect(io.output).toContain('旧版本');
    } finally {
      lock.release();
    }
  });
});

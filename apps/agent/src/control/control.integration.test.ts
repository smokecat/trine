/**
 * 控制通道端到端：进程内真服务端 + 真 AgentApp（假会话）+ 真控制通道 + 模拟浏览器。
 *
 * 验证的是「agent 在跑、不停机」的整条路径：`pair` 子命令出码 → 浏览器扫码发
 * pair.begin → 子命令终端里显示的 SAS 与浏览器算出的一致 → 确认 → 浏览器拿到
 * pair.confirm 并能接入；随后 `devices revoke` 让它立即失效。
 */
import { createInvitation } from '../../../server/src/auth/invitations.ts';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sodiumReady } from '@trine/core/crypto';
import { startServer, type TrineServer } from '../../../server/src/server.ts';
import type { AgentApp } from '../app/app.ts';
import { startEchoAgent } from '../testing/echo-session.ts';
import { MockClient } from '../testing/mock-client.ts';
import { ScriptIO } from '../testing/script-io.ts';
import { controlSocketPath, runSubcommand } from './commands.ts';
import { attachControlServer } from './host.ts';
import type { ControlServer } from './server.ts';

let server: TrineServer;
let home: string;
let app: AgentApp;
let control: ControlServer;
let logs: string[];

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'trine-ctl-e2e-'));
  logs = [];
  server = await startServer({
    port: 0,
    hostname: '127.0.0.1',
    dbPath: ':memory:',
    allowOpenRegistration: false,
    heartbeatIntervalMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  ({ app } = await startEchoAgent({
    serverUrl: `http://127.0.0.1:${server.port}`,
    getInvitation: async () => createInvitation(server.store).token,
    home,
    machineId: 'mbp',
    log: (l) => logs.push(l),
  }));
  control = await attachControlServer(app, controlSocketPath(home), { log: (l) => logs.push(l) });
  await waitFor(() => app.node.online, 'agent 接入');
});

afterEach(async () => {
  await control.close();
  await app.stop();
  await server.stop();
  await rm(home, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待「${label}」超时`);
    await Bun.sleep(10);
  }
}

function payloadOf(io: ScriptIO): string {
  const match = /trine1:[A-Za-z0-9+/=_-]+/.exec(io.output);
  if (!match) throw new Error('输出里没有配对码');
  return match[0];
}

describe('控制通道 · 端到端', () => {
  test('pair 子命令：SAS 两端一致 → 确认 → 浏览器入名册且收到 pair.confirm', async () => {
    const browser = new MockClient('web-new', server.port);
    let browserSas = '';
    const io = new ScriptIO([
      async () => {
        // 人在这里比对：终端显示的必须就是浏览器算出的那组
        expect(io.output).toContain(`本端校验码 ${browserSas}`);
        return 'y';
      },
    ]);
    const done = runSubcommand({ name: 'pair' }, home, io);
    await io.waitFor('等待浏览器扫码');

    await browser.connectForPairing();
    const scanned = browser.scan(payloadOf(io));
    browserSas = scanned.sas.digits;
    browser.sendPairBegin(scanned.pairingToken);

    expect(await done).toBe(0);
    await browser.wait('pair.confirm');
    expect(app.node.recipients.has('web-new')).toBe(true);
    expect(io.output).toContain('已配对 web-new');
    browser.close();
  });

  test('浏览器放弃配对 → 子命令收到「对端取消」', async () => {
    const browser = new MockClient('web-quit', server.port);
    const io = new ScriptIO([undefined, 'q']);
    const done = runSubcommand({ name: 'pair' }, home, io);
    await io.waitFor('等待浏览器扫码');
    await browser.connectForPairing();
    const scanned = browser.scan(payloadOf(io));
    browser.sendPairBegin(scanned.pairingToken);
    await io.waitFor('本端校验码');
    browser.send({ type: 'pair.abort', pairingToken: scanned.pairingToken });

    expect(await done).toBe(1);
    expect(io.output).toContain('对端取消了配对');
    expect(app.node.recipients.has('web-quit')).toBe(false);
    browser.close();
  });

  test('devices revoke：运行中的 agent 立即移除，status 反映新数目', async () => {
    await app.node.recipients.add({ deviceId: 'web-stale', boxPubKey: 'b', signPubKey: 's', pairedAt: 1 });
    const io = new ScriptIO([]);
    expect(await runSubcommand({ name: 'devices.revoke', device: 'web-st' }, home, io)).toBe(0);
    expect(app.node.recipients.has('web-stale')).toBe(false);
    expect(logs).toContain('[app] 已移除配对设备 web-stale');

    const status = new ScriptIO([]);
    expect(await runSubcommand({ name: 'status' }, home, status)).toBe(0);
    expect(status.output).toContain('已配对设备：0 台');
    expect(status.output).toContain('已接入');
  });
});

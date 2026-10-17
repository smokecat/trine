import { createInvitation } from '../../../server/src/auth/invitations.ts';
/**
 * `startEchoAgent` 助手本身的测试。
 *
 * 它是给 web 阶段 1 的 in-process e2e 用的地基——「起一个真 agent 接上真
 * 服务端」这件事如果悄悄坏了，坏的会是别人的测试，而且现场会指向 web 的
 * 协议层而不是这里。所以在这里先钉住它的契约。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sodiumReady } from '@trine/core/crypto';
import { startServer, type TrineServer } from '../../../server/src/server.ts';
import { startEchoAgent } from './echo-session.ts';

let server: TrineServer;
let home: string;

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'trine-echo-'));
  server = await startServer({
    port: 0,
    hostname: '127.0.0.1',
    dbPath: ':memory:',
    allowOpenRegistration: false,
    heartbeatIntervalMs: 60_000,
    sweepIntervalMs: 60_000,
  });
});

afterEach(async () => {
  await server.stop();
  await rm(home, { recursive: true, force: true });
});

const serverUrl = () => `http://127.0.0.1:${server.port}`;
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('startEchoAgent', () => {
  test('默认自动接入服务端（首设备使用邀请）', async () => {
    const { app, stop } = await startEchoAgent({ getInvitation: async () => createInvitation(server.store).token, serverUrl: serverUrl(), home });
    try {
      await settle();
      expect(app.node.online).toBe(true);
      expect(server.registry.isAgentOnline('mbp')).toBe(true);
      // 默认值：machineId / name / claudeVersion 都不依赖本机环境
      expect(app.node.machineId).toBe('mbp');
      expect(app.machineInfo()).toMatchObject({
        name: 'Test MBP',
        claudeVersion: 'test',
        activeSessionCount: 0,
      });
    } finally {
      await stop();
    }
  });

  test('autoStart:false 只装配不接入，交给调用方自己 start', async () => {
    const { app, stop } = await startEchoAgent({
      getInvitation: async () => createInvitation(server.store).token, serverUrl: serverUrl(),
      home,
      autoStart: false,
    });
    try {
      await settle();
      expect(app.node.online).toBe(false);
      await app.start();
      await settle();
      expect(app.node.online).toBe(true);
    } finally {
      await stop();
    }
  });

  test('可覆盖 machineId / name / claudeVersion', async () => {
    const { app, stop } = await startEchoAgent({
      getInvitation: async () => createInvitation(server.store).token, serverUrl: serverUrl(),
      home,
      machineId: 'vps-1',
      name: 'My VPS',
      claudeVersion: '9.9.9 (fake)',
      autoStart: false,
    });
    try {
      expect(app.node.machineId).toBe('vps-1');
      expect(app.machineInfo()).toMatchObject({
        name: 'My VPS',
        claudeVersion: '9.9.9 (fake)',
      });
    } finally {
      await stop();
    }
  });

  test('claudeVersion 不去探测本机 claude：有没有装都不影响测试结果', async () => {
    // detectClaudeVersion 自身对「没装」有兜底（返回 'unknown'），但那样断言
    // 就得跟着环境变。助手写死默认值，测试结果与本机装没装 claude 无关。
    const { app, stop } = await startEchoAgent({
      getInvitation: async () => createInvitation(server.store).token, serverUrl: serverUrl(),
      home,
      autoStart: false,
    });
    try {
      expect(app.machineInfo().claudeVersion).toBe('test');
    } finally {
      await stop();
    }
  });

  test('stop() 之后连接关闭，服务端不再认为该机器在线', async () => {
    const { app, stop } = await startEchoAgent({ getInvitation: async () => createInvitation(server.store).token, serverUrl: serverUrl(), home });
    await settle();
    expect(app.node.online).toBe(true);
    await stop();
    await settle();
    expect(app.node.online).toBe(false);
    expect(server.registry.isAgentOnline('mbp')).toBe(false);
  });
});

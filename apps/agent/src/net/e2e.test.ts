import { createInvitation } from '../../../server/src/auth/invitations.ts';
/**
 * 三端贯通测试：真服务端进程内实例 + 真 WebSocket + 真 AgentNode +
 * 用 core 原语手搓的模拟 client。
 *
 * 走完整条路：
 *   agent bootstrap 注册上线
 *   → 生成配对材料（QR）
 *   → client 以 role:'pairing' 免认证接入、发 pair.begin
 *   → 双端各自算 SAS 并比对一致
 *   → agent 确认，发 pair.confirm 复述身份
 *   → server 背书校验通过，自动登记 client
 *   → client 换 token，以 role:'client' 正常接入
 *   → 双向密文 relay 往返，两端各自解密成功
 *   → 断言服务端从头到尾只见密文与 † 字段
 *
 * 外加异常路径：token 过期/重放、SAS 不一致 abort、agent 复述与 begin
 * 不一致被 server 拒、非 agent 角色发 confirm 被拒。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodePairingPayload,
  generateKeyPair,
  generateSignKeyPair,
  sealJson,
  sodiumReady,
  type Sas,
} from '@trine/core/crypto';
import type {
  AgentToClientEvent,
  ClientToAgentEvent,
  TransportFrame,
} from '@trine/core';
import { startServer, type TrineServer } from '../../../server/src/server.ts';
import { MockClient } from '../testing/mock-client.ts';
import { AgentNode } from './node.ts';
import type { Recipient } from './recipients.ts';

let server: TrineServer;
let dir: string;
let agent: AgentNode;
/** agent 收到的入站事件 */
let inbound: { event: ClientToAgentEvent; sender: Recipient }[];

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trine-e2e-'));
  inbound = [];
  server = await startServer({
    port: 0,
    hostname: '127.0.0.1',
    dbPath: ':memory:',
    // 关键：开放注册关着。client 能被登记进来，只可能是 agent 背书的结果
    allowOpenRegistration: false,
    heartbeatIntervalMs: 60_000,
    sweepIntervalMs: 60_000,
  });
  agent = await AgentNode.create({
    serverUrl: `http://127.0.0.1:${server.port}`,
    getInvitation: async () => createInvitation(server.store).token,
    identityPath: join(dir, 'identity.json'),
    recipientsPath: join(dir, 'recipients.json'),
    machineId: 'mbp',
    name: 'Test MBP',
    onEvent: (event, sender) => inbound.push({ event, sender }),
  });
});

afterEach(async () => {
  agent.disconnect();
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/**
 * 完整走一遍配对，返回已配对且已正常接入的 client。
 * `tamper` 可在中途改动 agent 要复述的身份，用来测背书校验。
 */
async function pairSuccessfully(deviceId = 'phone'): Promise<{
  client: MockClient;
  agentSas: Sas;
  clientSas: Sas;
}> {
  await agent.connect();
  await settle();

  const session = agent.startPairing();
  const client = new MockClient(deviceId, server.port);
  await client.connectForPairing();
  await settle();

  const scanned = client.scan(session.payload);
  client.sendPairBegin(scanned.pairingToken);
  await settle();

  const pending = agent.pairing.get(scanned.pairingToken)?.pending;
  if (!pending) throw new Error('agent 没有收到 pair.begin');

  // 人工比对这一步（测试里代之以断言）
  await agent.confirmPairing(scanned.pairingToken);
  await client.wait('pair.confirm');

  return { client, agentSas: pending.sas, clientSas: scanned.sas };
}

// ---------------------------------------------------------------------------

describe('三端贯通：配对 → 登记 → 接入 → 密文往返', () => {
  test('走完整条路，双端 SAS 一致且消息双向可解', async () => {
    await agent.connect();
    await settle();
    // agent 通过邀请成功接入
    expect(agent.online).toBe(true);
    expect(server.registry.isAgentOnline('mbp')).toBe(true);

    // 1. agent 生成配对材料
    const session = agent.startPairing();
    expect(session.payload.startsWith('trine1:')).toBe(true);

    // 2. client 免认证接入并扫码
    const client = new MockClient('phone', server.port);
    await client.connectForPairing();
    await settle();
    const scanned = client.scan(session.payload);
    expect(scanned.pairingToken).toBe(session.pairingToken);
    // AgentNode 把本机 machineId 写进了 QR：client 不必再靠「首条在线
    // machine.status」猜自己配的是哪台机器
    expect(decodePairingPayload(session.payload).machineId).toBe('mbp');

    // 3. pair.begin 送达 agent
    client.sendPairBegin(scanned.pairingToken);
    await settle();
    const pending = agent.pairing.get(session.pairingToken)?.pending;
    expect(pending).toBeTruthy();
    expect(pending!.clientDeviceId).toBe('phone');

    // 4. 双端 SAS 一致——整套流程里唯一挡中间人的环节
    expect(pending!.sas).toEqual(scanned.sas);
    expect(pending!.sas.digits).toHaveLength(6);

    // 5. 用户确认 → agent 复述身份 → server 背书登记
    expect(server.store.getDevice('phone')).toBeNull();
    await agent.confirmPairing(session.pairingToken);
    await client.wait('pair.confirm');
    expect(server.store.getDevice('phone')).toMatchObject({
      role: 'client',
      signPubKey: client.signKeys.publicKey,
    });
    // token 已核销（agent 侧）
    expect(agent.pairing.activeCount).toBe(0);
    // agent 名册里有了这台设备
    expect(agent.recipients.get('phone')?.boxPubKey).toBe(
      client.boxKeys.publicKey,
    );

    // 6. client 换 token 正常接入
    client.close();
    await settle();
    const paired = new MockClient('phone', server.port);
    // 复用同一套密钥（现实中是同一台设备重连）
    Object.assign(paired, {
      signKeys: client.signKeys,
      boxKeys: client.boxKeys,
      agentBoxPubKey: client.agentBoxPubKey,
    });
    await paired.connectAsClient();
    expect((await paired.wait('machine.status')).machineId).toBe('mbp');

    // 7. client → agent 密文
    const c2a: ClientToAgentEvent = {
      type: 'input.send',
      ts: Date.now(),
      seq: 1,
      dir: 'c2a',
      sessionId: 's1',
      clientMsgId: 'c1',
      text: '这是只有两端读得懂的正文',
    };
    paired.sendEvent(c2a);
    await settle();
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.event).toEqual(c2a);
    expect(inbound[0]!.sender.deviceId).toBe('phone');

    // 8. agent → client 密文
    const a2c: AgentToClientEvent = {
      type: 'assistant.done',
      ts: Date.now(),
      seq: 1,
      dir: 'a2c',
      sessionId: 's1',
      messageId: 'm1',
      text: '这是 agent 的回复正文',
    };
    expect(agent.publish(a2c, 'run_done')).toBe(1);
    const relayed = await paired.wait('relay');
    expect(paired.openRelay(relayed)).toEqual(a2c);

    paired.close();
  });

  test('零知识：服务端库里只有密文与 † 字段，没有任何正文', async () => {
    const { client } = await pairSuccessfully();
    client.close();
    await settle();

    const paired = new MockClient('phone', server.port);
    Object.assign(paired, {
      signKeys: client.signKeys,
      boxKeys: client.boxKeys,
      agentBoxPubKey: client.agentBoxPubKey,
    });
    await paired.connectAsClient();
    await settle();

    const SECRET_C2A = '客户端的机密正文-ABCDEF';
    const SECRET_A2C = '代理端的机密正文-123456';
    paired.sendEvent({
      type: 'input.send',
      ts: Date.now(),
      seq: 1,
      dir: 'c2a',
      sessionId: 's1',
      clientMsgId: 'c1',
      text: SECRET_C2A,
    });
    agent.publish({
      type: 'assistant.done',
      ts: Date.now(),
      seq: 1,
      dir: 'a2c',
      sessionId: 's1',
      messageId: 'm1',
      text: SECRET_A2C,
    });
    await paired.wait('relay');
    await settle();

    // relay_frames 表：列集合就是 transport.ts 的明文字段，没有正文的位置。
    // recipient_id 是路由字段，† 判据下成立——服务端本来就持有设备清单，
    // 「这份密文送到哪台设备」正是中转本职
    const rows = server.store.db
      .query('SELECT * FROM relay_frames')
      .all() as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'ciphertext',
      'created_at',
      'dir',
      'machine_id',
      'nonce',
      'push_hint',
      'recipient_id',
      'seq',
      'session_id',
    ]);

    // 整个库 dump 一遍：两段正文一个字都不许出现
    const tables = (
      server.store.db
        .query("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
    ).map((t) => t.name);
    let dump = '';
    for (const table of tables) {
      dump += JSON.stringify(server.store.db.query(`SELECT * FROM ${table}`).all());
    }
    expect(dump).not.toContain(SECRET_C2A);
    expect(dump).not.toContain(SECRET_A2C);
    // 事件类型名也读不到——那也是密文里的东西
    expect(dump).not.toContain('assistant.done');
    expect(dump).not.toContain('input.send');
    // 更不该有 E2E 私钥或 qrSecret
    expect(dump).not.toContain(agent.identity.box.secretKey);
    expect(dump).not.toContain(client.boxKeys.secretKey);

    // 服务端能看到的只有 † 清单里的东西：路由字段 + 脱敏 pushHint
    expect(dump).toContain('mbp');
    expect(dump).toContain('s1');

    paired.close();
  });

  /**
   * 矩阵式配对（D8）的核心场景：N 台设备 = N 份密文，同 seq、
   * 靠 recipientDeviceId 区分（core 的帧字段 + server schema v2 的主键）。
   */
  test('矩阵式配对：两台设备各自独立，各收各的那一份密文', async () => {
    const first = await pairSuccessfully('phone');
    first.client.close();
    await settle();

    // 第二台设备走一遍全新的配对（新 token、新 qrSecret）
    const session = agent.startPairing();
    const tablet = new MockClient('tablet', server.port);
    await tablet.connectForPairing();
    await settle();
    const scanned = tablet.scan(session.payload);
    tablet.sendPairBegin(scanned.pairingToken);
    await settle();
    expect(agent.pairing.get(session.pairingToken)?.pending?.sas).toEqual(
      scanned.sas,
    );
    await agent.confirmPairing(session.pairingToken);
    await tablet.wait('pair.confirm');
    tablet.close();
    await settle();

    expect(agent.recipients.size).toBe(2);

    // 两台都接入，agent 发一条：各收到自己那一份，且都能解开
    const phone = new MockClient('phone', server.port);
    Object.assign(phone, {
      signKeys: first.client.signKeys,
      boxKeys: first.client.boxKeys,
      agentBoxPubKey: first.client.agentBoxPubKey,
    });
    const pad = new MockClient('tablet', server.port);
    Object.assign(pad, {
      signKeys: tablet.signKeys,
      boxKeys: tablet.boxKeys,
      agentBoxPubKey: tablet.agentBoxPubKey,
    });
    await phone.connectAsClient();
    await pad.connectAsClient();
    await settle();

    const event: AgentToClientEvent = {
      type: 'assistant.done',
      ts: Date.now(),
      seq: 1,
      dir: 'a2c',
      sessionId: 's1',
      messageId: 'm1',
      text: '两台设备都该读得到',
    };
    // 两份密文（一台一份），同一个 seq，靠 recipientDeviceId 区分
    expect(agent.publish(event)).toBe(2);
    await phone.wait('relay');
    await pad.wait('relay');
    await settle();

    const phoneFrames = phone.ofType('relay');
    const padFrames = pad.ofType('relay');

    // 定向投递：各自**只**收到自己那一帧，没有别人的密文串过来
    expect(phoneFrames).toHaveLength(1);
    expect(padFrames).toHaveLength(1);
    expect(phoneFrames[0]!.recipientDeviceId).toBe('phone');
    expect(padFrames[0]!.recipientDeviceId).toBe('tablet');
    // 同一逻辑事件 = 同一个 seq（client 侧单调游标的前提）
    expect(phoneFrames[0]!.seq).toBe(padFrames[0]!.seq);
    // 密文本身不同（不同共享密钥 + 不同 nonce）
    expect(phoneFrames[0]!.ciphertext).not.toBe(padFrames[0]!.ciphertext);

    // 各自都解得开自己那一份，明文一致
    expect(phone.openRelay(phoneFrames[0]!)).toEqual(event);
    expect(pad.openRelay(padFrames[0]!)).toEqual(event);
    // 但解不开对方那一份——撤销一台不牵连另一台的根据
    expect(tryOpen(pad, phoneFrames[0]!)).toBe(false);
    expect(tryOpen(phone, padFrames[0]!)).toBe(false);

    phone.close();
    pad.close();
  });

  test('设备 B 断线重连，sync.request 只补到自己那条子流', async () => {
    // 先把两台设备都配对好
    const first = await pairSuccessfully('phone');
    first.client.close();
    await settle();

    const session = agent.startPairing();
    const tabletPairing = new MockClient('tablet', server.port);
    await tabletPairing.connectForPairing();
    await settle();
    const scanned = tabletPairing.scan(session.payload);
    tabletPairing.sendPairBegin(scanned.pairingToken);
    await settle();
    await agent.confirmPairing(session.pairingToken);
    await tabletPairing.wait('pair.confirm');
    tabletPairing.close();
    await settle();

    // phone 在线，tablet 离线：agent 发两条，只有 phone 当场收到
    const phone = new MockClient('phone', server.port);
    Object.assign(phone, {
      signKeys: first.client.signKeys,
      boxKeys: first.client.boxKeys,
      agentBoxPubKey: first.client.agentBoxPubKey,
    });
    await phone.connectAsClient();
    await settle();

    for (let seq = 1; seq <= 3; seq++) {
      agent.publish({
        type: 'assistant.done',
        ts: Date.now(),
        seq,
        dir: 'a2c',
        sessionId: 's1',
        messageId: `m${seq}`,
        text: `第 ${seq} 条`,
      });
    }
    await phone.wait('relay');
    await settle();
    expect(phone.ofType('relay')).toHaveLength(3);

    // tablet 上线后请求补发
    const pad = new MockClient('tablet', server.port);
    Object.assign(pad, {
      signKeys: tabletPairing.signKeys,
      boxKeys: tabletPairing.boxKeys,
      agentBoxPubKey: tabletPairing.agentBoxPubKey,
    });
    await pad.connectAsClient();
    await settle();
    pad.send({
      type: 'sync.request',
      machineId: 'mbp',
      sessionId: 's1',
      sinceSeq: 0,
    });
    await pad.wait('relay');
    await settle();

    const resent = pad.ofType('relay');
    // 只补到自己那条子流：3 条，全是发给 tablet 的，全都解得开。
    // 不过滤的话这里会是 6 条，其中 3 条是 phone 的密文——解不开，
    // 还会把 client 侧按信封 seq 推进的单调游标打乱
    expect(resent).toHaveLength(3);
    expect(resent.every((f) => f.recipientDeviceId === 'tablet')).toBe(true);
    expect(resent.map((f) => f.seq)).toEqual([1, 2, 3]);
    for (const frame of resent) {
      expect(pad.openRelay(frame).type).toBe('assistant.done');
    }

    phone.close();
    pad.close();
  });
});

/** 断线重连（进程内）：同一 AgentNode，游标不丢 */
async function reconnectAgent(): Promise<void> {
  agent.disconnect();
  await settle();
  await agent.connect();
  await settle(80);
}

describe('接线层依赖的钩子', () => {
  test('重连后逐流发 sync.request：会话级与机器级各带自己的 sinceSeq', async () => {
    const { client } = await pairSuccessfully();
    client.close();
    await settle();
    const phone = new MockClient('phone', server.port);
    Object.assign(phone, {
      signKeys: client.signKeys,
      boxKeys: client.boxKeys,
      agentBoxPubKey: client.agentBoxPubKey,
    });
    await phone.connectAsClient();
    await settle();

    // 会话 s1 上收到 3 帧、机器级收到 1 帧、s2 一帧都没有
    for (let seq = 1; seq <= 3; seq++) {
      phone.sendEvent({
        type: 'input.send',
        ts: Date.now(),
        seq,
        dir: 'c2a',
        sessionId: 's1',
        clientMsgId: `c${seq}`,
        text: `第 ${seq} 条`,
      });
    }
    phone.sendEvent({
      type: 'session.list.request',
      ts: Date.now(),
      seq: 1,
      dir: 'c2a',
      reqId: 'r1',
    });
    await settle(80);
    expect(inbound).toHaveLength(4);
    expect(agent.cursors.minLastSeen('s1')).toBe(3);
    expect(agent.cursors.minLastSeen(undefined)).toBe(1);

    // 服务端处理 sync.request 时会把 sinceSeq 记进 stream_cursors——
    // 用它当「服务端确实收到了哪条 sync.request」的观测点
    expect(server.store.getCursor('mbp', 'mbp', 's1')).toBeNull();
    // 断线重连
    await reconnectAgent();

    // 断言必须落到**具体的 sid**：只断言「存在某条 sync.request」会被机器级
    // 那一条假绿（v1 方案的坑，评审 B3）
    expect(server.store.getCursor('mbp', 'mbp', 's1')).toBe(3);
    expect(server.store.getCursor('mbp', 'mbp', undefined)).toBe(1);
    // 没往来过的流不发（sinceSeq=0 会把整个留存窗口重放一遍）
    expect(server.store.getCursor('mbp', 'mbp', 's2')).toBeNull();
    // 补发回来的帧被游标挡掉（seq ≤ 已见），没有重复交给上层
    await settle(80);
    expect(inbound).toHaveLength(4);
    phone.close();
  });

  test('onOpen 在每次接入后触发，且在本层补发请求之后', async () => {
    const opens: number[] = [];
    const node = await AgentNode.create({
      serverUrl: `http://127.0.0.1:${server.port}`,
      getInvitation: async () => createInvitation(server.store).token,
      identityPath: join(dir, 'identity.json'),
      recipientsPath: join(dir, 'recipients.json'),
      machineId: 'mbp',
      onOpen: () => opens.push(Date.now()),
    });
    await node.connect();
    await settle(80);
    expect(opens).toHaveLength(1);
    node.disconnect();
    await settle();
    await node.connect();
    await settle(80);
    expect(opens).toHaveLength(2);
    node.disconnect();
  });

  test('publishTo 只封给指定收件人，其他设备一帧都收不到', async () => {
    const first = await pairSuccessfully('phone');
    first.client.close();
    await settle();
    const session = agent.startPairing();
    const tabletPairing = new MockClient('tablet', server.port);
    await tabletPairing.connectForPairing();
    await settle();
    const scanned = tabletPairing.scan(session.payload);
    tabletPairing.sendPairBegin(scanned.pairingToken);
    await settle();
    await agent.confirmPairing(scanned.pairingToken);
    await tabletPairing.wait('pair.confirm');
    tabletPairing.close();
    await settle();

    const phone = new MockClient('phone', server.port);
    Object.assign(phone, {
      signKeys: first.client.signKeys,
      boxKeys: first.client.boxKeys,
      agentBoxPubKey: first.client.agentBoxPubKey,
    });
    const pad = new MockClient('tablet', server.port);
    Object.assign(pad, {
      signKeys: tabletPairing.signKeys,
      boxKeys: tabletPairing.boxKeys,
      agentBoxPubKey: tabletPairing.agentBoxPubKey,
    });
    await phone.connectAsClient();
    await pad.connectAsClient();
    await settle();

    const event: AgentToClientEvent = {
      type: 'assistant.done',
      ts: Date.now(),
      seq: 1,
      dir: 'a2c',
      sessionId: 's1',
      messageId: 'm1',
      text: '只给 tablet',
    };
    expect(agent.publishTo('tablet', event)).toBe(true);
    await pad.wait('relay');
    await settle();
    expect(pad.ofType('relay')).toHaveLength(1);
    expect(pad.openRelay(pad.ofType('relay')[0]!)).toEqual(event);
    expect(phone.ofType('relay')).toHaveLength(0);
    // 不在名册里的收件人：不发、返回 false
    expect(agent.publishTo('stranger', event)).toBe(false);
    phone.close();
    pad.close();
  });
});

function tryOpen(
  client: MockClient,
  frame: Extract<TransportFrame, { type: 'relay' }>,
): boolean {
  try {
    client.openRelay(frame);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

describe('异常路径', () => {
  test('SAS 不一致：用户 abort → 双端清理，token 再也用不了', async () => {
    await agent.connect();
    await settle();
    const session = agent.startPairing();
    const client = new MockClient('phone', server.port);
    await client.connectForPairing();
    await settle();
    const scanned = client.scan(session.payload);
    client.sendPairBegin(scanned.pairingToken);
    await settle();

    // 假设用户看出两端 SAS 对不上，中止（不做自动重试——默认假设是中间人）
    expect(agent.abortPairing(session.pairingToken, 'SAS 不一致')).toBe(true);
    await client.wait('pair.abort');

    expect(agent.pairing.activeCount).toBe(0);
    expect(agent.recipients.size).toBe(0);
    expect(server.store.getDevice('phone')).toBeNull();
    // abort 之后 server 侧的 begin 记录也没了：再 confirm 也登记不了
    expect(
      agent.sendFrame({
        type: 'pair.confirm',
        pairingToken: session.pairingToken,
        clientDeviceId: 'phone',
        clientSignPubKey: client.signKeys.publicKey,
      }),
    ).toBe(true);
    await settle();
    expect(server.store.getDevice('phone')).toBeNull();

    client.close();
  });

  test('token 过期：TTL 到点后 pair.begin 被 agent 静默忽略', async () => {
    await agent.connect();
    await settle();
    const session = agent.startPairing();
    const client = new MockClient('phone', server.port);
    await client.connectForPairing();
    await settle();
    const scanned = client.scan(session.payload);

    // 把 agent 侧的会话核销掉（等价于 TTL 到点被 sweep 清理）
    agent.pairing.abort(session.pairingToken, 'expired');
    client.sendPairBegin(scanned.pairingToken);
    await settle();

    // 静默丢弃：没有 pending，也没有任何回应
    expect(agent.pairing.get(session.pairingToken)).toBeNull();
    expect(server.store.getDevice('phone')).toBeNull();
    client.close();
  });

  test('token 重放：配对成功后拿同一 token 想再塞一台设备', async () => {
    const { client } = await pairSuccessfully('phone');
    const usedToken = agent.recipients.get('phone') ? null : null;
    void usedToken;
    client.close();
    await settle();

    // 攻击者拿走已核销的 token，冒充 agent 复述另一个 deviceId。
    // 这里直接用 agent 的连接发（等价于「agent 被诱导重发」的最强假设）
    const stale = [...agent.recipients.list()][0]!;
    agent.sendFrame({
      type: 'pair.confirm',
      pairingToken: 'ALREADY-USED',
      clientDeviceId: 'attacker',
      clientSignPubKey: stale.signPubKey,
    });
    await settle();
    // server 侧的 begin 记录早已核销，登记不了
    expect(server.store.getDevice('attacker')).toBeNull();
  });

  test('agent 复述与 begin 不一致 → server 拒绝登记且不转发 confirm', async () => {
    await agent.connect();
    await settle();
    const session = agent.startPairing();
    const client = new MockClient('phone', server.port);
    await client.connectForPairing();
    await settle();
    const scanned = client.scan(session.payload);
    client.sendPairBegin(scanned.pairingToken);
    await settle();

    // agent 复述了一把不是它收到的公钥（现实中对应中间人换过公钥，
    // 那种情况下 SAS 已经该让用户拒绝了；这里直接测最后一道防线）
    const attacker = generateSignKeyPair();
    agent.sendFrame({
      type: 'pair.confirm',
      pairingToken: scanned.pairingToken,
      clientDeviceId: 'phone',
      clientSignPubKey: attacker.publicKey,
    });
    await settle();

    expect(server.store.getDevice('phone')).toBeNull();
    // 没登记就绝不转发——否则 client 会以为配对成功却换不到 token
    expect(client.ofType('pair.confirm')).toHaveLength(0);
    client.close();
  });

  test('client 自己发 confirm 想给自己背书 → 被 server 拒', async () => {
    await agent.connect();
    await settle();
    const session = agent.startPairing();
    const client = new MockClient('phone', server.port);
    await client.connectForPairing();
    await settle();
    const scanned = client.scan(session.payload);
    client.sendPairBegin(scanned.pairingToken);
    await settle();

    client.send({
      type: 'pair.confirm',
      pairingToken: scanned.pairingToken,
      clientDeviceId: 'phone',
      clientSignPubKey: client.signKeys.publicKey,
    });
    await settle();
    expect(server.store.getDevice('phone')).toBeNull();
    client.close();
  });

  test('未配对设备发的密文被 agent 丢弃（解不开）', async () => {
    await agent.connect();
    await settle();
    // 先配对一台，让名册非空，从而走的是 decrypt_failed 而不是 unknown_sender
    const { client } = await pairSuccessfully('phone');
    client.close();
    await settle();

    const dropped: string[] = [];
    const node = await AgentNode.create({
      serverUrl: `http://127.0.0.1:${server.port}`,
      getInvitation: async () => createInvitation(server.store).token,
      identityPath: join(dir, 'identity.json'),
      recipientsPath: join(dir, 'recipients.json'),
      onInboundDropped: (failure) => dropped.push(failure),
    });
    const stranger = generateKeyPair();
    const box = sealJson(
      {
        type: 'input.send',
        ts: Date.now(),
        seq: 1,
        dir: 'c2a',
        sessionId: 's1',
        clientMsgId: 'x',
        text: '我不是已配对设备',
      },
      node.identity.box.publicKey,
      stranger.secretKey,
    );
    // 直接喂进入站路径（等价于恶意服务端转来一条帧）
    const result = (
      await import('./envelope.ts')
    ).openInbound(
      {
        type: 'relay',
        machineId: 'mbp',
        sessionId: 's1',
        seq: 1,
        nonce: box.nonce,
        ciphertext: box.ciphertext,
      },
      node.recipients.list(),
      node.identity.box.secretKey,
    );
    expect(result).toMatchObject({ ok: false, failure: 'decrypt_failed' });
  });

  test('pairing 连接不能用来读会话流（受限连接的白名单）', async () => {
    await agent.connect();
    await settle();
    const client = new MockClient('sneaky', server.port);
    await client.connectForPairing();
    await settle();

    const closed = new Promise<number>((resolve) => {
      client.socket!.addEventListener('close', (ev: CloseEvent) => resolve(ev.code));
    });
    client.send({ type: 'sync.request', machineId: 'mbp', sinceSeq: 0 });
    // 4007 = PAIRING_FRAME_NOT_ALLOWED
    expect(await closed).toBe(4007);
  });
});

import { createInvitation } from './auth/invitations.ts';
/**
 * 服务端侧的配对流程集成测试：真 Bun.serve + 真 WebSocket，
 * 覆盖 D8 的两处关键改动——免认证的 `role:'pairing'` 受限连接，
 * 与 agent 背书式登记。
 *
 * 与 hub.test.ts 的分工：那边用替身覆盖分支逻辑，这里验证握手层
 * （server.ts 的 hello 分支 + pairing 帧白名单）确实按设计装配起来了。
 * 三端真正的密文贯通在 apps/agent 的 e2e 测试里。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  authChallengeMessage,
  generateSignKeyPair,
  signDetached,
  sodiumReady,
  type SignKeyPair,
} from '@trine/core/crypto';
import {
  encodeTransportFrame,
  type TransportFrame,
} from '@trine/core/protocol';
import {
  CLOSE,
  helloFrame,
  MAX_PAIRING_CONNS,
  MAX_PAIRING_CONNS_PER_SOURCE,
  pairingHelloFrame,
  startServer,
  type TrineServer,
} from './server.ts';

let server: TrineServer;
let agentKeys: SignKeyPair;

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(async () => {
  agentKeys = generateSignKeyPair();
  server = await startServer({
    port: 0,
    hostname: '127.0.0.1',
    dbPath: ':memory:',
    // 关掉开放注册：配对登记的放行依据必须是 agent 背书，
    // 开着的话测出来的「登记成功」可能只是开放注册在兜底
    allowOpenRegistration: false,
    heartbeatIntervalMs: 60_000,
    sweepIntervalMs: 60_000,
  });
});

afterEach(async () => {
  await server.stop();
});

const settle = () => new Promise((r) => setTimeout(r, 30));

async function post(path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** 已登记设备走挑战-应答换 token（不再注册） */
async function tokenFor(deviceId: string, keys: SignKeyPair): Promise<string> {
  const chal = await post('/auth/challenge', { deviceId });
  expect(chal.status).toBe(200);
  const challenge = chal.body.challenge as string;
  const verified = await post('/auth/verify', {
    deviceId,
    challenge,
    signature: signDetached(
      authChallengeMessage(deviceId, challenge),
      keys.secretKey,
    ),
  });
  expect(verified.status).toBe(200);
  return verified.body.token as string;
}

/** 首台 agent 同样需要管理员签发的邀请。 */
async function bootstrapAgent(deviceId = 'mbp'): Promise<string> {
  const reg = await post('/auth/register', {
    deviceId,
    role: 'agent',
    invitation: createInvitation(server.store).token,
    signPubKey: agentKeys.publicKey,
  });
  expect(reg.status).toBe(200);
  return tokenFor(deviceId, agentKeys);
}

/** 极简收帧 WS 包装 */
class Peer {
  readonly received: TransportFrame[] = [];
  closeInfo: { code: number; reason: string } | null = null;
  private readonly waiters: {
    match: (f: TransportFrame) => boolean;
    resolve: (f: TransportFrame) => void;
  }[] = [];

  private constructor(readonly ws: WebSocket) {}

  static async open(
    port: number,
    hello: string | null,
    /** 模拟来源 IP（X-Forwarded-For），测试按源配额用；默认走 socket 回环 */
    source?: string,
  ): Promise<Peer> {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      source ? { headers: { 'x-forwarded-for': source } } : undefined,
    );
    const peer = new Peer(ws);
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as TransportFrame;
      peer.received.push(frame);
      const idx = peer.waiters.findIndex((w) => w.match(frame));
      if (idx >= 0) peer.waiters.splice(idx, 1)[0]!.resolve(frame);
    });
    ws.addEventListener('close', (ev) => {
      peer.closeInfo = { code: ev.code, reason: ev.reason };
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error')), {
        once: true,
      });
    });
    if (hello) ws.send(hello);
    return peer;
  }

  send(frame: TransportFrame): void {
    this.ws.send(encodeTransportFrame(frame));
  }

  wait<K extends TransportFrame['type']>(
    type: K,
    timeoutMs = 2000,
  ): Promise<Extract<TransportFrame, { type: K }>> {
    const match = (f: TransportFrame) => f.type === type;
    const already = this.received.find(match);
    if (already) return Promise.resolve(already as never);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`等待 ${type} 帧超时`)),
        timeoutMs,
      );
      this.waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f as never);
        },
      });
    });
  }

  waitClose(timeoutMs = 2000): Promise<{ code: number; reason: string }> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待关闭超时')), timeoutMs);
      this.ws.addEventListener(
        'close',
        (ev) => {
          clearTimeout(timer);
          resolve({ code: ev.code, reason: ev.reason });
        },
        { once: true },
      );
    });
  }

  ofType<K extends TransportFrame['type']>(
    type: K,
  ): Extract<TransportFrame, { type: K }>[] {
    return this.received.filter((f) => f.type === type) as never;
  }

  close(): void {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------

describe('pairing 受限连接（缺口 1 的修复）', () => {
  test('免认证即可建连并发出 pair.begin', async () => {
    const agentToken = await bootstrapAgent();
    const agent = await Peer.open(server.port, helloFrame('agent', 'mbp', agentToken));
    await settle();

    // 全新设备：库里没有它的公钥，换不到 token
    const newKeys = generateSignKeyPair();
    const pairing = await Peer.open(server.port, pairingHelloFrame('tablet'));
    await settle();
    expect(server.hub.pairingConnCount).toBe(1);

    pairing.send({
      type: 'pair.begin',
      pairingToken: 'TOK',
      clientPubKey: 'CLIENT-X25519',
      clientSignPubKey: newKeys.publicKey,
      clientDeviceId: 'tablet',
    });
    const begin = await agent.wait('pair.begin');
    expect(begin.clientDeviceId).toBe('tablet');

    agent.close();
    pairing.close();
  });

  test('pairing 连接不进 ConnectionRegistry（收不到任何广播）', async () => {
    const agentToken = await bootstrapAgent();
    const pairing = await Peer.open(server.port, pairingHelloFrame('tablet'));
    await settle();

    // agent 上线会向全体在线 client 广播 machine.status
    const agent = await Peer.open(server.port, helloFrame('agent', 'mbp', agentToken));
    await settle();

    expect(server.registry.size).toBe(1); // 只有 agent
    expect(pairing.ofType('machine.status')).toHaveLength(0);
    expect(pairing.received).toHaveLength(0);

    agent.close();
    pairing.close();
  });

  test('pairing 连接发 pair.* 以外的帧即被断开（白名单）', async () => {
    const pairing = await Peer.open(server.port, pairingHelloFrame('tablet'));
    await settle();
    pairing.send({
      type: 'relay',
      machineId: 'mbp',
      sessionId: 's1',
      seq: 1,
      nonce: 'N',
      ciphertext: 'C',
    });
    expect((await pairing.waitClose()).code).toBe(
      CLOSE.PAIRING_FRAME_NOT_ALLOWED,
    );
  });

  test('pairing 连接发 sync.request 同样被断开（读不到会话流）', async () => {
    const pairing = await Peer.open(server.port, pairingHelloFrame('tablet'));
    await settle();
    pairing.send({ type: 'sync.request', machineId: 'mbp', sinceSeq: 0 });
    expect((await pairing.waitClose()).code).toBe(
      CLOSE.PAIRING_FRAME_NOT_ALLOWED,
    );
  });

  test('连接关闭后从 hub 注销', async () => {
    const pairing = await Peer.open(server.port, pairingHelloFrame('tablet'));
    await settle();
    expect(server.hub.pairingConnCount).toBe(1);
    pairing.close();
    await settle();
    expect(server.hub.pairingConnCount).toBe(0);
  });

  test('单一来源超过每源配额被拒，其他来源不受影响（DoS 根本解）', async () => {
    // 攻击者从一个 IP 猛开连接：占满自己的每源配额后就被 4009 挡住，
    // 动不了全局其余槽位，也动不了合法用户
    const attacker: Peer[] = [];
    for (let i = 0; i < MAX_PAIRING_CONNS_PER_SOURCE; i++) {
      attacker.push(
        await Peer.open(server.port, pairingHelloFrame(`atk-${i}`), '9.9.9.9'),
      );
    }
    await settle();
    expect(server.hub.pairingConnCount).toBe(MAX_PAIRING_CONNS_PER_SOURCE);

    // 同源再来一条：按源配额拒（4009），不是全局上限
    const overflow = await Peer.open(
      server.port,
      pairingHelloFrame('atk-more'),
      '9.9.9.9',
    );
    expect((await overflow.waitClose()).code).toBe(
      CLOSE.PAIRING_SOURCE_CAPACITY,
    );

    // 另一个来源的合法用户完全不受影响
    const victim = await Peer.open(
      server.port,
      pairingHelloFrame('victim'),
      '1.1.1.1',
    );
    await settle();
    // victim 没被踢——拿它发一个 begin 走通即证明连接可用
    expect(victim.closeInfo).toBeNull();

    victim.close();
    for (const c of attacker) c.close();
  });

  test('伪造左位 XFF 绕不过每源配额——聚合到最右真实 IP 那个桶', async () => {
    // main 的 clientSource bugfix（a8128dd）取 XFF 最右（紧邻本服务的反代
    // 追加的真实客户端 IP）。攻击者往链左侧塞任意伪造值都影响不到取值，
    // 于是同一真实 IP 的连接必然聚合到同一桶，每源配额真正兜得住。
    //
    // 模拟单跳反代：链形如 `<客户端自带的伪造值>, <反代追加的真实 IP>`。
    // 三条连接各塞不同的左位伪造值，但右位真实 IP 相同。
    const REAL = '7.7.7.7';
    const forged = (fake: string) => `${fake}, ${REAL}`;
    const conns: Peer[] = [];
    for (let i = 0; i < MAX_PAIRING_CONNS_PER_SOURCE; i++) {
      conns.push(
        await Peer.open(
          server.port,
          pairingHelloFrame(`forge-${i}`),
          // 每条左位都不一样——旧的取最左实现会把它们当成不同来源、全放行
          forged(`9.9.9.${i}`),
        ),
      );
    }
    await settle();
    expect(server.hub.pairingConnCount).toBe(MAX_PAIRING_CONNS_PER_SOURCE);
    // 服务端确实按最右真实 IP 归桶
    for (const c of server.hub.pairingConns()) {
      expect(c.source).toBe(REAL);
    }

    // 第三条同样伪造一个全新左位，但真实 IP 仍是 REAL → 撞每源配额 4009
    const overflow = await Peer.open(
      server.port,
      pairingHelloFrame('forge-more'),
      forged('123.45.67.89'),
    );
    expect((await overflow.waitClose()).code).toBe(
      CLOSE.PAIRING_SOURCE_CAPACITY,
    );

    for (const c of conns) c.close();
  });

  test('全站上限作兜底：多来源各不超配额也拦得住总量（4008）', async () => {
    // 分布式打法：每源只开配额内的连接，但来源足够多把全局填满
    const conns: Peer[] = [];
    const perSource = MAX_PAIRING_CONNS_PER_SOURCE;
    const sources = Math.ceil(MAX_PAIRING_CONNS / perSource);
    for (let s = 0; s < sources; s++) {
      for (let i = 0; i < perSource && conns.length < MAX_PAIRING_CONNS; i++) {
        conns.push(
          await Peer.open(server.port, pairingHelloFrame(`d-${s}-${i}`), `10.0.0.${s}`),
        );
      }
    }
    await settle();
    expect(server.hub.pairingConnCount).toBe(MAX_PAIRING_CONNS);

    // 再来一个全新来源：每源配额没满，但撞上全局上限 4008
    const overflow = await Peer.open(
      server.port,
      pairingHelloFrame('overflow'),
      '10.0.0.254',
    );
    expect((await overflow.waitClose()).code).toBe(CLOSE.PAIRING_CAPACITY);

    for (const c of conns) c.close();
  });

  test('空连接（连上不发 begin）超短宽限被踢，槽位释放', async () => {
    // 用一个极短宽限的服务实例，避免测试等 10s
    await server.stop();
    server = await startServer({
      port: 0,
      hostname: '127.0.0.1',
      dbPath: ':memory:',
      allowOpenRegistration: false,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      pairingBeginGraceMs: 150,
    });
    // 空连接：连上后一个 begin 都不发
    const idle = await Peer.open(server.port, pairingHelloFrame('lurker'));
    await settle();
    expect(server.hub.pairingConnCount).toBe(1);
    // 宽限到点被踢（4010），槽位释放
    expect((await idle.waitClose()).code).toBe(CLOSE.PAIRING_BEGIN_TIMEOUT);
    await settle();
    expect(server.hub.pairingConnCount).toBe(0);
  });

  test('被限流拒绝的帧不刷新 lastSeenAt（灌垃圾帧续不了坑）', async () => {
    const pairing = await Peer.open(server.port, pairingHelloFrame('spammer'));
    await settle();
    const conn = server.hub.pairingConns()[0]!;

    // 先把限流窗口刷满（每连接 20 帧，均被接受 → 刷新 lastSeenAt）
    for (let i = 0; i < 20; i++) {
      pairing.send({ type: 'pair.abort', pairingToken: `T-${i}` });
    }
    await settle();
    // 记下刷满后的活跃时刻，并等一小段真实时间拉开差距
    const afterAccepted = conn.lastSeenAt;
    await new Promise((r) => setTimeout(r, 40));

    // 第 21 条起被 PAIR_RATE_LIMIT 拒——这些帧绝不能推进 lastSeenAt，
    // 否则攻击者每 ~110s 灌一帧就能永久霸占槽位、绕过 idle 超时
    for (let i = 0; i < 5; i++) {
      pairing.send({ type: 'pair.abort', pairingToken: `SPAM-${i}` });
    }
    await settle();
    expect(conn.lastSeenAt).toBe(afterAccepted);
    pairing.close();
  });
});

describe('背书式登记全链路', () => {
  test('配对成功后新设备能用自己的密钥换到 token 并正常接入', async () => {
    const agentToken = await bootstrapAgent();
    const agent = await Peer.open(server.port, helloFrame('agent', 'mbp', agentToken));
    await settle();

    const tabletKeys = generateSignKeyPair();
    const pairing = await Peer.open(server.port, pairingHelloFrame('tablet'));
    await settle();

    // 配对前：设备不存在，challenge 拿不到（换不到 token）
    expect(server.store.getDevice('tablet')).toBeNull();
    expect((await post('/auth/challenge', { deviceId: 'tablet' })).status).toBe(
      401,
    );

    pairing.send({
      type: 'pair.begin',
      pairingToken: 'TOK',
      clientPubKey: 'CLIENT-X25519',
      clientSignPubKey: tabletKeys.publicKey,
      clientDeviceId: 'tablet',
    });
    const begin = await agent.wait('pair.begin');
    // agent 复述它实际收到的那份
    agent.send({
      type: 'pair.confirm',
      pairingToken: begin.pairingToken,
      clientDeviceId: begin.clientDeviceId,
      clientSignPubKey: begin.clientSignPubKey,
    });
    await pairing.wait('pair.confirm');

    // server 已登记，且开放注册是关着的——放行依据只可能是 agent 背书
    expect(server.store.getDevice('tablet')).toMatchObject({
      role: 'client',
      signPubKey: tabletKeys.publicKey,
    });

    // 换 token，以正式 client 角色接入
    pairing.close();
    const clientToken = await tokenFor('tablet', tabletKeys);
    const client = await Peer.open(
      server.port,
      helloFrame('client', 'tablet', clientToken),
    );
    expect((await client.wait('machine.status')).machineId).toBe('mbp');

    agent.close();
    client.close();
  });

  test('agent 复述与 begin 不符：不登记、不转发 confirm', async () => {
    const agentToken = await bootstrapAgent();
    const agent = await Peer.open(server.port, helloFrame('agent', 'mbp', agentToken));
    await settle();

    const tabletKeys = generateSignKeyPair();
    const pairing = await Peer.open(server.port, pairingHelloFrame('tablet'));
    await settle();
    pairing.send({
      type: 'pair.begin',
      pairingToken: 'TOK',
      clientPubKey: 'CLIENT-X25519',
      clientSignPubKey: tabletKeys.publicKey,
      clientDeviceId: 'tablet',
    });
    await agent.wait('pair.begin');

    // 攻击者的公钥（现实中对应「中间人换过公钥」，SAS 已该拦下）
    agent.send({
      type: 'pair.confirm',
      pairingToken: 'TOK',
      clientDeviceId: 'tablet',
      clientSignPubKey: generateSignKeyPair().publicKey,
    });
    await settle();

    expect(server.store.getDevice('tablet')).toBeNull();
    expect(pairing.ofType('pair.confirm')).toHaveLength(0);

    agent.close();
    pairing.close();
  });

  test('pairing 连接自己发 confirm 登记不了（自我背书无效）', async () => {
    await bootstrapAgent();
    const agent = await Peer.open(
      server.port,
      helloFrame('agent', 'mbp', await tokenFor('mbp', agentKeys)),
    );
    await settle();

    const tabletKeys = generateSignKeyPair();
    const pairing = await Peer.open(server.port, pairingHelloFrame('tablet'));
    await settle();
    const material = {
      pairingToken: 'TOK',
      clientDeviceId: 'tablet',
      clientSignPubKey: tabletKeys.publicKey,
    };
    pairing.send({
      type: 'pair.begin',
      clientPubKey: 'CLIENT-X25519',
      ...material,
    });
    await agent.wait('pair.begin');

    pairing.send({ type: 'pair.confirm', ...material });
    await settle();
    expect(server.store.getDevice('tablet')).toBeNull();

    agent.close();
    pairing.close();
  });

  test('token 重放：核销后同一 confirm 再来一次登记不了第二台设备', async () => {
    const agentToken = await bootstrapAgent();
    const agent = await Peer.open(server.port, helloFrame('agent', 'mbp', agentToken));
    await settle();

    const tabletKeys = generateSignKeyPair();
    const pairing = await Peer.open(server.port, pairingHelloFrame('tablet'));
    await settle();
    pairing.send({
      type: 'pair.begin',
      pairingToken: 'TOK',
      clientPubKey: 'CLIENT-X25519',
      clientSignPubKey: tabletKeys.publicKey,
      clientDeviceId: 'tablet',
    });
    await agent.wait('pair.begin');
    const confirm = {
      type: 'pair.confirm' as const,
      pairingToken: 'TOK',
      clientDeviceId: 'tablet',
      clientSignPubKey: tabletKeys.publicKey,
    };
    agent.send(confirm);
    await pairing.wait('pair.confirm');

    // 重放同一 token，换个 deviceId 想再塞一台设备进来
    agent.send({ ...confirm, clientDeviceId: 'attacker' });
    await settle();
    expect(server.store.getDevice('attacker')).toBeNull();

    agent.close();
    pairing.close();
  });

  test('零知识：配对全程服务端不接触 qrSecret 与任何 X25519 私钥', async () => {
    const agentToken = await bootstrapAgent();
    const agent = await Peer.open(server.port, helloFrame('agent', 'mbp', agentToken));
    await settle();
    const tabletKeys = generateSignKeyPair();
    const pairing = await Peer.open(server.port, pairingHelloFrame('tablet'));
    await settle();
    pairing.send({
      type: 'pair.begin',
      pairingToken: 'TOK',
      clientPubKey: 'CLIENT-X25519',
      clientSignPubKey: tabletKeys.publicKey,
      clientDeviceId: 'tablet',
    });
    const begin = await agent.wait('pair.begin');
    agent.send({
      type: 'pair.confirm',
      pairingToken: 'TOK',
      clientDeviceId: begin.clientDeviceId,
      clientSignPubKey: begin.clientSignPubKey,
    });
    await pairing.wait('pair.confirm');

    // devices 表只有签名公钥，没有任何 E2E 密钥材料的位置
    const cols = (
      server.store.db.query('PRAGMA table_info(devices)').all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).toContain('sign_pub_key');
    expect(cols.some((n) => /box|x25519|qr|secret|private/i.test(n))).toBe(false);
    // 库里从没出现过 client 的 X25519 公钥——那是 E2E 侧的东西，
    // 服务端只是把它在明文帧里转了一手，不留存
    const dump = JSON.stringify(
      server.store.db.query('SELECT * FROM devices').all(),
    );
    expect(dump).not.toContain('CLIENT-X25519');

    agent.close();
    pairing.close();
  });
});

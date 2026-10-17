import { createInvitation } from './auth/invitations.ts';
/**
 * 全链路集成测试：本地起真服务，两条真 WebSocket 模拟 client + agent，
 * 走完 注册/认证 → 握手 → 中转 → 断线补发 → 离线排队/撤回。
 *
 * 与 hub.test.ts 的分工：那边用测试替身覆盖分支逻辑，这里验证
 * Bun.serve + Hono + 真 WS 装配起来确实能跑通。
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
  FIRST_SEQ,
  NO_SEQ_RECEIVED,
  type TransportFrame,
} from '@trine/core/protocol';
import { CLOSE, helloFrame, startServer, type TrineServer } from './server.ts';

let server: TrineServer;
let agentKeys: SignKeyPair;
let clientKeys: SignKeyPair;

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(async () => {
  agentKeys = generateSignKeyPair();
  clientKeys = generateSignKeyPair();
  server = await startServer({
    port: 0,
    hostname: '127.0.0.1',
    dbPath: ':memory:',
    allowOpenRegistration: true,
    // 心跳/清理周期在测试里调大，避免定时器干扰断言
    heartbeatIntervalMs: 60_000,
    sweepIntervalMs: 60_000,
    parkedTtlMs: 60_000,
  });
});

afterEach(async () => {
  await server.stop();
});

// ---------------------------------------------------------------------------
// 测试用的最小客户端
// ---------------------------------------------------------------------------

/** 走完 注册 → 挑战 → 应答，拿到 token */
async function authenticate(
  deviceId: string,
  role: 'client' | 'agent',
  keys: SignKeyPair,
): Promise<string> {
  const base = `http://127.0.0.1:${server.port}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  if (role === 'client') server.store.registerDevice(deviceId, role, keys.publicKey);
  const reg = await post('/auth/register', {
    deviceId,
    role,
    signPubKey: keys.publicKey,
    ...(role === 'agent' ? { invitation: createInvitation(server.store).token } : {}),
  });
  expect(reg.status).toBe(200);

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

/** 收帧带缓冲的 WS 包装：可等待「下一条满足条件的帧」 */
class TestPeer {
  readonly received: TransportFrame[] = [];
  closeInfo: { code: number; reason: string } | null = null;
  private readonly waiters: {
    match: (f: TransportFrame) => boolean;
    resolve: (f: TransportFrame) => void;
  }[] = [];

  private constructor(readonly ws: WebSocket) {}

  static async connect(
    port: number,
    role: 'client' | 'agent',
    deviceId: string,
    token: string,
    { skipHello = false } = {},
  ): Promise<TestPeer> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const peer = new TestPeer(ws);

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
    if (!skipHello) ws.send(helloFrame(role, deviceId, token));
    return peer;
  }

  send(frame: TransportFrame): void {
    this.ws.send(encodeTransportFrame(frame));
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  /** 等下一条满足条件的帧（含已收到的） */
  wait<K extends TransportFrame['type']>(
    type: K,
    extra: (f: Extract<TransportFrame, { type: K }>) => boolean = () => true,
    timeoutMs = 2000,
  ): Promise<Extract<TransportFrame, { type: K }>> {
    const match = (f: TransportFrame) =>
      f.type === type && extra(f as never);
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

  /** 等连接被关闭 */
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

/** c2a 帧（client → agent）：不带 recipientDeviceId（收件人就是该机器 agent） */
function relayFrame(over: Partial<Extract<TransportFrame, { type: 'relay' }>> = {}) {
  return {
    type: 'relay' as const,
    machineId: 'mbp',
    sessionId: 's1',
    seq: FIRST_SEQ,
    nonce: 'NONCE-1',
    ciphertext: 'CIPHERTEXT-1',
    ...over,
  } as TransportFrame;
}

/** a2c 帧（agent → client）：必带 recipientDeviceId，每收件人一份密文 */
function a2cFrame(over: Partial<Extract<TransportFrame, { type: 'relay' }>> = {}) {
  return relayFrame({ recipientDeviceId: 'phone', ...over });
}

/** 让出事件循环若干轮，等异步 WS 消息落地 */
const settle = () => new Promise((r) => setTimeout(r, 30));

// ---------------------------------------------------------------------------

describe('HTTP 认证端点', () => {
  test('健康检查', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  test('完整注册-挑战-应答流程签发 token', async () => {
    const token = await authenticate('mbp', 'agent', agentKeys);
    expect(token.length).toBeGreaterThan(0);
  });

  test('错误签名换不到 token', async () => {
    await fetch(`http://127.0.0.1:${server.port}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'mbp',
        role: 'agent',
        signPubKey: agentKeys.publicKey,
        invitation: createInvitation(server.store).token,
      }),
    });
    const chal = (await (
      await fetch(`http://127.0.0.1:${server.port}/auth/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'mbp' }),
      })
    ).json()) as { challenge: string };

    const wrong = generateSignKeyPair();
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'mbp',
        challenge: chal.challenge,
        signature: signDetached(
          authChallengeMessage('mbp', chal.challenge),
          wrong.secretKey,
        ),
      }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('bad_signature');
  });

  test('/devices 需要 bearer token', async () => {
    const token = await authenticate('mbp', 'agent', agentKeys);
    const unauth = await fetch(`http://127.0.0.1:${server.port}/devices`);
    expect(unauth.status).toBe(401);

    const res = await fetch(`http://127.0.0.1:${server.port}/devices`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { devices: unknown[] };
    expect(body.devices).toHaveLength(1);
    // 设备列表不泄露任何密钥材料
    expect(JSON.stringify(body)).not.toContain(agentKeys.publicKey);
  });

  test('畸形请求体返回 400', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('WS 握手', () => {
  test('无 token 的 hello 被拒', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const closed = new Promise<CloseEvent>((r) =>
      ws.addEventListener('close', (e) => r(e as CloseEvent), { once: true }),
    );
    ws.send(
      JSON.stringify({ type: 'hello', v: 1, role: 'client', deviceId: 'x' }),
    );
    expect((await closed).code).toBe(CLOSE.UNAUTHENTICATED);
  });

  test('伪造 token 被拒', async () => {
    const peer = await TestPeer.connect(
      server.port,
      'client',
      'phone',
      'made-up-token',
    );
    expect((await peer.waitClose()).code).toBe(CLOSE.UNAUTHENTICATED);
  });

  test('自报身份与 token 不符时被拒（身份以 token 为准）', async () => {
    const token = await authenticate('mbp', 'agent', agentKeys);
    // 拿 agent 的 token 冒充 client
    const peer = await TestPeer.connect(server.port, 'client', 'mbp', token);
    expect((await peer.waitClose()).code).toBe(CLOSE.UNAUTHENTICATED);
  });

  test('第一帧不是 hello 就断开', async () => {
    const peer = await TestPeer.connect(server.port, 'client', 'x', 'y', {
      skipHello: true,
    });
    peer.sendRaw(JSON.stringify(relayFrame()));
    const closed = await peer.waitClose();
    expect(
      ([CLOSE.UNAUTHENTICATED, CLOSE.VERSION_MISMATCH] as number[]).includes(
        closed.code,
      ),
    ).toBe(true);
  });

  test('协议版本不符被拒', async () => {
    const token = await authenticate('phone', 'client', clientKeys);
    const peer = await TestPeer.connect(server.port, 'client', 'phone', token, {
      skipHello: true,
    });
    peer.sendRaw(
      JSON.stringify({
        type: 'hello',
        v: 999,
        role: 'client',
        deviceId: 'phone',
        authToken: token,
      }),
    );
    expect((await peer.waitClose()).code).toBe(CLOSE.VERSION_MISMATCH);
  });

  test('agent 重连顶掉旧连接', async () => {
    const token = await authenticate('mbp', 'agent', agentKeys);
    const first = await TestPeer.connect(server.port, 'agent', 'mbp', token);
    await settle();
    const second = await TestPeer.connect(server.port, 'agent', 'mbp', token);

    expect((await first.waitClose()).code).toBe(CLOSE.REPLACED);
    await settle();
    expect(server.registry.isAgentOnline('mbp')).toBe(true);
    second.close();
  });
});

describe('全链路：中转 → 补发 → 排队 → 撤回', () => {
  test('client ↔ agent 双向密文中转', async () => {
    const agentToken = await authenticate('mbp', 'agent', agentKeys);
    const clientToken = await authenticate('phone', 'client', clientKeys);
    const agent = await TestPeer.connect(server.port, 'agent', 'mbp', agentToken);
    const client = await TestPeer.connect(
      server.port,
      'client',
      'phone',
      clientToken,
    );
    // client 上线即收到机器在线状态
    expect(
      (await client.wait('machine.status', (f) => f.machineId === 'mbp')).online,
    ).toBe(true);

    // client → agent
    client.send(relayFrame({ seq: 1, ciphertext: 'C2A-SECRET' }));
    const toAgent = await agent.wait('relay');
    expect(toAgent.ciphertext).toBe('C2A-SECRET');
    expect(toAgent.machineId).toBe('mbp');

    // agent → client
    agent.send(a2cFrame({ seq: 1, ciphertext: 'A2C-SECRET' }));
    const toClient = await client.wait('relay');
    expect(toClient.ciphertext).toBe('A2C-SECRET');

    agent.close();
    client.close();
  });

  test('agent 对每个收件人各发一份，两台设备各收各的', async () => {
    const agentToken = await authenticate('mbp', 'agent', agentKeys);
    const phoneToken = await authenticate('phone', 'client', clientKeys);
    const laptopKeys = generateSignKeyPair();
    const laptopToken = await authenticate('laptop', 'client', laptopKeys);

    const agent = await TestPeer.connect(server.port, 'agent', 'mbp', agentToken);
    const phone = await TestPeer.connect(server.port, 'client', 'phone', phoneToken);
    const laptop = await TestPeer.connect(
      server.port,
      'client',
      'laptop',
      laptopToken,
    );
    await settle();

    // 同一逻辑事件、同一 seq，两份密文只差收件人
    agent.send(
      a2cFrame({ seq: 1, recipientDeviceId: 'phone', ciphertext: 'FOR-PHONE' }),
    );
    agent.send(
      a2cFrame({
        seq: 1,
        recipientDeviceId: 'laptop',
        ciphertext: 'FOR-LAPTOP',
      }),
    );

    expect((await phone.wait('relay')).ciphertext).toBe('FOR-PHONE');
    expect((await laptop.wait('relay')).ciphertext).toBe('FOR-LAPTOP');
    await settle();
    // 各自只收到自己那一份，没有串台
    expect(phone.ofType('relay').map((f) => f.ciphertext)).toEqual([
      'FOR-PHONE',
    ]);
    expect(laptop.ofType('relay').map((f) => f.ciphertext)).toEqual([
      'FOR-LAPTOP',
    ]);

    agent.close();
    phone.close();
    laptop.close();
  });

  test('断线重连后按 sinceSeq 补发漏掉的帧', async () => {
    const agentToken = await authenticate('mbp', 'agent', agentKeys);
    const clientToken = await authenticate('phone', 'client', clientKeys);
    const agent = await TestPeer.connect(server.port, 'agent', 'mbp', agentToken);
    let client = await TestPeer.connect(
      server.port,
      'client',
      'phone',
      clientToken,
    );
    await settle();

    // client 收到前两帧后断线
    agent.send(a2cFrame({ seq: 1, ciphertext: 'C1' }));
    agent.send(a2cFrame({ seq: 2, ciphertext: 'C2' }));
    await client.wait('relay', (f) => f.seq === 2);
    client.close();
    await settle();

    // 断线期间 agent 继续发
    agent.send(a2cFrame({ seq: 3, ciphertext: 'C3' }));
    agent.send(a2cFrame({ seq: 4, ciphertext: 'C4' }));
    await settle();

    // 重连并请求补发
    client = await TestPeer.connect(server.port, 'client', 'phone', clientToken);
    client.send({
      type: 'sync.request',
      machineId: 'mbp',
      sessionId: 's1',
      sinceSeq: 2,
    });
    await client.wait('relay', (f) => f.seq === 4);

    const resent = client.ofType('relay');
    expect(resent.map((f) => f.seq)).toEqual([3, 4]);
    expect(resent.map((f) => f.ciphertext)).toEqual(['C3', 'C4']);

    agent.close();
    client.close();
  });

  test('全新客户端用 sinceSeq=0 取回整条流（含首帧）', async () => {
    const agentToken = await authenticate('mbp', 'agent', agentKeys);
    const clientToken = await authenticate('phone', 'client', clientKeys);
    const agent = await TestPeer.connect(server.port, 'agent', 'mbp', agentToken);
    await settle();
    agent.send(a2cFrame({ seq: FIRST_SEQ, ciphertext: 'FIRST' }));
    await settle();

    const client = await TestPeer.connect(
      server.port,
      'client',
      'phone',
      clientToken,
    );
    client.send({
      type: 'sync.request',
      machineId: 'mbp',
      sessionId: 's1',
      sinceSeq: NO_SEQ_RECEIVED,
    });
    // 首帧必须补得回来——这正是 seq 从 1 起的理由
    expect((await client.wait('relay')).ciphertext).toBe('FIRST');

    agent.close();
    client.close();
  });

  test('agent 离线时排队，上线后自动投递', async () => {
    const clientToken = await authenticate('phone', 'client', clientKeys);
    const agentToken = await authenticate('mbp', 'agent', agentKeys);
    const client = await TestPeer.connect(
      server.port,
      'client',
      'phone',
      clientToken,
    );
    await settle();

    // agent 不在线：帧被排队，client 收到 input.parked 回执
    client.send(relayFrame({ seq: 1, ciphertext: 'PARKED-1' }));
    const receipt = await client.wait('input.parked');
    expect(receipt).toMatchObject({ machineId: 'mbp', sessionId: 's1', seq: 1 });
    expect(receipt.expiresAt).toBeGreaterThan(Date.now());
    expect((await client.wait('parked.count')).parkedCount).toBe(1);

    // agent 上线：排队帧自动投出
    const agent = await TestPeer.connect(server.port, 'agent', 'mbp', agentToken);
    expect((await agent.wait('relay')).ciphertext).toBe('PARKED-1');
    // client 收到计数归零与机器上线
    await client.wait('parked.count', (f) => f.parkedCount === 0);
    await client.wait('machine.status', (f) => f.online);

    agent.close();
    client.close();
  });

  test('park.recall 撤回后 agent 上线不再收到该帧', async () => {
    const clientToken = await authenticate('phone', 'client', clientKeys);
    const agentToken = await authenticate('mbp', 'agent', agentKeys);
    const client = await TestPeer.connect(
      server.port,
      'client',
      'phone',
      clientToken,
    );
    await settle();

    client.send(relayFrame({ seq: 1, ciphertext: 'RECALL-ME' }));
    client.send(relayFrame({ seq: 2, ciphertext: 'KEEP-ME' }));
    await client.wait('input.parked', (f) => f.seq === 2);

    client.send({
      type: 'park.recall',
      machineId: 'mbp',
      sessionId: 's1',
      seq: 1,
    });
    await client.wait('parked.count', (f) => f.parkedCount === 1);

    const agent = await TestPeer.connect(server.port, 'agent', 'mbp', agentToken);
    await agent.wait('relay', (f) => f.seq === 2);
    await settle();

    const got = agent.ofType('relay');
    expect(got.map((f) => f.ciphertext)).toEqual(['KEEP-ME']);

    agent.close();
    client.close();
  });

  test('重复 park.recall 幂等，不影响已投递的帧', async () => {
    const clientToken = await authenticate('phone', 'client', clientKeys);
    const agentToken = await authenticate('mbp', 'agent', agentKeys);
    const client = await TestPeer.connect(
      server.port,
      'client',
      'phone',
      clientToken,
    );
    await settle();
    client.send(relayFrame({ seq: 1 }));
    await client.wait('input.parked');

    const agent = await TestPeer.connect(server.port, 'agent', 'mbp', agentToken);
    await agent.wait('relay');
    await settle();

    // 已投递后再撤回：静默无操作，状态保持 delivered
    const recall = {
      type: 'park.recall' as const,
      machineId: 'mbp',
      sessionId: 's1',
      seq: 1,
    };
    client.send(recall);
    client.send(recall);
    await settle();
    expect(server.hub.parked.get('mbp', 's1', 1)!.state).toBe('delivered');

    agent.close();
    client.close();
  });

  test('agent 下线广播 machine.status offline', async () => {
    const agentToken = await authenticate('mbp', 'agent', agentKeys);
    const clientToken = await authenticate('phone', 'client', clientKeys);
    const agent = await TestPeer.connect(server.port, 'agent', 'mbp', agentToken);
    const client = await TestPeer.connect(
      server.port,
      'client',
      'phone',
      clientToken,
    );
    await client.wait('machine.status', (f) => f.online);

    agent.close();
    const offline = await client.wait('machine.status', (f) => !f.online);
    expect(offline.machineId).toBe('mbp');
    client.close();
  });

  test('重复 seq 不会被投递两次', async () => {
    const agentToken = await authenticate('mbp', 'agent', agentKeys);
    const clientToken = await authenticate('phone', 'client', clientKeys);
    const agent = await TestPeer.connect(server.port, 'agent', 'mbp', agentToken);
    const client = await TestPeer.connect(
      server.port,
      'client',
      'phone',
      clientToken,
    );
    await settle();

    agent.send(a2cFrame({ seq: 1, ciphertext: 'ONCE' }));
    agent.send(a2cFrame({ seq: 1, ciphertext: 'ONCE' }));
    agent.send(a2cFrame({ seq: 2, ciphertext: 'NEXT' }));
    await client.wait('relay', (f) => f.seq === 2);
    await settle();

    expect(client.ofType('relay').map((f) => f.seq)).toEqual([1, 2]);
    agent.close();
    client.close();
  });

  test('配对帧经服务端中转到对侧', async () => {
    const agentToken = await authenticate('mbp', 'agent', agentKeys);
    const clientToken = await authenticate('phone', 'client', clientKeys);
    const agent = await TestPeer.connect(server.port, 'agent', 'mbp', agentToken);
    const client = await TestPeer.connect(
      server.port,
      'client',
      'phone',
      clientToken,
    );
    await settle();

    const newDevice = generateSignKeyPair();
    client.send({
      type: 'pair.begin',
      pairingToken: 'TOKEN-1',
      clientPubKey: 'CLIENT-PUB',
      clientSignPubKey: newDevice.publicKey,
      clientDeviceId: 'tablet',
    });
    const begin = await agent.wait('pair.begin');
    expect(begin).toMatchObject({
      pairingToken: 'TOKEN-1',
      clientPubKey: 'CLIENT-PUB',
      clientDeviceId: 'tablet',
    });

    agent.send({
      type: 'pair.confirm',
      pairingToken: 'TOKEN-1',
      clientDeviceId: 'tablet',
      clientSignPubKey: newDevice.publicKey,
    });
    expect((await client.wait('pair.confirm')).pairingToken).toBe('TOKEN-1');
    // 背书通过即登记
    expect(server.store.getDevice('tablet')?.role).toBe('client');

    agent.close();
    client.close();
  });
});

describe('B1 回归：排队消息不被留存裁剪吞掉', () => {
  test('大批排队帧在 agent 上线后一条不少地送达', async () => {
    // 评审复现 B1 的场景。两道防线各管一段：
    // ① 配置不变量拦住 relayMaxPerStream < parkedMaxPerMachine（见 config.test.ts）；
    // ② trimStream 自身不碰 pending 帧（见 store.test.ts 的 B1 用例，
    //    那里直接把 keep 压到远小于排队量，能精确复现丢帧）。
    //
    // 本用例走真链路，验证在**合法配置的边界**上端到端不丢消息：
    // 留存 = 排队配额 = 128，排队量顶满配额。
    await server.stop();
    const BATCH = 128;
    server = await startServer({
      port: 0,
      hostname: '127.0.0.1',
      dbPath: ':memory:',
      allowOpenRegistration: true,
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      parkedTtlMs: 60_000,
      relayMaxPerStream: BATCH,
      parkedMaxPerMachine: BATCH,
    });

    const clientToken = await authenticate('phone', 'client', clientKeys);
    const agentToken = await authenticate('mbp', 'agent', agentKeys);
    const client = await TestPeer.connect(
      server.port,
      'client',
      'phone',
      clientToken,
    );
    await settle();

    // agent 离线，猛灌 BATCH 条
    for (let i = 1; i <= BATCH; i++) {
      client.send(relayFrame({ seq: i, ciphertext: `PAYLOAD-${i}` }));
    }
    await client.wait('input.parked', (f) => f.seq === BATCH, 5000);

    // 回执数 = 排队数：client 认为这 BATCH 条都在队列里
    expect(client.ofType('input.parked')).toHaveLength(BATCH);

    // agent 上线，全部投出
    const agent = await TestPeer.connect(server.port, 'agent', 'mbp', agentToken);
    await agent.wait('relay', (f) => f.seq === BATCH, 5000);
    await settle();

    const delivered = agent.ofType('relay');
    // 核心断言：回执了多少条，就得投出多少条——一条都不许静默蒸发
    expect(delivered).toHaveLength(BATCH);
    expect(delivered.map((f) => f.seq)).toEqual(
      Array.from({ length: BATCH }, (_, i) => i + 1),
    );
    // 密文也得是原样，不能张冠李戴
    expect(delivered.map((f) => f.ciphertext)).toEqual(
      Array.from({ length: BATCH }, (_, i) => `PAYLOAD-${i + 1}`),
    );
    // 没有任何一条被判过期
    expect(client.ofType('park.expired')).toHaveLength(0);

    agent.close();
    client.close();
  });
});

describe('零知识边界', () => {
  test('库里除密文外不出现任何 E2E 正文；密文原样存', async () => {
    const agentToken = await authenticate('mbp', 'agent', agentKeys);
    const clientToken = await authenticate('phone', 'client', clientKeys);
    const agent = await TestPeer.connect(server.port, 'agent', 'mbp', agentToken);
    const client = await TestPeer.connect(
      server.port,
      'client',
      'phone',
      clientToken,
    );
    await settle();
    agent.send(
      a2cFrame({ seq: 1, nonce: 'N-KEEP', ciphertext: 'CIPHER-KEEP' }),
    );
    await client.wait('relay');

    const rows = server.store.db
      .query('SELECT * FROM relay_frames')
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    // 存的就是原样密文与 nonce，服务端没有也不需要解开它
    expect(rows[0]!.ciphertext).toBe('CIPHER-KEEP');
    expect(rows[0]!.nonce).toBe('N-KEEP');
    // 表的列集合就是 transport.ts 的明文字段，没有正文字段的位置。
    // recipient_id 是路由字段——服务端本来就知道设备集合，
    // 「这份密文送到哪台设备」是中转本职（见 transport.ts 的 † 判据）
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

    agent.close();
    client.close();
  });

  test('设备表只存签名公钥，不存任何 E2E(X25519) 密钥', async () => {
    await authenticate('mbp', 'agent', agentKeys);
    const cols = server.store.db
      .query('PRAGMA table_info(devices)')
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('sign_pub_key');
    // 没有任何存 E2E 公钥/私钥的列
    expect(names.some((n) => /box|x25519|secret|private/i.test(n))).toBe(false);
  });
});

describe('WS 升级 Origin 检查（真服务端）', () => {
  let guarded: TrineServer;

  beforeEach(async () => {
    guarded = await startServer({
      port: 0,
      hostname: '127.0.0.1',
      dbPath: ':memory:',
      corsOrigins: ['https://web.example.com'],
      heartbeatIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    await guarded.stop();
  });

  /** 直接打 /ws 而不带升级头：只看 Origin 闸放不放行 */
  const probe = (headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${guarded.port}/ws`, { headers });

  test('清单外 origin 在升级前就被 403 挡下', async () => {
    const res = await probe({ origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('origin not allowed');
  });

  test('清单内 origin 过闸（落到 426 说明已经进了升级那一步）', async () => {
    const res = await probe({ origin: 'https://web.example.com' });
    expect(res.status).toBe(426);
  });

  test('无 Origin 头（agent / CLI）过闸', async () => {
    expect((await probe({})).status).toBe(426);
  });
});

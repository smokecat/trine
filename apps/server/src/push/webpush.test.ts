/**
 * Web Push（PWA 通知）单测：订阅存取、按设备在线抑制/去抖、投递请求形态、
 * 订阅失效清理，以及 hub 侧 push.* 帧的接线。
 *
 * 真推送不在单测范围：加密与 VAPID 由久经沙场的 web-push 库负责，
 * 这里验证的是我们自己的编排逻辑。全部注入 fake fetch / 手动时钟，零真网络。
 */
import { describe, expect, test } from 'bun:test';
import { generateVAPIDKeys } from 'web-push';
import { loadConfig, type ServerConfig } from '../config.ts';
import { Store } from '../store/index.ts';
import { WebPushService } from './webpush.ts';
import { RelayHub } from '../ws/hub.ts';
import { ConnectionRegistry, type Conn, type Sendable } from '../ws/registry.ts';

/** 记录每次 fetch 的请求形态，可编排响应 */
class FakeFetch {
  readonly calls: { url: string; headers: Record<string, string>; body: Uint8Array }[] = [];
  respondWith: (url: string) => { status: number } = () => ({ status: 201 });

  readonly impl = (url: string, init?: RequestInit): Promise<Response> => {
    this.calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: new Uint8Array((init?.body ?? new ArrayBuffer(0)) as ArrayBuffer),
    });
    return Promise.resolve(new Response(null, this.respondWith(url)));
  };
}

function makeService(over: {
  store?: Store;
  online?: Set<string>;
  fetch?: FakeFetch;
  now?: () => number;
} = {}): WebPushService {
  return new WebPushService({
    store: over.store ?? new Store(':memory:'),
    isDeviceOnline: (id) => (over.online ?? new Set()).has(id),
    fetchImpl: (over.fetch ?? new FakeFetch()).impl,
    now: over.now ?? (() => 1_000_000),
    log: () => {},
  });
}

// p256dh 必须是合法的 P-256 公钥点(65 字节 → 87 字符 base64url):加密库
// 会真的拿它做 ECDH,假字符串过不了 base64url/长度校验。拿 VAPID 生成器
// 的公钥当客户端公钥用,形状完全一致
const SUB = (() => {
  const k = generateVAPIDKeys();
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/dTok',
    keys: {
      p256dh: k.publicKey,
      auth: Buffer.from('0123456789abcdef').toString('base64url'),
    },
  };
})();

// ---------------------------------------------------------------------------

describe('VAPID 密钥管理', () => {
  test('首启自动生成,跨实例稳定(落库)', () => {
    const store = new Store(':memory:');
    const a = makeService({ store });
    const key = a.vapidPublicKey;
    expect(key).toBeTruthy();
    expect(key!.length).toBeGreaterThan(40);
    // 换一个服务实例(如重启)读到同一副密钥
    expect(makeService({ store }).vapidPublicKey).toBe(key);
  });
});

describe('订阅存取', () => {
  test('subscribe 覆盖式存储,unsubscribe 删除,幂等', () => {
    const store = new Store(':memory:');
    const svc = makeService({ store });
    svc.subscribe('phone', SUB);
    expect(store.getPushSubscription('phone')?.endpoint).toBe(SUB.endpoint);
    // 同设备换 endpoint(浏览器轮换) → 覆盖
    svc.subscribe('phone', { ...SUB, endpoint: 'https://fcm.example/new' });
    expect(store.getPushSubscription('phone')?.endpoint).toBe('https://fcm.example/new');
    svc.unsubscribe('phone');
    expect(store.getPushSubscription('phone')).toBeNull();
    svc.unsubscribe('phone'); // 再删不炸
  });
});

describe('deliverTo:按设备定向的抑制与去抖', () => {
  test('没订阅 → no_subscription;设备在线 → device_online(且不占去抖名额)', () => {
    const online = new Set<string>();
    const svc = makeService({ online });
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' }))
      .toEqual({ kind: 'skipped', reason: 'no_subscription' });
    svc.subscribe('phone', SUB);
    online.add('phone');
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' }))
      .toEqual({ kind: 'skipped', reason: 'device_online' });
    // 在线抑制不记去抖:下线后第一条就能推
    online.delete('phone');
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' }).kind)
      .toBe('sent');
  });

  test('会话级静音:run.done 不推,机器级事件(无 sessionId)不受影响', () => {
    const svc = makeService();
    svc.subscribe('phone', SUB);
    svc.setMutes('phone', ['s-poll']);
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's-poll', hint: 'run_done' }))
      .toEqual({ kind: 'skipped', reason: 'muted' });
    // 未静音的会话照推
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's-other', hint: 'run_done' }).kind)
      .toBe('sent');
    // 机器级事件没有 sessionId,静音管不着
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' }).kind)
      .toBe('sent');
    // 全量覆盖式更新:清空名单后恢复推送
    svc.setMutes('phone', []);
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's-poll', hint: 'run_done' }).kind)
      .toBe('sent');
  });

  test('同(设备,机器,会话,hint)窗口内去抖,不同会话不去抖', () => {
    let clock = 1_000_000;
    const svc = makeService({ now: () => clock });
    svc.subscribe('phone', SUB);
    const e1 = svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's1', hint: 'permission_pending' });
    expect(e1.kind).toBe('sent');
    clock += 5_000; // 30s 窗口内
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's1', hint: 'permission_pending' }))
      .toEqual({ kind: 'skipped', reason: 'deduped' });
    // 另一个会话同时要权限:是另一件事,该推
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's2', hint: 'permission_pending' }).kind)
      .toBe('sent');
    clock += 31_000; // 窗口过期
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', sessionId: 's1', hint: 'permission_pending' }).kind)
      .toBe('sent');
  });

  test('投递请求:aes128gcm 密文 + TTL + VAPID 头,payload 推送服务读不到明文', async () => {
    const fetch = new FakeFetch();
    const svc = makeService({ fetch });
    svc.subscribe('phone', SUB);
    const out = svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' });
    expect(out.kind).toBe('sent');
    await new Promise((r) => setTimeout(r, 10)); // fire-and-forget 落地
    expect(fetch.calls.length).toBe(1);
    const call = fetch.calls[0]!;
    expect(call.url).toBe(SUB.endpoint);
    expect(call.headers['Content-Encoding']).toBe('aes128gcm');
    expect(String(call.headers.TTL)).toBe('7200');
    expect(String(call.headers.Authorization)).toContain('vapid t=');
    // 正文是 RFC8291 密文,绝不含明文文案
    const text = Buffer.from(call.body).toString('utf8');
    expect(text).not.toContain('任务完成');
    expect(call.body.length).toBeGreaterThan(64);
  });

  test('404/410 = 订阅失效 → 清行;201 → 保留', async () => {
    const fetch = new FakeFetch();
    const store = new Store(':memory:');
    const svc = makeService({ fetch, store });
    svc.subscribe('phone', SUB);
    fetch.respondWith = () => ({ status: 410 });
    svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getPushSubscription('phone')).toBeNull();
    // 再投一条:订阅已清,不再发请求
    expect(fetch.calls.length).toBe(1);
    expect(svc.deliverTo({ machineId: 'mbp', recipientDeviceId: 'phone', hint: 'run_done' }))
      .toEqual({ kind: 'skipped', reason: 'no_subscription' });
  });
});

// ---------------------------------------------------------------------------
// hub 接线:push.* 帧 + client 上线下发公钥
// ---------------------------------------------------------------------------

class FakeSocket implements Sendable {
  readonly sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { /* 测试里不用 */ }
  frame<T = Record<string, unknown>>(i: number): T { return JSON.parse(this.sent[i]!) as T; }
}

function clientConn(ws: FakeSocket): Conn<FakeSocket> {
  return {
    ws, deviceId: 'phone', role: 'client',
    connectedAt: 1, lastSeenAt: 1, pendingPings: 0,
  };
}

describe('hub:push.* 帧接线', () => {
  function makeHub(over: { webpush?: WebPushService } = {}): {
    hub: RelayHub<FakeSocket>;
    store: Store;
    config: ServerConfig;
  } {
    const store = new Store(':memory:');
    const config = loadConfig({ dbPath: ':memory:' });
    const hub = new RelayHub<FakeSocket>({
      store,
      registry: new ConnectionRegistry<FakeSocket>(),
      config,
      ...(over.webpush ? { webpush: over.webpush } : {}),
      now: () => 1_000_000,
    });
    return { hub, store, config };
  }

  test('client 上线即收到 push.config(带 VAPID 公钥)', () => {
    const svc = makeService();
    const key = svc.vapidPublicKey;
    expect(key).toBeTruthy();
    const { hub } = makeHub({ webpush: svc });
    const ws = new FakeSocket();
    hub.onClientOnline(clientConn(ws));
    const cfg = ws.frame(0) as { type: string; vapidPublicKey?: string };
    expect(cfg.type).toBe('push.config');
    expect(cfg.vapidPublicKey).toEqual(key ?? undefined);
  });

  test('push.subscribe 按连接身份归档并回执;agent 发则拒', () => {
    const store = new Store(':memory:');
    const svc = makeService({ store });
    const { hub } = makeHub({ webpush: svc });
    const ws = new FakeSocket();
    const outcome = hub.handleFrame(clientConn(ws), {
      type: 'push.subscribe', endpoint: SUB.endpoint, keys: SUB.keys,
    });
    expect(outcome.kind).toBe('ignored');
    const ack = ws.frame(0) as { type: string; ok: boolean };
    expect(ack).toEqual({ type: 'push.subscribed', ok: true });
    expect(store.getPushSubscription('phone')?.endpoint).toBe(SUB.endpoint);

    const agentWs = new FakeSocket();
    const rejected = hub.handleFrame(
      { ws: agentWs, deviceId: 'mbp', role: 'agent', machineId: 'mbp', connectedAt: 1, lastSeenAt: 1, pendingPings: 0 },
      { type: 'push.subscribe', endpoint: SUB.endpoint, keys: SUB.keys },
    );
    expect(rejected).toEqual({ kind: 'rejected', reason: 'push_sub_from_agent' });
  });

  test('push.unsubscribe 删行并回执', () => {
    const store = new Store(':memory:');
    const svc = makeService({ store });
    const { hub } = makeHub({ webpush: svc });
    svc.subscribe('phone', SUB);
    const ws = new FakeSocket();
    hub.handleFrame(clientConn(ws), { type: 'push.unsubscribe', endpoint: SUB.endpoint });
    expect(store.getPushSubscription('phone')).toBeNull();
    expect((ws.frame(0) as { ok: boolean }).ok).toBe(true);
  });

  test('push.mute 全量覆盖静音名单(无回执,幂等)', () => {
    const store = new Store(':memory:');
    const svc = makeService({ store });
    const { hub } = makeHub({ webpush: svc });
    const ws = new FakeSocket();
    hub.handleFrame(clientConn(ws), { type: 'push.mute', sessionIds: ['a', 'b'] });
    expect(store.isPushMuted('phone', 'a')).toBe(true);
    expect(store.isPushMuted('phone', 'b')).toBe(true);
    expect(ws.sent.length).toBe(0); // 静音没有回执
    hub.handleFrame(clientConn(ws), { type: 'push.mute', sessionIds: ['a'] });
    expect(store.isPushMuted('phone', 'b')).toBe(false); // 全量覆盖
    // agent 发 push.mute 直接拒
    const rejected = hub.handleFrame(
      { ws: new FakeSocket(), deviceId: 'mbp', role: 'agent', machineId: 'mbp', connectedAt: 1, lastSeenAt: 1, pendingPings: 0 },
      { type: 'push.mute', sessionIds: ['a'] },
    );
    expect(rejected.kind).toBe('rejected');
  });

  test('未启用 webpush 的 hub:订阅回执 ok:false,client 上线不下发 config', () => {
    const { hub } = makeHub();
    const ws = new FakeSocket();
    hub.onClientOnline(clientConn(ws));
    expect(ws.sent.length).toBe(0); // 没有任何机器,也就没有 status 帧;重点是没有 push.config
    hub.handleFrame(clientConn(ws), { type: 'push.subscribe', endpoint: SUB.endpoint, keys: SUB.keys });
    expect((ws.frame(0) as { ok: boolean; error?: string }).ok).toBe(false);
  });
});

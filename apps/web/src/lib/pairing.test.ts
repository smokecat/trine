import { beforeAll, describe, expect, test } from 'bun:test';
import {
  decodePairingPayload,
  encodePairingPayload,
  generateKeyPair,
  generateQrSecret,
  generateSignKeyPair,
  sodiumReady,
  type BoxKeyPair,
} from '@trine/core/crypto';
import { AuthClientError } from '@trine/core/net';
import { PairingFlow, describePairingCodeError, type PairingSnapshot } from './pairing.ts';
import type { Identity } from './storage.ts';
import { FakeClock, FakeSocketFactory, flushMicrotasks } from './test-utils.ts';

let agent: BoxKeyPair;
let identity: Identity;

beforeAll(async () => {
  await sodiumReady();
  agent = generateKeyPair();
  identity = { v: 1, deviceId: 'web-1', sign: generateSignKeyPair(), box: generateKeyPair() };
});

function code(over: Partial<Parameters<typeof encodePairingPayload>[0]> = {}): string {
  return encodePairingPayload({
    v: 1,
    serverUrl: 'http://localhost:5173',
    agentPubKey: agent.publicKey,
    pairingToken: 'tok-1',
    qrSecret: generateQrSecret(),
    machineId: 'mbp',
    ...over,
  });
}

function harness(over: { currentServerUrl?: string | null; registered?: { value: boolean } } = {}) {
  const clock = new FakeClock();
  const sockets = new FakeSocketFactory();
  const phases: string[] = [];
  const registered = over.registered ?? { value: true };
  let authCalls = 0;
  const flow = new PairingFlow({
    identity,
    currentServerUrl: over.currentServerUrl ?? null,
    createSocket: sockets.create,
    clock,
    makeAuth: () => ({
      authenticate: async () => {
        authCalls++;
        if (!registered.value) throw new AuthClientError('unknown', 401, 'unknown_device');
        return { token: 'tok', expiresAt: clock.now() + 3_600_000 };
      },
    }),
    onChange: (s: PairingSnapshot) => void phases.push(s.phase),
  });
  return { flow, clock, sockets, phases, registered, authCalls: () => authCalls };
}

describe('pairing · 准备', () => {
  test('非法配对码 → failed 且原因可读；合法 → ready 带 SAS 与 machineId', () => {
    const h = harness();
    expect(h.flow.prepare('hello')).toMatchObject({ phase: 'failed', error: expect.stringContaining('trine1:') });
    expect(h.flow.prepare('trine1:!!!')).toMatchObject({ phase: 'failed' });
    const snap = h.flow.prepare(code());
    expect(snap.phase).toBe('ready');
    expect(snap.sas?.digits).toMatch(/^\d{6}$/);
    expect(snap.sas?.emoji).toHaveLength(4);
    expect(snap.machineId).toBe('mbp');
    expect(snap.serverUrl).toBe('http://localhost:5173');
  });

  test('MVP 单服务端：已配对到别的服务端 → 拒绝；尾斜杠/大小写差异视为同一服务端', () => {
    const h = harness({ currentServerUrl: 'https://other.example' });
    expect(h.flow.prepare(code())).toMatchObject({ phase: 'failed', error: expect.stringContaining('重置本地状态') });
    for (const same of ['http://localhost:5173', 'http://localhost:5173/', 'http://LOCALHOST:5173/']) {
      expect(harness({ currentServerUrl: same }).flow.prepare(code()).phase).toBe('ready');
    }
  });

  test('dispose：在途的认证结果作废，phase=disposed，不会变成 done', async () => {
    const registered = { value: false };
    const h = harness({ registered });
    h.flow.prepare(code());
    h.flow.start();
    h.sockets.last.emitOpen();
    h.sockets.last.emitClose(1006);
    await flushMicrotasks();
    expect(h.flow.phase).toBe('verifying');
    h.flow.dispose();
    expect(h.flow.phase).toBe('disposed');
    registered.value = true;
    await h.clock.advance(10_000);
    expect(h.flow.phase).toBe('disposed');
    expect(h.flow.snapshot().result).toBeNull();
    expect(h.clock.pending).toBe(0);
  });
});

describe('pairing · 完成判据 = authenticate 成功', () => {
  test('快路径：pairing 连接发 hello + pair.begin，收到 confirm → 探测认证 → done', async () => {
    const h = harness();
    h.flow.prepare(code());
    h.flow.start();
    expect(h.flow.phase).toBe('waiting');
    h.sockets.last.emitOpen();
    expect(h.sockets.last.sentFrames).toEqual([
      { type: 'hello', v: 1, role: 'pairing', deviceId: 'web-1' },
      {
        type: 'pair.begin',
        pairingToken: 'tok-1',
        clientPubKey: identity.box.publicKey,
        clientSignPubKey: identity.sign.publicKey,
        clientDeviceId: 'web-1',
      },
    ]);
    // 别的 token 的 confirm 与本次无关
    h.sockets.last.emitMessage({ type: 'pair.confirm', pairingToken: 'other', clientDeviceId: 'x', clientSignPubKey: 'y' });
    expect(h.flow.phase).toBe('waiting');
    h.sockets.last.emitMessage({ type: 'pair.confirm', pairingToken: 'tok-1', clientDeviceId: 'web-1', clientSignPubKey: identity.sign.publicKey });
    await flushMicrotasks();
    expect(h.flow.phase).toBe('done');
    expect(h.flow.snapshot().result).toEqual({
      serverUrl: 'http://localhost:5173',
      agentBoxPubKey: agent.publicKey,
      machineId: 'mbp',
      token: { token: 'tok', expiresAt: expect.any(Number) },
    });
    expect(h.sockets.last.closed).not.toBeNull();
    expect(h.phases).toEqual(['ready', 'waiting', 'verifying', 'done']);
  });

  test('confirm 丢失：pairing 连接被 4004 关掉 → 转探测；未登记时每 5s 重试，登记后成功', async () => {
    const registered = { value: false };
    const h = harness({ registered });
    h.flow.prepare(code());
    h.flow.start();
    h.sockets.last.emitOpen();
    h.sockets.last.emitClose(4004, 'pairing idle');
    await flushMicrotasks();
    expect(h.flow.phase).toBe('verifying');
    expect(h.authCalls()).toBe(1);
    await h.clock.advance(4_999);
    expect(h.authCalls()).toBe(1);
    await h.clock.advance(1);
    expect(h.authCalls()).toBe(2);
    expect(h.flow.snapshot().attempts).toBe(2);
    // agent 侧此刻按了 y：服务端登记成功
    registered.value = true;
    await h.clock.advance(5_000);
    expect(h.flow.phase).toBe('done');
    expect(h.clock.pending).toBe(0);
  });

  test('5 分钟仍未登记 → failed', async () => {
    const h = harness({ registered: { value: false } });
    h.flow.prepare(code());
    h.flow.start();
    h.sockets.last.emitOpen();
    h.sockets.last.emitClose(1006);
    await flushMicrotasks();
    await h.clock.advance(5 * 60_000 + 1);
    expect(h.flow.phase).toBe('failed');
    expect(h.flow.snapshot().error).toMatch(/超时/);
    expect(h.clock.pending).toBe(0);
  });
});

describe('pairing · 中止', () => {
  test('用户点「不一致」→ 发 pair.abort、关连接、aborted', () => {
    const h = harness();
    h.flow.prepare(code());
    h.flow.start();
    h.sockets.last.emitOpen();
    h.flow.abort();
    expect(h.sockets.last.sentFrames.at(-1)).toEqual({ type: 'pair.abort', pairingToken: 'tok-1', reason: 'SAS mismatch' });
    expect(h.flow.phase).toBe('aborted');
    // 之后 socket 关闭不会再触发探测
    h.sockets.last.emitClose(1000);
    expect(h.flow.phase).toBe('aborted');
  });

  test('agent 中止（pair.abort 帧）→ aborted 带原因', () => {
    const h = harness();
    h.flow.prepare(code());
    h.flow.start();
    h.sockets.last.emitOpen();
    h.sockets.last.emitMessage({ type: 'pair.abort', pairingToken: 'tok-1', reason: 'SAS mismatch' });
    expect(h.flow.phase).toBe('aborted');
    expect(h.flow.snapshot().error).toContain('SAS mismatch');
    expect(h.authCalls()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 配对码错误文案
//
// 一律用**真的坏输入**去触发（坏 base64 / 缺字段 JSON / 非法 serverUrl），
// 不手造 Error：这些异常的形状（libsodium 的 `incomplete input`、zod 的
// issue 结构）正是映射逻辑要判的东西，手造出来的 Error 只会把测试写成
// 「实现说什么就是什么」。
// ---------------------------------------------------------------------------
describe('describePairingCodeError', () => {
  /** 把任意 payload 编成 trine1: 码（绕开 encodePairingPayload 的校验，好造坏数据） */
  const raw = (obj: unknown): string =>
    'trine1:' + Buffer.from(JSON.stringify(obj)).toString('base64url');

  /** 真的去解码，把它真实抛出的异常喂给映射函数 */
  const describeOf = (codeText: string): string => {
    try {
      decodePairingPayload(codeText);
    } catch (err) {
      return describePairingCodeError(err);
    }
    throw new Error(`期望 ${codeText.slice(0, 24)}… 解码失败，但它成功了`);
  };

  const valid = {
    v: 1,
    serverUrl: 'http://localhost:5173',
    agentPubKey: '',
    pairingToken: 'tok-1',
    qrSecret: 'q',
  };

  test('不是 trine 配对码', () => {
    expect(describeOf('hello')).toBe('这不是 trine 配对码（应以 trine1: 开头）');
  });

  test('libsodium 的 `incomplete input`（残缺/非法 base64）不再透英文', () => {
    // 这三种都让 from_base64 抛 `incomplete input`，早先落到兜底分支原样透出
    for (const bad of ['trine1:####', 'trine1:eyJ2Ijox!!', 'trine1:@@@@@@@@']) {
      const msg = describeOf(bad);
      expect(msg).toBe('配对码内容损坏或不完整，请重新复制');
      expect(msg).not.toContain('incomplete input');
    }
  });

  test('缺字段说「不完整」，不说「公钥损坏 / 地址不合法」', () => {
    // zod 的报文里恰好带字段名，早先的子串匹配把「缺」当成了「坏」
    const noKey = raw({ v: 1, serverUrl: 'http://localhost:5173', pairingToken: 't', qrSecret: 'q' });
    expect(describeOf(noKey)).toBe('配对码内容损坏或不完整，请重新复制');
    const noUrl = raw({ v: 1, agentPubKey: 'AAAA', pairingToken: 't', qrSecret: 'q' });
    expect(describeOf(noUrl)).toBe('配对码内容损坏或不完整，请重新复制');
  });

  test('字段在但值不合法：仍给具体原因', () => {
    // serverUrl 非 TLS 非回环 → zod custom issue
    expect(describeOf(raw({ ...valid, serverUrl: 'http://evil.example', agentPubKey: agent.publicKey }))).toBe(
      '配对码里的服务端地址不合法（必须是 https/wss，或本机回环地址）',
    );
    // agentPubKey 长度不对 → decodePairingPayload 自己抛的普通 Error
    expect(describeOf(raw({ ...valid, agentPubKey: 'AAAA' }))).toBe('配对码里的 agent 公钥损坏');
  });

  test('坏 JSON / 空内容', () => {
    expect(describeOf('trine1:' + Buffer.from('{ not json').toString('base64url'))).toBe(
      '配对码内容损坏或不完整，请重新复制',
    );
    expect(describeOf('trine1:')).toBe('配对码内容损坏或不完整，请重新复制');
  });

  test('任何情况下都不把原始英文异常透给用户', () => {
    for (const bad of ['trine1:####', raw({ v: 1 }), 'trine1:' + Buffer.from('x').toString('base64url')]) {
      expect(describeOf(bad)).not.toMatch(/[a-z]{4,}\s[a-z]{4,}/); // 连续两个英文单词 = 漏出来了
    }
  });
});

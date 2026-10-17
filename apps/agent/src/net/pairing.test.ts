import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodePairingPayload,
  deriveSas,
  generateKeyPair,
  generateSignKeyPair,
  sodiumReady,
  type BoxKeyPair,
  type SignKeyPair,
} from '@trine/core/crypto';
import type { TransportFrame } from '@trine/core/protocol';
import { PAIRING_TOKEN_TTL_MS, PairingManager } from './pairing.ts';
import { RecipientBookStore } from './recipients.ts';
import { formatPairingPrompt, renderPairingPayload } from './qr.ts';

let dir: string;
let recipients: RecipientBookStore;
let manager: PairingManager;
let agentBox: BoxKeyPair;
let clientBox: BoxKeyPair;
let clientSign: SignKeyPair;
let clock: number;

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(async () => {
  clock = 1_000_000;
  dir = await mkdtemp(join(tmpdir(), 'trine-pairing-'));
  recipients = await RecipientBookStore.load(join(dir, 'recipients.json'));
  agentBox = generateKeyPair();
  clientBox = generateKeyPair();
  clientSign = generateSignKeyPair();
  manager = new PairingManager({
    agentBoxPubKey: agentBox.publicKey,
    recipients,
    serverUrl: 'https://trine.example.com',
    machineId: 'mbp-machine-1',
    now: () => clock,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function beginFrame(
  pairingToken: string,
  over: Partial<Extract<TransportFrame, { type: 'pair.begin' }>> = {},
): Extract<TransportFrame, { type: 'pair.begin' }> {
  return {
    type: 'pair.begin',
    pairingToken,
    clientPubKey: clientBox.publicKey,
    clientSignPubKey: clientSign.publicKey,
    clientDeviceId: 'phone',
    ...over,
  };
}

describe('配对材料生成', () => {
  test('QR payload 可解码，且带上 qrSecret 与 agent 公钥', () => {
    const session = manager.begin();
    const payload = decodePairingPayload(session.payload);
    expect(payload.agentPubKey).toBe(agentBox.publicKey);
    expect(payload.pairingToken).toBe(session.pairingToken);
    expect(payload.qrSecret).toBe(session.qrSecret);
    expect(payload.serverUrl).toBe('https://trine.example.com');
  });

  test('QR payload 带上本机 machineId（client 据此认出配的是哪台机器）', () => {
    const payload = decodePairingPayload(manager.begin().payload);
    expect(payload.machineId).toBe('mbp-machine-1');
  });

  test('未配置 machineId 时 QR 不带该字段（旧行为，client 回落猜测）', () => {
    const anonymous = new PairingManager({
      agentBoxPubKey: agentBox.publicKey,
      recipients,
      serverUrl: 'https://trine.example.com',
      now: () => clock,
    });
    const payload = decodePairingPayload(anonymous.begin().payload);
    expect(payload.machineId).toBeUndefined();
  });

  test('每次 begin 的 token 与 qrSecret 都不重样', () => {
    const a = manager.begin();
    const b = manager.begin();
    expect(a.pairingToken).not.toBe(b.pairingToken);
    expect(a.qrSecret).not.toBe(b.qrSecret);
  });

  test('明文 http 的 serverUrl 被拒（中间人可直接换公钥）', () => {
    const insecure = new PairingManager({
      agentBoxPubKey: agentBox.publicKey,
      recipients,
      serverUrl: 'http://trine.example.com',
      now: () => clock,
    });
    expect(() => insecure.begin()).toThrow();
  });
});

describe('SAS 与确认', () => {
  test('双端各自算出的 SAS 一致', () => {
    const session = manager.begin();
    const outcome = manager.onBegin(beginFrame(session.pairingToken));
    if (outcome.kind !== 'awaiting_confirm') throw new Error('应当等待确认');

    // client 侧用它真实持有的整份身份算一遍
    const clientSide = deriveSas(
      agentBox.publicKey,
      {
        boxPubKey: clientBox.publicKey,
        signPubKey: clientSign.publicKey,
        deviceId: 'phone',
      },
      session.qrSecret,
    );
    expect(outcome.peer.sas).toEqual(clientSide);
    expect(outcome.peer.sas.digits).toHaveLength(6);
    expect(outcome.peer.sas.emoji).toHaveLength(4);
  });

  test('box 公钥被中间人替换 → SAS 不一致（这就是人工比对的意义）', () => {
    const session = manager.begin();
    const attacker = generateKeyPair();
    const outcome = manager.onBegin(
      beginFrame(session.pairingToken, { clientPubKey: attacker.publicKey }),
    );
    if (outcome.kind !== 'awaiting_confirm') throw new Error('应当等待确认');

    // 真 client 手里的公钥没变，它算出的 SAS 与 agent 屏幕上的对不上
    const realClientSas = deriveSas(
      agentBox.publicKey,
      {
        boxPubKey: clientBox.publicKey,
        signPubKey: clientSign.publicKey,
        deviceId: 'phone',
      },
      session.qrSecret,
    );
    expect(outcome.peer.sas).not.toEqual(realClientSas);
  });

  test('对抗性：server 只替换 signPubKey（box 公钥不动）→ SAS 不一致', () => {
    // 认证平面劫持：登记落库的凭据是 signPubKey，agent 收到的是攻击者的
    const session = manager.begin();
    const attackerSign = generateSignKeyPair();
    const outcome = manager.onBegin(
      beginFrame(session.pairingToken, {
        clientSignPubKey: attackerSign.publicKey,
      }),
    );
    if (outcome.kind !== 'awaiting_confirm') throw new Error('应当等待确认');

    // 真 client 用自己**真实**的 signPubKey 算——与 agent 屏幕上的对不上
    const realClientSas = deriveSas(
      agentBox.publicKey,
      {
        boxPubKey: clientBox.publicKey,
        signPubKey: clientSign.publicKey,
        deviceId: 'phone',
      },
      session.qrSecret,
    );
    expect(outcome.peer.sas).not.toEqual(realClientSas);
  });

  test('对抗性：server 只替换 clientDeviceId → SAS 不一致', () => {
    const session = manager.begin();
    const outcome = manager.onBegin(
      beginFrame(session.pairingToken, { clientDeviceId: 'attacker-device' }),
    );
    if (outcome.kind !== 'awaiting_confirm') throw new Error('应当等待确认');

    const realClientSas = deriveSas(
      agentBox.publicKey,
      {
        boxPubKey: clientBox.publicKey,
        signPubKey: clientSign.publicKey,
        deviceId: 'phone',
      },
      session.qrSecret,
    );
    expect(outcome.peer.sas).not.toEqual(realClientSas);
  });

  test('确认后写名册并产出复述身份的 confirm 帧', async () => {
    const session = manager.begin();
    manager.onBegin(beginFrame(session.pairingToken));
    const { frame, recipient } = await manager.confirm(session.pairingToken);

    expect(frame).toEqual({
      type: 'pair.confirm',
      pairingToken: session.pairingToken,
      clientDeviceId: 'phone',
      // 复述的必须是 agent 实际收到的那份
      clientSignPubKey: clientSign.publicKey,
    });
    expect(recipient.boxPubKey).toBe(clientBox.publicKey);
    expect(recipients.get('phone')?.boxPubKey).toBe(clientBox.publicKey);
  });

  test('没收到 begin 就确认会抛错', async () => {
    const session = manager.begin();
    await expect(manager.confirm(session.pairingToken)).rejects.toThrow(
      /还没有收到/,
    );
  });

  test('不认识的 token 确认会抛错', async () => {
    await expect(manager.confirm('made-up')).rejects.toThrow(/不存在/);
  });
});

describe('pairingToken 三路径核销（D8 要求落码）', () => {
  test('路径 1：确认成功即核销，同一 token 不能再用', async () => {
    const session = manager.begin();
    manager.onBegin(beginFrame(session.pairingToken));
    await manager.confirm(session.pairingToken);

    expect(manager.activeCount).toBe(0);
    expect(manager.get(session.pairingToken)).toBeNull();
    // 重放：同一 token 再来一条 begin 也认不出来了
    expect(manager.onBegin(beginFrame(session.pairingToken))).toEqual({
      kind: 'ignored',
      reason: 'unknown_token',
    });
    await expect(manager.confirm(session.pairingToken)).rejects.toThrow();
  });

  test('路径 2：abort 立即核销并产出 abort 帧', () => {
    const session = manager.begin();
    manager.onBegin(beginFrame(session.pairingToken));

    const frame = manager.abort(session.pairingToken, 'SAS 不一致');
    expect(frame).toEqual({
      type: 'pair.abort',
      pairingToken: session.pairingToken,
      reason: 'SAS 不一致',
    });
    expect(manager.activeCount).toBe(0);
    // 重复 abort 幂等，不再产出帧
    expect(manager.abort(session.pairingToken)).toBeNull();
  });

  test('路径 3：TTL 到点被动核销', async () => {
    const session = manager.begin();
    expect(session.expiresAt - session.createdAt).toBe(PAIRING_TOKEN_TTL_MS);

    clock += PAIRING_TOKEN_TTL_MS + 1;
    // 过期与「不认识」归同一条路径：对外区分等于泄露「这个 token 存在过」
    expect(manager.onBegin(beginFrame(session.pairingToken))).toEqual({
      kind: 'ignored',
      reason: 'unknown_token',
    });
    expect(manager.activeCount).toBe(0);
  });

  test('TTL 边界内仍然可用', () => {
    const session = manager.begin();
    clock += PAIRING_TOKEN_TTL_MS - 1;
    expect(manager.onBegin(beginFrame(session.pairingToken)).kind).toBe(
      'awaiting_confirm',
    );
  });

  test('已收到 begin 但迟迟不确认，过期后确认被拒', async () => {
    const session = manager.begin();
    manager.onBegin(beginFrame(session.pairingToken));
    clock += PAIRING_TOKEN_TTL_MS + 1;
    await expect(manager.confirm(session.pairingToken)).rejects.toThrow(
      /已过期/,
    );
    expect(recipients.size).toBe(0);
  });

  test('sweep 清掉全部过期会话', () => {
    manager.begin();
    manager.begin();
    expect(manager.activeCount).toBe(2);
    clock += PAIRING_TOKEN_TTL_MS + 1;
    expect(manager.sweep()).toBe(2);
    expect(manager.activeCount).toBe(0);
  });
});

describe('广播噪音与畸形输入', () => {
  test('不是发给本机的 token 静默忽略（服务端向全体 agent 广播）', () => {
    manager.begin();
    expect(manager.onBegin(beginFrame('别人的 token'))).toEqual({
      kind: 'ignored',
      reason: 'unknown_token',
    });
  });

  test('非法 Ed25519 公钥在算 SAS 前就被拒', () => {
    const session = manager.begin();
    expect(
      manager.onBegin(
        beginFrame(session.pairingToken, { clientSignPubKey: 'not-a-key' }),
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid_sign_key' });
  });

  test('非法 X25519 公钥被拒而不是抛出去', () => {
    const session = manager.begin();
    expect(
      manager.onBegin(
        beginFrame(session.pairingToken, { clientPubKey: '!!!not base64!!!' }),
      ),
    ).toEqual({ kind: 'rejected', reason: 'invalid_pub_key' });
  });
});

describe('终端二维码', () => {
  test('渲染出 QR，且原文永远在（fallback 兜底）', async () => {
    const session = manager.begin();
    const rendered = await renderPairingPayload(session.payload);
    expect(rendered.text).toBe(session.payload);
    expect(rendered.qr).toBeTruthy();

    const prompt = formatPairingPrompt(rendered);
    expect(prompt).toContain(session.payload);
    // 必须明确提醒「两端一致才确认」——SAS 是唯一挡中间人的环节
    expect(prompt).toContain('一致');
  });

  test('QR 渲染不出来时仍给出可复制的配对码', () => {
    const prompt = formatPairingPrompt({
      qr: null,
      text: 'trine1:PAYLOAD',
      qrError: '终端不支持',
    });
    expect(prompt).toContain('trine1:PAYLOAD');
    expect(prompt).toContain('终端不支持');
  });
});

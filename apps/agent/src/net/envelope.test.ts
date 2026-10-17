import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  generateKeyPair,
  sealJson,
  sodiumReady,
  type BoxKeyPair,
} from '@trine/core/crypto';
import type {
  AgentToClientEvent,
  ClientToAgentEvent,
  RelayFrame,
} from '@trine/core';
import { openInbound, sealForAll, sealForRecipient, SeqCursors } from './envelope.ts';
import type { Recipient } from './recipients.ts';

let agent: BoxKeyPair;
let phone: BoxKeyPair;
let tablet: BoxKeyPair;
let phoneRecipient: Recipient;
let tabletRecipient: Recipient;

beforeAll(async () => {
  await sodiumReady();
});

beforeEach(() => {
  agent = generateKeyPair();
  phone = generateKeyPair();
  tablet = generateKeyPair();
  phoneRecipient = {
    deviceId: 'phone',
    boxPubKey: phone.publicKey,
    signPubKey: 'SIGN-PHONE',
    pairedAt: 1,
  };
  tabletRecipient = {
    deviceId: 'tablet',
    boxPubKey: tablet.publicKey,
    signPubKey: 'SIGN-TABLET',
    pairedAt: 2,
  };
});

const a2cEvent: AgentToClientEvent = {
  type: 'assistant.done',
  ts: 1_700_000_000_000,
  seq: 7,
  dir: 'a2c',
  sessionId: 's1',
  messageId: 'm1',
  text: '这是一段绝不该被服务端看到的正文',
};

const c2aEvent: ClientToAgentEvent = {
  type: 'input.send',
  ts: 1_700_000_000_000,
  seq: 3,
  dir: 'c2a',
  sessionId: 's1',
  clientMsgId: 'c1',
  text: '帮我跑一下测试',
};

describe('出站封套', () => {
  test('信封只带路由字段，正文一律进密文', () => {
    const { frame } = sealForRecipient(a2cEvent, phoneRecipient, {
      machineId: 'mbp',
      boxSecretKey: agent.secretKey,
      pushHint: 'run_done',
    });
    expect(frame).toMatchObject({
      type: 'relay',
      machineId: 'mbp',
      sessionId: 's1',
      seq: 7,
      pushHint: 'run_done',
    });
    // 帧上不该出现正文的任何一个字
    expect(JSON.stringify(frame)).not.toContain('绝不该被服务端看到');
    expect(JSON.stringify(frame)).not.toContain('assistant.done');
  });

  test('机器级事件省略 sessionId（而不是置 undefined）', () => {
    const machineEvent: AgentToClientEvent = {
      type: 'machine.info',
      ts: 1,
      seq: 1,
      dir: 'a2c',
      info: {
        name: 'MBP',
        platform: 'darwin',
        osVersion: '15.0',
        agentVersion: '0.1.0',
        claudeVersion: '1.0.0',
        activeSessionCount: 0,
      },
    };
    const { frame } = sealForRecipient(machineEvent, phoneRecipient, {
      machineId: 'mbp',
      boxSecretKey: agent.secretKey,
    });
    expect('sessionId' in frame).toBe(false);
  });

  test('帧上带 recipientDeviceId（a2c 帧坐标的一部分）', () => {
    const { frame } = sealForRecipient(a2cEvent, phoneRecipient, {
      machineId: 'mbp',
      boxSecretKey: agent.secretKey,
    });
    expect(frame.recipientDeviceId).toBe('phone');
  });

  test('矩阵式 fanout：每个收件人各一份密文，同 seq、只差收件人', () => {
    const sealed = sealForAll(a2cEvent, [phoneRecipient, tabletRecipient], {
      machineId: 'mbp',
      boxSecretKey: agent.secretKey,
    });
    expect(sealed).toHaveLength(2);
    // 同一事件对不同收件人的密文不同（不同的共享密钥 + 不同 nonce）
    expect(sealed[0]!.frame.ciphertext).not.toBe(sealed[1]!.frame.ciphertext);
    // 同一逻辑事件 = 同一个 seq：seq 与逻辑事件一一对应是 client 侧
    // 单调游标的前提，给每个收件人各配一套计数器会让这个对应关系散掉
    expect(sealed[0]!.frame.seq).toBe(a2cEvent.seq);
    expect(sealed[1]!.frame.seq).toBe(a2cEvent.seq);
    // 区分它们的只有收件人这一维
    expect(sealed.map((s) => s.frame.recipientDeviceId)).toEqual([
      'phone',
      'tablet',
    ]);

    // phone 的那份 tablet 解不开——单设备泄露不牵连其他设备，
    // 这正是选矩阵式而非共享根密钥的理由
    const forPhone = sealed.find((s) => s.recipient.deviceId === 'phone')!;
    const asTablet = openInbound(
      forPhone.frame,
      [{ ...phoneRecipient, boxPubKey: agent.publicKey }],
      tablet.secretKey,
    );
    expect(asTablet.ok).toBe(false);
  });

  test('没有收件人时返回空数组（全新 agent 的正常状态）', () => {
    expect(
      sealForAll(a2cEvent, [], { machineId: 'mbp', boxSecretKey: agent.secretKey }),
    ).toEqual([]);
  });
});

describe('入站解封', () => {
  /** 模拟 client 发一条 c2a 帧给 agent */
  function inboundFrom(
    client: BoxKeyPair,
    event: ClientToAgentEvent = c2aEvent,
    envelopeOver: Partial<RelayFrame> = {},
  ): RelayFrame {
    const box = sealJson(event, agent.publicKey, client.secretKey);
    return {
      type: 'relay',
      machineId: 'mbp',
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      seq: event.seq,
      nonce: box.nonce,
      ciphertext: box.ciphertext,
      ...envelopeOver,
    };
  }

  test('解得开 + schema 过 + 绑定过 → 认出发送方', () => {
    const result = openInbound(
      inboundFrom(phone),
      [phoneRecipient, tabletRecipient],
      agent.secretKey,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sender.deviceId).toBe('phone');
    expect(result.event).toEqual(c2aEvent);
  });

  test('逐个收件人试解：第二个才对得上也能认出来', () => {
    const result = openInbound(
      inboundFrom(tablet),
      [phoneRecipient, tabletRecipient],
      agent.secretKey,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sender.deviceId).toBe('tablet');
  });

  test('陌生设备的密文解不开', () => {
    const stranger = generateKeyPair();
    const result = openInbound(
      inboundFrom(stranger),
      [phoneRecipient],
      agent.secretKey,
    );
    expect(result).toMatchObject({ ok: false, failure: 'decrypt_failed' });
  });

  test('还没配对任何设备时归因为 unknown_sender', () => {
    const result = openInbound(inboundFrom(phone), [], agent.secretKey);
    expect(result).toMatchObject({ ok: false, failure: 'unknown_sender' });
  });

  test('密文被篡改一个字节即解不开（Poly1305）', () => {
    const frame = inboundFrom(phone);
    const tampered: RelayFrame = {
      ...frame,
      ciphertext: `${frame.ciphertext.slice(0, -1)}${
        frame.ciphertext.at(-1) === 'A' ? 'B' : 'A'
      }`,
    };
    expect(
      openInbound(tampered, [phoneRecipient], agent.secretKey).ok,
    ).toBe(false);
  });

  test('反射攻击：agent 自己发的密文被回灌 → dir 不符被拒', () => {
    // 恶意服务端把 agent 发给 phone 的密文原样回发给 agent。
    // crypto_box 双向共享密钥相同，所以它**解得开**——挡住它的是 dir。
    const { frame } = sealForRecipient(a2cEvent, phoneRecipient, {
      machineId: 'mbp',
      boxSecretKey: agent.secretKey,
    });
    const result = openInbound(
      frame,
      [{ ...phoneRecipient, boxPubKey: agent.publicKey }],
      phone.secretKey,
    );
    // a2c 的事件在 c2a 的联合类型里根本不存在，先在 schema 层就被挡下
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(['schema_invalid', 'binding_invalid']).toContain(result.failure);
    }
  });

  test('服务端改了信封 seq → 与密文内不符被拒（重放防御）', () => {
    const frame = inboundFrom(phone, c2aEvent, { seq: 999 });
    expect(openInbound(frame, [phoneRecipient], agent.secretKey)).toMatchObject({
      ok: false,
      failure: 'binding_invalid',
    });
  });

  test('跨会话拼接：信封挂了别的 sessionId → 被拒', () => {
    const frame = inboundFrom(phone, c2aEvent, { sessionId: 'other-session' });
    expect(openInbound(frame, [phoneRecipient], agent.secretKey)).toMatchObject({
      ok: false,
      failure: 'binding_invalid',
    });
  });

  test('解得开但内容不合 schema → 归因 schema_invalid，不再试其他收件人', () => {
    const box = sealJson(
      { type: 'not.a.real.event', dir: 'c2a', seq: 1, ts: 1 },
      agent.publicKey,
      phone.secretKey,
    );
    const frame: RelayFrame = {
      type: 'relay',
      machineId: 'mbp',
      seq: 1,
      nonce: box.nonce,
      ciphertext: box.ciphertext,
    };
    expect(
      openInbound(frame, [phoneRecipient, tabletRecipient], agent.secretKey),
    ).toMatchObject({ ok: false, failure: 'schema_invalid' });
  });
});

describe('seq 单调游标（挡原样重放）', () => {
  test('严格递增才接受', () => {
    const cursors = new SeqCursors();
    expect(cursors.accept('phone', 's1', 1)).toBe(true);
    expect(cursors.accept('phone', 's1', 2)).toBe(true);
    // 原样重放一条旧帧：信封与密文完全一致，绑定校验拦不住，游标能
    expect(cursors.accept('phone', 's1', 2)).toBe(false);
    expect(cursors.accept('phone', 's1', 1)).toBe(false);
    expect(cursors.accept('phone', 's1', 3)).toBe(true);
  });

  test('每 (设备, 会话) 一条独立序列', () => {
    const cursors = new SeqCursors();
    expect(cursors.accept('phone', 's1', 5)).toBe(true);
    // 另一个会话、另一台设备各自从头计
    expect(cursors.accept('phone', 's2', 1)).toBe(true);
    expect(cursors.accept('tablet', 's1', 1)).toBe(true);
    expect(cursors.lastSeen('phone', 's1')).toBe(5);
    expect(cursors.lastSeen('phone', 's2')).toBe(1);
  });

  test('机器级序列（sessionId 省略）独立于会话级', () => {
    const cursors = new SeqCursors();
    expect(cursors.accept('phone', undefined, 3)).toBe(true);
    expect(cursors.accept('phone', 's1', 1)).toBe(true);
    expect(cursors.lastSeen('phone', undefined)).toBe(3);
  });

  test('没见过的流 lastSeen 为 0（= sinceSeq 的从头补发语义）', () => {
    expect(new SeqCursors().lastSeen('phone', 's1')).toBe(0);
  });

  test('minLastSeen 取某流跨全部发送方的最小值（c2a 单条 sync 用）', () => {
    const cursors = new SeqCursors();
    // c2a 是共享流，两个发送方都写机器级序列，各自游标不同
    cursors.accept('phone', undefined, 7);
    cursors.accept('tablet', undefined, 3);
    // 取最小 → 一条 sync.request 就能把谁漏的都补回来，整条流只重放一次
    expect(cursors.minLastSeen(undefined)).toBe(3);

    // 会话级流各自独立统计
    cursors.accept('phone', 's1', 10);
    cursors.accept('tablet', 's1', 12);
    expect(cursors.minLastSeen('s1')).toBe(10);
    // 机器级不受会话级影响
    expect(cursors.minLastSeen(undefined)).toBe(3);
  });

  test('snapshot/restore 往返保持游标；restore 只进不退且跳过坏条目', () => {
    const cursors = new SeqCursors();
    cursors.accept('phone', 's1', 5);
    cursors.accept('phone', undefined, 2);
    const snap = cursors.snapshot();
    // 快照可 JSON 往返（key 里的 NUL 分隔符在 JSON 字符串里合法）
    const roundTrip = JSON.parse(JSON.stringify(snap)) as Record<string, number>;

    const restored = new SeqCursors();
    // 进程内已推进到 7：restore 的 5 不能把它拖回去
    restored.accept('phone', 's1', 7);
    restored.restore({
      ...roundTrip,
      // 坏条目：负数 / 非数 / 没分隔符的 key，全部跳过不抛
      ['tablet\u0000s9']: -1,
      ['tablet\u0000s8']: Number.NaN,
      'no-separator': 3,
    });
    expect(restored.lastSeen('phone', 's1')).toBe(7);
    expect(restored.lastSeen('phone', undefined)).toBe(2);
    expect(restored.lastSeen('tablet', 's9')).toBe(0);
    expect(restored.lastSeen('tablet', 's8')).toBe(0);
    // 恢复后重放防护立刻生效
    expect(restored.accept('phone', undefined, 2)).toBe(false);
    expect(restored.accept('phone', undefined, 3)).toBe(true);
  });

  test('sessionIds 列出出现过的流（去重，机器级为 undefined）', () => {
    const cursors = new SeqCursors();
    expect(cursors.sessionIds()).toEqual([]);
    cursors.accept('phone', 's1', 1);
    cursors.accept('tablet', 's1', 4);
    cursors.accept('phone', undefined, 2);
    cursors.accept('phone', 's2', 1);
    const ids = cursors.sessionIds();
    expect(ids).toHaveLength(3);
    expect(ids).toContain('s1');
    expect(ids).toContain('s2');
    expect(ids).toContain(undefined);
  });

  test('minLastSeen 没有匹配记录时为 0', () => {
    expect(new SeqCursors().minLastSeen(undefined)).toBe(0);
    expect(new SeqCursors().minLastSeen('s1')).toBe(0);
  });

  test('minLastSeen 精确按分隔符切 sessionId，不被 deviceId 尾串误命中', () => {
    const cursors = new SeqCursors();
    // deviceId 恰好以目标 sessionId 结尾——endsWith 会误命中，切分则不会
    cursors.accept('devs1', undefined, 5);
    cursors.accept('phone', 's1', 9);
    expect(cursors.minLastSeen('s1')).toBe(9);
  });
});

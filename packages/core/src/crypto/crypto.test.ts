import { beforeAll, describe, expect, test } from 'bun:test';
import {
  decodePairingPayload,
  deriveSas,
  encodePairingPayload,
  fromBase64,
  generateKeyPair,
  generateQrSecret,
  generateSignKeyPair,
  open,
  openJson,
  seal,
  sealJson,
  sodiumReady,
  toBase64,
  type ClientPairingIdentity,
} from './index.ts';

beforeAll(async () => {
  await sodiumReady();
});

describe('crypto_box 封装', () => {
  test('加解密往返（client → agent）', () => {
    const client = generateKeyPair();
    const agent = generateKeyPair();
    const box = seal('机密 payload ✓', agent.publicKey, client.secretKey);
    const plain = open(box, client.publicKey, agent.secretKey);
    expect(new TextDecoder().decode(plain)).toBe('机密 payload ✓');
  });

  test('每次加密 nonce 不同，密文不同', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const box1 = seal('same', b.publicKey, a.secretKey);
    const box2 = seal('same', b.publicKey, a.secretKey);
    expect(box1.nonce).not.toBe(box2.nonce);
    expect(box1.ciphertext).not.toBe(box2.ciphertext);
  });

  test('密文被篡改时解密抛错', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const box = seal('payload', b.publicKey, a.secretKey);
    const tampered = {
      ...box,
      ciphertext: box.ciphertext.slice(0, -2) + (box.ciphertext.endsWith('AA') ? 'BB' : 'AA'),
    };
    expect(() => open(tampered, a.publicKey, b.secretKey)).toThrow();
  });

  test('错误密钥解不开（服务端/第三方无法解密）', () => {
    const client = generateKeyPair();
    const agent = generateKeyPair();
    const eve = generateKeyPair();
    const box = seal('payload', agent.publicKey, client.secretKey);
    expect(() => open(box, client.publicKey, eve.secretKey)).toThrow();
  });

  test('sealJson/openJson 往返 E2E 事件帧', () => {
    const client = generateKeyPair();
    const agent = generateKeyPair();
    const event = {
      type: 'permission.request',
      ts: Date.now(),
      seq: 7,
      dir: 'a2c',
      sessionId: 's1',
      requestId: 'r1',
      toolName: 'Bash',
      input: { command: 'git status' },
      requestedAt: Date.now(),
    };
    const box = sealJson(event, client.publicKey, agent.secretKey);
    expect(openJson(box, agent.publicKey, client.secretKey)).toEqual(event);
  });
});

describe('配对', () => {
  const validPayload = () => ({
    v: 1 as const,
    serverUrl: 'wss://relay.example.com',
    agentPubKey: generateKeyPair().publicKey,
    pairingToken: 'tok-once',
    qrSecret: generateQrSecret(),
  });

  /** 两个 SAS 是否在人眼比对层面相同（数字 + emoji 都一致） */
  const sasEqual = (
    x: { digits: string; emoji: string[] },
    y: { digits: string; emoji: string[] },
  ) => x.digits === y.digits && x.emoji.join('') === y.emoji.join('');

  test('QR payload 编解码往返', () => {
    const payload = validPayload();
    const encoded = encodePairingPayload(payload);
    expect(encoded.startsWith('trine1:')).toBe(true);
    expect(decodePairingPayload(encoded)).toEqual(payload as never);
  });

  test('QR payload 带 machineId 时编解码往返保真', () => {
    const payload = { ...validPayload(), machineId: 'a1b2c3d4e5f6' };
    const decoded = decodePairingPayload(encodePairingPayload(payload));
    expect(decoded).toEqual(payload as never);
    expect(decoded.machineId).toBe('a1b2c3d4e5f6');
  });

  test('machineId 可选：旧格式 QR（不带该字段）仍能解码', () => {
    // 向后兼容判据：0.1.0 时期生成的 payload 没有 machineId，
    // 解码端必须照收，由调用方回落到「首条在线 machine.status」
    const legacy = validPayload();
    expect('machineId' in legacy).toBe(false);
    const decoded = decodePairingPayload(encodePairingPayload(legacy));
    expect(decoded.machineId).toBeUndefined();
    expect(decoded.agentPubKey).toBe(legacy.agentPubKey);
  });

  test('machineId 为空串被拒（min(1)）', () => {
    expect(() =>
      encodePairingPayload({ ...validPayload(), machineId: '' } as never),
    ).toThrow();
  });

  test('非 trine 前缀 / 非法内容被拒绝', () => {
    expect(() => decodePairingPayload('otherapp:xxx')).toThrow();
    expect(() => decodePairingPayload('trine1:aGVsbG8')).toThrow();
  });

  test('qrSecret 必带且每次随机（128-bit）', () => {
    const { qrSecret: _drop, ...noSecret } = validPayload();
    expect(() => encodePairingPayload(noSecret as never)).toThrow();
    const s1 = generateQrSecret();
    const s2 = generateQrSecret();
    expect(s1).not.toBe(s2);
    expect(fromBase64(s1)).toHaveLength(16);
  });

  test('serverUrl 只接受 wss / https', () => {
    for (const url of ['wss://relay.example.com', 'https://relay.example.com']) {
      expect(() =>
        encodePairingPayload({ ...validPayload(), serverUrl: url }),
      ).not.toThrow();
    }
    for (const url of [
      'ws://relay.example.com',
      'http://relay.example.com',
      'ftp://relay.example.com',
      '不是 URL',
    ]) {
      expect(() =>
        encodePairingPayload({ ...validPayload(), serverUrl: url }),
      ).toThrow();
    }
  });

  test('回环地址豁免 TLS（本机开发与测试），且只认字面量回环', () => {
    // 流量不出网卡，没有可插入的中间人；强制 TLS 只会逼出自签证书，
    // 而「习惯性点掉证书警告」比这个豁免危险得多
    for (const url of [
      'http://127.0.0.1:8787',
      'ws://127.0.0.1:8787',
      'http://localhost:8787',
      'ws://localhost',
      'http://127.1.2.3:8787',
    ]) {
      expect(() =>
        encodePairingPayload({ ...validPayload(), serverUrl: url }),
      ).not.toThrow();
    }
    // 「看起来像本机」但不是字面量回环的一律不豁免——解析结果取决于
    // 运行环境的 hosts/DNS，不是这段代码能保证的性质
    for (const url of [
      'http://localhost.evil.com',
      'ws://127.0.0.1.evil.com',
      'http://0.0.0.0:8787',
      'http://10.0.0.1:8787',
    ]) {
      expect(() =>
        encodePairingPayload({ ...validPayload(), serverUrl: url }),
      ).toThrow();
    }
  });

  test('decodePairingPayload 校验 agentPubKey 恰为 32 字节', () => {
    // schema 允许任意非空字符串，长度校验发生在 decode——所以先绕过 encode 的
    // schema 校验直接造串（encode 只管 schema，长度是 decode 的职责）
    const bad = (pubKey: string) => {
      const json = JSON.stringify({ ...validPayload(), agentPubKey: pubKey });
      return `trine1:${toBase64(new TextEncoder().encode(json))}`;
    };
    expect(() => decodePairingPayload(bad(toBase64(new Uint8Array(31))))).toThrow(
      /32 字节/,
    );
    expect(() => decodePairingPayload(bad(toBase64(new Uint8Array(33))))).toThrow(
      /32 字节/,
    );
    expect(() =>
      decodePairingPayload(bad(toBase64(new Uint8Array(32)))),
    ).not.toThrow();
  });

  /** 造一份 client 身份：box 公钥 + Ed25519 签名公钥 + deviceId */
  const clientIdentity = (
    over: Partial<ClientPairingIdentity> = {},
  ): ClientPairingIdentity => ({
    boxPubKey: generateKeyPair().publicKey,
    signPubKey: generateSignKeyPair().publicKey,
    deviceId: 'phone',
    ...over,
  });

  test('SAS：两端计算一致，且两把 box 公钥的传参顺序无关', () => {
    const agentBox = generateKeyPair();
    const client = clientIdentity();
    const secret = generateQrSecret();
    // 两端各自计算：agent 传自己的 box 公钥 + 收到的 client 身份；
    // client 传相同的 agent 公钥 + 自己持有的身份——结果必须一致
    const sas1 = deriveSas(agentBox.publicKey, client, secret);
    const sas2 = deriveSas(agentBox.publicKey, client, secret);
    expect(sas1).toEqual(sas2);
    expect(sas1.digits).toMatch(/^\d{6}$/);
    expect(sas1.emoji).toHaveLength(4);

    // 两把对称 box 公钥谁排前谁排后不影响结果（内部按字节序排序）
    const swapped = deriveSas(
      client.boxPubKey,
      { ...client, boxPubKey: agentBox.publicKey },
      secret,
    );
    expect(swapped).toEqual(sas1);
  });

  test('SAS：中间人替换 box 公钥可被发现', () => {
    const agentBox = generateKeyPair();
    const client = clientIdentity();
    const secret = generateQrSecret();
    const honest = deriveSas(agentBox.publicKey, client, secret);
    const attacked = deriveSas(
      agentBox.publicKey,
      { ...client, boxPubKey: generateKeyPair().publicKey },
      secret,
    );
    expect(sasEqual(honest, attacked)).toBe(false);
  });

  // ── 评审打回的信任根缺陷：SAS 必须覆盖登记凭据（signPubKey / deviceId）──

  test('对抗性：server 只替换 clientSignPubKey（box 公钥不变）→ 两端 SAS 不一致', () => {
    // 威胁模型 D1：不可信 server 可任意改明文 pair.* 帧。D8 背书登记落库的
    // 凭据是 Ed25519 signPubKey——若 SAS 不覆盖它，server 就能只换签名公钥、
    // 保留 box 公钥，两端 SAS 仍一致、用户比对通过，认证平面被劫持。
    const agentBox = generateKeyPair();
    const client = clientIdentity();
    const secret = generateQrSecret();

    // client 侧：用自己**真实持有**的 signPubKey 算
    const clientSide = deriveSas(agentBox.publicKey, client, secret);
    // agent 侧：用它从被篡改的 pair.begin **实际收到**的 signPubKey 算
    const agentSide = deriveSas(
      agentBox.publicKey,
      { ...client, signPubKey: generateSignKeyPair().publicKey },
      secret,
    );
    // 两端不一致 → 用户比对必然失败 → 攻击被挡在确认之前
    expect(sasEqual(clientSide, agentSide)).toBe(false);
  });

  test('对抗性：server 只替换 clientDeviceId → 两端 SAS 不一致', () => {
    // deviceId 是 server 事后拿去当登记主键的字段，同样必须被 SAS 绑定
    const agentBox = generateKeyPair();
    const client = clientIdentity({ deviceId: 'phone' });
    const secret = generateQrSecret();

    const clientSide = deriveSas(agentBox.publicKey, client, secret);
    const agentSide = deriveSas(
      agentBox.publicKey,
      { ...client, deviceId: 'attacker-device' },
      secret,
    );
    expect(sasEqual(clientSide, agentSide)).toBe(false);
  });

  test('对抗性：deviceId 变长且无分隔符注入歧义', () => {
    // deviceId 是变长字符串，若直接拼接会有 "a|b" vs "a"+"|b" 的歧义。
    // 定长哈希后每段固定长度，下面两组「拼起来看着一样」的输入必须不同。
    const agentBox = generateKeyPair();
    const sign = generateSignKeyPair().publicKey;
    const box = generateKeyPair().publicKey;
    const secret = generateQrSecret();
    const s1 = deriveSas(
      agentBox.publicKey,
      { boxPubKey: box, signPubKey: sign, deviceId: 'ab' },
      secret,
    );
    const s2 = deriveSas(
      agentBox.publicKey,
      { boxPubKey: box, signPubKey: sign, deviceId: 'a' },
      secret,
    );
    expect(sasEqual(s1, s2)).toBe(false);
  });

  test('SAS：同一身份、不同 qrSecret 得到不同短串', () => {
    const agentBox = generateKeyPair();
    const client = clientIdentity();
    const sas1 = deriveSas(agentBox.publicKey, client, generateQrSecret());
    const sas2 = deriveSas(agentBox.publicKey, client, generateQrSecret());
    expect(sasEqual(sas1, sas2)).toBe(false);
  });

  test('SAS：不知道 qrSecret 无法预测——猜错 key 即得到不同结果', () => {
    const agentBox = generateKeyPair();
    const client = clientIdentity();
    const real = generateQrSecret();
    const truth = deriveSas(agentBox.publicKey, client, real);
    // 攻击者知道全部公开字段，但只能瞎猜 key；抽样 32 次全部对不上
    let collisions = 0;
    for (let i = 0; i < 32; i++) {
      if (sasEqual(deriveSas(agentBox.publicKey, client, generateQrSecret()), truth)) {
        collisions++;
      }
    }
    expect(collisions).toBe(0);
  });
});

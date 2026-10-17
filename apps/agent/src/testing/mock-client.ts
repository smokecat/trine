/**
 * 测试用模拟 client：只用 @trine/core 的原语，不依赖 apps/web。
 *
 * 走的是真实 client 该走的路：pairing 角色免认证接入 → 扫码算 SAS → pair.begin
 * → 等 confirm → 挑战-应答换 token → 以 client 角色接入 → 收发 E2E 密文。
 * net/e2e.test.ts 与 app/ 的集成测试共用；client-demo.ts 是它的交互式版本。
 */
import {
  authChallengeMessage,
  decodePairingPayload,
  deriveSas,
  generateKeyPair,
  generateSignKeyPair,
  openJson,
  sealJson,
  signDetached,
  type BoxKeyPair,
  type Sas,
  type SignKeyPair,
} from '@trine/core/crypto';
import {
  assertEnvelopeBinding,
  AgentToClientEventSchema,
  decodeTransportFrame,
  encodeTransportFrame,
  type AgentToClientEvent,
  type ClientToAgentEvent,
  type TransportFrame,
} from '@trine/core';

export class MockClient {
  readonly deviceId: string;
  readonly signKeys: SignKeyPair = generateSignKeyPair();
  readonly boxKeys: BoxKeyPair = generateKeyPair();
  readonly received: TransportFrame[] = [];
  /** 配对时从 QR 里解出来的 agent X25519 公钥 */
  agentBoxPubKey = '';
  private ws: WebSocket | null = null;
  private readonly waiters: {
    match: (f: TransportFrame) => boolean;
    resolve: (f: TransportFrame) => void;
  }[] = [];

  constructor(
    deviceId: string,
    private readonly port: number,
  ) {
    this.deviceId = deviceId;
  }

  /** 以 role:'pairing' 免认证接入（配对前唯一能走的门） */
  async connectForPairing(): Promise<void> {
    await this.#open(
      encodeTransportFrame({
        type: 'hello',
        v: 1,
        role: 'pairing',
        deviceId: this.deviceId,
      }),
    );
  }

  /** 配对完成后：换 token 并以正式 client 角色接入 */
  async connectAsClient(): Promise<void> {
    const token = await this.#exchangeToken();
    await this.#open(
      encodeTransportFrame({
        type: 'hello',
        v: 1,
        role: 'client',
        deviceId: this.deviceId,
        authToken: token,
      }),
    );
  }

  /** 挑战-应答换 token——只有已被登记的设备才走得通 */
  async #exchangeToken(): Promise<string> {
    const base = `http://127.0.0.1:${this.port}`;
    const chal = await fetch(`${base}/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: this.deviceId }),
    });
    if (!chal.ok) throw new Error(`challenge 失败：HTTP ${chal.status}`);
    const { challenge } = (await chal.json()) as { challenge: string };
    const res = await fetch(`${base}/auth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: this.deviceId,
        challenge,
        signature: signDetached(
          authChallengeMessage(this.deviceId, challenge),
          this.signKeys.secretKey,
        ),
      }),
    });
    if (!res.ok) throw new Error(`verify 失败：HTTP ${res.status}`);
    return ((await res.json()) as { token: string }).token;
  }

  async #open(hello: string): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`);
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const frame = decodeTransportFrame(String(ev.data));
      this.received.push(frame);
      const idx = this.waiters.findIndex((w) => w.match(frame));
      if (idx >= 0) this.waiters.splice(idx, 1)[0]!.resolve(frame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error')), {
        once: true,
      });
    });
    ws.send(hello);
  }

  /** 扫码：解出 agent 公钥与配对材料，算出自己这一侧的 SAS */
  scan(payload: string): { pairingToken: string; qrSecret: string; sas: Sas } {
    const decoded = decodePairingPayload(payload);
    this.agentBoxPubKey = decoded.agentPubKey;
    return {
      pairingToken: decoded.pairingToken,
      qrSecret: decoded.qrSecret,
      // client 侧用自己真实持有的整份身份算 SAS（box + sign + deviceId）
      sas: deriveSas(
        decoded.agentPubKey,
        {
          boxPubKey: this.boxKeys.publicKey,
          signPubKey: this.signKeys.publicKey,
          deviceId: this.deviceId,
        },
        decoded.qrSecret,
      ),
    };
  }

  sendPairBegin(pairingToken: string): void {
    this.send({
      type: 'pair.begin',
      pairingToken,
      clientPubKey: this.boxKeys.publicKey,
      clientSignPubKey: this.signKeys.publicKey,
      clientDeviceId: this.deviceId,
    });
  }

  /** 发一条 E2E 密文给 agent */
  sendEvent(event: ClientToAgentEvent, machineId = 'mbp'): void {
    const box = sealJson(event, this.agentBoxPubKey, this.boxKeys.secretKey);
    this.send({
      type: 'relay',
      machineId,
      ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
      seq: event.seq,
      nonce: box.nonce,
      ciphertext: box.ciphertext,
    });
  }

  /** 解一条来自 agent 的密文（走与 agent 侧对称的三步校验） */
  openRelay(frame: Extract<TransportFrame, { type: 'relay' }>): AgentToClientEvent {
    const value = openJson(
      { nonce: frame.nonce, ciphertext: frame.ciphertext },
      this.agentBoxPubKey,
      this.boxKeys.secretKey,
    );
    const event = AgentToClientEventSchema.parse(value);
    assertEnvelopeBinding(
      event,
      { sessionId: frame.sessionId, seq: frame.seq },
      // client 只接受 agent → client 方向
      'a2c',
    );
    return event;
  }

  send(frame: TransportFrame): void {
    this.ws?.send(encodeTransportFrame(frame));
  }

  wait<K extends TransportFrame['type']>(
    type: K,
    timeoutMs = 3000,
  ): Promise<Extract<TransportFrame, { type: K }>> {
    const match = (f: TransportFrame) => f.type === type;
    const already = this.received.find(match);
    if (already) return Promise.resolve(already as never);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`client 等待 ${type} 帧超时`)),
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

  ofType<K extends TransportFrame['type']>(
    type: K,
  ): Extract<TransportFrame, { type: K }>[] {
    return this.received.filter((f) => f.type === type) as never;
  }

  close(): void {
    this.ws?.close();
  }

  /** 底层 socket（测试里拿关闭码用） */
  get socket(): WebSocket | null {
    return this.ws;
  }
}


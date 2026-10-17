/**
 * 代理端网络层的装配：身份 + 认证 + WS + 配对 + E2E 封套串成一个对象。
 *
 * 这一层是 `apps/agent/src/bridge`（Claude SDK 桥接，产出明文事件）与
 * 服务端之间的那一段。分工刻意保持单向：
 * - bridge 只管把 SDK 消息翻译成明文 `AgentToClientEvent`，不知道有网络；
 * - 本层只管把明文事件加密发出去、把入站密文解开交给回调，不知道 SDK。
 *
 * 两者的接缝就是 `publish()`（出站）与 `onEvent`（入站）。bridge 的
 * `EventSink` 形状（`{ event, scope }`）可以直接接到 `publish` 上。
 *
 * ## 边界
 *
 * 本层提供完整可用的收发能力与配对能力，但**不引用任何 bridge 模块**——
 * 两层的接线在 `apps/agent/src/app/`（app.ts 装配、router.ts 入站路由、
 * outbox.ts 出站自愈、state.ts 游标持久化），本层只暴露它们需要的钩子：
 * `onOpen` / `onEvent` / `onTransportFrame` / `publish` / `publishTo` / `cursors`。
 */
import type {
  AgentToClientEvent,
  ClientToAgentEvent,
  PushHint,
  RelayFrame,
  TransportFrame,
} from '@trine/core';
import { sodiumReady } from '@trine/core/crypto';
import { AuthClient, AuthClientError, assertEnrollmentUrl, httpBase, wsEndpoint } from '@trine/core/net';
import {
  openInbound,
  sealForAll,
  sealForRecipient,
  SeqCursors,
  type OpenFailure,
} from './envelope.ts';
import {
  assertIdentityUsable,
  loadOrCreateIdentity,
  type AgentIdentity,
} from './identity.ts';
import { PairingManager, type PairingSession } from './pairing.ts';
import { RecipientBookStore, type Recipient } from './recipients.ts';
import { WsClient, type BackoffOptions, type SocketLike } from './ws-client.ts';

export interface AgentNodeOptions {
  /**
   * 服务端根地址。必须是 `https://` 或 `wss://`——带外 QR 里会带上它，
   * 明文 ws/http 会让中间人直接替换 pair.begin 里的公钥（core 会校验）。
   */
  serverUrl: string;
  /** 身份文件路径，默认 `~/.trine/identity.json` */
  identityPath?: string;
  /** 名册文件路径，默认 `~/.trine/recipients.json` */
  recipientsPath?: string;
  /** 首次生成身份时用的展示名 */
  name?: string;
  /** 首次生成身份时指定 machineId（测试/多实例用） */
  machineId?: string;

  /** 入站事件（已解密 + schema + 信封绑定校验） */
  onEvent?: (event: ClientToAgentEvent, sender: Recipient) => void;
  /** 入站帧被丢弃时的归因回调（分类计数/告警用） */
  onInboundDropped?: (failure: OpenFailure, detail: string) => void;
  /** 收到 pair.begin 且 token 对得上——上层据此展示 SAS 等用户确认 */
  onPairingRequest?: (session: PairingSession) => void;
  /** 非 relay/pair 的 transport 帧（machine.status、relay.reject 等） */
  onTransportFrame?: (frame: TransportFrame) => void;
  /**
   * 每次（重）连上服务端并完成 hello 后触发——在本层自己的补发请求
   * **之后**调用。接线层据此广播 machine.info、重放会话状态等。
   */
  onOpen?: () => void;

  /** Called once only for an unregistered identity; secret is not retained. */
  getInvitation?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  createSocket?: (url: string) => SocketLike;
  backoff?: BackoffOptions;
  now?: () => number;
  log?: (line: string) => void;
}

export class AgentNode {
  #ws: WsClient | null = null;
  readonly #cursors = new SeqCursors();

  private constructor(
    readonly identity: AgentIdentity,
    readonly recipients: RecipientBookStore,
    readonly pairing: PairingManager,
    readonly auth: AuthClient,
    private readonly options: AgentNodeOptions,
    private readonly log: (line: string) => void,
  ) {}

  /**
   * 装配：读/建身份 → 读名册 → 组装认证与配对。
   *
   * 刻意不在这里建连——`create()` 只做本地准备，能不能连上服务端是另一回事，
   * 分开之后「身份坏了」和「网络不通」不会混成同一个错误。
   */
  static async create(options: AgentNodeOptions): Promise<AgentNode> {
    await sodiumReady();
    const { identity } = await loadOrCreateIdentity({
      ...(options.identityPath !== undefined ? { path: options.identityPath } : {}),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.machineId !== undefined ? { machineId: options.machineId } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    assertIdentityUsable(identity);

    const recipients = await RecipientBookStore.load(options.recipientsPath);
    const log = options.log ?? (() => {});

    const pairing = new PairingManager({
      agentBoxPubKey: identity.box.publicKey,
      recipients,
      serverUrl: options.serverUrl,
      // QR 带上本机 machineId：client 配对成功后不必再靠「首条在线
      // machine.status」去猜自己配的是哪台机器（多机场景那会猜错）
      machineId: identity.machineId,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });

    const auth = new AuthClient({
      baseUrl: httpBase(options.serverUrl),
      deviceId: identity.machineId,
      signKeys: identity.sign,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });

    return new AgentNode(identity, recipients, pairing, auth, options, log);
  }

  get machineId(): string {
    return this.identity.machineId;
  }

  /**
   * 入站 seq 游标（按发送方 × 会话）。暴露出来是为了让接线层持久化它：
   * 游标本身是内存态，进程重启后不补发、重放防护清零，都要靠上层在
   * 启动时 `restore()`、退出/定期 `snapshot()`。
   */
  get cursors(): SeqCursors {
    return this.#cursors;
  }

  /** 已连上服务端且完成 hello */
  get online(): boolean {
    return this.#ws?.state === 'open';
  }

  /** Authenticate before starting retries, so enrollment failures are actionable. */
  async connect(): Promise<void> {
    const wsUrl = wsEndpoint(this.options.serverUrl);
    let initialToken;
    try {
      initialToken = await this.auth.authenticate({ signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      if (!(error instanceof AuthClientError) || error.reason !== 'unknown_device') throw error;
      if (!this.options.getInvitation) {
        throw new Error('此身份尚未注册：请由 relay 管理员签发邀请，并使用 --enroll 启动；已有设备请检查 --home 与 --server。');
      }
      assertEnrollmentUrl(httpBase(this.options.serverUrl));
      const invitation = await this.options.getInvitation();
      try {
        await this.auth.register('agent', { invitation, signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        // Server may have committed before the response was lost. Prove ownership
        // rather than burning another invitation or storing a local receipt.
        try { initialToken = await this.auth.authenticate({ signal: AbortSignal.timeout(15_000) }); }
        catch { throw error; }
      }
      initialToken ??= await this.auth.authenticate({ signal: AbortSignal.timeout(15_000) });
    }
    const ws = new WsClient({
      url: wsUrl,
      deviceId: this.identity.machineId,
      token: initialToken.token,
      refreshToken: async () => (await this.auth.authenticate({ signal: AbortSignal.timeout(15_000) })).token,
      onFrame: (frame) => this.#onFrame(frame),
      onOpen: () => this.#onOpen(),
      onError: (err) => this.log(`[net] 连接出错：${String(err)}`),
      ...(this.options.createSocket !== undefined
        ? { createSocket: this.options.createSocket }
        : {}),
      ...(this.options.backoff !== undefined ? { backoff: this.options.backoff } : {}),
      log: this.log,
    });
    this.#ws = ws;
    await ws.start();
  }

  /** 主动断连，不再重连；resolve 于 socket 真正 close（或 WsClient 的等待上限） */
  disconnect(): Promise<void> {
    const ws = this.#ws;
    this.#ws = null;
    return ws?.stop() ?? Promise.resolve();
  }

  /**
   * 出站：一个明文事件 → 逐收件人 seal → 发若干条 relay 帧。
   *
   * 返回实际发出去的帧数。收件人为空（还没配对过任何设备）时返回 0——
   * 这不是错误，是全新 agent 的正常状态。
   *
   * N 个收件人 → N 条帧，**同一个 seq**、不同 recipientDeviceId。收件人
   * 是帧坐标的一部分（transport.ts / server schema v2），服务端据此定向
   * 投递、按设备分子流补发；而 seq 与逻辑事件保持一一对应，client 侧的
   * 单调游标才有意义。
   */
  publish(event: AgentToClientEvent, pushHint?: PushHint): number {
    const sealed = sealForAll(event, this.recipients.list(), {
      machineId: this.identity.machineId,
      boxSecretKey: this.identity.box.secretKey,
      ...(pushHint !== undefined ? { pushHint } : {}),
    });
    let sent = 0;
    for (const item of sealed) {
      if (this.#ws?.send(item.frame)) sent++;
    }
    return sent;
  }

  /**
   * 出站（定向）：只封给**一个**收件人并发出。
   *
   * 给 relay.reject 自愈重发用：被拒的是某一个收件人子流上的帧，其他收件人
   * 早已接受了原帧，全员重发会让它们收到重复事件（seq 不同、内容相同）。
   * 收件人不在名册里返回 false。
   */
  publishTo(
    recipientDeviceId: string,
    event: AgentToClientEvent,
    pushHint?: PushHint,
  ): boolean {
    const recipient = this.recipients.get(recipientDeviceId);
    if (recipient === null) return false;
    const { frame } = sealForRecipient(event, recipient, {
      machineId: this.identity.machineId,
      boxSecretKey: this.identity.box.secretKey,
      ...(pushHint !== undefined ? { pushHint } : {}),
    });
    return this.#ws?.send(frame) ?? false;
  }

  /** 发一条明文 transport 帧（pair.confirm / sync.request 等） */
  sendFrame(frame: TransportFrame): boolean {
    return this.#ws?.send(frame) ?? false;
  }

  // -------------------------------------------------------------------------
  // 配对
  // -------------------------------------------------------------------------

  /** 生成一次配对材料（QR 文本在 `session.payload`） */
  startPairing(): PairingSession {
    return this.pairing.begin();
  }

  /**
   * 用户比对 SAS 一致后确认：写名册 + 发 pair.confirm。
   *
   * 发不出去（连接断了）时**名册已经写了**——这是有意的取舍：名册多一条
   * 用不上的记录无害（对端连不上就是没配对成功，重来一次覆盖即可），
   * 而反过来「发出去了但没写名册」会让 client 接入后被当成陌生人。
   */
  async confirmPairing(pairingToken: string): Promise<boolean> {
    const { frame, recipient } = await this.pairing.confirm(pairingToken);
    const sent = this.sendFrame(frame);
    this.log(
      `[pair] 已确认设备 ${recipient.deviceId}（confirm ${sent ? '已发出' : '发送失败，请重试'}）`,
    );
    return sent;
  }

  /** 中止配对：核销 token 并告知对端 */
  abortPairing(pairingToken: string, reason?: string): boolean {
    const frame = this.pairing.abort(pairingToken, reason);
    if (!frame) return false;
    return this.sendFrame(frame);
  }

  // -------------------------------------------------------------------------
  // 入站
  // -------------------------------------------------------------------------

  #onOpen(): void {
    this.log(`[net] 已接入服务端 machine=${this.identity.machineId}`);
    // 重连后的补发请求：agent 要的是 client 发来的帧（c2a）。
    //
    // **逐流**各发一条 sync.request：c2a 的每条流（机器级 + 每个会话）在服务端
    // 是各自独立的 seq 序列，sinceSeq 只对自己那条流有意义，一条机器级请求
    // 补不回会话级的帧。早先这里只发机器级那一条，等于会话级 c2a（input.send
    // 全在这）在传输中丢了就永久丢——那才是 client 最常发的东西。
    //
    // 每条流内部，c2a 是**单一共享流**（没有发送方维度），补发也不按发送方
    // 过滤——所以每条流只发**一条**，sinceSeq 取该流全部发送方游标的最小值
    // （minLastSeen）。若按每个发送方各发一条，服务端每条都会把整条流重放一遍。
    //
    // 只在**确有过往来**（min > 0）时发：sinceSeq=0 会把整个留存窗口重放一遍。
    // 「有哪些流、各到哪」来自游标；游标由接线层在启动时从磁盘 restore
    // （见 `cursors` getter），进程内重连则天然正确。
    for (const sessionId of this.#cursors.sessionIds()) {
      const sinceSeq = this.#cursors.minLastSeen(sessionId);
      if (sinceSeq <= 0) continue;
      this.sendFrame({
        type: 'sync.request',
        machineId: this.identity.machineId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        sinceSeq,
      });
    }
    this.options.onOpen?.();
  }

  #onFrame(frame: TransportFrame): void {
    switch (frame.type) {
      case 'relay':
        this.#onRelay(frame);
        return;
      case 'pair.begin':
        this.#onPairBegin(frame);
        return;
      case 'pair.abort':
        // 对端放弃了：核销掉本地会话（核销路径 2 的对端触发版）
        this.pairing.abort(frame.pairingToken, 'aborted by peer');
        return;
      case 'pair.confirm':
        // agent 是发 confirm 的那一方，收到只可能是服务端把自己的帧回灌了
        return;
      default:
        this.options.onTransportFrame?.(frame);
    }
  }

  #onRelay(frame: RelayFrame): void {
    const result = openInbound(
      frame,
      this.recipients.list(),
      this.identity.box.secretKey,
    );
    if (!result.ok) {
      this.options.onInboundDropped?.(result.failure, result.detail);
      this.log(`[net] 丢弃入站帧：${result.failure} ${result.detail}`);
      return;
    }
    // seq 单调：assertEnvelopeBinding 挡不住「原样重放一条旧帧」，
    // 那要靠接收方自己的游标（见 envelope.ts 的 SeqCursors）
    if (
      !this.#cursors.accept(result.sender.deviceId, frame.sessionId, frame.seq)
    ) {
      this.options.onInboundDropped?.(
        'binding_invalid',
        `seq ${frame.seq} 不高于已见最大值，疑似重放`,
      );
      return;
    }
    this.options.onEvent?.(result.event, result.sender);
  }

  #onPairBegin(frame: Extract<TransportFrame, { type: 'pair.begin' }>): void {
    const outcome = this.pairing.onBegin(frame);
    if (outcome.kind === 'awaiting_confirm') {
      // 上层负责展示 SAS 并拿到用户的显式确认——本层绝不自动确认
      this.options.onPairingRequest?.(outcome.session);
      return;
    }
    if (outcome.kind === 'rejected') {
      this.log(`[pair] 拒绝配对请求：${outcome.reason}`);
    }
    // ignored：token 不是发给本机的。服务端向全体 agent 广播 pair.begin
    // （它不知道 token 属于谁），所以这是完全正常的情况，静默丢弃
  }
}

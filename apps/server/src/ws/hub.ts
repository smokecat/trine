/**
 * 中转核心：帧的接收、校验、路由、落库、补发、排队。
 *
 * ## 零知识边界
 *
 * 本文件处理的每一帧都先过 `TransportFrameSchema`（core 的唯一入站校验口），
 * 之后只碰 machineId / sessionId / seq / pushHint 这些路由字段。
 * `ciphertext` / `nonce` 一路原样存转，从不解析、不入日志、不进错误消息。
 *
 * ## 帧的方向与路由
 *
 * - client → server：`relay`（c2a，目标 agent）、`sync.request`、
 *   `park.recall`、`pair.*`
 * - agent → server：`relay`（a2c，广播给全部在线 client）、`pair.*`
 * - server → client：`machine.status`、`input.parked`、`parked.count`、
 *   补发的 relay 帧
 *
 * 方向由**连接的已认证角色**决定，不由帧里的任何字段决定——否则 client
 * 声称自己是 agent 就能伪造 agent 的回复。
 */
import {
  encodeTransportFrame,
  TransportFrameSchema,
  type RelayRejectReason,
  type TransportFrame,
} from '@trine/core/protocol';
import type { AuthService } from '../auth/index.ts';
import type { ServerConfig } from '../config.ts';
import type { PushDispatcher } from '../push/index.ts';
import { ParkedQueue } from '../store/parked.ts';
import type { FrameDir, Store } from '../store/index.ts';
import type {
  Conn,
  ConnectionRegistry,
  PairingConn,
  PairPeer,
  Sendable,
} from './registry.ts';

/**
 * pair.* 帧的每连接频率上限。配对是人工动作：扫码、比对 SAS、点确认，
 * 一次流程也就三五帧，一分钟内 20 帧已经宽松到不可能误伤。
 */
export const PAIR_RATE_LIMIT = { windowMs: 60_000, maxFrames: 20 } as const;

/**
 * `pair.begin` 记录在服务端内存里的存活时长。
 *
 * 这不是 pairingToken 的权威 TTL——权威 TTL 在 agent 手里（token 是 agent
 * 生成的，服务端从没见过它的签发时刻）。本值只管服务端这份「begin 缓存」
 * 活多久：它的唯一用途是给随后到来的 `pair.confirm` 做一致性比对，
 * 人工比对 SAS 再慢也用不了 10 分钟，超时即丢，缓存不会无界增长。
 */
export const PAIR_BEGIN_TTL_MS = 10 * 60 * 1000;

/**
 * begin 缓存的条目上限。配对是个位数频率的人工动作，正常永远碰不到；
 * 但 `pair.begin` 来自免认证的 pairing 连接，没有上限就是一个内存放大器
 * （频率限流只管单连接，攻击者可以开很多条连接）。满了就先扫过期，
 * 仍满则拒收新的 begin——拒收比无界增长安全。
 */
export const PAIR_BEGIN_MAX_ENTRIES = 256;

/** 处理一帧的结果，供测试与日志观察（不含任何密文） */
export type HandleOutcome =
  | { kind: 'relayed'; dir: FrameDir; targets: number }
  | { kind: 'parked'; seq: number }
  | { kind: 'duplicate' }
  | { kind: 'resent'; count: number }
  | { kind: 'recalled'; effective: boolean }
  | { kind: 'pair_forwarded'; targets: number }
  /** pair.confirm 通过背书校验、设备已登记并把 confirm 转给了 client */
  | { kind: 'pair_registered'; deviceId: string; targets: number }
  | { kind: 'ignored'; reason: string }
  | { kind: 'rejected'; reason: string };

export interface HubDeps<T extends Sendable = Sendable> {
  store: Store;
  registry: ConnectionRegistry<T>;
  config: ServerConfig;
  /**
   * 背书式登记要用（D8）：agent 发来合规的 pair.confirm 时，由 hub 直接
   * 调 `auth.register(..., 'pairing')` 把 client 设备登记进来。
   * 可选是为了让既有的纯中转测试不必都造一个 AuthService——省略时
   * pair.confirm 退化为纯转发**且不登记任何设备**（见 handlePairConfirm）。
   */
  auth?: AuthService;
  push?: PushDispatcher;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * 服务端为一次配对缓存的 `pair.begin` 记录。
 *
 * 只存比对所需的三样东西——服务端在配对里的角色仅是「记下 client 自报了
 * 什么，等 agent 复述时逐字比对」，不参与也无从参与密钥协商（qrSecret
 * 永不到服务端）。
 */
interface PairBeginRecord {
  clientDeviceId: string;
  clientSignPubKey: string;
  /** 到点即丢，见 PAIR_BEGIN_TTL_MS */
  expiresAt: number;
}

export class RelayHub<T extends Sendable = Sendable> {
  readonly parked: ParkedQueue;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /**
   * pairingToken → begin 记录。内存态，进程重启即清空——配对是几十秒内
   * 完成的人工流程，重启后重新扫码即可，不值得落库。
   */
  private readonly pairBegins = new Map<string, PairBeginRecord>();

  constructor(private readonly deps: HubDeps<T>) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => {});
    this.parked = new ParkedQueue(
      deps.store,
      deps.config.parkedTtlMs,
      deps.config.parkedMaxPerMachine,
    );
  }

  // -------------------------------------------------------------------------
  // 入站分发
  // -------------------------------------------------------------------------

  /**
   * 处理一条已认证连接发来的原始文本帧。
   * 解析失败一律拒绝——不猜测、不修复畸形输入。
   */
  handleRaw(conn: Conn<T>, raw: string): HandleOutcome {
    let frame: TransportFrame;
    try {
      frame = TransportFrameSchema.parse(JSON.parse(raw));
    } catch {
      // 刻意不把 raw 或 zod 的 received 值写进日志：畸形帧里也可能带密文
      return { kind: 'rejected', reason: 'malformed_frame' };
    }
    conn.lastSeenAt = this.now();
    conn.pendingPings = 0;
    return this.handleFrame(conn, frame);
  }

  handleFrame(conn: Conn<T>, frame: TransportFrame): HandleOutcome {
    switch (frame.type) {
      case 'hello':
        // 握手在连接建立时已完成，重复的 hello 无意义但也无害
        return { kind: 'ignored', reason: 'duplicate_hello' };
      case 'relay':
        return this.handleRelay(conn, frame);
      case 'sync.request':
        return this.handleSync(conn, frame);
      case 'park.recall':
        return this.handleRecall(conn, frame);
      case 'pair.begin':
      case 'pair.confirm':
      case 'pair.abort':
        return this.handlePair(conn, frame);
      // 以下都是 server → client 单向帧，收到即视为对端行为异常
      case 'sync.done':
      case 'machine.status':
      case 'input.parked':
      case 'parked.count':
      case 'park.expired':
      case 'relay.reject':
        return { kind: 'rejected', reason: `server_only_frame:${frame.type}` };
    }
  }

  // -------------------------------------------------------------------------
  // relay 中转
  // -------------------------------------------------------------------------

  private handleRelay(
    conn: Conn<T>,
    frame: Extract<TransportFrame, { type: 'relay' }>,
  ): HandleOutcome {
    const { store } = this.deps;
    const now = this.now();

    // 方向由已认证角色定，不看帧内容
    const dir: FrameDir = conn.role === 'agent' ? 'a2c' : 'c2a';

    if (conn.role === 'agent' && frame.machineId !== conn.machineId) {
      // agent 只能以自己的名义发帧，否则可冒充其他机器
      return { kind: 'rejected', reason: 'machine_id_mismatch' };
    }
    if (conn.role === 'client' && frame.pushHint !== undefined) {
      // pushHint 只在 agent→server 方向有效（transport.ts 注释）；
      // 允许 client 带上等于把推送触发权交给了任意 client
      return { kind: 'rejected', reason: 'push_hint_from_client' };
    }

    // recipientDeviceId 的方向约定（transport.ts）：a2c 必带、c2a 省略。
    // 在这里硬性拦住而不是宽容处理——两个方向都放行的话，帧的坐标就有了
    // 两种形状，去重与补发得处处分支判断，那是 bug 的温床。
    if (dir === 'a2c' && frame.recipientDeviceId === undefined) {
      return { kind: 'rejected', reason: 'recipient_required' };
    }
    if (dir === 'c2a' && frame.recipientDeviceId !== undefined) {
      // c2a 的收件人天然是该 machineId 的 agent，写出来只可能写歪
      return { kind: 'rejected', reason: 'recipient_not_allowed' };
    }

    const appended = store.appendRelayFrame({
      machineId: frame.machineId,
      sessionId: frame.sessionId,
      recipientDeviceId: frame.recipientDeviceId,
      seq: frame.seq,
      dir,
      nonce: frame.nonce,
      ciphertext: frame.ciphertext,
      pushHint: frame.pushHint ?? null,
      createdAt: now,
    });

    if (!appended.ok) {
      this.log(
        `[relay] seq 拒绝(${appended.reason}) machine=${frame.machineId} stream=${
          frame.sessionId ?? '(machine)'
        } dir=${dir} seq=${frame.seq}`,
      );
      // 回执给发起方：不然这帧就是静默蒸发，两边都不会察觉。
      // seq 类拒绝把高水位一并带回去，发送方据此跳号重发（自愈），
      // 不必猜自己该从哪个 seq 续
      this.sendRelayReject(
        conn,
        frame,
        appended.reason,
        'expectedAfter' in appended ? appended.expectedAfter : undefined,
      );
      return { kind: 'rejected', reason: appended.reason };
    }

    // 超出留存上限就裁掉最旧的（保留窗口 = 断线补发能力的上限）。
    // 按子流裁剪（含收件人）：混在一起算 keep 会让每台设备的实际留存
    // 窗口缩到 1/N，断线补发能力随配对设备数悄悄变差
    if (frame.seq % 64 === 0) {
      store.trimStream(
        frame.machineId,
        frame.sessionId,
        dir,
        this.deps.config.relayMaxPerStream,
        frame.recipientDeviceId,
      );
    }

    if (appended.duplicate) {
      // 复推是常态（PROTOCOL-REQUIREMENTS §5 全链路幂等），静默丢弃即可
      return { kind: 'duplicate' };
    }

    if (dir === 'a2c') return this.routeToRecipient(frame, now);
    return this.forwardToAgent(conn, frame, now);
  }

  /**
   * agent → **指定收件人设备**的全部在线连接。
   *
   * 这里从「广播给所有 client」改成了定向投递（矩阵式配对的必然结果）：
   * 每份密文只有 `recipientDeviceId` 那台设备解得开，发给别人纯属浪费带宽，
   * 而且没有理由把一份别人的密文推到不相干的设备上——它虽然解不开，
   * 但零知识的取向是「拿不到的东西就别送过去」。
   *
   * 多设备同步仍然成立，只是实现方式变了：agent 对每个收件人各发一帧，
   * N 台设备就有 N 帧，各自定向送达。
   *
   * 同一台设备可能有多条连接（多标签页、刚重连时的新旧连接并存），
   * 所以这里遍历全部 client 连接按 deviceId 匹配，而不是只找第一条。
   * 一条都没匹配上（设备离线）就只落库，等它重连后 sync.request 补发。
   */
  private routeToRecipient(
    frame: Extract<TransportFrame, { type: 'relay' }>,
    now: number,
  ): HandleOutcome {
    const payload = encodeTransportFrame(frame);
    let targets = 0;
    for (const client of this.deps.registry.allClients()) {
      if (client.deviceId !== frame.recipientDeviceId) continue;
      if (this.send(client, payload)) targets++;
    }

    // 推送触发：pushHint 是明文，且只含事件类型。
    // dispatch() 同步返回、内部 fire-and-forget——帧处理路径**不等推送**，
    // 一个挂掉的推送端点绝不能拖住中转。sessionId 只做去抖分桶，
    // 不进推送内容（push/types.ts 的脱敏约束）。
    if (frame.pushHint) {
      this.deps.push?.dispatch({
        machineId: frame.machineId,
        ...(frame.sessionId !== undefined
          ? { sessionId: frame.sessionId }
          : {}),
        hint: frame.pushHint,
        at: now,
      });
    }
    return { kind: 'relayed', dir: 'a2c', targets };
  }

  /** client → 目标 agent；agent 离线则排队 + 回执 input.parked */
  private forwardToAgent(
    conn: Conn<T>,
    frame: Extract<TransportFrame, { type: 'relay' }>,
    now: number,
  ): HandleOutcome {
    const agent = this.deps.registry.agent(frame.machineId);
    if (agent && this.send(agent, encodeTransportFrame(frame))) {
      return { kind: 'relayed', dir: 'c2a', targets: 1 };
    }

    // agent 离线：只有会话级帧才排队。
    // 机器级帧（machine.info/cwd.* 请求）都是「问当前状态」，隔一天再送达
    // 毫无意义，且 transport.ts 的 input.parked 回执要求带 sessionId。
    if (frame.sessionId === undefined) {
      return { kind: 'ignored', reason: 'agent_offline_machine_frame' };
    }

    const result = this.parked.park(
      frame.machineId,
      frame.sessionId,
      frame.seq,
      now,
    );
    if (!result.row) {
      this.log(
        `[park] 队列超限拒绝 machine=${frame.machineId} seq=${frame.seq}`,
      );
      // 同样要回执：client 必须知道这条没能排上队
      this.sendRelayReject(conn, frame, 'parked_quota_exceeded');
      return { kind: 'rejected', reason: 'parked_quota_exceeded' };
    }

    // 回执给发送方；重复排队（幂等命中）也回执，client 重连后要能重新拿到
    this.send(
      conn,
      encodeTransportFrame({
        type: 'input.parked',
        machineId: frame.machineId,
        sessionId: frame.sessionId,
        seq: frame.seq,
        expiresAt: result.row.expiresAt,
      }),
    );
    this.broadcastParkedCount(frame.machineId, now);
    return { kind: 'parked', seq: frame.seq };
  }

  // -------------------------------------------------------------------------
  // 断线补发
  // -------------------------------------------------------------------------

  /**
   * sync.request：按 sinceSeq 补发。
   *
   * 补发的方向取决于请求方：client 要的是 agent 发来的帧（a2c），
   * agent 要的是 client 发来的帧（c2a）。
   *
   * ## a2c 补发按请求连接的**已认证 deviceId** 过滤
   *
   * 矩阵式配对下 a2c 帧按收件人分成了多条子流，一台 client 只该拿回自己
   * 那条。别人的密文它解不开（crypto_box 点对点），所以这不是保密性问题，
   * 但仍然要过滤，两条理由：
   * - 一台设备重连一次就要拉走 N 倍的数据，N = 已配对设备数；
   * - client 侧的 seq 单调游标会被别人的帧打乱——它按信封 seq 推进游标，
   *   而各子流的 seq 是各自独立的序列。
   *
   * 过滤用的是 `conn.deviceId`（token 换回的身份），**不是**帧里的任何
   * 自报字段：sync.request 上没有收件人字段，也刻意不加——加了就等于让
   * client 自己声明「我要谁的帧」。
   */
  private handleSync(
    conn: Conn<T>,
    frame: Extract<TransportFrame, { type: 'sync.request' }>,
  ): HandleOutcome {
    const dir: FrameDir = conn.role === 'client' ? 'a2c' : 'c2a';
    if (conn.role === 'agent' && frame.machineId !== conn.machineId) {
      return { kind: 'rejected', reason: 'machine_id_mismatch' };
    }
    // c2a 没有收件人维度，传 undefined 表示不按收件人过滤
    const recipientFilter = dir === 'a2c' ? conn.deviceId : undefined;

    // 一直取到取空为止：framesSince 单次有 limit，积压超过 limit 时
    // 只发一批会留下缺口，而 client 并没有「收到不足就再问一次」的义务
    // ——那是个没写进协议的约定，不能让正确性依赖它。
    let sent = 0;
    let cursor = frame.sinceSeq;
    let drained = false;
    while (!drained) {
      const batch = this.deps.store.framesSince(
        frame.machineId,
        frame.sessionId,
        dir,
        cursor,
        undefined,
        recipientFilter,
      );
      if (batch.length === 0) break;

      for (const stored of batch) {
        const ok = this.send(
          conn,
          encodeTransportFrame({
            type: 'relay',
            machineId: stored.machineId,
            ...(stored.sessionId !== undefined
              ? { sessionId: stored.sessionId }
              : {}),
            ...(stored.recipientDeviceId !== undefined
              ? { recipientDeviceId: stored.recipientDeviceId }
              : {}),
            seq: stored.seq,
            nonce: stored.nonce,
            ciphertext: stored.ciphertext,
            // 补发不重复触发推送，但字段照原样带回（client 侧不依赖它）
            ...(stored.pushHint
              ? { pushHint: stored.pushHint as 'run_done' }
              : {}),
          }),
        );
        if (!ok) {
          // 连接断了，后面的发出去也是白发
          drained = true;
          break;
        }
        sent++;
        cursor = stored.seq;
      }
    }

    this.deps.store.setCursor(
      conn.deviceId,
      frame.machineId,
      frame.sessionId,
      frame.sinceSeq,
      this.now(),
    );

    // 补发结束标记：必须在补发帧**之后**、任何后续帧之前发出。
    //
    // 连接是同一条，补发进行期间 agent 新产生的 live 帧也在往这里发，且
    // live 帧的 seq 必然更大。请求方据此在补发期间暂存 live 帧、收到本帧
    // 后再按 seq 归并——没有这个标记就只能靠超时猜，猜早了丢历史帧。
    //
    // `cursor` 就是本次实际发出的最大 seq；一帧都没补发时它仍是入参
    // sinceSeq，语义恰好是「你已经是最新的了」，两种情况同一条路径。
    this.send(
      conn,
      encodeTransportFrame({
        type: 'sync.done',
        machineId: frame.machineId,
        ...(frame.sessionId !== undefined ? { sessionId: frame.sessionId } : {}),
        upTo: cursor,
      }),
    );

    // 补发完顺带把该机器当前的排队数与在线状态同步给 client
    if (conn.role === 'client') {
      this.sendMachineStatus(conn, frame.machineId);
      this.send(
        conn,
        encodeTransportFrame({
          type: 'parked.count',
          machineId: frame.machineId,
          parkedCount: this.parked.pendingCount(frame.machineId, this.now()),
        }),
      );
    }
    return { kind: 'resent', count: sent };
  }

  // -------------------------------------------------------------------------
  // 排队撤回
  // -------------------------------------------------------------------------

  private handleRecall(
    conn: Conn<T>,
    frame: Extract<TransportFrame, { type: 'park.recall' }>,
  ): HandleOutcome {
    if (conn.role !== 'client') {
      return { kind: 'rejected', reason: 'recall_from_non_client' };
    }
    const now = this.now();
    // 幂等：不存在/已投递/已过期/已撤回一律静默无操作（transport.ts 要求）
    const effective = this.parked.recall(
      frame.machineId,
      frame.sessionId,
      frame.seq,
      now,
    );
    if (effective) this.broadcastParkedCount(frame.machineId, now);
    return { kind: 'recalled', effective };
  }

  // -------------------------------------------------------------------------
  // 配对帧中转（服务端只转发，不参与密钥协商）
  // -------------------------------------------------------------------------

  /**
   * pair.* 帧此时 E2E 通道尚未建立，是明文经服务端中转（安全性靠一次性
   * token + 带外 QR + 双端 SAS 比对，见 transport.ts §4 注释）。
   *
   * 服务端**不认识 pairingToken 对应哪台机器**——token 由 agent 生成、
   * 只进 QR，服务端从没见过。因此路由策略是向对侧全体广播，由持有该
   * token 的一端自行认领；不匹配的一端丢弃即可。
   *
   * ## 代价（如实记录，不是「可忽略」）
   *
   * 广播意味着**一次性配对 token 会明文送到当前每一台在线 agent 手上**。
   * 若其中某台 agent 已被攻破，它就能截获本该发给另一台机器的配对 token，
   * 抢先完成 pair.begin。真正挡住这种冒充的是**双端 SAS 人工比对**：
   * 攻击者的公钥算出的 SAS 与用户屏幕上 agent 显示的对不上，用户会拒绝。
   * 也就是说这里的安全性完全押在 SAS 上，广播本身确实削弱了纵深防御。
   *
   * 单用户、机器数个位数的场景下这是可接受的 trade-off（换来服务端对
   * pairingToken 的完全无知）。要消除它，得让服务端知道 token 属于哪台
   * 机器——那就得让 agent 预先向服务端登记 token，与「服务端零知识」
   * 的取向相悖。留作已知 trade-off，不在本轮改。
   *
   * 频率上限见 `PAIR_RATE_LIMIT`：配对是低频人工动作，一条连接短时间内
   * 刷几十帧只可能是滥用（拿广播当放大器骚扰全体 agent）。
   */
  handlePair(
    conn: PairPeer<T>,
    frame: Extract<
      TransportFrame,
      { type: 'pair.begin' | 'pair.confirm' | 'pair.abort' }
    >,
  ): HandleOutcome {
    if (!this.allowPairFrame(conn)) {
      this.log(`[pair] 频率超限拒绝 device=${conn.deviceId}`);
      return { kind: 'rejected', reason: 'pair_rate_limited' };
    }

    switch (frame.type) {
      case 'pair.begin':
        return this.handlePairBegin(conn, frame);
      case 'pair.confirm':
        return this.handlePairConfirm(conn, frame);
      case 'pair.abort':
        // 中止：立刻丢掉 begin 记录（三路径核销之一，见 D8 代价意识）。
        // 任一方都可以发——发起方放弃扫码、agent 侧 SAS 对不上都算。
        this.pairBegins.delete(frame.pairingToken);
        return this.forwardPair(conn, frame);
    }
  }

  /**
   * `pair.begin`：缓存自报身份 + 广播给全体在线 agent。
   *
   * 缓存的这份**不是**登记依据，只是「client 说了什么」的存根，等 agent
   * 复述时逐字比对（陷阱 2：登记永不信 client 自报字段）。
   */
  private handlePairBegin(
    conn: PairPeer<T>,
    frame: Extract<TransportFrame, { type: 'pair.begin' }>,
  ): HandleOutcome {
    const now = this.now();
    this.sweepPairBegins(now);
    // 缓存满时**淘汰最旧的一条**而非拒收新的（DoS 修 ②）：拒收会让攻击者
    // 灌满缓存后合法用户的新配对永远挤不进；LRU 淘汰保证新配对总能进来，
    // 被挤掉的至多是一次陈旧的、多半已经放弃的配对尝试。Map 的插入顺序
    // 即年龄顺序（TTL 恒定，先插的先到期），首个 key 就是最旧的。
    if (
      this.pairBegins.size >= PAIR_BEGIN_MAX_ENTRIES &&
      !this.pairBegins.has(frame.pairingToken)
    ) {
      const oldest = this.pairBegins.keys().next().value;
      if (oldest !== undefined) {
        this.pairBegins.delete(oldest);
        this.log('[pair] begin 缓存满，淘汰最旧的一条');
      }
    }

    // 同 token 重复 begin 直接覆盖：正常情况是 client 重试（网络抖动、
    // agent 当时不在线）。攻击者用同一 token 覆盖也不构成新的攻击面
    // ——SAS 依旧由 agent 实际收到的那份公钥算出，覆盖只会让 SAS 对不上。
    //
    // 覆盖时先删再设，让它移到 Map 末尾（刷新为「最新」）——否则一条被
    // 反复 begin 的记录会停在原来的年龄位置，被 LRU 误当成最旧的淘汰掉。
    this.pairBegins.delete(frame.pairingToken);
    this.pairBegins.set(frame.pairingToken, {
      clientDeviceId: frame.clientDeviceId,
      clientSignPubKey: frame.clientSignPubKey,
      expiresAt: now + PAIR_BEGIN_TTL_MS,
    });
    return this.forwardPair(conn, frame);
  }

  /**
   * `pair.confirm`：背书式登记的落点（D8）。
   *
   * 三道校验缺一不可，任一不过都**不登记也不转发**——转发一个没能登记的
   * confirm 会让 client 以为配对成功，转头却换不到 token，卡在一个没有
   * 任何提示的死胡同里。
   *
   * 1. **角色必须是已认证的 agent**。client 或 pairing 连接发 confirm 等于
   *    自己给自己背书，那整套背书机制就没了意义。
   * 2. **必须有对应的 begin 缓存记录**。没有就说明这个 token 从没走过
   *    begin（或已过期/已核销），无从比对。
   * 3. **复述的身份必须与缓存逐字相同**。agent 复述的是它实际收到的那份；
   *    中间人替换过公钥的话这里就对不上（更早一步，SAS 已经让用户拒绝了）。
   *
   * 登记成功后**立即核销 begin 记录**（三路径核销之二）：同一 token 再来
   * 一次 confirm 会因为第 2 条失败，重放窗口就此关闭
   * （Happy issue #674 的反面教材——核销必须落码，不能只写在注释里）。
   */
  private handlePairConfirm(
    conn: PairPeer<T>,
    frame: Extract<TransportFrame, { type: 'pair.confirm' }>,
  ): HandleOutcome {
    if (conn.role !== 'agent') {
      this.log(`[pair] 非 agent 角色发 confirm，拒绝 role=${conn.role}`);
      return { kind: 'rejected', reason: 'pair_confirm_from_non_agent' };
    }

    const now = this.now();
    this.sweepPairBegins(now);
    const record = this.pairBegins.get(frame.pairingToken);
    if (!record) {
      // token 没走过 begin / 已过期 / 已被核销（重放）
      this.log('[pair] confirm 找不到对应的 begin 记录，拒绝');
      return { kind: 'rejected', reason: 'pair_unknown_token' };
    }
    if (
      record.clientDeviceId !== frame.clientDeviceId ||
      record.clientSignPubKey !== frame.clientSignPubKey
    ) {
      // agent 复述的身份与 client 自报的不符：要么中间有人换过公钥，
      // 要么 agent 行为异常。两种情况都不该登记，且必须丢掉这次配对。
      this.pairBegins.delete(frame.pairingToken);
      this.log('[pair] confirm 复述身份与 begin 记录不符，拒绝并作废本次配对');
      return { kind: 'rejected', reason: 'pair_identity_mismatch' };
    }

    const auth = this.deps.auth;
    if (!auth) {
      // 没注入 AuthService 就没有登记能力。此时**绝不能**假装成功往下转发
      this.log('[pair] 未注入 AuthService，无法完成背书登记');
      return { kind: 'rejected', reason: 'pair_registration_unavailable' };
    }

    const registered = auth.register(
      frame.clientDeviceId,
      'client',
      frame.clientSignPubKey,
      'pairing',
      now,
    );
    if (!registered.ok) {
      this.log(`[pair] 背书登记失败 reason=${registered.error}`);
      return { kind: 'rejected', reason: `pair_register_${registered.error}` };
    }

    // 核销：登记成功即作废本次 token，重放到此为止
    this.pairBegins.delete(frame.pairingToken);

    const forwarded = this.forwardPair(conn, frame);
    const targets = forwarded.kind === 'pair_forwarded' ? forwarded.targets : 0;
    return {
      kind: 'pair_registered',
      deviceId: frame.clientDeviceId,
      targets,
    };
  }

  /** 向对侧广播一帧 pair.*（agent ↔ client/pairing 互为对侧） */
  private forwardPair(
    conn: PairPeer<T>,
    frame: Extract<
      TransportFrame,
      { type: 'pair.begin' | 'pair.confirm' | 'pair.abort' }
    >,
  ): HandleOutcome {
    const payload = encodeTransportFrame(frame);
    // agent 发的往 client 侧走（含未认证的 pairing 连接——配对中的新设备
    // 正是挂在那上面等 confirm 的）；其余一律往全体 agent 广播
    const peers: PairPeer<T>[] =
      conn.role === 'agent'
        ? [...this.deps.registry.allClients(), ...this.#pairingConns]
        : this.deps.registry.allAgents();
    let targets = 0;
    for (const peer of peers) {
      if (peer.ws === conn.ws) continue;
      if (this.sendTo(peer.ws, payload)) targets++;
    }
    return { kind: 'pair_forwarded', targets };
  }

  /**
   * 在线的 pairing 受限连接。由装配层（server.ts）登记进来——它们刻意不在
   * ConnectionRegistry 里（见 registry.ts 的 PairingConn 注释），但 pair.*
   * 转发必须找得到它们：配对中的新设备正挂在这上面等 confirm。
   */
  readonly #pairingConns = new Set<PairingConn<T>>();

  addPairingConn(conn: PairingConn<T>): void {
    this.#pairingConns.add(conn);
  }

  removePairingConn(conn: PairingConn<T>): void {
    this.#pairingConns.delete(conn);
  }

  /** 遍历在线 pairing 连接（装配层的超时扫描用） */
  pairingConns(): PairingConn<T>[] {
    return [...this.#pairingConns];
  }

  /** 当前 pairing 连接数（测试与运维观察用） */
  get pairingConnCount(): number {
    return this.#pairingConns.size;
  }

  /**
   * 某来源当前的 pairing 连接数（按来源配额用）。
   *
   * 单一攻击源即使把自己的配额占满，也只影响自己那几个槽位，动不了其他
   * 来源和合法用户——这是把 DoS 从「连接维度」也关掉的根本解。
   */
  pairingConnCountForSource(source: string): number {
    let n = 0;
    for (const conn of this.#pairingConns) {
      if (conn.source === source) n++;
    }
    return n;
  }

  /**
   * 丢掉过期的 begin 记录（三路径核销之三：超时）。
   *
   * 触发点有三处，都不额外挂定时器：每次 pair.* 进来时顺手扫；以及
   * pairing 连接建立 / 断开时由装配层各触发一次（DoS 修 ③）。后两处是
   * 为了堵住「攻击者刷完就断、过期条目干占缓存到 TTL」的窗口——缓存规模
   * 是「同时进行的配对数」，个位数，扫全表成本可忽略。
   */
  sweepPairBegins(now = this.now()): void {
    for (const [token, record] of this.pairBegins) {
      if (record.expiresAt <= now) this.pairBegins.delete(token);
    }
  }

  /** 当前缓存的 begin 记录数（测试断言核销确实落码用） */
  get pendingPairBeginCount(): number {
    return this.pairBegins.size;
  }

  /**
   * 每连接的 pair.* 频率上限：滑动窗口内计数。
   * 状态挂在连接上，连接断开即随之消失——配对是短暂的人工流程，
   * 不值得为它在库里留记录。
   */
  private allowPairFrame(conn: PairPeer<T>): boolean {
    const now = this.now();
    const history = (conn.pairFrameTimes ??= []);
    // 丢掉窗口外的旧记录
    while (history.length > 0 && now - history[0]! > PAIR_RATE_LIMIT.windowMs) {
      history.shift();
    }
    if (history.length >= PAIR_RATE_LIMIT.maxFrames) return false;
    history.push(now);
    return true;
  }

  // -------------------------------------------------------------------------
  // 连接生命周期钩子
  // -------------------------------------------------------------------------

  /** agent 上线：广播状态，冲排队队列 */
  onAgentOnline(conn: Conn<T>): { delivered: number } {
    const machineId = conn.machineId!;
    const now = this.now();
    this.broadcastMachineStatus(machineId, true, now);

    let delivered = 0;
    for (const row of this.parked.pending(machineId, now)) {
      const stored = this.deps.store.getFrame(
        row.machineId,
        row.sessionId,
        'c2a',
        row.seq,
      );
      if (!stored) {
        // 密文已被 relay TTL 清掉：这条投不出去了，判过期而不是 delivered
        // ——绝不能对 client 谎报已送达；也不能留在 pending 里永远重试
        if (this.parked.expire(row.machineId, row.sessionId, row.seq, now)) {
          // 明确告诉 client 这条没了，别让它的 input.parked 回执永远挂着
          this.broadcastParkExpired(row.machineId, row.sessionId, row.seq);
        }
        continue;
      }
      const ok = this.send(
        conn,
        encodeTransportFrame({
          type: 'relay',
          machineId: stored.machineId,
          ...(stored.sessionId !== undefined
            ? { sessionId: stored.sessionId }
            : {}),
          seq: stored.seq,
          nonce: stored.nonce,
          ciphertext: stored.ciphertext,
        }),
      );
      // 发送失败即停，**有意为之**：连接刚断，后面的帧发出去也是白发。
      // 剩下的保持 pending，等 agent 下次上线再整批投递——排队帧的价值
      // 就在于「等得起」，这里不该为了跑完循环而把它们标成已投递。
      if (!ok) break;
      // 终态防覆盖：只有仍是 pending 才会真的转 delivered
      if (this.parked.markDelivered(row.machineId, row.sessionId, row.seq, now))
        delivered++;
    }
    if (delivered > 0) this.broadcastParkedCount(machineId, now);
    return { delivered };
  }

  onAgentOffline(machineId: string): void {
    this.broadcastMachineStatus(machineId, false, this.now());
  }

  /** client 上线：把全部已知机器的在线状态与排队数推一遍 */
  onClientOnline(conn: Conn<T>): void {
    const now = this.now();
    for (const device of this.deps.store.listDevices('agent')) {
      this.sendMachineStatus(conn, device.deviceId);
      const count = this.parked.pendingCount(device.deviceId, now);
      if (count > 0) {
        this.send(
          conn,
          encodeTransportFrame({
            type: 'parked.count',
            machineId: device.deviceId,
            parkedCount: count,
          }),
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 状态广播
  // -------------------------------------------------------------------------

  private sendMachineStatus(conn: Conn<T>, machineId: string): void {
    const online = this.deps.registry.isAgentOnline(machineId);
    const device = this.deps.store.getDevice(machineId);
    this.send(
      conn,
      encodeTransportFrame({
        type: 'machine.status',
        machineId,
        online,
        lastSeenAt: online ? this.now() : (device?.lastSeenAt ?? 0),
      }),
    );
  }

  broadcastMachineStatus(
    machineId: string,
    online: boolean,
    now = this.now(),
  ): void {
    // lastSeenAt 是服务端自己的观测值，不是对端上报的——终态防覆盖的
    // 前提是这个值只由服务端单方推进，不接受任何对端写入
    if (online) this.deps.store.touchDevice(machineId, now);
    const device = this.deps.store.getDevice(machineId);
    const payload = encodeTransportFrame({
      type: 'machine.status',
      machineId,
      online,
      lastSeenAt: online ? now : (device?.lastSeenAt ?? now),
    });
    for (const client of this.deps.registry.allClients()) {
      this.send(client, payload);
    }
  }

  broadcastParkedCount(machineId: string, now = this.now()): void {
    const payload = encodeTransportFrame({
      type: 'parked.count',
      machineId,
      parkedCount: this.parked.pendingCount(machineId, now),
    });
    for (const client of this.deps.registry.allClients()) {
      this.send(client, payload);
    }
  }

  // -------------------------------------------------------------------------
  // 定期清理
  // -------------------------------------------------------------------------

  /** 过期清理：parked 转终态、relay 超留存、长期不活跃的子流高水位、认证残留 */
  sweep(now = this.now()): {
    parkedExpired: number;
    relayPurged: number;
    settledPurged: number;
    hwmPurged: number;
  } {
    const expired = this.parked.sweepExpired(now);
    // 逐条告知 client：它手里的 input.parked 回执必须有个了结
    for (const row of expired) {
      this.broadcastParkExpired(row.machineId, row.sessionId, row.seq);
    }
    for (const machineId of new Set(expired.map((r) => r.machineId))) {
      this.broadcastParkedCount(machineId, now);
    }
    const relayPurged = this.deps.store.sweepRelayFrames(
      now - this.deps.config.relayRetentionMs,
    );
    // 结算记录多留一个 TTL 周期，够 client 重连后问明白「我那条怎么了」
    const settledPurged = this.parked.purgeSettled(
      now - this.deps.config.parkedTtlMs,
    );
    // 高水位的 TTL 远长于留存（config 不变量保证），只清确实死掉的流
    const hwmPurged = this.deps.store.sweepStreamHwm(now - this.deps.config.hwmTtlMs);
    this.deps.store.sweepExpiredAuth(now);
    return {
      parkedExpired: expired.length,
      relayPurged,
      settledPurged,
      hwmPurged,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * 回执一帧被拒的原因给发起方（帧不再静默蒸发）。
   *
   * `expectedAfter` 是该流的持久高水位，只在 seq 类拒绝时有值；store 早就
   * 算出来了，早先组帧时把它丢了，于是发送方只能盲猜——现在原样透传。
   * `recipientDeviceId` 同样原样回带：a2c 的高水位是**按收件人子流**算的，
   * 发送方要知道被拒的是哪条子流才能只给它重发。
   */
  private sendRelayReject(
    conn: Conn<T>,
    frame: Extract<TransportFrame, { type: 'relay' }>,
    reason: RelayRejectReason,
    expectedAfter?: number,
  ): void {
    this.send(
      conn,
      encodeTransportFrame({
        type: 'relay.reject',
        machineId: frame.machineId,
        ...(frame.sessionId !== undefined
          ? { sessionId: frame.sessionId }
          : {}),
        ...(frame.recipientDeviceId !== undefined
          ? { recipientDeviceId: frame.recipientDeviceId }
          : {}),
        seq: frame.seq,
        reason,
        ...(expectedAfter !== undefined ? { expectedAfter } : {}),
      }),
    );
  }

  /** 向全部在线 client 广播「这条排队帧再也送不出去了」 */
  private broadcastParkExpired(
    machineId: string,
    sessionId: string,
    seq: number,
  ): void {
    const payload = encodeTransportFrame({
      type: 'park.expired',
      machineId,
      sessionId,
      seq,
    });
    for (const client of this.deps.registry.allClients()) {
      this.send(client, payload);
    }
  }

  /** 发送并吞掉断连异常：一个死连接不该中断对其他连接的分发 */
  private send(conn: Conn<T>, payload: string): boolean {
    return this.sendTo(conn.ws, payload);
  }

  /** 同上，但只要一个 socket——pair.* 要发给不在注册表里的 pairing 连接 */
  private sendTo(ws: T, payload: string): boolean {
    try {
      ws.send(payload);
      return true;
    } catch {
      return false;
    }
  }
}

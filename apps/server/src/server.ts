/**
 * 服务端装配：Bun.serve（WS 升级 + Hono HTTP fallback）+ 心跳 + 定期清理。
 *
 * ## WS 握手
 *
 * 1. `GET /ws` 升级；此时**还未认证**——认证在应用层第一帧完成，
 *    这样 token 不用塞进 URL（URL 会进反代访问日志）。
 * 2. 升级后必须在 `helloTimeoutMs` 内发出 `hello` 帧，否则断开；
 *    未认证连接期间除 hello 外的任何帧一律拒绝并断开。
 * 3. hello 校验：token 有效 → 取出已登记的 deviceId/role；
 *    帧里自报的 role/deviceId 必须与登记一致（自报值只做交叉检查，
 *    永不作为身份来源）。
 *
 * ## 心跳与空闲断连
 *
 * 服务端周期发 WS ping；连续 `maxMissedPings` 次没等到 pong，或
 * `idleTimeoutMs` 内没有任何入站帧，即主动断开。客户端侧的指数退避重连
 * （D2）与之配合：服务端只管快速清理死连接，不管重连节奏。
 */
import {
  decodeTransportFrame,
  encodeTransportFrame,
  HelloSchema,
} from '@trine/core/protocol';
import { sodiumReady } from '@trine/core/crypto';
import type { Server, ServerWebSocket } from 'bun';
import { ANONYMOUS_SOURCE, AuthService } from './auth/index.ts';
import { BlobStore } from './blobs.ts';
import { loadConfig, type ServerConfig } from './config.ts';
import { clientSource, createHttpApp } from './http.ts';
import { createPushDispatcher } from './push/index.ts';
import { Store } from './store/index.ts';
import { RelayHub } from './ws/hub.ts';
import {
  ConnectionRegistry,
  type Conn,
  type PairingConn,
  type Sendable,
} from './ws/registry.ts';

export const SERVER_VERSION = '0.1.0';

/** WS 关闭码：4000 段是应用自定义区间 */
export const CLOSE = {
  UNAUTHENTICATED: 4001,
  HELLO_TIMEOUT: 4002,
  IDLE_TIMEOUT: 4004,
  REPLACED: 4005,
  VERSION_MISMATCH: 4006,
  /** pairing 受限连接发了 pair.* 以外的帧 */
  PAIRING_FRAME_NOT_ALLOWED: 4007,
  /** 全站在线 pairing 连接数已达上限（见 MAX_PAIRING_CONNS） */
  PAIRING_CAPACITY: 4008,
  /** 该来源的 pairing 连接数已达每源配额（见 MAX_PAIRING_CONNS_PER_SOURCE） */
  PAIRING_SOURCE_CAPACITY: 4009,
  /** pairing 连接建立后短宽限内没发出合法 pair.begin（空占坑） */
  PAIRING_BEGIN_TIMEOUT: 4010,
} as const;

/** 握手宽限：升级后多久没发 hello 就断开 */
const HELLO_TIMEOUT_MS = 10_000;
/** 连续未响应的 ping 数上限 */
const MAX_MISSED_PINGS = 2;
/** 优雅关闭的等待上限（见 stop() 里的 Bun 行为说明） */
const SHUTDOWN_GRACE_MS = 200;

/**
 * pairing 受限连接的空闲上限（D8：短超时）。
 *
 * 明显短于普通连接的 `idleTimeoutMs`：这条连接免认证，对端身份完全未知，
 * 挂着不动就是白占资源。2 分钟足够走完「扫码 → 比对 SAS → 点确认」，
 * 用户真的走神超时了，重新扫码即可（本就不做断线续配对）。
 *
 * 注意 pairing 连接**不进 ConnectionRegistry**，因而不在心跳循环的
 * `registry.all()` 里——它的超时清理是另一条独立的扫描（见 pairingSweeper）。
 */
export const PAIRING_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * 全站同时在线的 pairing 受限连接数上限。
 *
 * 这是 begin-DoS 的**根因防线**：pairing 连接免认证，谁都能开；不设总数
 * 上限的话，攻击者开一批匿名连接、各刷满 PAIR_RATE_LIMIT（每连接 20 帧）
 * 就能灌满 begin 缓存，且断开后缓存还占着——一次无凭据请求就能锁死全站
 * 配对若干分钟。个人工具正常同时进行的配对是个位数，32 是宽到不可能误伤
 * 真实用户、又把匿名连接数摁在低位的取值。满了就拒绝新的 pairing 升级
 * （已在配对的连接不受影响）。
 */
export const MAX_PAIRING_CONNS = 32;

/**
 * **每来源** pairing 连接配额（按 IP）。
 *
 * 全局上限 MAX_PAIRING_CONNS 单独用是不够的：pairing 连接免认证、无每源
 * 配额，攻击者从单一 IP 开满 32 条（一个 begin 都不发）就能把合法用户挡在
 * 门外，比灌 begin 缓存还便宜。按来源限死后，单一攻击源最多占 2 个槽位，
 * 全局配额留给其他来源。正常用户同一 IP 顶多同时配一两台设备，2 够用。
 *
 * 取源沿用认证限流那套 clientSource（信任反代头时读 XFF/X-Real-IP），
 * 拿不到头时退到 socket 对端 IP（`srv.requestIP`，客户端无法伪造）。
 * 因此即便反代场景配错、或直连公网关掉了 trustProxyHeader，也仍有真实
 * 的 socket IP 兜底做每源区分——只有在同一 NAT 后的多台设备才会共桶，
 * 那本就该被全局上限 + 空连接宽限 + keepalive 收紧一并兜底。
 */
export const MAX_PAIRING_CONNS_PER_SOURCE = 2;

/**
 * pairing 连接建立后必须发出**合法** pair.begin 的宽限时长的默认值。
 * 权威值在 `config.pairingBeginGraceMs`（可经 TRINE_PAIRING_BEGIN_GRACE_MS
 * 覆盖，测试用于缩短）；本常量仅作文档与默认参考。
 *
 * 空连接（连上不 begin）是最便宜的占坑手段：不触发任何限流、不写任何缓存，
 * 只是白占一个槽位到 2min 的 idle 超时。宽限设在 HELLO_TIMEOUT 量级——正常
 * 用户扫码后几秒内就发 begin，纯占坑的连接活不过这个窗口。
 */
export const PAIRING_BEGIN_GRACE_MS = 10_000;

interface SocketData {
  /** 已认证连接；认证前 / pairing 角色下为 null */
  conn: Conn<ServerWebSocket<SocketData>> | null;
  /**
   * 免认证的 pairing 受限连接（与 conn 互斥，最多一个非 null）。
   * 单独一个字段而不是塞进 conn：类型上就分开，避免哪天有人手滑把它
   * 当成已认证连接喂给 relay 路径。
   */
  pairing: PairingConn<ServerWebSocket<SocketData>> | null;
  /**
   * 连接来源标识（IP，经 clientSource 归一）。在 fetch（WS 升级）时捕获——
   * 那是唯一能拿到原始 Request 头的地方。用于 pairing 连接的按源配额。
   */
  source: string;
  openedAt: number;
}

type WS = ServerWebSocket<SocketData>;

export interface TrineServer {
  server: Server<SocketData>;
  store: Store;
  hub: RelayHub<WS>;
  auth: AuthService;
  registry: ConnectionRegistry<WS>;
  config: ServerConfig;
  port: number;
  url: string;
  stop(): Promise<void>;
}

/**
 * WS 升级是否放行该来源。
 *
 * 三条判据，按顺序：
 * 1. **两项 Web 配置都没开** → 一律放行（纯 API 中转部署，行为不变）；
 * 2. **没有 Origin 头** → 放行。agent、CLI、测试脚本这类非浏览器客户端
 *    不带这个头；带不带不是身份证明，真正的身份在 hello 帧的 token 上，
 *    本检查只针对「浏览器里的网页」这一类来源；
 * 3. **有 Origin 头** → 必须在 CORS 清单里，或其 host 等于请求的 `Host`
 *    头（同源托管：页面就是本服务发出去的，此时清单往往是空的）。
 */
export function isWsOriginAllowed(req: Request, config: ServerConfig): boolean {
  if (config.corsOrigins.length === 0 && config.webDist === '') return true;

  const origin = req.headers.get('origin');
  if (origin === null || origin === '') return true;

  if (config.corsOrigins.includes(origin)) return true;

  // 同源：Origin 的 host（含端口）与 Host 头一致。比的是 host 而非整个
  // origin——Host 头不带 scheme，反代终止 TLS 后本进程也无从得知外部用的是
  // http 还是 https，拿 scheme 比必然误判。
  const host = req.headers.get('host');
  if (host !== null && host !== '') {
    try {
      if (new URL(origin).host === host) return true;
    } catch {
      // Origin 不是合法 URL（畸形/"null"）：不放行
      return false;
    }
  }
  return false;
}

export async function startServer(
  overrides: Partial<ServerConfig> = {},
): Promise<TrineServer> {
  // E2E 加密库虽由三端各自使用，服务端只用到 sign 的验签与随机数，
  // 但同样依赖 libsodium WASM 就绪
  await sodiumReady();

  const config = loadConfig(overrides);
  const store = new Store(config.dbPath);
  const auth = new AuthService(store, config);
  const registry = new ConnectionRegistry<WS>();
  const push = createPushDispatcher({
    config,
    // client 不绑机器，「有 client 在线」= 人正对着某个屏幕
    hasOnlineClient: () => registry.hasOnlineClient(),
    log: (line) => console.info(line),
  });
  if (push.enabled) {
    console.info(`[push] 已启用渠道：${push.channelNames.join(', ')}`);
  }
  // auth 注入 hub：背书式登记（D8）——agent 发来合规 pair.confirm 时
  // 由 hub 直接把 client 设备登记进来
  const hub = new RelayHub<WS>({ store, registry, config, push, auth });

  const blobs =
    config.blobDir === ''
      ? undefined
      : new BlobStore({ dir: config.blobDir, maxBytes: config.blobMaxBytes, ttlMs: config.blobTtlMs });

  const http = createHttpApp({
    auth,
    store,
    isAgentOnline: (m) => registry.isAgentOnline(m),
    version: SERVER_VERSION,
    trustProxyHeader: config.trustProxyHeader,
    corsOrigins: config.corsOrigins,
    webDist: config.webDist,
    ...(blobs === undefined ? {} : { blobs }),
  });
  if (config.webDist !== '') {
    console.info(`[http] 托管 Web 构建产物：${config.webDist}`);
  }
  if (config.corsOrigins.length > 0) {
    console.info(`[http] CORS 允许来源：${config.corsOrigins.join(', ')}`);
  }

  const server = Bun.serve<SocketData, never>({
    port: config.port,
    hostname: config.hostname,
    // idleTimeout 由应用层心跳接管，这里给足余量（Bun 上限 255s）
    idleTimeout: 255,
    // Bun 默认 128MB；附件上传按 blob 上限放宽（留 1MB 余量给头部）。
    // 只有 /blobs 会收大请求体，其余端点各有自己的 bodyLimit
    maxRequestBodySize: Math.max(config.blobMaxBytes, 128 * 1024 * 1024) + 1024 * 1024,

    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        // 跨源 WS 拦截：WebSocket **不受同源策略约束**，浏览器里任意页面都能
        // 向本服务开一条 WS，而 `Origin` 头是唯一能识别「这是哪个网页发起的」
        // 的线索（浏览器强制带上、页面脚本改不了）。
        //
        // 要紧的是 pairing 角色：那条连接**免认证**，任意网页都能借访客的
        // 浏览器开一批，绕开 MAX_PAIRING_CONNS_PER_SOURCE 的每源配额——
        // 配额按 IP 算，而访客的 IP 各不相同。
        //
        // 只在「已经有 Web 形态」时启用（配了 CORS 清单或托管了 WEB_DIST）：
        // 纯 API 中转部署下客户端是 agent/CLI，压根不带 Origin 头，
        // 加这道检查只会平白多一个出错面。
        if (!isWsOriginAllowed(req, config)) {
          return new Response('origin not allowed', { status: 403 });
        }
        // 来源标识必须在这里捕获——WS 升级后就拿不到原始 Request 头了。
        // 沿用认证限流那套 clientSource（信任反代头时读 XFF/X-Real-IP，
        // 否则不信任伪造头）；拿不到头时退到 socket 对端 IP（不可伪造）。
        const fromHeader = clientSource(req, config.trustProxyHeader);
        const source =
          fromHeader === ANONYMOUS_SOURCE
            ? (srv.requestIP(req)?.address ?? ANONYMOUS_SOURCE)
            : fromHeader;
        const ok = srv.upgrade(req, {
          data: {
            conn: null,
            pairing: null,
            source,
            openedAt: Date.now(),
          } satisfies SocketData,
        });
        return ok
          ? undefined
          : new Response('expected websocket upgrade', { status: 426 });
      }
      return http.fetch(req);
    },

    websocket: {
      open(ws: WS) {
        // 握手宽限：到点还没握手（认证连接或 pairing 连接都算）就踢掉，
        // 避免半开连接堆积
        setTimeout(() => {
          if (!ws.data.conn && !ws.data.pairing) {
            closeQuietly(ws, CLOSE.HELLO_TIMEOUT, 'hello timeout');
          }
        }, HELLO_TIMEOUT_MS);
      },

      message(ws: WS, raw: string | Buffer) {
        const text = typeof raw === 'string' ? raw.toString() : raw.toString();
        const conn = ws.data.conn;
        const pairing = ws.data.pairing;
        if (!conn && !pairing) {
          handleHello(ws, text, {
            auth,
            registry,
            hub,
            store,
            pairingBeginGraceMs: config.pairingBeginGraceMs,
          });
          return;
        }
        if (pairing) {
          handlePairingFrame(ws, pairing, text, hub);
          return;
        }
        const outcome = hub.handleRaw(conn!, text);
        if (outcome.kind === 'rejected') {
          console.warn(
            `[ws] 拒绝帧 device=${conn!.deviceId} reason=${outcome.reason}`,
          );
        }
      },

      pong(ws: WS) {
        const conn = ws.data.conn;
        if (conn) {
          conn.lastSeenAt = Date.now();
          conn.pendingPings = 0;
        }
        if (ws.data.pairing) ws.data.pairing.lastSeenAt = Date.now();
      },

      close(ws: WS) {
        if (ws.data.pairing) {
          hub.removePairingConn(ws.data.pairing);
          ws.data.pairing = null;
          // 断开时也清一遍过期 begin：攻击者刷完就断的话，缓存里的过期条目
          // 不能只等 TTL 被动失效（DoS 修 ③）
          hub.sweepPairBegins();
        }
        const conn = registry.remove(ws);
        if (!conn) return;
        store.touchDevice(conn.deviceId, Date.now());
        if (conn.role === 'agent' && conn.machineId) {
          // 只有确实没有替代连接时才广播离线——顶替场景下机器仍在线
          if (!registry.isAgentOnline(conn.machineId)) {
            hub.onAgentOffline(conn.machineId);
          }
        }
      },
    },
  });

  // 心跳 + 空闲断连
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const conn of registry.all()) {
      if (now - conn.lastSeenAt > config.idleTimeoutMs) {
        closeQuietly(conn.ws, CLOSE.IDLE_TIMEOUT, 'idle');
        continue;
      }
      if (conn.pendingPings >= MAX_MISSED_PINGS) {
        closeQuietly(conn.ws, CLOSE.IDLE_TIMEOUT, 'ping timeout');
        continue;
      }
      try {
        conn.ws.ping();
        conn.pendingPings++;
      } catch {
        closeQuietly(conn.ws, CLOSE.IDLE_TIMEOUT, 'ping failed');
      }
    }
  }, config.heartbeatIntervalMs);

  // pairing 受限连接的独立超时扫描：它们不在 registry 里，心跳循环看不到。
  // 周期取超时值的 1/4，最迟 2.5 个超时周期内一定被清掉。
  const pairingSweeper = setInterval(
    () => {
      const now = Date.now();
      for (const conn of hub.pairingConns()) {
        if (now - conn.lastSeenAt > PAIRING_IDLE_TIMEOUT_MS) {
          closeQuietly(conn.ws, CLOSE.IDLE_TIMEOUT, 'pairing idle');
        }
      }
    },
    Math.max(1000, Math.floor(PAIRING_IDLE_TIMEOUT_MS / 4)),
  );

  // 过期清理
  const sweeper = setInterval(() => {
    try {
      const result = hub.sweep();
      if (result.parkedExpired || result.relayPurged || result.settledPurged || result.hwmPurged) {
        console.info(
          `[sweep] parked过期=${result.parkedExpired} relay清理=${result.relayPurged} 结算清理=${result.settledPurged} 高水位清理=${result.hwmPurged}`,
        );
      }
    } catch (err) {
      console.error('[sweep] 失败:', err);
    }
    blobs?.sweep().then(
      (n) => {
        if (n > 0) console.info(`[sweep] blob清理=${n}`);
      },
      (err: unknown) => console.error('[sweep] blob 清理失败:', err),
    );
  }, config.sweepIntervalMs);

  // port 0（测试里随机端口）时以实际绑定值为准
  const port = server.port ?? config.port;
  return {
    server,
    store,
    hub,
    auth,
    registry,
    config,
    port,
    url: `http://${config.hostname}:${port}`,
    async stop() {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      clearInterval(pairingSweeper);
      for (const conn of registry.all()) {
        closeQuietly(conn.ws, 1001, 'server shutdown');
      }
      for (const conn of hub.pairingConns()) {
        closeQuietly(conn.ws, 1001, 'server shutdown');
      }
      // Bun 1.3.11：一旦发生过 WS 升级，server.stop() 返回的 Promise
      // 即使所有 socket 都已关闭也不再 resolve。给它一个上限，
      // 超时就继续往下走——监听端口此时已经停了，剩下的只是等待句柄回收。
      await Promise.race([
        server.stop(true),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
      ]);
      store.close();
    },
  };
}

// ---------------------------------------------------------------------------
// hello 握手
// ---------------------------------------------------------------------------

function handleHello(
  ws: WS,
  text: string,
  deps: {
    auth: AuthService;
    registry: ConnectionRegistry<WS>;
    hub: RelayHub<WS>;
    store: Store;
    pairingBeginGraceMs: number;
  },
): void {
  let hello: ReturnType<typeof HelloSchema.parse>;
  try {
    const frame = decodeTransportFrame(text);
    if (frame.type !== 'hello') {
      closeQuietly(ws, CLOSE.UNAUTHENTICATED, 'hello required');
      return;
    }
    hello = frame;
  } catch {
    // 协议版本不符会在这里被 z.literal 挡下——一并按协议错处理
    closeQuietly(ws, CLOSE.VERSION_MISMATCH, 'bad hello');
    return;
  }

  // pairing：免认证的受限连接（D8）。全新设备还没有登记过公钥，换不到
  // token，这是它唯一能发出 pair.begin 的入口。刻意不进 ConnectionRegistry
  // ——它收不到任何 relay / 广播 / 补发，能做的只有收发 pair.*。
  if (hello.role === 'pairing') {
    const source = ws.data.source;
    // ① 按来源配额（根本解）：单一攻击源占不满全局槽位，也就动不了
    //    其他来源和合法用户。放在全局上限之前——先挡住廉价的单源打法。
    if (
      deps.hub.pairingConnCountForSource(source) >= MAX_PAIRING_CONNS_PER_SOURCE
    ) {
      closeQuietly(ws, CLOSE.PAIRING_SOURCE_CAPACITY, 'pairing source capacity');
      return;
    }
    // 全局上限保留作兜底（多源分布式打法、或同 NAT 后共桶时），
    // 但不再是唯一防线。
    if (deps.hub.pairingConnCount >= MAX_PAIRING_CONNS) {
      closeQuietly(ws, CLOSE.PAIRING_CAPACITY, 'pairing capacity');
      return;
    }
    const now = Date.now();
    const pairing: PairingConn<WS> = {
      ws,
      role: 'pairing',
      // 自报值，未经任何验证，只用于日志与限流 key
      deviceId: hello.deviceId,
      source,
      connectedAt: now,
      lastSeenAt: now,
      beganAt: null,
    };
    ws.data.pairing = pairing;
    deps.hub.addPairingConn(pairing);
    // 新连接建立时顺手清一遍过期 begin 记录，不让它们干占缓存（DoS 修 ③）
    deps.hub.sweepPairBegins();
    // ② 空连接短宽限：连上迟迟不发合法 begin 的纯占坑连接活不久。
    //    正常用户扫码后几秒内就 begin，beganAt 会被置上，这里就放它过。
    setTimeout(() => {
      if (ws.data.pairing && ws.data.pairing.beganAt === null) {
        closeQuietly(ws, CLOSE.PAIRING_BEGIN_TIMEOUT, 'no pair.begin in grace');
      }
    }, deps.pairingBeginGraceMs);
    return;
  }

  if (!hello.authToken) {
    closeQuietly(ws, CLOSE.UNAUTHENTICATED, 'auth required');
    return;
  }
  const authed = deps.auth.authenticateToken(hello.authToken);
  if (!authed.ok) {
    closeQuietly(ws, CLOSE.UNAUTHENTICATED, authed.error);
    return;
  }
  // 自报值只做交叉检查：身份一律以 token 换回的登记信息为准
  if (
    authed.value.deviceId !== hello.deviceId ||
    authed.value.role !== hello.role
  ) {
    closeQuietly(ws, CLOSE.UNAUTHENTICATED, 'identity mismatch');
    return;
  }

  const now = Date.now();
  const conn: Conn<WS> = {
    ws,
    deviceId: authed.value.deviceId,
    role: authed.value.role,
    machineId:
      authed.value.role === 'agent' ? authed.value.deviceId : undefined,
    connectedAt: now,
    lastSeenAt: now,
    pendingPings: 0,
  };
  ws.data.conn = conn;
  deps.store.touchDevice(conn.deviceId, now);

  if (conn.role === 'agent') {
    const replaced = deps.registry.addAgent(conn);
    if (replaced) {
      replaced.ws.data.conn = null;
      closeQuietly(replaced.ws, CLOSE.REPLACED, 'replaced by new connection');
    }
    deps.hub.onAgentOnline(conn);
  } else {
    deps.registry.addClient(conn);
    deps.hub.onClientOnline(conn);
  }
}

/**
 * pairing 受限连接的入站帧处理。
 *
 * **白名单而非黑名单**：只有 `pair.*` 三种帧被放行，其余一律关连接。
 * 这条连接的对端身份完全未经验证，多放行一种帧就是多开一扇门——
 * 尤其 `relay` / `sync.request` 会让未认证方读到会话密文流。
 */
function handlePairingFrame(
  ws: WS,
  pairing: PairingConn<WS>,
  text: string,
  hub: RelayHub<WS>,
): void {
  // ③ keepalive 收紧：**不在这里无条件刷新 lastSeenAt**。否则被 PAIR_RATE_LIMIT
  // 拒绝的垃圾帧也能给连接续命，攻击者每 ~110s 灌一帧就永久霸占槽位。
  // 只有真正推进了配对状态的帧（handlePair 未拒绝）才刷新——见下方。
  let frame: ReturnType<typeof decodeTransportFrame>;
  try {
    frame = decodeTransportFrame(text);
  } catch {
    closeQuietly(ws, CLOSE.PAIRING_FRAME_NOT_ALLOWED, 'malformed frame');
    return;
  }
  if (
    frame.type !== 'pair.begin' &&
    frame.type !== 'pair.confirm' &&
    frame.type !== 'pair.abort'
  ) {
    closeQuietly(
      ws,
      CLOSE.PAIRING_FRAME_NOT_ALLOWED,
      'pairing connection: pair.* only',
    );
    return;
  }

  const outcome = hub.handlePair(pairing, frame);
  if (outcome.kind === 'rejected') {
    // 被拒的帧不续命、也不解除空连接宽限——灌垃圾帧续不了坑
    console.warn(`[ws] 拒绝配对帧 reason=${outcome.reason}`);
    return;
  }
  // 帧被接受：刷新活跃时刻；合法 begin 首次通过即解除空连接宽限
  pairing.lastSeenAt = Date.now();
  if (frame.type === 'pair.begin' && pairing.beganAt === null) {
    pairing.beganAt = pairing.lastSeenAt;
  }
}

function closeQuietly(ws: Sendable, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // 已经关掉的连接再关一次不算错
  }
}

/** 便捷：给 client/agent 端构造 hello 帧（测试与 SDK 复用） */
export function helloFrame(
  role: 'client' | 'agent',
  deviceId: string,
  authToken: string,
): string {
  return encodeTransportFrame({
    type: 'hello',
    v: 1,
    role,
    deviceId,
    authToken,
  });
}

/**
 * 便捷：pairing 受限连接的 hello 帧。
 * 不带 authToken——这个角色的存在意义就是「还没有 token」。
 */
export function pairingHelloFrame(deviceId: string): string {
  return encodeTransportFrame({
    type: 'hello',
    v: 1,
    role: 'pairing',
    deviceId,
  });
}

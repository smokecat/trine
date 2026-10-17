/**
 * 服务端运行配置：全部可经环境变量覆盖，默认值面向单用户小 VPS。
 * 部署示例见 apps/server/deploy/。
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`环境变量 ${name} 必须是非负整数，实际：${raw}`);
  }
  return n;
}

export interface ServerConfig {
  /** 监听端口（前置 Caddy/Nginx 反代，本进程只听 127.0.0.1） */
  port: number;
  hostname: string;
  /** SQLite 文件路径；':memory:' 用于测试 */
  dbPath: string;

  /** 挑战串有效期：短到足以完成一次往返，长到容忍时钟/网络抖动 */
  challengeTtlMs: number;
  /** 认证 token 有效期；过期需重新走挑战-应答 */
  tokenTtlMs: number;
  /** 已废弃：兼容旧配置，不能开放注册；新 agent 必须有邀请 */
  allowOpenRegistration: boolean;

  /** 心跳间隔：服务端主动 ping 的周期 */
  heartbeatIntervalMs: number;
  /** 空闲断连阈值：超过此时长没收到任何帧/pong 即断开 */
  idleTimeoutMs: number;
  /**
   * pairing 受限连接建立后必须在此时长内发出合法 pair.begin，否则踢掉
   * （空连接占坑防线）。参照 HELLO_TIMEOUT 量级，默认 10s。
   */
  pairingBeginGraceMs: number;

  /** relay 帧留存 TTL（断线补发窗口），超期清理 */
  relayRetentionMs: number;
  /** agent 离线排队帧 TTL（决策点 1：默认 24h 可配置） */
  parkedTtlMs: number;
  /** 单个 (machineId, sessionId) 序列最多留存的 relay 帧数，防单会话撑爆库 */
  relayMaxPerStream: number;
  /**
   * 子流持久高水位（stream_hwm）的 TTL：多久没帧的流删掉基线、变回 fresh。
   * 必须远大于 relayRetentionMs（否则基线先于留存蒸发，D10 的前提失效）；
   * 又不能无穷大（否则随机 sessionId 可无限灌行）。默认 90 天。
   */
  hwmTtlMs: number;
  /** 单台机器最多排队帧数，防离线期间无限堆积 */
  parkedMaxPerMachine: number;

  /** 过期清理扫描周期 */
  sweepIntervalMs: number;

  /** 认证失败限流：同一来源在窗口内允许的失败次数 */
  authFailWindowMs: number;
  authFailMaxAttempts: number;
  /**
   * 是否信任反代注入的客户端 IP 头（X-Forwarded-For / X-Real-IP）。
   * 默认 true——既定部署形态是 Caddy 反代 + 只听回环。直接暴露到公网时
   * 必须置 0，否则来源可被任意伪造。
   */
  trustProxyHeader: boolean;

  // ---- 推送（D6，全部可选：不配 Bark 即整体禁用推送）----
  /** Bark 服务器根地址，如 https://api.day.app 或自建地址；空 = 禁用 */
  barkServerUrl: string;
  /** Bark 设备 key（凭据，绝不入日志）；空 = 禁用 */
  barkDeviceKey: string;
  /** 单次推送 HTTP 超时；避免「推送无超时永久定格」 */
  pushTimeoutMs: number;
  /** 在线抑制：该机器有在线 client 时不推（人正在看）。默认开 */
  pushSuppressWhenOnline: boolean;
  /** 去抖窗口：同一 (machineId, sessionId, hint) 窗口内只推一次；0 = 关 */
  pushDedupeWindowMs: number;
  /**
   * 机器标识别名，`machineId=别名` 逗号分隔。
   * 明文写在推送里，是**用户知情的主动选择**；不配则用 machineId 短前缀。
   */
  pushAliases: string;

  // ---- Web 客户端接入（默认全关：不配就完全是原来的行为）----
  /**
   * 允许跨源访问 `/auth/*` `/healthz` `/devices` 的 origin 清单，逗号分隔。
   * 空 = 一个 CORS 头都不发（生产默认形态是 TRINE_WEB_DIST 同源托管，零 CORS）。
   * **不接受 `*`**：见 parseCorsOrigins。
   */
  corsOrigins: string[];
  /**
   * Web 构建产物目录；空 = 不托管静态文件。
   * 设置后由本进程直接托管 SPA（同源），浏览器不必跨源，也就不需要 CORS。
   */
  webDist: string;
}

const HOUR = 60 * 60 * 1000;

/**
 * 解析 `TRINE_CORS_ORIGINS`：逗号分隔的 origin 清单。
 *
 * **通配 `*` 被硬拒绝而不是静默接受**。这里放行的端点里有 `/auth/*`——
 * 换句话说是「谁可以拿本服务的挑战串去签名换 token」。`*` 意味着任何网页
 * 都能从访客浏览器里对它发起请求；写这个值的人几乎总是「先跑通再说」，
 * 而这种临时配置最后都留在了生产。要开就明确列出来。
 *
 * 每一项必须是**纯 origin**（scheme://host[:port]，无路径无尾斜杠）——
 * `Origin` 请求头就长这样，带路径的配置永远匹配不上，与其让人对着
 * 「配了却不生效」排查半天，不如启动即报错。
 */
export function parseCorsOrigins(raw: string): string[] {
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  assertCorsOrigins(items);
  return items;
}

/** corsOrigins 每一项的合法性校验（解析路径与 overrides 路径共用） */
function assertCorsOrigins(items: readonly string[]): void {
  for (const item of items) {
    if (item === '*') {
      throw new Error(
        '配置不合法：TRINE_CORS_ORIGINS 不接受通配 `*`——放行的端点包含 ' +
          '/auth/*（换 token 的入口），必须逐个列出允许的 origin',
      );
    }
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new Error(
        `配置不合法：TRINE_CORS_ORIGINS 的 "${item}" 不是合法 origin，` +
          '格式应为 scheme://host[:port]，如 https://trine.example.com',
      );
    }
    if (url.origin !== item) {
      throw new Error(
        `配置不合法：TRINE_CORS_ORIGINS 的 "${item}" 必须是纯 origin ` +
          `（无路径、无尾斜杠），应写作 "${url.origin}"——Origin 请求头就长这样，` +
          '带路径的值永远匹配不上',
      );
    }
  }
}


/**
 * 配置不变量：不满足即抛错拒绝启动。
 *
 * 坏配置在这里一次性炸掉，好过带着一个会静默吞消息的组合跑上线。
 */
export function assertConfigInvariants(config: ServerConfig): void {
  // relayMaxPerStream 是「单条流留存多少帧」，parkedMaxPerMachine 是
  // 「一台机器最多排队多少帧」。若前者小于后者，排队帧就可能多到把自己
  // 挤出留存窗口——裁剪虽有 pending 保护子句兜底不会真删，但那意味着
  // 裁剪对这条流彻底失效、留存上限形同虚设。配置阶段就该排除这种组合。
  if (config.relayMaxPerStream < config.parkedMaxPerMachine) {
    throw new Error(
      `配置不合法：TRINE_RELAY_MAX_PER_STREAM (${config.relayMaxPerStream}) ` +
        `必须 >= TRINE_PARKED_MAX_PER_MACHINE (${config.parkedMaxPerMachine})，` +
        '否则排队中的帧会被留存裁剪挤出窗口',
    );
  }
  // 高水位是单调校验的基线，必须活得比留存久：基线先于帧蒸发的话，留存里
  // 还有 seq=N 的帧、基线却回到 fresh，下一帧任意 seq 成基线，单调语义失真
  if (config.hwmTtlMs <= config.relayRetentionMs) {
    throw new Error(
      `配置不合法：TRINE_HWM_TTL_MS (${config.hwmTtlMs}) ` +
        `必须 > TRINE_RELAY_TTL_MS (${config.relayRetentionMs})，` +
        '否则 seq 单调基线会先于留存帧被清理',
    );
  }
  if (config.idleTimeoutMs <= config.heartbeatIntervalMs) {
    throw new Error(
      `配置不合法：TRINE_IDLE_TIMEOUT_MS (${config.idleTimeoutMs}) ` +
        `必须 > TRINE_HEARTBEAT_MS (${config.heartbeatIntervalMs})，` +
        '否则连接会在第一次心跳前就被判空闲断开',
    );
  }
  // 只配一半的推送渠道会静默什么都不做——用户以为配好了，实际一条都收不到。
  // 这种「看起来在跑其实没跑」比启动失败难查得多，配置阶段就炸掉。
  if (Boolean(config.barkServerUrl) !== Boolean(config.barkDeviceKey)) {
    throw new Error(
      '配置不合法：TRINE_BARK_URL 与 TRINE_BARK_KEY 必须同时配置或同时留空，' +
        '只配一半会导致推送静默禁用',
    );
  }
  if (config.barkServerUrl && !/^https?:\/\//.test(config.barkServerUrl)) {
    throw new Error(
      `配置不合法：TRINE_BARK_URL 必须以 http:// 或 https:// 开头，实际：${config.barkServerUrl}`,
    );
  }
  // 再校验一次 corsOrigins：环境变量那条路径在 parseCorsOrigins 里已经校过，
  // 但 loadConfig 的 overrides（测试与嵌入式调用）是直接塞数组进来的，
  // 绕开了解析。校验放在不变量这一层，两条路径才都盖住。
  assertCorsOrigins(config.corsOrigins);
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const config = buildConfig(overrides);
  assertConfigInvariants(config);
  return config;
}

function buildConfig(overrides: Partial<ServerConfig>): ServerConfig {
  return {
    port: envInt('TRINE_PORT', 8787),
    hostname: process.env.TRINE_HOST ?? '127.0.0.1',
    dbPath: process.env.TRINE_DB ?? './trine.sqlite',

    challengeTtlMs: envInt('TRINE_CHALLENGE_TTL_MS', 2 * 60 * 1000),
    tokenTtlMs: envInt('TRINE_TOKEN_TTL_MS', 24 * HOUR),
    allowOpenRegistration: process.env.TRINE_OPEN_REGISTRATION === '1',

    heartbeatIntervalMs: envInt('TRINE_HEARTBEAT_MS', 30_000),
    idleTimeoutMs: envInt('TRINE_IDLE_TIMEOUT_MS', 90_000),
    pairingBeginGraceMs: envInt('TRINE_PAIRING_BEGIN_GRACE_MS', 10_000),

    relayRetentionMs: envInt('TRINE_RELAY_TTL_MS', 7 * 24 * HOUR),
    parkedTtlMs: envInt('TRINE_PARKED_TTL_MS', 24 * HOUR),
    relayMaxPerStream: envInt('TRINE_RELAY_MAX_PER_STREAM', 2000),
    hwmTtlMs: envInt('TRINE_HWM_TTL_MS', 90 * 24 * HOUR),
    parkedMaxPerMachine: envInt('TRINE_PARKED_MAX_PER_MACHINE', 500),

    sweepIntervalMs: envInt('TRINE_SWEEP_MS', 5 * 60 * 1000),

    authFailWindowMs: envInt('TRINE_AUTH_FAIL_WINDOW_MS', 10 * 60 * 1000),
    authFailMaxAttempts: envInt('TRINE_AUTH_FAIL_MAX', 20),
    trustProxyHeader: process.env.TRINE_TRUST_PROXY !== '0',

    barkServerUrl: (process.env.TRINE_BARK_URL ?? '').trim(),
    barkDeviceKey: (process.env.TRINE_BARK_KEY ?? '').trim(),
    pushTimeoutMs: envInt('TRINE_PUSH_TIMEOUT_MS', 5_000),
    pushSuppressWhenOnline: process.env.TRINE_PUSH_SUPPRESS_ONLINE !== '0',
    pushDedupeWindowMs: envInt('TRINE_PUSH_DEDUPE_MS', 30_000),
    pushAliases: process.env.TRINE_PUSH_ALIAS ?? '',

    corsOrigins: parseCorsOrigins(process.env.TRINE_CORS_ORIGINS ?? ''),
    webDist: (process.env.TRINE_WEB_DIST ?? '').trim(),

    ...overrides,
  };
}

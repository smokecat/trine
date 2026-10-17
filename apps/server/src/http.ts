/**
 * HTTP 路由（Hono）：认证端点 + 健康检查 + 设备管理。
 *
 * 这里**没有任何**读写会话内容的端点——服务端读不了密文，也就不该有
 * 「查会话」「看消息」这类 API。能提供的只有认证与设备元数据。
 */
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { ANONYMOUS_SOURCE, type AuthService } from './auth/index.ts';
import type { Store } from './store/index.ts';

const RegisterBody = z.object({
  deviceId: z.string().min(1).max(128),
  role: z.enum(['client', 'agent']),
  signPubKey: z.string().min(1).max(128),
});

const ChallengeBody = z.object({
  deviceId: z.string().min(1).max(128),
});

const VerifyBody = z.object({
  deviceId: z.string().min(1).max(128),
  challenge: z.string().min(1).max(128),
  signature: z.string().min(1).max(256),
});

/** 认证错误 → HTTP 状态码 */
const STATUS: Record<string, 400 | 401 | 403 | 404 | 409 | 429> = {
  unknown_device: 401,
  device_revoked: 403,
  invalid_challenge: 401,
  bad_signature: 401,
  rate_limited: 429,
  invalid_public_key: 400,
  registration_closed: 403,
  device_exists_with_other_key: 409,
  role_mismatch: 409,
};

export interface HttpDeps {
  auth: AuthService;
  store: Store;
  /** 在线 agent 判定，健康检查/设备列表用 */
  isAgentOnline: (machineId: string) => boolean;
  version: string;
  /**
   * 是否信任反代注入的客户端 IP 头。
   * 默认 true——本服务的既定部署形态就是 Caddy 反代 + 只听回环
   * （见 deploy/）。若把进程直接暴露到公网，必须置 false，
   * 否则任何人都能自带一个头伪造来源、绕开按来源的限流。
   */
  trustProxyHeader?: boolean;
  /**
   * 允许跨源访问 API 端点的 origin 清单（`TRINE_CORS_ORIGINS`）。
   * 空/省略 = 一个 CORS 头都不发，与加本功能之前完全一致。
   */
  corsOrigins?: readonly string[];
  /**
   * Web 构建产物目录（`TRINE_WEB_DIST`）。空/省略 = 不托管静态文件。
   */
  webDist?: string;
}

/** 走 API 语义、**不该**被 SPA fallback 吞掉的路径前缀 */
const API_PREFIXES = ['/auth', '/ws', '/healthz', '/devices'] as const;

/**
 * 静态响应的安全头。
 *
 * - `script-src 'self' 'wasm-unsafe-eval'`：libsodium 是 WebAssembly，
 *   没有 wasm-unsafe-eval 浏览器会**静默**回落到 asm.js 慢路径（或直接失败），
 *   排查成本极高。它只放行 wasm 编译，不等于 `unsafe-eval`。
 * - `style-src 'unsafe-inline'`：Tailwind/shadcn 在运行时注入内联样式
 *   （CSS 变量与动画），这是现实需要；样式注入的危害面远小于脚本。
 * - `connect-src 'self'`：同源托管形态下 WS 与 API 都走本源，不需要通配
 *   `wss:`——通配等于允许页面往任意主机发数据，与零知识的取向相悖。
 *   分离部署（SPA 在别处）时页面不由本服务发出，本头也管不到它。
 * - `img-src`/`media-src` 的 blob: 给本地生成的图片/音视频预览留口子；
 *   `worker-src blob:` 给打包器产出的 worker。
 * - `object-src 'none'` / `base-uri 'self'` / `frame-ancestors 'none'`：
 *   分别堵掉插件、<base> 劫持相对路径、被第三方页面内嵌点击劫持。
 */
const STATIC_SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  // 防止浏览器把 .js/.json 按嗅探结果当别的类型执行
  'x-content-type-options': 'nosniff',
};

export function createHttpApp(deps: HttpDeps): Hono {
  const app = new Hono();

  // ---- CORS：只为「SPA 与服务端分离部署」而存在 ----
  //
  // 默认形态是 TRINE_WEB_DIST 同源托管，那时浏览器根本不跨源，一个头都不该发。
  // 需要它的是把 SPA 放在另一个域（对象存储/CDN/另一台前端机）的部署。
  // 本机开发也不靠它——web 的 vite dev server 把 /auth /ws 等反代到本服务，
  // 开发期同样是同源（见 apps/web/README.md）。
  //
  // 清单为空 = 不注册中间件，行为与加本功能之前逐字节一致。
  const corsOrigins = deps.corsOrigins ?? [];
  if (corsOrigins.length > 0) {
    const allowed = new Set(corsOrigins);
    const middleware = cors({
      // 逐个比对而不是交给通配：命中才回 origin，未命中返回 null
      // （hono 据此不发 Access-Control-Allow-Origin），浏览器照常拦下。
      origin: (origin) => (allowed.has(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['content-type', 'authorization'],
      // **不开 credentials**：认证走 Authorization 头里的 bearer token，
      // 不靠 cookie。不发 cookie 也就没有 CSRF 面。
      credentials: false,
    });
    // 只挂在这三处；/ws 的跨源控制在升级那一层（server.ts），不归 CORS 管
    app.use('/auth/*', middleware);
    app.use('/healthz', middleware);
    app.use('/devices', middleware);
  }

  app.get('/healthz', (c) =>
    c.json({ ok: true, version: deps.version, at: Date.now() }),
  );

  app.post('/auth/register', async (c) => {
    const parsed = RegisterBody.safeParse(await safeJson(c.req.raw));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const { deviceId, role, signPubKey } = parsed.data;
    // HTTP 端点只承载 bootstrap 与手工开窗两条路径：空库首设备是 bootstrap，
    // 其余一律记为 open（真放行与否由 auth.register 按 allowOpenRegistration 决定）。
    // 配对登记不走这里——它由 hub 在 agent 背书后直接调 register(..., 'pairing')。
    const via = deps.store.countDevices() === 0 ? 'bootstrap' : 'open';
    const result = deps.auth.register(deviceId, role, signPubKey, via);
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]!);
    return c.json({ deviceId, created: result.value.created });
  });

  app.post('/auth/challenge', async (c) => {
    const parsed = ChallengeBody.safeParse(await safeJson(c.req.raw));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const result = deps.auth.issueChallenge(
      parsed.data.deviceId,
      clientSource(c.req.raw, deps.trustProxyHeader),
    );
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]!);
    return c.json(result.value);
  });

  app.post('/auth/verify', async (c) => {
    const parsed = VerifyBody.safeParse(await safeJson(c.req.raw));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const { deviceId, challenge, signature } = parsed.data;
    const result = deps.auth.verify(
      deviceId,
      challenge,
      signature,
      clientSource(c.req.raw, deps.trustProxyHeader),
    );
    if (!result.ok) return c.json({ error: result.error }, STATUS[result.error]!);
    return c.json(result.value);
  });

  /** 设备列表：只回元数据，且**不含任何公钥/密钥材料** */
  app.get('/devices', (c) => {
    const token = bearer(c.req.header('authorization'));
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    const authed = deps.auth.authenticateToken(token);
    if (!authed.ok) return c.json({ error: 'unauthorized' }, 401);

    return c.json({
      devices: deps.store.listDevices().map((d) => ({
        deviceId: d.deviceId,
        role: d.role,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        revoked: d.revokedAt !== null,
        online: d.role === 'agent' ? deps.isAgentOnline(d.deviceId) : undefined,
      })),
    });
  });

  mountWebDist(app, deps.webDist ?? '');

  return app;
}

/**
 * 挂载 SPA 静态托管（`TRINE_WEB_DIST`）。
 *
 * 挂在全部 API 路由**之后**：Hono 按注册顺序匹配，先注册的 /auth 等拿到
 * 自己的请求，剩下的才落到静态层。这也是 fallback 不会吞掉 API 404 的
 * 第一道保证（第二道是 API_PREFIXES 显式排除，见下）。
 *
 * `/ws` 不经这里——server.ts 的 fetch 在进 Hono 之前就把它分流了。
 */
function mountWebDist(app: Hono, webDist: string): void {
  if (webDist === '') return;

  const withSecurityHeaders = (c: { header: (k: string, v: string) => void }) => {
    for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
      c.header(name, value);
    }
  };

  app.use(
    '*',
    serveStatic({
      root: webDist,
      onFound: (_path, c) => withSecurityHeaders(c),
    }),
  );

  // SPA fallback：静态层没命中的 GET 回 index.html，让前端路由接管
  // （/s/:machineId/:sessionId 这类深链直接刷新也要能进来）。
  //
  // 三道闸：
  // 1. 只对 GET——POST /auth/xxx 打错路径该是 404，不是一张 HTML；
  // 2. 排除 API 前缀——`/auth/verify` 拼错成 `/auth/verify` 时必须回
  //    404 JSON，回 HTML 会让客户端把 `<!doctype` 当 JSON 解析，
  //    错误现场面目全非；
  // 3. index.html 读不出来（目录配错）时不伪造 200，交给下游 404。
  app.get('*', async (c, next) => {
    if (API_PREFIXES.some((p) => c.req.path === p || c.req.path.startsWith(`${p}/`))) {
      return next();
    }
    const index = Bun.file(`${webDist.replace(/\/+$/, '')}/index.html`);
    if (!(await index.exists())) return next();
    withSecurityHeaders(c);
    c.header('content-type', 'text/html; charset=utf-8');
    return c.body(await index.arrayBuffer());
  });
}

/**
 * 提取客户端来源标识，用作按来源的限流 key（S1）。
 *
 * 部署形态是 Caddy 反代 + 进程只听回环，直连的 remote address 恒为
 * 127.0.0.1，毫无区分度，所以必须读反代注入的头。**这只在信任反代时成立**：
 * 直接暴露进程时任何人都能自带一个 X-Forwarded-For 伪造来源，
 * 那还不如退回统一占位（限流退化成按 deviceId，但至少不被伪造牵着走）。
 *
 * ## X-Forwarded-For 为什么取「最右」而非「最左」
 *
 * XFF 是逗号分隔的链，方向是「越靠左越远、越靠右越近」：每一跳代理把它
 * 看到的对端 IP **追加到链末尾**。客户端可以自带一个 XFF 值发进来，反代
 * 不会覆盖它，只会在后面追加真实 socket IP，于是链变成
 * `<客户端伪造的任意值>, <反代看到的真实客户端 IP>`。
 *
 * 取**最左**等于把这个完全由攻击者控制的值当来源——单个 IP 就能伪造无限
 * 多来源，绕开任何按来源的限流（S1 认证失败限流、pairing 每源配额都栽在
 * 这里）。**能信任的只有紧邻本服务那一跳反代刚追加进去的值，也就是链的
 * 最右**。`trustProxyHeader` 的语义正是「信任正前方那一跳反代注入的值」，
 * 单跳 Caddy 部署下最右就是真实客户端 IP；攻击者往左塞什么都不影响。
 *
 * 多级代理（本服务前面不止一跳可信反代）下，可信的是「从右数第 N 跳」，
 * 需要一个可配置的可信跳数才能精确定位——当前部署恒为单跳 Caddy，
 * `.at(-1)` 足够且正确，故不引入该配置。
 * TODO(多跳): 若将来出现多级可信反代，加 `trustedProxyHops` 从右数第 K 个取值。
 *
 * x-real-ip 分支：仅作 XFF 缺失时的回退。它**依赖反代把该头覆盖为单值真实
 * IP、而非透传客户端自带值**——这属反代配置（本仓库 Caddyfile 未设它，
 * 故正常路径永远走 XFF），本函数无从校验，取用时按单值来源对待。
 */
export function clientSource(req: Request, trustProxyHeader = true): string {
  if (!trustProxyHeader) return ANONYMOUS_SOURCE;
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    // 取最右：紧邻本服务的那一跳反代刚追加的真实客户端 IP，
    // 攻击者往链左侧塞任何值都影响不到它。
    const nearest = forwarded.split(',').at(-1)?.trim();
    if (nearest) return nearest;
  }
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  return ANONYMOUS_SOURCE;
}

export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
  return value;
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

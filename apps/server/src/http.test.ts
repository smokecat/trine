/**
 * clientSource 取值与「按来源限流不被伪造 XFF 头绕过」的回归测试。
 *
 * 背景 bug：clientSource 曾取 X-Forwarded-For 的**最左**值。XFF 每跳追加、
 * 最左恒由客户端可控，于是单个攻击者只要每次换一个左位 XFF 值，就换一个
 * 限流桶——认证失败限流（S1）与 pairing 每源配额（pairing-e2e）双双失效。
 * 修复改取**最右**（紧邻本服务那一跳反代刚追加的真实客户端 IP）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authChallengeMessage,
  generateSignKeyPair,
  signDetached,
  sodiumReady,
  type SignKeyPair,
} from '@trine/core/crypto';
import { AuthService, ANONYMOUS_SOURCE } from './auth/index.ts';
import { loadConfig, parseCorsOrigins, type ServerConfig } from './config.ts';
import { clientSource, createHttpApp } from './http.ts';
import { isWsOriginAllowed } from './server.ts';
import { Store } from './store/index.ts';

/** 造一个只带指定头的请求，用于喂 clientSource */
function reqWith(headers: Record<string, string>): Request {
  return new Request('https://trine.example.com/auth/verify', {
    method: 'POST',
    headers,
  });
}

describe('clientSource', () => {
  test('取 X-Forwarded-For 链的最右值（攻击者伪造的最左被忽略）', () => {
    // 链 = <攻击者伪造> , <反代追加的真实 IP>；取最右
    const src = clientSource(
      reqWith({ 'x-forwarded-for': '1.2.3.4, 198.51.100.9' }),
      true,
    );
    expect(src).toBe('198.51.100.9');
  });

  test('多跳链仍取最右', () => {
    const src = clientSource(
      reqWith({ 'x-forwarded-for': 'evil, 10.0.0.1, 198.51.100.9' }),
      true,
    );
    expect(src).toBe('198.51.100.9');
  });

  test('单值链原样返回', () => {
    expect(
      clientSource(reqWith({ 'x-forwarded-for': '203.0.113.5' }), true),
    ).toBe('203.0.113.5');
  });

  test('空/纯空白链回退（走 x-real-ip，否则匿名）', () => {
    // 最右段是空白 → 跳过 XFF，回退 x-real-ip
    expect(
      clientSource(
        reqWith({ 'x-forwarded-for': '1.2.3.4, ', 'x-real-ip': '198.51.100.2' }),
        true,
      ),
    ).toBe('198.51.100.2');
    // XFF 完全为空且无 x-real-ip → 匿名占位
    expect(clientSource(reqWith({ 'x-forwarded-for': '' }), true)).toBe(
      ANONYMOUS_SOURCE,
    );
  });

  test('x-real-ip 作为 XFF 缺失时的回退', () => {
    expect(clientSource(reqWith({ 'x-real-ip': '198.51.100.3' }), true)).toBe(
      '198.51.100.3',
    );
  });

  test('trustProxyHeader=false 一律匿名（不信任任何头）', () => {
    expect(
      clientSource(
        reqWith({ 'x-forwarded-for': '198.51.100.9', 'x-real-ip': '198.51.100.3' }),
        false,
      ),
    ).toBe(ANONYMOUS_SOURCE);
  });

  test('无任何来源头时返回匿名占位', () => {
    expect(clientSource(reqWith({}), true)).toBe(ANONYMOUS_SOURCE);
  });
});

describe('认证失败限流不被伪造 XFF 头绕过', () => {
  let store: Store;
  let auth: AuthService;
  let config: ServerConfig;
  let kp: SignKeyPair;
  const DEVICE = 'mbp';
  const REAL_IP = '198.51.100.9';

  beforeAll(async () => {
    await sodiumReady();
    kp = generateSignKeyPair();
  });

  beforeEach(() => {
    store = new Store(':memory:');
    config = loadConfig({
      dbPath: ':memory:',
      challengeTtlMs: 60_000,
      tokenTtlMs: 3600_000,
      authFailMaxAttempts: 3,
      authFailWindowMs: 60_000,
      allowOpenRegistration: true,
    });
    auth = new AuthService(store, config);
    auth.register(DEVICE, 'agent', kp.publicKey, 'bootstrap');
  });

  /**
   * 拿一个当前有效挑战串，配一个**错误**签名（另一密钥）打 verify，
   * 断言必然失败并返回错误码（bad_signature 或 rate_limited）。
   */
  function badVerifyOnce(source: string): string {
    const ch = auth.issueChallenge(DEVICE, source);
    if (!ch.ok) throw new Error(`challenge failed: ${ch.error}`);
    const wrongKey = generateSignKeyPair();
    const wrongSig = signDetached(
      authChallengeMessage(DEVICE, ch.value.challenge),
      wrongKey.secretKey,
    );
    const r = auth.verify(DEVICE, ch.value.challenge, wrongSig, source);
    if (r.ok) throw new Error('expected verify to fail');
    return r.error;
  }

  test('攻击者每次换左位 XFF、真实 IP 恒在最右 → 仍聚合到同一桶、算得满阈值', () => {
    // 模拟攻击者用同一 socket（真实 IP 恒 REAL_IP，被反代追加到 XFF 末尾），
    // 每次请求自带一个不同的左位 XFF 值。clientSource 取最右，故所有请求的
    // source 都收敛到 REAL_IP。authFailMaxAttempts=3：第 3 次签名失败后，
    // 第 4 次（即便再换左位）必须被限流拒绝。
    const forgedLeft = ['aaa', 'bbb', 'ccc', 'ddd'];
    const sources = forgedLeft.map((left) =>
      clientSource(
        reqWith({ 'x-forwarded-for': `${left}, ${REAL_IP}` }),
        true,
      ),
    );
    // 所有伪造前缀都收敛到同一真实来源
    expect(new Set(sources).size).toBe(1);
    expect(sources[0]).toBe(REAL_IP);

    // 前 3 次：签名失败被记数
    for (let i = 0; i < 3; i++) {
      expect(badVerifyOnce(sources[i]!)).toBe('bad_signature');
    }
    // 第 4 次：桶已满，即便换了左位 XFF 也被限流
    expect(badVerifyOnce(sources[3]!)).toBe('rate_limited');
  });

  test('对照：真取最左（旧 bug 行为）本可无限绕过 —— 现在取最右后不同左位不再拆桶', () => {
    // 若取最左，下面三个来源会是 aaa/bbb/ccc 三个不同桶，永远算不满；
    // 取最右后三者同为 REAL_IP，同一桶累计。
    const s1 = clientSource(reqWith({ 'x-forwarded-for': `aaa, ${REAL_IP}` }), true);
    const s2 = clientSource(reqWith({ 'x-forwarded-for': `bbb, ${REAL_IP}` }), true);
    const s3 = clientSource(reqWith({ 'x-forwarded-for': `ccc, ${REAL_IP}` }), true);
    expect([s1, s2, s3]).toEqual([REAL_IP, REAL_IP, REAL_IP]);

    expect(badVerifyOnce(s1)).toBe('bad_signature');
    expect(badVerifyOnce(s2)).toBe('bad_signature');
    expect(badVerifyOnce(s3)).toBe('bad_signature');
    // 第 4 次任何左位都被拦
    expect(
      badVerifyOnce(
        clientSource(reqWith({ 'x-forwarded-for': `zzz, ${REAL_IP}` }), true),
      ),
    ).toBe('rate_limited');
  });
});

// ---------------------------------------------------------------------------
// Web 客户端接入：CORS 允许清单 + SPA 静态托管
// ---------------------------------------------------------------------------

/** 造一个只有认证依赖的 Hono app，用于打 HTTP 端点 */
function appWith(
  extra: Partial<Parameters<typeof createHttpApp>[0]> = {},
): ReturnType<typeof createHttpApp> {
  const store = new Store(':memory:');
  const config = loadConfig({ dbPath: ':memory:', allowOpenRegistration: true });
  return createHttpApp({
    auth: new AuthService(store, config),
    store,
    isAgentOnline: () => false,
    version: 'test',
    ...extra,
  });
}

const ORIGIN = 'https://web.example.com';

describe('CORS 允许清单（TRINE_CORS_ORIGINS）', () => {
  test('默认（未配置）：一个 CORS 头都不发', async () => {
    const res = await appWith().request('/healthz', {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('配置后：允许清单内的 origin 拿到回头', async () => {
    const app = appWith({ corsOrigins: [ORIGIN] });
    for (const path of ['/healthz', '/devices', '/auth/challenge']) {
      const res = await app.request(path, { headers: { origin: ORIGIN } });
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      // Vary: Origin 必须有——否则中间缓存会把某一 origin 的响应
      // （带它的 ACAO 头）喂给另一个 origin
      expect(res.headers.get('vary') ?? '').toContain('Origin');
    }
  });

  test('未列入清单的 origin 不回 ACAO 头（浏览器照常拦下）', async () => {
    const res = await appWith({ corsOrigins: [ORIGIN] }).request('/healthz', {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('OPTIONS 预检：带 Authorization 的跨源请求被放行', async () => {
    const res = await appWith({ corsOrigins: [ORIGIN] }).request('/devices', {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const allowHeaders = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    expect(allowHeaders).toContain('authorization');
    expect(allowHeaders).toContain('content-type');
    expect(res.headers.get('access-control-allow-methods') ?? '').toContain('POST');
    // 不开 credentials：认证走 bearer token，不靠 cookie，也就没有 CSRF 面
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  test('通配 `*` 是配置错误，不被静默接受', () => {
    expect(() => parseCorsOrigins('*')).toThrow(/通配/);
    expect(() => parseCorsOrigins(`${ORIGIN},*`)).toThrow(/通配/);
    // overrides 路径（绕开解析）同样被不变量挡下
    expect(() => loadConfig({ dbPath: ':memory:', corsOrigins: ['*'] })).toThrow(
      /通配/,
    );
  });

  test('非纯 origin（带路径/尾斜杠）报配置错误而不是静默不生效', () => {
    expect(() => parseCorsOrigins('https://web.example.com/')).toThrow(/纯 origin/);
    expect(() => parseCorsOrigins('https://web.example.com/app')).toThrow(/纯 origin/);
    expect(() => parseCorsOrigins('not-a-url')).toThrow(/合法 origin/);
  });

  test('空串与多余逗号/空格被忽略', () => {
    expect(parseCorsOrigins('')).toEqual([]);
    expect(parseCorsOrigins('  ,  ')).toEqual([]);
    expect(parseCorsOrigins(` ${ORIGIN} , http://localhost:5173 `)).toEqual([
      ORIGIN,
      'http://localhost:5173',
    ]);
  });
});

describe('SPA 静态托管（TRINE_WEB_DIST）', () => {
  let dist: string;

  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), 'trine-webdist-'));
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>trine</title>');
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(join(dist, 'assets', 'app.js'), 'export const x = 1;\n');
  });

  afterEach(async () => {
    await rm(dist, { recursive: true, force: true });
  });

  test('默认（未配置）：不托管任何静态文件', async () => {
    expect((await appWith().request('/')).status).toBe(404);
  });

  test('直达：index.html 与 asset 各自命中真实文件', async () => {
    const app = appWith({ webDist: dist });

    const index = await app.request('/index.html');
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<title>trine</title>');

    const asset = await app.request('/assets/app.js');
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('export const x = 1;');
  });

  test('SPA fallback：未命中的 GET 深链回 index.html', async () => {
    const res = await appWith({ webDist: dist }).request('/s/mbp/sess-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
    expect(await res.text()).toContain('<title>trine</title>');
  });

  test('API 路径不被 fallback 吞掉（打错路径要看得见真错误）', async () => {
    const app = appWith({ webDist: dist });

    // GET /auth/xxx 不存在 → 404，不是一张 HTML
    const authGet = await app.request('/auth/nope');
    expect(authGet.status).toBe(404);
    expect(await authGet.text()).not.toContain('<title>trine</title>');

    // /devices 无 token → 依旧是 401 JSON
    const devices = await app.request('/devices');
    expect(devices.status).toBe(401);
    expect(await devices.json()).toEqual({ error: 'unauthorized' });

    // /healthz 依旧是 JSON
    expect(await (await app.request('/healthz')).json()).toMatchObject({ ok: true });

    // POST 一律不走 fallback
    expect((await app.request('/auth/verify', { method: 'POST' })).status).toBe(400);
    expect((await app.request('/anything', { method: 'POST' })).status).toBe(404);
  });

  test('静态与 fallback 响应都带 CSP 与 nosniff', async () => {
    const app = appWith({ webDist: dist });
    for (const path of ['/index.html', '/assets/app.js', '/s/mbp/sess-1']) {
      const res = await app.request(path);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'self'");
      // libsodium 是 WebAssembly：缺这一条浏览器会静默回落 asm.js
      expect(csp).toContain("'wasm-unsafe-eval'");
      // Tailwind/shadcn 的运行时内联样式
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("frame-ancestors 'none'");
      // connect-src 收紧到同源，不放通配 wss:
      expect(csp).toContain("connect-src 'self'");
      expect(csp).not.toContain('wss:');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  test('路径穿越拿不到 dist 之外的文件', async () => {
    const outside = join(dist, '..', 'trine-secret.txt');
    await writeFile(outside, 'secret');
    try {
      const res = await appWith({ webDist: dist }).request('/../trine-secret.txt');
      expect(await res.text()).not.toContain('secret');
    } finally {
      await rm(outside, { force: true });
    }
  });
});

describe('WS 升级 Origin 允许清单', () => {
  const cfg = (over: Partial<ServerConfig> = {}) =>
    loadConfig({ dbPath: ':memory:', ...over });

  /** 造一个带指定头的 /ws 升级请求 */
  const wsReq = (headers: Record<string, string>) =>
    new Request('http://trine.example.com/ws', { headers });

  test('两项 Web 配置都没开 → 一律放行（纯 API 中转，行为不变）', () => {
    const c = cfg();
    expect(isWsOriginAllowed(wsReq({}), c)).toBe(true);
    // 连恶意 origin 也放行——这个部署形态下压根没有浏览器客户端，
    // 加检查只会平白多一个出错面
    expect(isWsOriginAllowed(wsReq({ origin: 'https://evil.example.com' }), c)).toBe(
      true,
    );
  });

  test('无 Origin 头放行（agent / CLI 不带这个头）', () => {
    expect(isWsOriginAllowed(wsReq({}), cfg({ corsOrigins: [ORIGIN] }))).toBe(true);
    expect(isWsOriginAllowed(wsReq({}), cfg({ webDist: '/srv/web' }))).toBe(true);
  });

  test('清单内的 origin 放行', () => {
    const c = cfg({ corsOrigins: [ORIGIN, 'http://localhost:5173'] });
    expect(isWsOriginAllowed(wsReq({ origin: ORIGIN }), c)).toBe(true);
    expect(isWsOriginAllowed(wsReq({ origin: 'http://localhost:5173' }), c)).toBe(true);
  });

  test('同源放行：Origin 的 host 等于 Host 头（WEB_DIST 托管时清单常为空）', () => {
    const c = cfg({ webDist: '/srv/web' });
    expect(
      isWsOriginAllowed(
        wsReq({ origin: 'https://trine.example.com', host: 'trine.example.com' }),
        c,
      ),
    ).toBe(true);
    // 比的是 host 不是整个 origin：反代终止 TLS 后本进程不知道外部用的是
    // http 还是 https，拿 scheme 比必然误判
    expect(
      isWsOriginAllowed(
        wsReq({ origin: 'http://trine.example.com', host: 'trine.example.com' }),
        c,
      ),
    ).toBe(true);
    // 端口也算 host 的一部分
    expect(
      isWsOriginAllowed(
        wsReq({ origin: 'http://localhost:5173', host: 'localhost:8787' }),
        c,
      ),
    ).toBe(false);
  });

  test('清单外的外部 origin 被拒', () => {
    const c = cfg({ corsOrigins: [ORIGIN], webDist: '/srv/web' });
    for (const origin of [
      'https://evil.example.com',
      // 同名前缀不算同源
      'https://web.example.com.evil.io',
      'null',
    ]) {
      expect({
        origin,
        allowed: isWsOriginAllowed(
          wsReq({ origin, host: 'trine.example.com' }),
          c,
        ),
      }).toEqual({ origin, allowed: false });
    }
  });

  test('拦的正是 pairing 那条免认证连接的滥用路径', () => {
    // pairing 角色免认证，任意网页都能借访客浏览器开一批连接；每源配额
    // 按 IP 算，而访客们的 IP 各不相同，配额拦不住。Origin 是唯一能识别
    // 「这是哪个网页发起的」的线索。
    const c = cfg({ webDist: '/srv/web' });
    expect(
      isWsOriginAllowed(
        wsReq({ origin: 'https://attacker.example', host: 'trine.example.com' }),
        c,
      ),
    ).toBe(false);
  });
});

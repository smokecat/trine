/**
 * `@trine/core/net` 的单测：地址推导 + 认证客户端的挑战-应答往返。
 *
 * 地址推导用例自 `apps/agent/src/net/ws-client.test.ts` 随函数迁来（下沉
 * core 供 web 复用）；AuthClient 此前无独立测试，趁下沉一并补上——它现在
 * 是三端共用件，签名串和错误分类改坏了会同时打断 agent 与 web。
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import {
  authChallengeMessage,
  generateSignKeyPair,
  sodiumReady,
  verifyDetached,
  type SignKeyPair,
} from '../crypto/index.ts';
import { AuthClient, AuthClientError, httpBase, wsEndpoint } from './index.ts';

let signKeys: SignKeyPair;

beforeAll(async () => {
  await sodiumReady();
  signKeys = generateSignKeyPair();
});

describe('地址推导', () => {
  test('wss/https 互转，端点补 /ws', () => {
    expect(wsEndpoint('https://trine.example.com')).toBe(
      'wss://trine.example.com/ws',
    );
    expect(wsEndpoint('wss://trine.example.com/')).toBe(
      'wss://trine.example.com/ws',
    );
    expect(httpBase('wss://trine.example.com')).toBe('https://trine.example.com');
  });

  test('本地开发的 http/ws 同样成立', () => {
    expect(wsEndpoint('http://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/ws');
    expect(httpBase('ws://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  });
});

/** 记录请求并按路径回固定响应的 fetch 替身 */
function stubFetch(
  handler: (path: string, body: Record<string, unknown>) => Response,
): { fetchImpl: typeof fetch; calls: { path: string; body: Record<string, unknown> }[] } {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: unknown, init?: { body?: unknown }) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, body });
    return handler(path, body);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('AuthClient', () => {
  const make = (fetchImpl: typeof fetch) =>
    new AuthClient({
      // 带尾斜杠：构造函数应当剥掉，否则拼出 `//auth/challenge`
      baseUrl: 'https://trine.example.com/',
      deviceId: 'phone',
      signKeys,
      fetchImpl,
    });

  test('authenticate：挑战 → 签名应答 → token，签名对 core 的待签名串成立', async () => {
    const { fetchImpl, calls } = stubFetch((path) => {
      if (path === '/auth/challenge') {
        return json({ challenge: 'chal-1', expiresAt: 9_999 });
      }
      return json({ token: 'tok-1', expiresAt: 12_345 });
    });

    const token = await make(fetchImpl).authenticate();
    expect(token).toEqual({ token: 'tok-1', expiresAt: 12_345 });
    expect(calls.map((c) => c.path)).toEqual(['/auth/challenge', '/auth/verify']);

    // 待签名串必须是 core 的 authChallengeMessage(deviceId, challenge)，
    // 而不是本地另拼一个——服务端就是按这个逐字节验的
    const verify = calls[1]!.body;
    expect(verify['deviceId']).toBe('phone');
    expect(verify['challenge']).toBe('chal-1');
    expect(
      verifyDetached(
        authChallengeMessage('phone', 'chal-1'),
        String(verify['signature']),
        signKeys.publicKey,
      ),
    ).toBe(true);
  });

  test('非 2xx 抛 AuthClientError，带上服务端的机器可读 error', async () => {
    const { fetchImpl } = stubFetch(() => json({ error: 'unknown_device' }, 401));
    const err = await make(fetchImpl)
      .challenge()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthClientError);
    expect((err as AuthClientError).status).toBe(401);
    expect((err as AuthClientError).reason).toBe('unknown_device');
  });

  test('bootstrap：已注册设备直接认证，不调用注册', async () => {
    const { fetchImpl, calls } = stubFetch((path) => {
      if (path === '/auth/register') return json({ error: 'registration_closed' }, 403);
      if (path === '/auth/challenge') return json({ challenge: 'chal-2', expiresAt: 1 });
      return json({ token: 'tok-2', expiresAt: 2 });
    });
    expect(await make(fetchImpl).bootstrap()).toEqual({ token: 'tok-2', expiresAt: 2 });
    expect(calls.map((c) => c.path)).toEqual([
      '/auth/challenge',
      '/auth/verify',
    ]);
  });

  test('bootstrap：非「已登记」类的注册错误照常抛出', async () => {
    const { fetchImpl } = stubFetch((path) =>
      path === '/auth/register' ? json({ error: 'rate_limited' }, 429) : json({ error: 'unknown_device' }, 401),
    );
    const err = await make(fetchImpl)
      .bootstrap()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthClientError);
    expect((err as AuthClientError).reason).toBe('rate_limited');
  });
});

describe('AuthClient · 默认 fetch 的 this 绑定（回归：浏览器 Illegal invocation）', () => {
  test('不注入 fetchImpl 时，全局 fetch 以 globalThis 为 this 被调用', async () => {
    // 浏览器里 window.fetch 对 this 敏感：以 AuthClient 实例为 this 调用会抛 Illegal invocation。
    // Bun 不校验 this，这里用一个记录 this 的替身来断言绑定本身。
    const original = globalThis.fetch;
    let seenThis: unknown = 'unset';
    globalThis.fetch = function (this: unknown) {
      seenThis = this;
      return Promise.resolve(json({ challenge: 'c', expiresAt: 1 }));
    } as unknown as typeof fetch;
    try {
      const client = new AuthClient({ baseUrl: 'https://trine.example.com', deviceId: 'phone', signKeys });
      await client.challenge();
      expect(seenThis).toBe(globalThis);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('AuthClient · signal 透传（评审 N3：认证不能是永久黑洞）', () => {
  /**
   * 移动网络的半开连接里 `fetch` 可以永不 settle——调用方（web 的
   * Connection）要靠 AbortSignal 给它一个超时兜底。这里的替身**真的响应
   * signal**（`addEventListener('abort')` 后 reject），和真 fetch 同形；
   * 只断言「signal 被原样交给了 fetch」而不真的挂起，测试才不会自己变慢。
   */
  function hangingFetch(): { fetchImpl: typeof fetch; seen: (AbortSignal | undefined)[] } {
    const seen: (AbortSignal | undefined)[] = [];
    const fetchImpl = (async (_input: unknown, init?: { signal?: AbortSignal }) => {
      seen.push(init?.signal);
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined) return; // 永不 settle：正是要修的那个黑洞
        if (signal.aborted) return void reject(new DOMException('aborted', 'AbortError'));
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  }

  const client = (fetchImpl: typeof fetch): AuthClient =>
    new AuthClient({ baseUrl: 'https://trine.example.com', deviceId: 'phone', signKeys, fetchImpl });

  test('authenticate({ signal })：abort 后 promise 真的 reject（不再永久挂起）', async () => {
    const { fetchImpl, seen } = hangingFetch();
    const ac = new AbortController();
    const promise = client(fetchImpl).authenticate({ signal: ac.signal });
    ac.abort();
    await expect(promise).rejects.toThrow(/abort/i);
    expect(seen[0]).toBe(ac.signal);
  });

  test('challenge / verify / register / bootstrap 都透传 signal', async () => {
    for (const call of [
      (c: AuthClient, s: AbortSignal) => c.challenge({ signal: s }),
      (c: AuthClient, s: AbortSignal) => c.verify('chal', { signal: s }),
      (c: AuthClient, s: AbortSignal) => c.register('client', { signal: s }),
      (c: AuthClient, s: AbortSignal) => c.bootstrap({ signal: s }),
    ]) {
      const { fetchImpl, seen } = hangingFetch();
      const ac = new AbortController();
      const promise = call(client(fetchImpl), ac.signal);
      ac.abort();
      await expect(promise).rejects.toThrow(/abort/i);
      expect(seen[0]).toBe(ac.signal);
    }
  });

  test('不给 signal 时 init 里不出现 signal 字段（行为与从前一致）', async () => {
    const { fetchImpl, calls } = stubFetch(() => json({ challenge: 'c', expiresAt: 1 }));
    let seenInit: Record<string, unknown> | undefined;
    const spy = (async (input: unknown, init?: Record<string, unknown>) => {
      seenInit = init;
      return fetchImpl(input as string, init as RequestInit);
    }) as unknown as typeof fetch;
    await client(spy).challenge();
    expect(seenInit).not.toHaveProperty('signal');
    expect(calls).toHaveLength(1);
  });
});

describe('registration secret transport', () => {
  test('invitation is only in POST body; redirects are disabled', async () => {
    let seen: RequestInit | undefined;
    let endpoint = '';
    const client = new AuthClient({ baseUrl: 'https://relay.example', deviceId: 'synthetic', signKeys,
      fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => { endpoint = String(url); seen = init; return Response.json({ created: true }); }) as unknown as typeof fetch });
    const invitation = 'synthetic-invite';
    await client.register('agent', { invitation });
    expect(endpoint).toBe('https://relay.example/auth/register');
    expect(seen?.redirect).toBe('error');
    expect(JSON.parse(String(seen?.body)).invitation).toBe(invitation);
  });
  test('remote plaintext, URL credentials and queries cannot carry an invitation', async () => {
    for (const baseUrl of ['http://relay.example', 'https://user:pass@relay.example', 'https://relay.example?secret=x', 'https://relay.example#secret']) {
      let calls = 0;
      const client = new AuthClient({ baseUrl, deviceId: 'synthetic', signKeys,
        fetchImpl: (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch });
      await expect(client.register('agent', { invitation: 'synthetic-invite' })).rejects.toThrow('Enrollment requires');
      expect(calls).toBe(0);
    }
  });
});

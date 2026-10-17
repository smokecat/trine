import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  authChallengeMessage,
  generateSignKeyPair,
  signDetached,
  sodiumReady,
  type SignKeyPair,
} from '@trine/core/crypto';
import { loadConfig, type ServerConfig } from '../config.ts';
import { Store } from '../store/index.ts';
import { AuthService, hashToken, rateLimitKey } from './index.ts';

let store: Store;
let auth: AuthService;
let config: ServerConfig;
let kp: SignKeyPair;
let clientKp: SignKeyPair;

/** 测试里的默认来源标识（限流 key = deviceId + 来源） */
const SRC = '198.51.100.7';

beforeAll(async () => {
  await sodiumReady();
  kp = generateSignKeyPair();
  clientKp = generateSignKeyPair();
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
  auth = new AuthService(store, config, () => {});
});

/** 走完 注册 → 挑战 → 应答 的完整流程，返回 token */
function fullAuth(
  deviceId: string,
  keys = kp,
  role: 'client' | 'agent' = 'agent',
  source = SRC,
) {
  auth.register(deviceId, role, keys.publicKey, 'open');
  const ch = auth.issueChallenge(deviceId, source);
  if (!ch.ok) throw new Error(`challenge failed: ${ch.error}`);
  const sig = signDetached(
    authChallengeMessage(deviceId, ch.value.challenge),
    keys.secretKey,
  );
  return {
    challenge: ch.value.challenge,
    result: auth.verify(deviceId, ch.value.challenge, sig, source),
  };
}

/** 取一个挑战串（限流测试里反复用） */
function challengeFor(deviceId: string, source = SRC): string {
  const ch = auth.issueChallenge(deviceId, source);
  if (!ch.ok) throw new Error(`challenge failed: ${ch.error}`);
  return ch.value.challenge;
}

describe('注册', () => {
  test('首次注册成功', () => {
    const r = auth.register('mbp', 'agent', kp.publicKey, 'open');
    expect(r).toEqual({ ok: true, value: { created: true } });
  });

  test('同 deviceId 同公钥重复注册幂等', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    expect(auth.register('mbp', 'agent', kp.publicKey, 'open')).toEqual({
      ok: true,
      value: { created: false },
    });
  });

  test('同 deviceId 换公钥被拒（防设备接管）', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    const attacker = generateSignKeyPair();
    expect(auth.register('mbp', 'agent', attacker.publicKey, 'open')).toEqual({
      ok: false,
      error: 'device_exists_with_other_key',
    });
  });

  test('同 deviceId 换角色被拒', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    expect(auth.register('mbp', 'client', kp.publicKey, 'open')).toEqual({
      ok: false,
      error: 'role_mismatch',
    });
  });

  test('非法公钥被拒', () => {
    expect(auth.register('mbp', 'agent', 'not-a-key', 'open').ok).toBe(false);
    expect(auth.register('mbp', 'agent', 'not-a-key', 'open')).toEqual({
      ok: false,
      error: 'invalid_public_key',
    });
  });

  test('已吊销设备重新注册被拒', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    store.revokeDevice('mbp', Date.now());
    expect(auth.register('mbp', 'agent', kp.publicKey, 'open')).toEqual({
      ok: false,
      error: 'device_revoked',
    });
  });

  test('关闭开放注册后：空库仍允许 bootstrap，之后一律拒绝', () => {
    const closed = new AuthService(
      store,
      loadConfig({ allowOpenRegistration: false }),
      () => {},
    );
    // 空库 bootstrap
    expect(closed.register('mbp', 'agent', kp.publicKey, 'open').ok).toBe(true);
    // 第二台设备就得走配对流程了
    const second = generateSignKeyPair();
    expect(closed.register('phone', 'client', second.publicKey, 'open')).toEqual({
      ok: false,
      error: 'registration_closed',
    });
  });

  test('via=pairing 不受开放注册开关限制（放行依据是 agent 背书）', () => {
    const closed = new AuthService(
      store,
      loadConfig({ allowOpenRegistration: false }),
      () => {},
    );
    // 先占掉 bootstrap 名额，确保后面走的不是空库特例
    expect(closed.register('mbp', 'agent', kp.publicKey, 'bootstrap').ok).toBe(
      true,
    );
    const phone = generateSignKeyPair();
    // 同一台设备：open 路径被拒，pairing 路径放行——两者的信任来源不同
    expect(closed.register('phone', 'client', phone.publicKey, 'open')).toEqual({
      ok: false,
      error: 'registration_closed',
    });
    expect(
      closed.register('phone', 'client', phone.publicKey, 'pairing'),
    ).toEqual({ ok: true, value: { created: true } });
  });

  test('via=pairing 也拦得住换公钥接管既有设备', () => {
    auth.register('phone', 'client', kp.publicKey, 'pairing');
    const attacker = generateSignKeyPair();
    // 背书来源不等于豁免——公钥不可覆盖的规则对所有来源一视同仁
    expect(
      auth.register('phone', 'client', attacker.publicKey, 'pairing'),
    ).toEqual({ ok: false, error: 'device_exists_with_other_key' });
  });

  test('登记来源写进审计日志', () => {
    const lines: string[] = [];
    const audited = new AuthService(store, config, (l) => lines.push(l));
    audited.register('phone', 'client', kp.publicKey, 'pairing');
    expect(lines.some((l) => l.includes('via=pairing'))).toBe(true);
    expect(lines.some((l) => l.includes('device=phone'))).toBe(true);
  });
});

describe('挑战-应答', () => {
  test('完整流程签发 token', () => {
    const { result } = fullAuth('mbp');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.token.length).toBeGreaterThan(0);
    // token 明文不入库，只存摘要
    const rows = store.db
      .query('SELECT token_hash FROM auth_tokens')
      .all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashToken(result.value.token));
    expect(rows[0]!.token_hash).not.toBe(result.value.token);
  });

  test('未知设备取挑战被拒', () => {
    expect(auth.issueChallenge('ghost')).toEqual({
      ok: false,
      error: 'unknown_device',
    });
  });

  test('错误签名被拒', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    const ch = auth.issueChallenge('mbp');
    if (!ch.ok) throw new Error('setup');
    const wrong = generateSignKeyPair();
    const sig = signDetached(
      authChallengeMessage('mbp', ch.value.challenge),
      wrong.secretKey,
    );
    expect(auth.verify('mbp', ch.value.challenge, sig)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });

  test('挑战串一次性：同一应答不能用第二次（防重放）', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    const ch = auth.issueChallenge('mbp');
    if (!ch.ok) throw new Error('setup');
    const sig = signDetached(
      authChallengeMessage('mbp', ch.value.challenge),
      kp.secretKey,
    );
    expect(auth.verify('mbp', ch.value.challenge, sig).ok).toBe(true);
    expect(auth.verify('mbp', ch.value.challenge, sig)).toEqual({
      ok: false,
      error: 'invalid_challenge',
    });
  });

  test('验签失败后该挑战串同样作废（不能反复试）', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    const ch = auth.issueChallenge('mbp');
    if (!ch.ok) throw new Error('setup');
    expect(auth.verify('mbp', ch.value.challenge, 'garbage').ok).toBe(false);
    // 这次拿正确签名也没用了
    const sig = signDetached(
      authChallengeMessage('mbp', ch.value.challenge),
      kp.secretKey,
    );
    expect(auth.verify('mbp', ch.value.challenge, sig)).toEqual({
      ok: false,
      error: 'invalid_challenge',
    });
  });

  test('A 设备的挑战串不能被 B 设备应答', () => {
    const other = generateSignKeyPair();
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    auth.register('phone', 'client', other.publicKey, 'open');
    const ch = auth.issueChallenge('mbp');
    if (!ch.ok) throw new Error('setup');
    const sig = signDetached(
      authChallengeMessage('phone', ch.value.challenge),
      other.secretKey,
    );
    expect(auth.verify('phone', ch.value.challenge, sig)).toEqual({
      ok: false,
      error: 'invalid_challenge',
    });
  });

  test('过期挑战串被拒', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    const now = Date.now();
    const ch = auth.issueChallenge('mbp', SRC, now);
    if (!ch.ok) throw new Error('setup');
    const sig = signDetached(
      authChallengeMessage('mbp', ch.value.challenge),
      kp.secretKey,
    );
    const later = now + config.challengeTtlMs + 1;
    expect(auth.verify('mbp', ch.value.challenge, sig, SRC, later)).toEqual({
      ok: false,
      error: 'invalid_challenge',
    });
  });
});

describe('token 校验', () => {
  test('有效 token 换回设备身份', () => {
    const { result } = fullAuth('mbp');
    if (!result.ok) throw new Error('setup');
    expect(auth.authenticateToken(result.value.token)).toEqual({
      ok: true,
      value: { deviceId: 'mbp', role: 'agent' },
    });
  });

  test('伪造 token 被拒', () => {
    fullAuth('mbp');
    expect(auth.authenticateToken('made-up-token').ok).toBe(false);
  });

  test('token 过期后失效', () => {
    const now = Date.now();
    const { result } = fullAuth('mbp');
    if (!result.ok) throw new Error('setup');
    expect(
      auth.authenticateToken(result.value.token, now + config.tokenTtlMs + 1).ok,
    ).toBe(false);
  });

  test('设备被吊销后其 token 立刻失效', () => {
    const { result } = fullAuth('mbp');
    if (!result.ok) throw new Error('setup');
    store.revokeDevice('mbp', Date.now());
    expect(auth.authenticateToken(result.value.token).ok).toBe(false);
  });

  test('logout 撤销单个 token', () => {
    const { result } = fullAuth('mbp');
    if (!result.ok) throw new Error('setup');
    auth.logout(result.value.token);
    expect(auth.authenticateToken(result.value.token).ok).toBe(false);
  });
});

describe('限流：签名失败计数', () => {
  test('同一来源连续签名失败达阈值后被拒', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    for (let i = 0; i < config.authFailMaxAttempts; i++) {
      auth.verify('mbp', challengeFor('mbp'), 'bad-sig', SRC);
    }
    expect(auth.verify('mbp', 'whatever', 'bad-sig', SRC)).toEqual({
      ok: false,
      error: 'rate_limited',
    });
  });

  test('认证成功清零该来源的计数', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    auth.verify('mbp', challengeFor('mbp'), 'bad-sig', SRC);
    expect(
      store.authFailureCount(rateLimitKey('mbp', SRC), config.authFailWindowMs),
    ).toBeGreaterThan(0);

    const { result } = fullAuth('mbp');
    expect(result.ok).toBe(true);
    expect(
      store.authFailureCount(rateLimitKey('mbp', SRC), config.authFailWindowMs),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// S1 回归：限流不得成为锁死合法设备的杠杆
// ---------------------------------------------------------------------------

describe('S1 回归：攻击者无法用限流把真设备挡在门外', () => {
  const ATTACKER = '203.0.113.66';

  test('攻击者狂刷垃圾 verify，真设备从自己的来源照常认证', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');

    // 攻击者知道 deviceId（本就不是秘密），用最有效的打法把配额烧光：
    // 自己取合法挑战串，再拿它发错签名——这是唯一会计数的路径
    let attackerBlocked = false;
    for (let i = 0; i < config.authFailMaxAttempts * 3; i++) {
      const ch = auth.issueChallenge('mbp', ATTACKER);
      if (!ch.ok) {
        attackerBlocked = true;
        break;
      }
      const r = auth.verify('mbp', ch.value.challenge, 'forged-sig', ATTACKER);
      if (!r.ok && r.error === 'rate_limited') {
        attackerBlocked = true;
        break;
      }
    }
    // 攻击者只把**自己**这个来源刷死了
    expect(attackerBlocked).toBe(true);

    // 真设备从自己的来源过来：配额干净，认证照常成功。
    // 这正是 S1 的回归点——改之前这里会是 rate_limited
    const { result } = fullAuth('mbp');
    expect(result.ok).toBe(true);
  });

  test('挑战串对不上不计数（正常竞态不该消耗配额）', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    for (let i = 0; i < config.authFailMaxAttempts * 3; i++) {
      expect(auth.verify('mbp', 'no-such-challenge', 'sig', SRC)).toEqual({
        ok: false,
        error: 'invalid_challenge',
      });
    }
    // 全程没有一次签名校验失败，配额分文未动
    expect(
      store.authFailureCount(rateLimitKey('mbp', SRC), config.authFailWindowMs),
    ).toBe(0);
    expect(fullAuth('mbp').result.ok).toBe(true);
  });

  test('限流 key 按 deviceId + 来源隔离', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    auth.register('phone', 'client', clientKp.publicKey, 'open');

    // 同一来源刷 mbp 刷到死
    for (let i = 0; i < config.authFailMaxAttempts; i++) {
      auth.verify('mbp', challengeFor('mbp'), 'bad-sig', SRC);
    }
    expect(auth.verify('mbp', 'x', 'y', SRC)).toEqual({
      ok: false,
      error: 'rate_limited',
    });

    // 同来源的另一台设备不受牵连
    expect(auth.verify('phone', 'x', 'y', SRC)).not.toEqual({
      ok: false,
      error: 'rate_limited',
    });
    // 同设备的另一来源也不受牵连
    expect(auth.verify('mbp', 'x', 'y', '198.51.100.99')).not.toEqual({
      ok: false,
      error: 'rate_limited',
    });
  });
});

// ---------------------------------------------------------------------------
// S2 回归：挑战表不随请求次数无界增长
// ---------------------------------------------------------------------------

describe('S2 回归：挑战表有界', () => {
  test('反复取挑战，每设备只驻留最新一个', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    // 取到取挑战限流阈值为止（本测试配置下是 3×5=15）
    let last = '';
    let rounds = 0;
    for (let i = 0; i < 15; i++) {
      const ch = auth.issueChallenge('mbp', SRC);
      if (!ch.ok) break;
      last = ch.value.challenge;
      rounds++;
    }
    // 确实取了很多次，但表里始终只有 1 行——改之前是 rounds 行
    expect(rounds).toBeGreaterThan(5);
    expect(store.countChallenges()).toBe(1);
    // 且留下的是最新那个——它必须还能用
    const sig = signDetached(authChallengeMessage('mbp', last), kp.secretKey);
    expect(auth.verify('mbp', last, sig, SRC).ok).toBe(true);
  });

  test('多设备各留一个，互不覆盖', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    auth.register('phone', 'client', clientKp.publicKey, 'open');
    challengeFor('mbp');
    challengeFor('phone');
    challengeFor('mbp');
    expect(store.countChallenges()).toBe(2);
  });

  test('发新挑战会作废该设备的旧挑战', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    const old = challengeFor('mbp');
    challengeFor('mbp');
    const sig = signDetached(authChallengeMessage('mbp', old), kp.secretKey);
    expect(auth.verify('mbp', old, sig, SRC)).toEqual({
      ok: false,
      error: 'invalid_challenge',
    });
  });

  test('取挑战端点本身有频率上限（成功也计数）', () => {
    auth.register('mbp', 'agent', kp.publicKey, 'open');
    // 阈值是验签阈值的若干倍，刷够了照样被挡
    let limited = false;
    for (let i = 0; i < config.authFailMaxAttempts * 10; i++) {
      const r = auth.issueChallenge('mbp', SRC);
      if (!r.ok && r.error === 'rate_limited') {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
    // 挡住了，但库里始终只有一行
    expect(store.countChallenges()).toBeLessThanOrEqual(1);
  });
});

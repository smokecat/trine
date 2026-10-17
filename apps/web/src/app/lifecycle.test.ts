/**
 * 接线层测试（评审阶段 1 B5/B6）：内存锁 + 两个 elector 快速切换主从，
 * 断言任何时刻最多一个活 client / 一个 socket；create 抛错进错误态。
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPair, sodiumReady } from '@trine/core/crypto';
import { MemoryChannelHub, MemoryDocStore, MemoryKv, MemoryLockRegistry } from '../lib/adapters.ts';
import { TrineClient } from '../lib/client.ts';
import { LeaderElector } from '../lib/leader.ts';
import { KV_IDENTITY, KV_PEER } from '../lib/storage.ts';
import { FakeClock, FakeSocketFactory, flushMicrotasks } from '../lib/test-utils.ts';
import { ClientLifecycle } from './lifecycle.ts';

beforeAll(async () => {
  await sodiumReady();
});

function pairedKv(): MemoryKv {
  const kv = new MemoryKv();
  kv.set(
    KV_PEER,
    JSON.stringify({
      v: 1,
      serverUrl: 'http://localhost:5173',
      machines: { mbp: { agentBoxPubKey: generateKeyPair().publicKey, pairedAt: 1, outSeq: {}, inCursors: {}, sessions: {} } },
    }),
  );
  return kv;
}

const stubFetch = (async (input: unknown) =>
  Response.json(String(input).endsWith('/auth/challenge') ? { challenge: 'c', expiresAt: 1 } : { token: 't', expiresAt: 9e15 })) as unknown as typeof fetch;

describe('lifecycle · 任何时刻最多一个 client', () => {
  test('主→从→主 在 create 在途时切换：过期代际的 client 被丢弃，只剩一个活 client / 一个 socket', async () => {
    const kv = pairedKv();
    const docs = new MemoryDocStore();
    const clock = new FakeClock();
    const sockets = new FakeSocketFactory();
    const created: TrineClient[] = [];
    const bound: TrineClient[] = [];
    const gates: (() => void)[] = [];
    const lifecycle = new ClientLifecycle({
      createClient: async () => {
        // 每次 create 都卡在一个门上，测试决定何时放行——模拟 sodium/IDB 的异步耗时
        await new Promise<void>((resolve) => gates.push(resolve));
        const c = await TrineClient.create({ kv, docs, createSocket: sockets.create, clock, fetchImpl: stubFetch });
        created.push(c);
        return c;
      },
      onClient: (c) => {
        bound.push(c);
        return () => {};
      },
      onError: (m) => {
        throw new Error(`不该出错：${m}`);
      },
    });
    const leader = (state: 'leader' | 'follower') => lifecycle.onLeaderChange({ state, instanceId: 'a', mode: 'locks' });

    leader('leader'); // create#1 在途
    leader('follower'); // 让位：#1 作废
    leader('leader'); // create#2 在途
    expect(gates).toHaveLength(2);
    gates[0]!(); // #1 先完成
    await flushMicrotasks(20);
    expect(bound).toHaveLength(0); // 过期代际，没被 bind/start
    gates[1]!();
    await flushMicrotasks(20);
    await lifecycle.settle();
    expect(created).toHaveLength(2);
    expect(bound).toHaveLength(1);
    expect(bound[0]).toBe(created[1]!);
    expect(lifecycle.client).toBe(created[1]!);
    // 只有一个 socket（#1 从未 start）
    expect(sockets.sockets).toHaveLength(1);
    // 重复的 leader 通知不建第二个
    leader('leader');
    await flushMicrotasks(5);
    expect(created).toHaveLength(2);
    // 让位 → 拆掉
    leader('follower');
    expect(lifecycle.client).toBeNull();
    expect(sockets.last.closed).not.toBeNull();
  });

  test('与真 LeaderElector（内存锁）接线：两页快速来回接管，始终只有一个活 client', async () => {
    const kv = pairedKv();
    const docs = new MemoryDocStore();
    const clock = new FakeClock();
    const sockets = new FakeSocketFactory();
    const locks = new MemoryLockRegistry();
    const hub = new MemoryChannelHub();
    const alive = new Set<TrineClient>();
    const mk = (id: string) => {
      const lifecycle = new ClientLifecycle({
        createClient: () => TrineClient.create({ kv, docs, createSocket: sockets.create, clock, fetchImpl: stubFetch }),
        onClient: (c) => {
          alive.add(c);
          return () => alive.delete(c);
        },
        onError: (m) => {
          throw new Error(m);
        },
      });
      const elector = new LeaderElector({
        locks: locks.adapter(),
        channel: hub.channel(),
        clock,
        instanceId: id,
        onChange: (s) => lifecycle.onLeaderChange(s),
      });
      return { lifecycle, elector };
    };
    const a = mk('a');
    const b = mk('b');
    a.elector.start();
    await flushMicrotasks(10);
    b.elector.start();
    await flushMicrotasks(10);
    // 来回接管三次，每次都不等 create 完成
    b.elector.takeOver();
    a.elector.takeOver();
    b.elector.takeOver();
    await flushMicrotasks(30);
    await a.lifecycle.settle();
    await b.lifecycle.settle();
    await flushMicrotasks(30);
    const leaders = [a, b].filter((x) => x.elector.state === 'leader');
    expect(leaders).toHaveLength(1);
    expect(alive.size).toBe(1);
    expect(leaders[0]!.lifecycle.client).not.toBeNull();
    const other = leaders[0] === a ? b : a;
    expect(other.lifecycle.client).toBeNull();
    // 每个 start 过的 client 至多一个 socket 仍未关闭
    expect(sockets.sockets.filter((s) => s.closed === null)).toHaveLength(1);
    a.elector.stop();
    b.elector.stop();
    a.lifecycle.dispose();
    b.lifecycle.dispose();
  });
});

describe('lifecycle · B6 create 抛错进错误态', () => {
  test('identity 损坏 → onError 收到可读信息，不是 unhandled rejection', async () => {
    const kv = pairedKv();
    kv.set(KV_IDENTITY, '{"v":1,"deviceId":"x"}');
    const errors: string[] = [];
    const lifecycle = new ClientLifecycle({
      createClient: () =>
        TrineClient.create({ kv, docs: new MemoryDocStore(), createSocket: new FakeSocketFactory().create, clock: new FakeClock(), fetchImpl: stubFetch }),
      onClient: () => () => {},
      onError: (m) => void errors.push(m),
    });
    lifecycle.onLeaderChange({ state: 'leader', instanceId: 'a', mode: 'locks' });
    await lifecycle.settle();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/本地身份.*损坏/);
    expect(lifecycle.client).toBeNull();
  });
});

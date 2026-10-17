import { describe, expect, test } from 'bun:test';
import { MemoryChannelHub, MemoryLockRegistry } from './adapters.ts';
import { LeaderElector, type LeaderSnapshot } from './leader.ts';
import { FakeClock, flushMicrotasks } from './test-utils.ts';

function setup(available: boolean) {
  const locks = new MemoryLockRegistry();
  const hub = new MemoryChannelHub();
  const clock = new FakeClock();
  const changes: string[] = [];
  const make = (id: string) =>
    new LeaderElector({
      locks: locks.adapter(available),
      channel: hub.channel(),
      clock,
      instanceId: id,
      onChange: (s: LeaderSnapshot) => void changes.push(`${s.instanceId}:${s.state}`),
    });
  return { locks, hub, clock, changes, make };
}

describe('leader · Web Locks 模式', () => {
  test('两个实例只有一个成为主，另一个是从', async () => {
    const { make, changes } = setup(true);
    const a = make('a');
    const b = make('b');
    a.start();
    await flushMicrotasks();
    b.start();
    await flushMicrotasks();
    expect(a.state).toBe('leader');
    expect(b.state).toBe('follower');
    expect(changes).toEqual(['a:leader', 'b:follower']);
    expect(a.mode).toBe('locks');
  });

  test('「在此接管」：从页广播 release，主让位，从页拿到锁成为主', async () => {
    const { make, changes, locks } = setup(true);
    const a = make('a');
    const b = make('b');
    a.start();
    await flushMicrotasks();
    b.start();
    await flushMicrotasks();
    b.takeOver();
    await flushMicrotasks(10);
    expect(b.state).toBe('leader');
    expect(a.state).toBe('follower');
    expect(changes.slice(2).sort()).toEqual(['a:follower', 'b:leader']);
    expect(locks.isHeld('trine:leader')).toBe(true);
    // 主 stop 后另一个自动接上
    b.stop();
    await flushMicrotasks(10);
    expect(a.state).toBe('leader');
  });

  test('stop 释放锁且不再参选', async () => {
    const { make, locks } = setup(true);
    const a = make('a');
    a.start();
    await flushMicrotasks();
    a.stop();
    await flushMicrotasks(10);
    expect(a.state).toBe('idle');
    expect(locks.isHeld('trine:leader')).toBe(false);
  });
});

describe('leader · 无 Web Locks 的退化选举', () => {
  test('3s 无心跳自任为主；两个主相遇按 instanceId 小者留任；接管让位', async () => {
    const { make, clock } = setup(false);
    const a = make('a');
    const b = make('b');
    a.start();
    b.start();
    expect(a.mode).toBe('heartbeat');
    expect([a.state, b.state]).toEqual(['follower', 'follower']);
    await clock.advance(3_000);
    // 同时到点两个都自任，随后心跳相遇，b 让位
    await clock.advance(1_100);
    expect(a.state).toBe('leader');
    expect(b.state).toBe('follower');
    // 持续心跳下 b 不会再自任
    await clock.advance(10_000);
    expect(b.state).toBe('follower');
    // 接管
    b.takeOver();
    await flushMicrotasks(10);
    expect(b.state).toBe('leader');
    expect(a.state).toBe('follower');
    await clock.advance(10_000);
    expect(a.state).toBe('follower');
    // 主消失 → 3s 后从页接管
    b.stop();
    await clock.advance(3_100);
    expect(a.state).toBe('leader');
    a.stop();
  });
});

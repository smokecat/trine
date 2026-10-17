import { describe, expect, test } from 'bun:test';
import type { TransportFrame } from '@trine/core';
import {
  Connection,
  backoffDelay,
  CONNECT_WATCHDOG_MS,
  DEFAULT_BACKOFF,
  RECENT_OPEN_MS,
  STALE_CONNECTING_MS,
  WAKE_DEBOUNCE_MS,
  type ConnectionSnapshot,
} from './connection.ts';
import { FakeClock, FakeSocketFactory, flushMicrotasks } from './test-utils.ts';

interface Harness {
  conn: Connection;
  clock: FakeClock;
  sockets: FakeSocketFactory;
  statuses: string[];
  opens: number;
  frames: TransportFrame[];
  tokens: (string | null)[];
  authCalls: number;
  authFail: { value: boolean };
}

function harness(over: { token?: { token: string; expiresAt: number } | null } = {}): Harness {
  const clock = new FakeClock();
  const sockets = new FakeSocketFactory();
  const h = {
    clock,
    sockets,
    statuses: [] as string[],
    opens: 0,
    frames: [] as TransportFrame[],
    tokens: [] as (string | null)[],
    authCalls: 0,
    authFail: { value: false },
  } as Harness;
  h.conn = new Connection({
    serverUrl: 'http://localhost:5173',
    deviceId: 'web-1',
    authenticate: async () => {
      h.authCalls++;
      if (h.authFail.value) throw new Error('unknown_device');
      return { token: `tok-${h.authCalls}`, expiresAt: clock.now() + 3_600_000 };
    },
    token: over.token ?? null,
    onToken: (t) => void h.tokens.push(t?.token ?? null),
    createSocket: sockets.create,
    clock,
    random: () => 0, // 无抖动，便于断言
    onOpen: () => void h.opens++,
    onFrame: (f) => void h.frames.push(f),
    onStatus: (s: ConnectionSnapshot) => void h.statuses.push(s.status),
  });
  return h;
}

describe('connection · 状态机', () => {
  test('start → authenticating → connecting → open：hello 带 token，onOpen 在 hello 之后同步触发', async () => {
    const h = harness();
    h.conn.start();
    await flushMicrotasks();
    expect(h.statuses).toEqual(['authenticating', 'connecting']);
    expect(h.sockets.sockets).toHaveLength(1);
    expect(h.sockets.last.url).toBe('ws://localhost:5173/ws');
    h.sockets.last.emitOpen();
    expect(h.sockets.last.sentFrames).toEqual([{ type: 'hello', v: 1, role: 'client', deviceId: 'web-1', authToken: 'tok-1' }]);
    expect(h.opens).toBe(1);
    expect(h.conn.isOpen).toBe(true);
    expect(h.tokens).toEqual(['tok-1']);
    // 入站帧解析后转交
    h.sockets.last.emitMessage({ type: 'machine.status', machineId: 'mbp', online: true, lastSeenAt: 1 });
    h.sockets.last.emitMessage('not json');
    expect(h.frames).toHaveLength(1);
  });

  test('缓存 token 有效则跳过认证；expiresAt 提前 60s 视为过期', async () => {
    const valid = harness({ token: { token: 'cached', expiresAt: Date.now() + 10 * 60_000 } });
    // FakeClock 起点固定；把 expiresAt 相对时钟算
    const h = harness({ token: { token: 'cached', expiresAt: valid.clock.now() + 10 * 60_000 } });
    h.conn.start();
    await flushMicrotasks();
    expect(h.authCalls).toBe(0);
    h.sockets.last.emitOpen();
    expect((h.sockets.last.sentFrames[0] as { authToken: string }).authToken).toBe('cached');

    const stale = harness({ token: { token: 'stale', expiresAt: valid.clock.now() + 30_000 } });
    stale.conn.start();
    await flushMicrotasks();
    expect(stale.authCalls).toBe(1);
  });

  test('断开 → 退避重连：1s 起、倍增、30s 封顶；open 后 attempt 归零', async () => {
    const h = harness();
    h.conn.start();
    await flushMicrotasks();
    h.sockets.last.emitOpen();
    h.sockets.last.emitClose(1006);
    expect(h.conn.snapshot()).toMatchObject({ status: 'backoff', attempt: 1, nextRetryAt: h.clock.now() + 1_000 });
    await h.clock.advance(999);
    expect(h.sockets.sockets).toHaveLength(1);
    await h.clock.advance(1);
    expect(h.sockets.sockets).toHaveLength(2);
    // 连不上（直接 close）→ 2s → 4s → …
    h.sockets.last.emitClose(1006);
    expect(h.conn.snapshot().attempt).toBe(2);
    await h.clock.advance(2_000);
    expect(h.sockets.sockets).toHaveLength(3);
    h.sockets.last.emitClose(1006);
    await h.clock.advance(4_000);
    expect(h.sockets.sockets).toHaveLength(4);
    // 成功 open 后再断：又从 1s 起
    h.sockets.last.emitOpen();
    h.sockets.last.emitClose(1006);
    expect(h.conn.snapshot().attempt).toBe(1);
    // 认证只做过一次（token 仍有效）
    expect(h.authCalls).toBe(1);
  });

  test('backoffDelay：封顶 30s，抖动只往下减', () => {
    expect(backoffDelay(0, DEFAULT_BACKOFF, () => 0)).toBe(1_000);
    expect(backoffDelay(3, DEFAULT_BACKOFF, () => 0)).toBe(8_000);
    expect(backoffDelay(10, DEFAULT_BACKOFF, () => 0)).toBe(30_000);
    expect(backoffDelay(10, DEFAULT_BACKOFF, () => 1)).toBe(24_000);
  });

  test('4001 → 丢 token、下一轮重新认证', async () => {
    const h = harness();
    h.conn.start();
    await flushMicrotasks();
    h.sockets.last.emitOpen();
    h.sockets.last.emitClose(4001, 'token expired');
    expect(h.tokens).toEqual(['tok-1', null]);
    await h.clock.advance(1_000);
    expect(h.authCalls).toBe(2);
    h.sockets.last.emitOpen();
    expect((h.sockets.last.sentFrames[0] as { authToken: string }).authToken).toBe('tok-2');
  });

  test('4006 → needs_upgrade，停止重连', async () => {
    const h = harness();
    h.conn.start();
    await flushMicrotasks();
    h.sockets.last.emitOpen();
    h.sockets.last.emitClose(4006, 'version');
    expect(h.conn.snapshot()).toMatchObject({ status: 'needs_upgrade', lastCloseCode: 4006 });
    await h.clock.advance(60_000);
    expect(h.sockets.sockets).toHaveLength(1);
    expect(h.clock.pending).toBe(0);
  });

  test('认证失败也走退避；stop 关 socket 且不再重连；旧 socket 事件被忽略', async () => {
    const h = harness();
    h.authFail.value = true;
    h.conn.start();
    await flushMicrotasks();
    expect(h.conn.snapshot()).toMatchObject({ status: 'backoff', lastError: 'unknown_device' });
    h.authFail.value = false;
    await h.clock.advance(1_000);
    h.sockets.last.emitOpen();
    const socket = h.sockets.last;
    h.conn.stop();
    expect(socket.closed).toEqual({ code: 1000, reason: 'client stop' });
    expect(h.conn.snapshot().status).toBe('stopped');
    socket.emitClose(1000);
    await h.clock.advance(60_000);
    expect(h.sockets.sockets).toHaveLength(1);
    expect(h.conn.send({ type: 'sync.request', machineId: 'mbp', sinceSeq: 0 })).toBe(false);
  });

  test('wake() 在退避中立即重连；已连上时无副作用', async () => {
    const h = harness();
    h.conn.start();
    await flushMicrotasks();
    h.sockets.last.emitOpen();
    h.conn.wake();
    expect(h.sockets.sockets).toHaveLength(1);
    h.sockets.last.emitClose(1006);
    h.conn.wake();
    await flushMicrotasks();
    expect(h.sockets.sockets).toHaveLength(2);
    // 退避定时器已取消；还挂着的那个是新一轮 connecting 的看门狗（N3）
    expect(h.conn.snapshot().nextRetryAt).toBeNull();
    expect(h.clock.pending).toBe(1);
  });

  test('wake() 在未 start 时不连（#stopped 守卫）', async () => {
    const h = harness();
    // 还没 start：`#stopped` 为真（初始 status 恰好是 idle，但守住这条的是
    // `#stopped`，不是状态名——`start()` 同步就进 authenticating，
    // 「已 start 但仍 idle」实际不可达，别再声称 wake 覆盖了它）
    expect(h.conn.snapshot().status).toBe('idle');
    h.conn.wake();
    await flushMicrotasks();
    expect(h.sockets.sockets).toHaveLength(0);
  });

  test('wake() 在 stopped 态不重连——恢复要显式 start()', async () => {
    const h = harness();
    h.conn.start();
    await flushMicrotasks();
    h.sockets.last.emitOpen();
    h.conn.stop();
    expect(h.conn.snapshot().status).toBe('stopped');
    // 主标签让位 / 重置本地状态之后另一个实例可能正持有连接，
    // 回前台自作主张连上去会让两个实例抢同一个 deviceId 的 outSeq
    h.conn.wake();
    await h.clock.advance(60_000);
    expect(h.sockets.sockets).toHaveLength(1);
    expect(h.conn.snapshot().status).toBe('stopped');
    // 显式 start() 才恢复
    h.conn.start();
    await flushMicrotasks();
    expect(h.sockets.sockets).toHaveLength(2);
  });

  test('wake() 在 needs_upgrade（4006）不重连', async () => {
    const h = harness();
    h.conn.start();
    await flushMicrotasks();
    h.sockets.last.emitOpen();
    h.sockets.last.emitClose(4006);
    expect(h.conn.snapshot().status).toBe('needs_upgrade');
    h.conn.wake();
    await h.clock.advance(60_000);
    expect(h.sockets.sockets).toHaveLength(1);
    expect(h.conn.snapshot().status).toBe('needs_upgrade');
  });

  // 早先这里有一条「wake() 把退避计数归零」——那是把 b759cab 的回归钉成了
  // 规范（评审 N2）。退避计数归零的正确语义在 close 分支的 `if (opened)`：
  // 只有真连上过才算新的一轮。下面三条钉住修正后的判据。

  test('服务端持续宕机 + 连续 20 次 wake：退避仍爬升，socket 数有上界（N2）', async () => {
    const h = harness();
    h.conn.start();
    await flushMicrotasks();
    // 从未 open 过：每次建连都被立刻拒（服务端宕机）
    h.sockets.last.emitClose(1006);
    expect(h.conn.snapshot().attempt).toBe(1);

    // 用户反复切前后台：锁屏解锁、切 app、下拉通知栏……
    for (let i = 0; i < 20; i++) {
      await h.clock.advance(WAKE_DEBOUNCE_MS); // 去抖窗口之外，每次都被受理
      h.conn.wake();
      await flushMicrotasks();
      h.sockets.last.emitClose(1006);
    }

    // 退避一路爬到封顶级（attempt 21 → 30s），没有被 wake 打回 1s
    expect(h.conn.snapshot().attempt).toBe(21);
    expect(h.conn.snapshot().status).toBe('backoff');
    // socket 上界：初次 1 + 20 次 wake 各一次 = 21，wake 没有制造额外连接
    expect(h.sockets.sockets).toHaveLength(21);
  });

  test('wake() 去抖：1s 内的重复 wake 只算一次（N2）', async () => {
    const h = harness();
    h.conn.start();
    await flushMicrotasks();
    h.sockets.last.emitOpen();
    h.sockets.last.emitClose(1006);
    expect(h.sockets.sockets).toHaveLength(1);

    h.conn.wake(); // 受理
    await flushMicrotasks();
    expect(h.sockets.sockets).toHaveLength(2);
    h.sockets.last.emitClose(1006);

    // 同一毫秒内再连点 5 次：全被去抖吃掉
    for (let i = 0; i < 5; i++) h.conn.wake();
    await flushMicrotasks();
    expect(h.sockets.sockets).toHaveLength(2);

    // 过了去抖窗口才再受理
    await h.clock.advance(WAKE_DEBOUNCE_MS);
    h.conn.wake();
    await flushMicrotasks();
    expect(h.sockets.sockets).toHaveLength(3);
  });

  test('wake() 只在「刚刚还连着」时把退避归零（N2）', async () => {
    // 瞬时断线：上次 open 就在 RECENT_OPEN_MS 内 → 归零，下一次失败从 1s 重退
    const fresh = harness();
    fresh.conn.start();
    await flushMicrotasks();
    fresh.sockets.last.emitOpen();
    // 断两次把 attempt 抬到 2（第二次 close 的重连还没到点）
    fresh.sockets.last.emitClose(1006);
    await fresh.clock.advance(1_000);
    fresh.sockets.last.emitClose(1006);
    expect(fresh.conn.snapshot().attempt).toBe(2);
    fresh.conn.wake(); // 上次 open 距今 1s，远在 RECENT_OPEN_MS 内
    await flushMicrotasks();
    expect(fresh.conn.snapshot().attempt).toBe(0);

    // 长时间连不上：上次 open 已是 RECENT_OPEN_MS 之前 → 不归零
    const stale = harness();
    stale.conn.start();
    await flushMicrotasks();
    stale.sockets.last.emitOpen();
    const openedAt = stale.clock.now();
    stale.sockets.last.emitClose(1006);
    // 退避自己又试了几轮都没成（每轮起来就被 close）
    for (let i = 0; i < 8; i++) {
      await stale.clock.advance(60_000);
      stale.sockets.last.emitClose(1006);
    }
    // 距上次成功 open 已远超「刚刚还连着」的窗口
    expect(stale.clock.now() - openedAt).toBeGreaterThan(RECENT_OPEN_MS);
    const before = stale.conn.snapshot().attempt;
    expect(before).toBeGreaterThan(1);
    stale.conn.wake();
    await flushMicrotasks();
    // wake 只是把这一次重连提前，计数原样保留（下一次失败继续往上爬）
    expect(stale.conn.snapshot().attempt).toBe(before);
  });
});

/**
 * `authenticating` / `connecting` 的看门狗（评审 N3）。
 *
 * 修复前这两态是**永久黑洞**：`authenticate()` 的 fetch 与建 socket 都可能
 * 永不 settle（手机 WiFi→蜂窝 的瞬间 TCP 半开），没有任何定时器会再触发，
 * UI 卡在「正在认证…」且横幅无按钮，用户只能刷新页面。
 */
describe('connection · 连接看门狗（N3）', () => {
  interface Hung {
    conn: Connection;
    clock: FakeClock;
    sockets: FakeSocketFactory;
    /** 每次 authenticate 拿到的 signal */
    signals: AbortSignal[];
    /** 放行第 n 次认证（不放行就一直挂着，模拟半开连接） */
    resolveAuth: (() => void)[];
  }

  /** authenticate 永不 settle（除非测试显式放行），socket 也不 open */
  function hungHarness(): Hung {
    const clock = new FakeClock();
    const sockets = new FakeSocketFactory();
    const h: Hung = { clock, sockets, signals: [], resolveAuth: [] } as unknown as Hung;
    h.conn = new Connection({
      serverUrl: 'http://localhost:5173',
      deviceId: 'web-1',
      authenticate: (signal) => {
        h.signals.push(signal);
        return new Promise((resolve, reject) => {
          h.resolveAuth.push(() => resolve({ token: `tok-${h.signals.length}`, expiresAt: clock.now() + 3_600_000 }));
          // 与真 AuthClient 同形：signal abort 就 reject
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
      createSocket: sockets.create,
      clock,
      random: () => 0,
      onOpen: () => {},
      onFrame: () => {},
    });
    return h;
  }

  test('authenticating 卡死 25s → abort 在途认证、进退避并再次尝试', async () => {
    const h = hungHarness();
    h.conn.start();
    await flushMicrotasks();
    expect(h.conn.snapshot().status).toBe('authenticating');
    expect(h.signals).toHaveLength(1);
    expect(h.signals[0]?.aborted).toBe(false);

    // 差一毫秒不动
    await h.clock.advance(CONNECT_WATCHDOG_MS - 1);
    expect(h.conn.snapshot().status).toBe('authenticating');

    await h.clock.advance(1);
    expect(h.conn.snapshot()).toMatchObject({ status: 'backoff', attempt: 1 });
    expect(h.signals[0]?.aborted).toBe(true); // 在途 fetch 被掐断，不再泄漏

    // 退避到点后真的再试一次
    await h.clock.advance(1_000);
    expect(h.conn.snapshot().status).toBe('authenticating');
    expect(h.signals).toHaveLength(2);
  });

  test('connecting 卡死（socket 既不 open 也不 close）25s → 关掉它并进退避', async () => {
    const h = hungHarness();
    h.conn.start();
    await flushMicrotasks();
    h.resolveAuth[0]?.(); // 认证成功
    await flushMicrotasks();
    expect(h.conn.snapshot().status).toBe('connecting');
    expect(h.sockets.sockets).toHaveLength(1);

    await h.clock.advance(CONNECT_WATCHDOG_MS);
    expect(h.conn.snapshot().status).toBe('backoff');
    // 半开的 socket 被主动关掉，不留残连
    expect(h.sockets.sockets[0]?.closed).toEqual({ code: 1000, reason: 'connect timeout' });

    await h.clock.advance(1_000);
    expect(h.sockets.sockets).toHaveLength(2);
  });

  test('被判超时的那一轮迟到 settle 也覆盖不了新一轮（代际号）', async () => {
    const h = hungHarness();
    h.conn.start();
    await flushMicrotasks();
    await h.clock.advance(CONNECT_WATCHDOG_MS); // 第一轮判超时
    await h.clock.advance(1_000); // 第二轮起来了
    expect(h.signals).toHaveLength(2);
    const socketsBefore = h.sockets.sockets.length;

    // 第一轮的认证现在才姗姗来迟（它的 promise 已被 abort reject，
    // 但即便实现方吞掉 abort 直接 resolve，代际号也必须挡住它）
    h.resolveAuth[0]?.();
    await flushMicrotasks();
    expect(h.sockets.sockets).toHaveLength(socketsBefore); // 没有凭空多一条 socket
    expect(h.conn.snapshot().status).toBe('authenticating'); // 仍是第二轮的状态
  });

  test('连上之后看门狗撤掉：长时间 open 不会被误判', async () => {
    const h = hungHarness();
    h.conn.start();
    await flushMicrotasks();
    h.resolveAuth[0]?.();
    await flushMicrotasks();
    h.sockets.last.emitOpen();
    expect(h.conn.snapshot().status).toBe('open');
    expect(h.clock.pending).toBe(0); // 看门狗已撤
    await h.clock.advance(10 * CONNECT_WATCHDOG_MS);
    expect(h.conn.snapshot().status).toBe('open');
    expect(h.sockets.sockets).toHaveLength(1);
  });

  test('wake() 对陈旧的中间态视为可重启：不用干等看门狗（N3 的 UI「重试」）', async () => {
    const h = hungHarness();
    h.conn.start();
    await flushMicrotasks();
    expect(h.conn.snapshot().status).toBe('authenticating');

    // 刚开始不到 STALE_CONNECTING_MS：wake 不打扰正常的认证往返
    await h.clock.advance(STALE_CONNECTING_MS - 1);
    h.conn.wake();
    await flushMicrotasks();
    expect(h.signals).toHaveLength(1);

    // 过了阈值（半开连接卡住了）：立刻重来一轮，旧的那次被 abort
    await h.clock.advance(1);
    h.conn.wake();
    await flushMicrotasks();
    expect(h.signals).toHaveLength(2);
    expect(h.signals[0]?.aborted).toBe(true);
    expect(h.conn.snapshot().status).toBe('authenticating');
    // 这一轮算失败过：退避计数往上爬，不是无限免费重试
    expect(h.conn.snapshot().attempt).toBe(1);
  });

  test('stop() 撤掉看门狗：停了就不该再有任何定时器', async () => {
    const h = hungHarness();
    h.conn.start();
    await flushMicrotasks();
    expect(h.clock.pending).toBe(1);
    h.conn.stop();
    expect(h.clock.pending).toBe(0);
    await h.clock.advance(10 * CONNECT_WATCHDOG_MS);
    expect(h.conn.snapshot().status).toBe('stopped');
  });
});

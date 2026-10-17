import { beforeEach, describe, expect, test } from 'bun:test';
import { Store } from './index.ts';
import { ParkedQueue, TERMINAL_STATES } from './parked.ts';

const TTL = 10_000;
let store: Store;
let queue: ParkedQueue;

beforeEach(() => {
  store = new Store(':memory:');
  queue = new ParkedQueue(store, TTL, 5);
});

describe('排队与计数', () => {
  test('park 后 pending 可见，expiresAt = now + TTL', () => {
    const r = queue.park('mbp', 's1', 1, 1000);
    expect(r.parked).toBe(true);
    expect(r.row!.expiresAt).toBe(1000 + TTL);
    expect(queue.pendingCount('mbp', 1000)).toBe(1);
  });

  test('重复 park 幂等且不刷新 TTL（否则重发即可无限续期）', () => {
    queue.park('mbp', 's1', 1, 1000);
    const again = queue.park('mbp', 's1', 1, 5000);
    expect(again.parked).toBe(false);
    expect(again.row!.expiresAt).toBe(1000 + TTL);
    expect(queue.pendingCount('mbp', 5000)).toBe(1);
  });

  test('超过每机器配额时拒绝', () => {
    for (let i = 0; i < 5; i++) {
      expect(queue.park('mbp', 's1', i, 1000).parked).toBe(true);
    }
    const over = queue.park('mbp', 's1', 99, 1000);
    expect(over.parked).toBe(false);
    expect(over.row).toBeNull();
    expect((over as { reason: string }).reason).toBe('quota_exceeded');
  });

  test('pendingCount 不数已过期的（即使还没被 sweep 转终态）', () => {
    queue.park('mbp', 's1', 1, 1000);
    expect(queue.pendingCount('mbp', 1000 + TTL + 1)).toBe(0);
    expect(queue.pending('mbp', 1000 + TTL + 1)).toHaveLength(0);
  });

  test('计数按机器隔离', () => {
    queue.park('mbp', 's1', 1, 1000);
    queue.park('nuc', 's1', 1, 1000);
    expect(queue.pendingCount('mbp', 1000)).toBe(1);
    expect(queue.pendingCount('nuc', 1000)).toBe(1);
  });
});

describe('终态防覆盖', () => {
  test('delivered 之后 recall 无效（投递已发生，不能谎报撤回）', () => {
    queue.park('mbp', 's1', 1, 1000);
    expect(queue.markDelivered('mbp', 's1', 1, 1100)).toBe(true);
    expect(queue.recall('mbp', 's1', 1, 1200)).toBe(false);
    expect(queue.get('mbp', 's1', 1)!.state).toBe('delivered');
  });

  test('recalled 之后 delivered 无效（撤回先赢，投递不能反悔）', () => {
    queue.park('mbp', 's1', 1, 1000);
    expect(queue.recall('mbp', 's1', 1, 1100)).toBe(true);
    expect(queue.markDelivered('mbp', 's1', 1, 1200)).toBe(false);
    expect(queue.get('mbp', 's1', 1)!.state).toBe('recalled');
  });

  test('delivered 之后 sweep 的 TTL 到点不得改成 expired', () => {
    queue.park('mbp', 's1', 1, 1000);
    queue.markDelivered('mbp', 's1', 1, 1100);
    const swept = queue.sweepExpired(1000 + TTL + 1);
    expect(swept).toEqual([]);
    expect(queue.get('mbp', 's1', 1)!.state).toBe('delivered');
  });

  test('expired 之后 delivered / recall 均无效', () => {
    queue.park('mbp', 's1', 1, 1000);
    queue.sweepExpired(1000 + TTL + 1);
    expect(queue.get('mbp', 's1', 1)!.state).toBe('expired');
    expect(queue.markDelivered('mbp', 's1', 1, 99_999)).toBe(false);
    expect(queue.recall('mbp', 's1', 1, 99_999)).toBe(false);
    expect(queue.get('mbp', 's1', 1)!.state).toBe('expired');
  });

  test('重复 recall 第二次返回 false（幂等，不报错）', () => {
    queue.park('mbp', 's1', 1, 1000);
    expect(queue.recall('mbp', 's1', 1, 1100)).toBe(true);
    expect(queue.recall('mbp', 's1', 1, 1200)).toBe(false);
  });

  test('recall 不存在的记录静默返回 false', () => {
    expect(queue.recall('mbp', 's1', 404, 1000)).toBe(false);
  });

  test('settled_at 只在首次进终态时写入，后续尝试不改', () => {
    queue.park('mbp', 's1', 1, 1000);
    queue.markDelivered('mbp', 's1', 1, 1100);
    queue.recall('mbp', 's1', 1, 9999);
    expect(queue.get('mbp', 's1', 1)!.settledAt).toBe(1100);
  });

  test('三个终态都在 TERMINAL_STATES 里，pending 不在', () => {
    expect([...TERMINAL_STATES].sort()).toEqual([
      'delivered',
      'expired',
      'recalled',
    ]);
    expect(TERMINAL_STATES.has('pending' as never)).toBe(false);
  });
});

describe('过期扫描与清理', () => {
  test('sweepExpired 返回被判过期的每一条坐标', () => {
    queue.park('mbp', 's1', 1, 1000);
    queue.park('mbp', 's2', 2, 1000);
    queue.park('nuc', 's1', 1, 1000);
    const result = queue.sweepExpired(1000 + TTL + 1);

    // 逐条返回（client 要按 seq 关联本地暂存消息），不是按机器汇总
    expect(result).toHaveLength(3);
    expect(
      result.map((r) => `${r.machineId}/${r.sessionId}/${r.seq}`).sort(),
    ).toEqual(['mbp/s1/1', 'mbp/s2/2', 'nuc/s1/1']);
    // 返回的是迁移**前**读到的行，状态已在库里落为 expired
    expect(queue.get('mbp', 's1', 1)!.state).toBe('expired');
  });

  test('sweepExpired 未到点不动', () => {
    queue.park('mbp', 's1', 1, 1000);
    expect(queue.sweepExpired(1000 + TTL - 1)).toEqual([]);
    expect(queue.get('mbp', 's1', 1)!.state).toBe('pending');
  });

  test('purgeSettled 只清早已结算的，pending 一律留着', () => {
    queue.park('mbp', 's1', 1, 1000);
    queue.park('mbp', 's1', 2, 1000);
    queue.markDelivered('mbp', 's1', 1, 1100);
    expect(queue.purgeSettled(5000)).toBe(1);
    expect(queue.get('mbp', 's1', 1)).toBeNull();
    expect(queue.get('mbp', 's1', 2)!.state).toBe('pending');
  });

  test('expire 单条：密文丢失时判过期而非已送达', () => {
    queue.park('mbp', 's1', 1, 1000);
    expect(queue.expire('mbp', 's1', 1, 1100)).toBe(true);
    expect(queue.get('mbp', 's1', 1)!.state).toBe('expired');
  });
});

describe('投递顺序', () => {
  test('pending 按排队时间再按 seq 升序', () => {
    queue.park('mbp', 's1', 5, 1000);
    queue.park('mbp', 's1', 3, 1000);
    queue.park('mbp', 's2', 1, 2000);
    expect(queue.pending('mbp', 2500).map((r) => r.seq)).toEqual([3, 5, 1]);
  });
});

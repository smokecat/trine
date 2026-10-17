/**
 * 排队与 clientMsgId 幂等去重。
 */
import { describe, expect, test } from 'bun:test';
import { InputQueue } from './queue.ts';

describe('InputQueue', () => {
  test('空闲时入队提示立即执行', () => {
    const queue = new InputQueue({ now: () => 0 });
    const result = queue.enqueue('m1', '你好');
    expect(result).toEqual({ accepted: true, duplicate: false, shouldRunNow: true });
  });

  test('运行中入队只排队不立即执行', () => {
    const queue = new InputQueue({ now: () => 0 });
    queue.setRunning(true);
    const result = queue.enqueue('m1', '你好');
    expect(result).toEqual({ accepted: true, duplicate: false, shouldRunNow: false });
    expect(queue.length).toBe(1);
  });

  test('重复 clientMsgId 不重复入队', () => {
    const queue = new InputQueue({ now: () => 0 });
    queue.enqueue('m1', '你好');
    const again = queue.enqueue('m1', '你好');

    expect(again).toEqual({ accepted: false, duplicate: true });
    expect(queue.length).toBe(1);
  });

  test('去重跨越取出——已执行的消息重推也不再执行', () => {
    const queue = new InputQueue({ now: () => 0 });
    queue.enqueue('m1', '第一条');
    expect(queue.takeNext()?.text).toBe('第一条');
    expect(queue.length).toBe(0);

    const replay = queue.enqueue('m1', '第一条');
    expect(replay).toEqual({ accepted: false, duplicate: true });
    expect(queue.length).toBe(0);
  });

  test('FIFO 顺序', () => {
    const queue = new InputQueue({ now: () => 0 });
    queue.enqueue('a', '1');
    queue.enqueue('b', '2');
    queue.enqueue('c', '3');

    expect([queue.takeNext()?.text, queue.takeNext()?.text, queue.takeNext()?.text]).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(queue.takeNext()).toBeUndefined();
  });

  test('recall 撤回未执行的消息', () => {
    const queue = new InputQueue({ now: () => 0 });
    queue.enqueue('a', '1');
    queue.enqueue('b', '2');

    expect(queue.recall('a')).toBe(true);
    expect(queue.length).toBe(1);
    expect(queue.takeNext()?.clientMsgId).toBe('b');
  });

  test('recall 已执行/不存在的返回 false', () => {
    const queue = new InputQueue({ now: () => 0 });
    queue.enqueue('a', '1');
    queue.takeNext();

    expect(queue.recall('a')).toBe(false);
    expect(queue.recall('never')).toBe(false);
  });

  test('撤回后同 id 重推不会复活（去重表不因撤回而清）', () => {
    const queue = new InputQueue({ now: () => 0 });
    queue.enqueue('a', '1');
    queue.recall('a');

    expect(queue.enqueue('a', '1')).toEqual({ accepted: false, duplicate: true });
    expect(queue.length).toBe(0);
  });

  test('去重表有界，超容量淘汰最旧的', () => {
    const queue = new InputQueue({ now: () => 0, dedupeCapacity: 3 });
    for (const id of ['a', 'b', 'c', 'd']) {
      queue.enqueue(id, id);
      queue.takeNext();
    }
    // a 已被淘汰 → 重推会被当成新消息
    expect(queue.enqueue('a', 'a')).toMatchObject({ duplicate: false });
    // d 还在表里
    expect(queue.enqueue('d', 'd')).toMatchObject({ duplicate: true });
  });

  test('clear 返回被丢弃的条目', () => {
    const queue = new InputQueue({ now: () => 0 });
    queue.enqueue('a', '1');
    queue.enqueue('b', '2');

    const dropped = queue.clear();
    expect(dropped.map((d) => d.clientMsgId)).toEqual(['a', 'b']);
    expect(queue.length).toBe(0);
  });

  test('记录入队时刻', () => {
    let clock = 1_234;
    const queue = new InputQueue({ now: () => clock });
    queue.enqueue('a', '1');
    clock = 9_999;
    queue.enqueue('b', '2');

    expect(queue.items.map((i) => i.queuedAt)).toEqual([1_234, 9_999]);
  });
});

/**
 * 文件预览缓存：LRU 淘汰 + 对象 URL 引用计数（可见消费者在用时不 revoke）。
 */
import { describe, expect, test } from 'bun:test';
import { FileCache } from './file-cache.ts';

interface Item {
  url: string;
  size: number;
}

function setup(maxEntries = 2, maxBytes = 1000): { cache: FileCache<Item>; revoked: string[] } {
  const revoked: string[] = [];
  const cache = new FileCache<Item>({ maxEntries, maxBytes, sizeOf: (i) => i.size, revoke: (u) => revoked.push(u) });
  return { cache, revoked };
}

describe('FileCache', () => {
  test('超出条数时淘汰最旧的并 revoke；命中会挪到最新', () => {
    const { cache, revoked } = setup(2);
    cache.set('a', { url: 'blob:a', size: 1 });
    cache.set('b', { url: 'blob:b', size: 1 });
    expect(cache.get('a')?.url).toBe('blob:a'); // a 变最新
    cache.set('c', { url: 'blob:c', size: 1 });
    expect(revoked).toEqual(['blob:b']);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  test('超出总字节也淘汰，但最新那个即使单个超额也留着', () => {
    const { cache, revoked } = setup(10, 100);
    cache.set('a', { url: 'blob:a', size: 60 });
    cache.set('b', { url: 'blob:b', size: 500 });
    expect(revoked).toEqual(['blob:a']);
    expect(cache.get('b')?.url).toBe('blob:b');
  });

  test('被占用的条目不参与淘汰；释放后补淘汰', () => {
    const { cache, revoked } = setup(1);
    cache.set('a', { url: 'blob:a', size: 1 });
    const release = cache.retain('blob:a');
    cache.set('b', { url: 'blob:b', size: 1 });
    expect(revoked).toEqual([]);
    expect(cache.get('a')?.url).toBe('blob:a');
    cache.get('b'); // b 变最新，a 最旧
    release();
    expect(revoked).toEqual(['blob:a']);
    expect(cache.get('a')).toBeUndefined();
  });

  test('刷新替换：旧 URL 有人在用时退役，最后一个使用者释放才 revoke', () => {
    const { cache, revoked } = setup(5);
    cache.set('a', { url: 'blob:a1', size: 1 });
    const r1 = cache.retain('blob:a1');
    const r2 = cache.retain('blob:a1');
    cache.set('a', { url: 'blob:a2', size: 1 });
    expect(revoked).toEqual([]);
    expect(cache.get('a')?.url).toBe('blob:a2');
    r1();
    r1(); // 幂等：重复释放不多减
    expect(cache.refCount('blob:a1')).toBe(1);
    expect(revoked).toEqual([]);
    r2();
    expect(revoked).toEqual(['blob:a1']);
  });

  test('没人用时刷新替换立即 revoke 旧 URL', () => {
    const { cache, revoked } = setup(5);
    cache.set('a', { url: 'blob:a1', size: 1 });
    cache.set('a', { url: 'blob:a2', size: 1 });
    expect(revoked).toEqual(['blob:a1']);
  });

  test('还在缓存里的 URL 释放后不 revoke（只是不再被占用）', () => {
    const { cache, revoked } = setup(5);
    cache.set('a', { url: 'blob:a', size: 1 });
    cache.retain('blob:a')();
    expect(revoked).toEqual([]);
    expect(cache.get('a')?.url).toBe('blob:a');
  });
});

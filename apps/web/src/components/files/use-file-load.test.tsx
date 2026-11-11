/**
 * useLeasedLoad：租约在结果到达时就已取得；取消（deps 变了）时迟到的结果立即释放；
 * 交给 React 的结果在换内容、卸载时释放。
 */
import { afterEach, describe, expect, test } from 'bun:test';

await import('@/lib/dom-test-env.ts');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useLeasedLoad } = await import('./use-file-load.ts');

let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

const tick = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 0)));

describe('useLeasedLoad', () => {
  test('取消的加载：结果迟到即释放；显示中的在换内容 / 卸载时释放', async () => {
    const released: string[] = [];
    const pending = new Map<string, (v: string) => void>();
    const fn = (key: string) => () =>
      new Promise<{ value: string; release: () => void }>((resolve) => {
        pending.set(key, (v) => resolve({ value: v, release: () => released.push(v) }));
      });
    let shown: string | undefined;
    function H({ k }: { k: string }): null {
      const [load] = useLeasedLoad(fn(k), [k]);
      shown = load.state === 'ok' ? load.value : undefined;
      return null;
    }
    root = createRoot(document.createElement('div'));
    act(() => root!.render(<H k="a" />));
    // a 还没回来就换成 b：a 的加载被取消
    act(() => root!.render(<H k="b" />));
    await act(async () => pending.get('a')!('A'));
    await tick();
    expect(released).toEqual(['A']);
    expect(shown).toBeUndefined();
    await act(async () => pending.get('b')!('B'));
    await tick();
    expect(shown).toBe('B');
    expect(released).toEqual(['A']);
    act(() => root!.unmount());
    root = null;
    expect(released).toEqual(['A', 'B']);
  });
});

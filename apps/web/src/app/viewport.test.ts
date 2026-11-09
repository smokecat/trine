import { expect, test } from 'bun:test';
import { trackVisualViewport } from './viewport.ts';
function fixture() {
  const values = new Map<string, string>();
  const root = { style: {
    setProperty: (key: string, value: string) => values.set(key, value),
    removeProperty: (key: string) => values.delete(key),
  } } as unknown as HTMLElement;
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  const win = Object.assign(new EventTarget(), { visualViewport: viewport, innerHeight: 800 });
  return { values, root, viewport, win: win as unknown as Window };
}
test('keyboard resize and viewport pan keep the shell within visible bounds, then restore', () => {
  const f = fixture();
  const stop = trackVisualViewport(f.win, f.root);
  f.viewport.height = 400;
  f.viewport.offsetTop = 50;
  f.viewport.dispatchEvent(new Event('resize'));
  expect(f.values.get('--app-viewport-height')).toBe('400px');
  expect(f.values.get('--app-viewport-top')).toBe('50px');
  expect(f.values.get('--app-viewport-bottom')).toBe('350px');
  f.viewport.height = 800;
  f.viewport.offsetTop = 0;
  f.viewport.dispatchEvent(new Event('scroll'));
  expect(f.values.get('--app-viewport-height')).toBe('800px');
  expect(f.values.get('--app-viewport-bottom')).toBe('0px');
  stop();
  expect(f.values.size).toBe(0);
  f.viewport.dispatchEvent(new Event('resize'));
  expect(f.values.size).toBe(0);
});
test('pinch zoom preserves native sizing; returning to normal scale restores tracking', () => {
  const f = fixture();
  const stop = trackVisualViewport(f.win, f.root);
  f.viewport.scale = 2;
  f.viewport.dispatchEvent(new Event('resize'));
  expect(f.values.size).toBe(0);
  f.viewport.scale = 1;
  f.viewport.dispatchEvent(new Event('resize'));
  expect(f.values.get('--app-viewport-height')).toBe('800px');
  stop();
});
test('older browsers without VisualViewport keep the CSS fallback', () => {
  const f = fixture();
  const stop = trackVisualViewport({} as Window, f.root);
  expect(f.values.size).toBe(0);
  stop();
});

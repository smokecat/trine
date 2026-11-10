import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// WCAG relative luminance, including alpha compositing of semantic soft fills.
// This checks readability rather than freezing the palette's exact hex values.
type Color = [number, number, number, number];
function color(value: string): Color {
  if (/^#[a-f\d]{6}$/i.test(value)) {
    return [...[1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255), 1] as Color;
  }
  const values = value.match(/[\d.]+/g)!.map(Number);
  return [values[0]! / 255, values[1]! / 255, values[2]! / 255, values[3] ?? 1];
}
function over(a: Color, b: Color): Color {
  return [a[0] * a[3] + b[0] * (1 - a[3]), a[1] * a[3] + b[1] * (1 - a[3]), a[2] * a[3] + b[2] * (1 - a[3]), 1];
}
function luminance(c: Color): number {
  return c.slice(0, 3).reduce((sum, v, i) => sum + [0.2126, 0.7152, 0.0722][i]! *
    (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4), 0);
}
function contrast(a: Color, b: Color): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high! + 0.05) / (low! + 0.05);
}
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
function tokens(selector: string): Record<string, Color> {
  const block = css.slice(css.indexOf(selector) + selector.length).split('}')[0]!;
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[a-f\d]{6}|rgba\([^)]+\));/gi)]
    .map((m) => [m[1]!, color(m[2]!)]));
}
for (const [theme, selector] of [['light', ':root {'], ['system dark', ":root:not([data-theme='light']) {"], ['dark', ':root.dark {']]) {
  describe(`${theme} theme contrast`, () => {
    const t = tokens(selector!);
    for (const background of ['phone-bg', 'surface', 'surface-2', 'surface-3', 'code-bg', 'user-bubble']) {
      test(`text on ${background}`, () => {
        for (const foreground of ['text', 'text-2', 'text-3']) {
          expect(contrast(t[foreground]!, t[background]!)).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
    test('status labels on tinted surfaces', () => {
      for (const status of ['amber', 'red', 'green', 'blue']) {
        for (const surface of ['phone-bg', 'surface', 'surface-2']) {
          expect(contrast(t[status]!, over(t[`${status}-soft`]!, t[surface]!))).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
    test('primary button and selected label', () => {
      expect(contrast(t['accent-fg']!, t.accent!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['accent-ink']!, over(t['accent-soft']!, t.surface!))).toBeGreaterThanOrEqual(4.5);
    });
    test('engine marks', () => {
      for (const engine of ['engine-claude', 'engine-codex']) {
        for (const surface of ['phone-bg', 'surface', 'surface-2', 'surface-3']) {
          expect(contrast(t[engine]!, t[surface]!)).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
    test('input boundary', () => {
      for (const surface of ['phone-bg', 'surface', 'surface-2']) {
        expect(contrast(t.input!, t[surface]!)).toBeGreaterThanOrEqual(3);
      }
    });
  });
}

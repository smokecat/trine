/**
 * CwdPicker 的复制按钮：常用目录与自定义目录各有一个；离线（disabled）也能复制；不给 onCopy 就不出。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { CwdPicker } = await import('./CwdPicker.tsx');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(props: Partial<React.ComponentProps<typeof CwdPicker>>): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <CwdPicker
        favorites={['/w/one', '/w/two']}
        defaultCwd="/w/one"
        value="/w/one"
        onChange={() => {}}
        onAdd={() => {}}
        onRemove={() => {}}
        onSetDefault={() => {}}
        {...props}
      />,
    ),
  );
}

const copyButtons = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="cwd-copy"]')];

describe('CwdPicker 复制目录', () => {
  test('每个常用目录一个复制按钮，点了复制对应路径；离线也可用', () => {
    const onCopy = mock((_p: string) => {});
    render({ onCopy, disabled: true });
    const buttons = copyButtons();
    expect(buttons).toHaveLength(2);
    expect(buttons.every((b) => !b.disabled)).toBe(true);
    act(() => buttons[1]!.click());
    expect(onCopy.mock.calls).toEqual([['/w/two']]);
  });

  test('自定义目录也能复制', () => {
    const onCopy = mock((_p: string) => {});
    render({ onCopy, value: '/w/custom' });
    const buttons = copyButtons();
    expect(buttons).toHaveLength(3);
    act(() => buttons[2]!.click());
    expect(onCopy.mock.calls).toEqual([['/w/custom']]);
  });

  test('不给 onCopy 就没有复制按钮', () => {
    render({ value: '/w/custom' });
    expect(copyButtons()).toHaveLength(0);
  });
});

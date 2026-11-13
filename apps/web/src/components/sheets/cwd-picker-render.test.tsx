/**
 * CwdPicker：复制按钮（常用目录与自定义目录各有一个；离线也能复制；不给 onCopy 就不出）、
 * 目录名 / 上级路径两行显示、窄屏「⋯」菜单。
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

const $ = (testId: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];

/** Radix 触发器在 pointerdown（左键）时打开 */
function openMenu(trigger: HTMLElement): void {
  act(() => {
    trigger.dispatchEvent(
      new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse' }),
    );
  });
}

describe('CwdPicker 显示', () => {
  test('拆成目录名 + 上级路径，home 显示成 ~；完整路径在 title 与「已选」里', () => {
    render({ favorites: ['/home/u/w/app', '/srv/api'], defaultCwd: '/srv/api', value: '/home/u/w/app', home: '/home/u' });
    expect($('cwd-name').map((e) => e.textContent)).toEqual(['app', 'api']);
    expect($('cwd-parent').map((e) => e.textContent)).toEqual(['~/w', '/srv']);
    expect($('cwd-pick').map((e) => e.title)).toEqual(['/home/u/w/app', '/srv/api']);
    expect($('cwd-selected-full')[0]!.textContent).toBe('已选：/home/u/w/app');
  });

  test('默认目录在目录名旁有星标；没选目录不出「已选」', () => {
    render({ value: '' });
    const picks = $('cwd-pick');
    expect(picks[0]!.querySelector('[data-testid="cwd-default-mark"]')).not.toBeNull();
    expect(picks[1]!.querySelector('[data-testid="cwd-default-mark"]')).toBeNull();
    expect($('cwd-selected-full')).toHaveLength(0);
  });

  test('「⋯」菜单：复制、设为默认、移除对应那一行；默认目录不能再设默认', () => {
    const onCopy = mock((_p: string) => {});
    const onSetDefault = mock((_p: string) => {});
    const onRemove = mock((_p: string) => {});
    render({ onCopy, onSetDefault, onRemove });
    const menus = $('cwd-row-menu');
    expect(menus).toHaveLength(2);

    openMenu(menus[0]!);
    expect($('cwd-menu-default')[0]!.hasAttribute('data-disabled')).toBe(true);
    act(() => $('cwd-menu-copy')[0]!.click());
    expect(onCopy.mock.calls).toEqual([['/w/one']]);

    openMenu(menus[1]!);
    act(() => $('cwd-menu-default')[0]!.click());
    expect(onSetDefault.mock.calls).toEqual([['/w/two']]);

    openMenu(menus[1]!);
    act(() => $('cwd-menu-remove')[0]!.click());
    expect(onRemove.mock.calls).toEqual([['/w/two']]);
  });
});

import { afterEach, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter, useLocation } = await import('react-router');
const { Sidebar } = await import('./Sidebar.tsx');
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}
test('sidebar create and cancel preserve the current session and other query parameters', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(
    <MemoryRouter initialEntries={['/s/demo-machine/demo-session?keep=1']}>
      <Location />
      <Sidebar filter={null} onFilterChange={() => {}} />
    </MemoryRouter>,
  ));
  await act(async () => (host!.querySelector('[data-testid="sidebar-new"]') as HTMLButtonElement).click());
  expect(host.querySelector('output')!.textContent).toBe('/s/demo-machine/demo-session?keep=1&new=1');
  const close = document.querySelector('[data-testid="new-session-sheet"] [data-slot="sheet-close"]') as HTMLButtonElement;
  expect(close).not.toBeNull();
  await act(async () => close.click());
  expect(host.querySelector('output')!.textContent).toBe('/s/demo-machine/demo-session?keep=1');
});

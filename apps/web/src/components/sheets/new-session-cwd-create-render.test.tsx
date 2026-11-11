/**
 * 新建会话时创建工作目录（cwd-create）：目录不存在时提前标出、开始会话前确认新建，
 * 确认后先建目录再建会话；已存在的目录不多一步；旧 agent（没有能力位）不预检。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router');
const { runtimeState, store } = await import('@/app/runtime.ts');
const { NewSessionSheet } = await import('./NewSessionSheet.tsx');
const { CwdPrepareError } = await import('@/lib/client.ts');

const MACHINE = 'mbp';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => runtimeState.setState({ client: null }));
});

interface Calls {
  prepares: { path: string; create: boolean }[];
  created: string[];
}

/** 假机器：existing 里的目录存在；/etc/passwd 是文件 */
function stubClient(calls: Calls, existing: Set<string>) {
  return {
    on: () => () => {},
    request: () => Promise.resolve({ type: 'cwd.list.response' }),
    send: () => true,
    extRequest: async () => ({ type: 'ext.catalog.response', rev: 'r', items: [] }),
    prepareCwd: async (_m: string, input: string, create: boolean) => {
      calls.prepares.push({ path: input, create });
      const path = input.replace(/^~/, '/home/u');
      if (path.startsWith('/etc/passwd')) throw new CwdPrepareError('not_dir', '这个路径是文件，不是目录');
      if (existing.has(path)) return { path, status: 'exists', missing: [] };
      const missing: string[] = [];
      for (let cur = path; !existing.has(cur) && cur !== '/'; cur = cur.slice(0, cur.lastIndexOf('/')) || '/') missing.unshift(cur);
      if (!create) return { path, status: 'missing', missing };
      for (const p of missing) existing.add(p);
      return { path, status: 'created', missing };
    },
    createSession: async (_m: string, args: { cwd: string }) => {
      calls.created.push(args.cwd);
      return { sessionId: 'new1' };
    },
    sendInput: () => 'c1',
  };
}

function setup(options: { capable?: boolean; existing?: string[] } = {}): Calls {
  const calls: Calls = { prepares: [], created: [] };
  const existing = new Set(options.existing ?? ['/home', '/home/u', '/repo']);
  act(() => {
    runtimeState.setState({ client: stubClient(calls, existing) as never });
    store.setState({
      machines: {
        [MACHINE]: {
          machineId: MACHINE,
          name: 'MBP',
          online: true,
          lastSeenAt: 1,
          parkedCount: 0,
          info: { name: 'MBP', ...(options.capable === false ? {} : { cwd: { pinOrder: true, create: true } }) },
          cwd: { favorites: ['/repo'], defaultCwd: '/repo' },
          lastError: null,
          stats: null,
          statsHistory: [],
        },
      } as never,
      sessions: {},
    });
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter>
        <NewSessionSheet open onOpenChange={() => {}} />
      </MemoryRouter>,
    );
  });
  return calls;
}

const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}

/** 在自定义输入框里填路径并点「使用」 */
async function useCustom(path: string): Promise<void> {
  const input = $('cwd-input') as HTMLInputElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, path);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => $('cwd-use')!.click());
  await flush();
}

describe('NewSessionSheet · 新建工作目录（cwd-create）', () => {
  test('已存在的目录：只预检，不弹确认，直接建会话', async () => {
    const calls = setup();
    await flush();
    expect($('ns-cwd-missing')).toBeNull();
    await act(async () => $('ns-create')!.click());
    await flush();
    expect($('ns-cwd-confirm')).toBeNull();
    expect(calls.prepares.every((p) => !p.create)).toBe(true);
    expect(calls.created).toEqual(['/repo']);
  });

  test('不存在：提前标「将新建」；开始会话先确认，列出各级目录；确认后先建目录再用解析后的路径建会话', async () => {
    const calls = setup();
    await flush();
    await useCustom('~/work/new');
    expect($('ns-cwd-missing')).not.toBeNull();
    expect($('cwd-custom-note')!.textContent).toBe('（将新建）');

    await act(async () => $('ns-create')!.click());
    await flush();
    expect($('ns-cwd-confirm')).not.toBeNull();
    const items = Array.from(document.querySelectorAll('[data-testid="ns-cwd-confirm-list"] li')).map((li) => li.lastElementChild?.textContent);
    expect(items).toEqual(['/home/u/work', '/home/u/work/new']);
    expect(calls.created).toEqual([]);

    await act(async () => $('ns-cwd-confirm-confirm')!.click());
    await flush();
    expect(calls.prepares.filter((p) => p.create)).toEqual([{ path: '/home/u/work/new', create: true }]);
    expect(calls.created).toEqual(['/home/u/work/new']);
  });

  test('确认框里取消：什么都不建', async () => {
    const calls = setup();
    await flush();
    await useCustom('/srv/proj');
    await act(async () => $('ns-create')!.click());
    await flush();
    const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="ns-cwd-confirm"] button')).find(
      (b) => b.textContent === '取消',
    )!;
    await act(async () => cancel.click());
    await flush();
    expect($('ns-cwd-confirm')).toBeNull();
    expect(calls.prepares.some((p) => p.create)).toBe(false);
    expect(calls.created).toEqual([]);
  });

  test('路径不可用：面板里标出原因；开始会话不建会话', async () => {
    const calls = setup();
    await flush();
    await useCustom('/etc/passwd/x');
    expect($('ns-cwd-error')!.textContent).toContain('不是目录');
    await act(async () => $('ns-create')!.click());
    await flush();
    expect($('ns-cwd-confirm')).toBeNull();
    expect(calls.created).toEqual([]);
  });

  test('旧 agent（没有 cwd.create 能力位）：不预检，按原样建会话', async () => {
    const calls = setup({ capable: false });
    await flush();
    await useCustom('~/work/new');
    expect($('ns-cwd-missing')).toBeNull();
    await act(async () => $('ns-create')!.click());
    await flush();
    expect(calls.prepares).toEqual([]);
    expect(calls.created).toEqual(['~/work/new']);
  });
});

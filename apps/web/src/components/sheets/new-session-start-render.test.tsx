/**
 * 新建会话「从任务开始」（扩展 U7）：机器有 newSession 扩展时出现；选一项预填首条消息（可改）；
 * 开始会话 = 建会话 → 关联（等回执）→ 发首条消息。关联失败不挡建会话。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router');
const { runtimeState, store } = await import('@/app/runtime.ts');
const { NewSessionSheet } = await import('./NewSessionSheet.tsx');

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

const CATALOG_ITEM = {
  id: 'tasks',
  name: 'Tasks',
  version: '1.0.0',
  apiVersion: 1,
  contributes: { newSession: { title: '从任务开始' } },
  capabilities: ['prompt.insert'],
  enabled: true,
  policy: { trust: 'custom', capabilities: {} },
  status: 'ok',
};

interface Calls {
  order: string[];
  reads: Record<string, unknown>[];
  linkBodies: Record<string, unknown>[];
  sent: { sessionId: string; text: string }[];
}

function stubClient(calls: Calls, options: { linkOk?: boolean; contributes?: boolean } = {}) {
  const listeners: ((machineId: string, event: unknown) => void)[] = [];
  let n = 0;
  return {
    on: (type: string, fn: (machineId: string, event: unknown) => void) => {
      if (type === 'event') listeners.push(fn);
      return () => {};
    },
    request: () => Promise.resolve({ type: 'cwd.list.response' }),
    send: () => true,
    extRequest: async (machineId: string, body: Record<string, unknown>) => {
      switch (body.type) {
        case 'ext.catalog.request':
          return { type: 'ext.catalog.response', rev: 'r1', items: options.contributes === false ? [] : [CATALOG_ITEM] };
        case 'ext.read': {
          calls.reads.push(body);
          const res = {
            type: 'ext.read.response',
            reqId: `q${++n}`,
            ts: 1,
            seq: n,
            dir: 'a2c',
            ext: 'tasks',
            op: 'pick',
            point: 'newSession',
            cwd: body.cwd,
            rev: n,
            ok: true,
            items: [
              { id: 'a', title: 'Task A', link: { ref: 'a', label: 'Task A' }, local: [{ type: 'prompt.insert', text: '继续 task-a 任务' }] },
              { id: 'b', title: 'Task B' },
            ],
          };
          for (const l of listeners) l(machineId, res);
          return res;
        }
        case 'session.links.update':
          calls.order.push('link');
          calls.linkBodies.push(body);
          return options.linkOk === false
            ? { type: 'session.links.update.response', ok: false, error: { code: 'denied', message: '关联太多' } }
            : { type: 'session.links.update.response', ok: true };
        default:
          throw new Error(`unexpected ${String(body.type)}`);
      }
    },
    createSession: async () => {
      calls.order.push('create');
      return { sessionId: 'new1' };
    },
    sendInput: (_m: string, sessionId: string, text: string) => {
      calls.order.push('send');
      calls.sent.push({ sessionId, text });
      return 'c1';
    },
  };
}

function setup(options: { linkOk?: boolean; contributes?: boolean } = {}): Calls {
  const calls: Calls = { order: [], reads: [], linkBodies: [], sent: [] };
  act(() => {
    runtimeState.setState({ client: stubClient(calls, options) as never });
    store.setState({
      machines: {
        [MACHINE]: {
          machineId: MACHINE,
          name: 'MBP',
          online: true,
          lastSeenAt: 1,
          parkedCount: 0,
          info: { name: 'MBP', extensions: { api: 1, rev: 'r1', count: 1, records: true } },
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
const $$ = (id: string) => Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}

describe('NewSessionSheet · 从任务开始（U7）', () => {
  test('没有 newSession 扩展：不出现这一节', async () => {
    setup({ contributes: false });
    await flush();
    expect($('ns-start')).toBeNull();
  });

  test('选一项 → 预填可改的首条消息；开始会话 = 建会话 → 关联 → 发送', async () => {
    const calls = setup();
    await flush();
    expect($('ns-start')).not.toBeNull();
    expect(calls.reads[0]).toMatchObject({ op: 'pick', point: 'newSession', cwd: '/repo' });
    expect(calls.reads[0]!.targetSessionId).toBeUndefined();
    const items = $$('ns-start-item');
    expect(items.map((b) => b.textContent)).toEqual(['Task A', 'Task B']);
    // 既没有预填也没有关联的项不可选
    expect((items[1] as HTMLButtonElement).disabled).toBe(true);
    act(() => items[0]!.click());
    expect($('ns-start-selected')!.textContent).toContain('建好后关联「Task A」');
    const prompt = $('ns-prompt') as HTMLTextAreaElement;
    expect(prompt.value).toBe('继续 task-a 任务');

    await act(async () => $('ns-create')!.click());
    await flush();
    expect(calls.order).toEqual(['create', 'link', 'send']);
    expect(calls.linkBodies[0]).toMatchObject({ targetSessionId: 'new1', ext: 'tasks', add: [{ ref: 'a', label: 'Task A' }] });
    expect(calls.sent).toEqual([{ sessionId: 'new1', text: '继续 task-a 任务' }]);
  });

  test('清掉选择：回到列表，不关联、不发送', async () => {
    const calls = setup();
    await flush();
    act(() => $$('ns-start-item')[0]!.click());
    act(() => $('ns-start-clear')!.click());
    expect($('ns-prompt')).toBeNull();
    await flush();
    await act(async () => $('ns-create')!.click());
    await flush();
    expect(calls.order).toEqual(['create']);
  });

  test('关联失败：会话照样建、消息照样发', async () => {
    const calls = setup({ linkOk: false });
    await flush();
    act(() => $$('ns-start-item')[0]!.click());
    await act(async () => $('ns-create')!.click());
    await flush();
    expect(calls.order).toEqual(['create', 'link', 'send']);
  });
});

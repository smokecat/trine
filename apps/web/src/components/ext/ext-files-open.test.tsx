/**
 * 会话面板的 files.open（方案 §4）：给了处理器才在读取 / 动作请求里声明特性；执行时先关面板
 * 再打开；结果迟到、浏览器已换到别的会话时丢掉。数据全是合成的。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import type { ExtFilesOpenEffect, ExtWireView } from '@trine/core';
import '@/lib/dom-test-env.ts';

const { act, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter } = await import('react-router');
const { runtimeState, store } = await import('@/app/runtime.ts');
const { ExtPanelSheet } = await import('./ExtPanel.tsx');

const MACHINE = 'm1';
const SESSION = 's1';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => runtimeState.setState({ client: null }));
  // 还原成 happy-dom 的默认地址，不影响同进程里的其他测试
  setURL('about:blank');
});

/** happy-dom 默认在 about:blank，history API 改不了 pathname：直接换 URL */
function setURL(url: string): void {
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url);
}

function setPath(path: string): void {
  setURL(`http://localhost${path}`);
}

const VIEW: ExtWireView = {
  sections: [
    {
      id: 's',
      items: [
        {
          id: 'task-a',
          title: 'Task A',
          actions: [
            { id: 'browse', label: '浏览任务目录', local: [{ type: 'files.open', path: '/w/.margin/tasks/task-a', dir: true }] },
            { id: 'later', label: '稍后打开', token: 'tok-1' },
          ],
        },
      ],
    },
  ],
};

interface Fake {
  requests: Record<string, unknown>[];
  /** 控制 prepare 什么时候回 */
  releasePrepare: (() => void) | null;
}

function setup(): Fake {
  const fake: Fake = { requests: [], releasePrepare: null };
  const listeners: ((machineId: string, event: unknown) => void)[] = [];
  const emit = (event: Record<string, unknown>): void => {
    for (const l of listeners) l(MACHINE, { ts: 1, seq: 1, dir: 'a2c', ...event });
  };
  const client = {
    on: (name: string, fn: (machineId: string, event: unknown) => void) => {
      if (name === 'event') listeners.push(fn);
      return () => {};
    },
    extSend: (_m: string, body: Record<string, unknown>) => fake.requests.push(body),
    extRequest: async (_m: string, body: Record<string, unknown>) => {
      fake.requests.push(body);
      if (body['type'] === 'ext.catalog.request') {
        return {
          rev: 'r1',
          items: [
            {
              id: 'tasks',
              name: 'Tasks',
              version: '1',
              apiVersion: 1,
              contributes: { sessionPanel: { title: '任务' } },
              capabilities: ['invoke'],
              enabled: true,
              policy: { trust: 'full', capabilities: {} },
              status: 'ok',
            },
          ],
        };
      }
      if (body['type'] === 'ext.read') {
        const res = { type: 'ext.read.response', reqId: 'x', ext: 'tasks', op: 'view', point: 'sessionPanel', targetSessionId: SESSION, rev: 1, ok: true, view: VIEW };
        emit(res);
        return res;
      }
      if (body['type'] === 'ext.action.prepare') {
        await new Promise<void>((r) => (fake.releasePrepare = r));
        return {
          type: 'ext.action.result',
          ts: 1,
          seq: 1,
          dir: 'a2c',
          reqId: 'p',
          invocationId: body['invocationId'],
          ok: true,
          local: [{ type: 'files.open', path: '/w/b.md' }],
        };
      }
      throw new Error(`unexpected ${String(body['type'])}`);
    },
  };
  act(() => {
    runtimeState.setState({ client: client as never });
    store.setState({
      machines: {
        [MACHINE]: {
          machineId: MACHINE,
          name: 'M',
          online: true,
          lastSeenAt: 1,
          parkedCount: 0,
          info: { name: 'M', extensions: { api: 1, rev: 'r1', count: 1 } },
          cwd: null,
          lastError: null,
          stats: null,
          statsHistory: [],
        },
      } as never,
      sessions: {},
    });
  });
  return fake;
}

const tick = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 0)));
const $ = (sel: string): HTMLElement | null => document.querySelector(sel);

async function mount(onFilesOpen: ((e: ExtFilesOpenEffect) => void) | undefined): Promise<{ isOpen: () => boolean }> {
  let open = true;
  function Harness(): React.JSX.Element {
    const [isOpen, setOpen] = useState(true);
    open = isOpen;
    return (
      <MemoryRouter>
        <ExtPanelSheet open={isOpen} onOpenChange={setOpen} machineId={MACHINE} sessionId={SESSION} onFilesOpen={onFilesOpen} />
      </MemoryRouter>
    );
  }
  setPath(`/s/${MACHINE}/${SESSION}`);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Harness />));
  await tick();
  await tick();
  return { isOpen: () => open };
}

const reads = (fake: Fake) => fake.requests.filter((r) => r['type'] === 'ext.read');

describe('会话面板 · files.open', () => {
  test('有处理器：读取与续租声明 files.open；点击后先关面板再打开', async () => {
    const fake = setup();
    const opened: ExtFilesOpenEffect[] = [];
    const panel = await mount((e) => opened.push(e));
    expect(reads(fake).length).toBeGreaterThan(0);
    for (const r of reads(fake)) expect(r['features']).toEqual(['files.open']);
    act(() => $('[data-action-id="browse"]')!.click());
    await tick();
    expect(opened).toEqual([{ type: 'files.open', path: '/w/.margin/tasks/task-a', dir: true }]);
    expect(panel.isOpen()).toBe(false);
  });

  test('没有处理器（agent 不支持文件查看）：不声明特性', async () => {
    const fake = setup();
    await mount(undefined);
    expect(reads(fake).length).toBeGreaterThan(0);
    for (const r of reads(fake)) expect(r['features']).toBeUndefined();
  });

  test('token 动作：prepare 带特性；结果回来时已换到别的会话 → 不打开', async () => {
    const fake = setup();
    const opened: ExtFilesOpenEffect[] = [];
    await mount((e) => opened.push(e));
    act(() => $('[data-action-id="later"]')!.click());
    await tick();
    const prepare = fake.requests.find((r) => r['type'] === 'ext.action.prepare');
    expect(prepare?.['features']).toEqual(['files.open']);
    setPath(`/s/${MACHINE}/other`);
    fake.releasePrepare!();
    await tick();
    await tick();
    expect(opened).toEqual([]);
  });

  test('token 动作：还在原会话 → 打开', async () => {
    const fake = setup();
    const opened: ExtFilesOpenEffect[] = [];
    await mount((e) => opened.push(e));
    act(() => $('[data-action-id="later"]')!.click());
    await tick();
    fake.releasePrepare!();
    await tick();
    await tick();
    expect(opened).toEqual([{ type: 'files.open', path: '/w/b.md' }]);
  });
});

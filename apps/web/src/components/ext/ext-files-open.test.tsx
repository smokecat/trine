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
            { id: 'mixed', label: '插入并打开', local: [{ type: 'prompt.insert', text: 'x' }, { type: 'files.open', path: '/w/a.md' }] },
            { id: 'later', label: '稍后打开', token: 'tok-1' },
          ],
        },
      ],
    },
  ],
};

/** agent 对不带特性的读取给的视图：带 files.open 的动作已被过滤 */
const PLAIN_VIEW: ExtWireView = {
  sections: [{ id: 's', items: [{ id: 'task-a', title: 'Task A', actions: [{ id: 'later', label: '稍后打开', token: 'tok-1' }] }] }],
};

interface Fake {
  requests: Record<string, unknown>[];
  /** 控制 prepare 什么时候回 */
  releasePrepare: (() => void) | null;
}

/**
 * agentFeatures：machine.info.extensions.features（undefined = 旧 agent）；
 * forceView：不管声明什么都回这份（模拟边界情况下收到本页执行不了的动作）
 */
function setup(options: { agentFeatures?: string[] | undefined; forceView?: ExtWireView } = { agentFeatures: ['files.open'] }): Fake {
  const fake: Fake = { requests: [], releasePrepare: null };
  const listeners: ((machineId: string, event: unknown) => void)[] = [];
  let rev = 0;
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
        // 与 agent 一致：回带有效特性集；没声明就给过滤后的视图
        const features = body['features'] as string[] | undefined;
        const view = options.forceView ?? (features?.includes('files.open') === true ? VIEW : PLAIN_VIEW);
        const res = {
          type: 'ext.read.response',
          reqId: 'x',
          ext: 'tasks',
          op: 'view',
          point: 'sessionPanel',
          targetSessionId: SESSION,
          rev: ++rev,
          ok: true,
          view,
          ...(features === undefined ? {} : { features }),
        };
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
          info: {
            name: 'M',
            extensions: { api: 1, rev: 'r1', count: 1, ...(options.agentFeatures === undefined ? {} : { features: options.agentFeatures }) },
          },
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

type Handler = ((e: ExtFilesOpenEffect) => void) | undefined;

async function mount(onFilesOpen: Handler): Promise<{ isOpen: () => boolean; setHandler: (h: Handler) => void }> {
  let open = true;
  let setHandlerState: (h: { fn: Handler }) => void = () => {};
  function Harness(): React.JSX.Element {
    const [isOpen, setOpen] = useState(true);
    const [handler, setHandler] = useState<{ fn: Handler }>({ fn: onFilesOpen });
    open = isOpen;
    setHandlerState = setHandler;
    return (
      <MemoryRouter>
        <ExtPanelSheet open={isOpen} onOpenChange={setOpen} machineId={MACHINE} sessionId={SESSION} onFilesOpen={handler.fn} />
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
  return { isOpen: () => open, setHandler: (fn) => act(() => setHandlerState({ fn })) };
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

  test('读取与 prepare 都带页面实例 id', async () => {
    const fake = setup();
    await mount(() => {});
    for (const r of reads(fake)) expect(typeof r['client']).toBe('string');
    act(() => $('[data-action-id="later"]')!.click());
    await tick();
    expect(typeof fake.requests.find((r) => r['type'] === 'ext.action.prepare')?.['client']).toBe('string');
  });

  test('旧 agent（machine.info 没有 features）：即使有处理器也不声明', async () => {
    const fake = setup({ agentFeatures: undefined });
    await mount(() => {});
    expect(reads(fake).length).toBeGreaterThan(0);
    for (const r of reads(fake)) expect(r['features']).toBeUndefined();
  });

  test('处理器没了（特性集变化）：不再显示旧特性集下的动作，按新键重读', async () => {
    const fake = setup();
    const panel = await mount(() => {});
    expect($('[data-action-id="browse"]')).not.toBeNull();
    const before = reads(fake).length;
    panel.setHandler(undefined);
    // 同一帧里就不能再看到旧缓存的带 files.open 的动作
    expect($('[data-action-id="browse"]')).toBeNull();
    await tick();
    expect(reads(fake).length).toBeGreaterThan(before);
    expect(reads(fake).at(-1)!['features']).toBeUndefined();
    expect($('[data-action-id="browse"]')).toBeNull();
    expect($('[data-action-id="later"]')).not.toBeNull();
  });

  test('收到本页执行不了的动作（插入 + files.open，但没有处理器）：整条不执行', async () => {
    setup({ agentFeatures: undefined, forceView: VIEW });
    const inserted: string[] = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    setPath(`/s/${MACHINE}/${SESSION}`);
    act(() =>
      root!.render(
        <MemoryRouter>
          <ExtPanelSheet open onOpenChange={() => {}} machineId={MACHINE} sessionId={SESSION} onInsert={(t) => inserted.push(t)} />
        </MemoryRouter>,
      ),
    );
    await tick();
    await tick();
    act(() => $('[data-action-id="mixed"]')!.click());
    await tick();
    expect(inserted).toEqual([]);
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

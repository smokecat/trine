import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtRawView, SessionMeta } from '@trine/core';
import type { EventBody } from '../bridge/types.ts';
import { SessionLinksStore } from './links-store.ts';
import { recordLinkChanges, SessionRecordsStore } from './records-store.ts';
import { ExtensionRegistry, MANIFEST_FILE } from './registry.ts';
import type { RunRequest, RunResult } from './runner.ts';
import { ExtensionService, REFRESH_DEBOUNCE_MS, type ExtHost } from './service.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'trine-extsvc-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Output = unknown | ((req: Omit<RunRequest, 'ext' | 'priority'> & { ext: string }) => unknown);

interface Harness {
  service: ExtensionService;
  registry: ExtensionRegistry;
  links: SessionLinksStore;
  records: SessionRecordsStore;
  sent: { to: string; body: EventBody }[];
  runs: { op: string; input: unknown }[];
  outputs: Map<string, Output>;
  created: Parameters<ExtHost['createSession']>[0][];
  prompts: { sid: string; text: string }[];
  sessions: Map<string, SessionMeta>;
  timers: (() => void)[];
  clock: { now: number };
  /** 进会话链时调（模拟排在前面的命令先生效） */
  chainHook?: (sid: string) => void;
  last<T extends EventBody['type']>(type: T): Extract<EventBody, { type: T }>;
}

function meta(sessionId: string, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId,
    title: `会话 ${sessionId}`,
    state: 'idle',
    lastActivityAt: 1,
    cwd: '/work/repo',
    model: 'opus',
    permissionMode: 'default',
    costUsd: 0,
    ...patch,
  };
}

async function harness(
  manifest: Record<string, unknown> = {},
  policy?: { trust: 'full' | 'custom'; capabilities?: Record<string, 'allow' | 'confirm' | 'deny'> },
): Promise<Harness> {
  const dir = join(root, 'ext');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'run'), '#!/bin/sh\n');
  await chmod(join(dir, 'run'), 0o755);
  await writeFile(
    join(dir, MANIFEST_FILE),
    JSON.stringify({
      apiVersion: 1,
      id: 'tasks',
      name: 'Tasks',
      version: '1.0.0',
      entry: ['./run'],
      contributes: {
        sessionPanel: { title: '任务' },
        sessionBadge: true,
        linkPicker: { title: '关联任务' },
        composerAction: { label: '任务' },
      },
      capabilities: ['prompt.insert', 'prompt.send', 'session.create', 'links.write', 'invoke'],
      ...manifest,
    }),
  );
  const registry = await ExtensionRegistry.load(join(root, 'extensions.json'));
  await registry.add(dir);
  if (policy !== undefined) await registry.setConfig('tasks', { policy: { trust: policy.trust, capabilities: policy.capabilities ?? {} } });
  const links = await SessionLinksStore.load(join(root, 'session-links.json'));
  const records = await SessionRecordsStore.load(join(root, 'session-ext-records.json'), { now: () => h.clock!.now });
  recordLinkChanges(links, records, (ext) => registry.get(ext)?.manifest?.name ?? ext);
  const h: Partial<Harness> = {
    sent: [],
    runs: [],
    outputs: new Map(),
    created: [],
    prompts: [],
    sessions: new Map([['s1', meta('s1')]]),
    timers: [],
    clock: { now: 1_000_000 },
  };
  const host: ExtHost = {
    machine: () => ({ id: 'm1', name: 'mbp' }),
    sessionMeta: async (sid) => h.sessions!.get(sid),
    cachedMeta: (sid) => h.sessions!.get(sid),
    isDeleted: () => false,
    createSession: async (args) => {
      h.created!.push(args);
      h.sessions!.set('new1', meta('new1', { cwd: args.cwd }));
      return { sessionId: 'new1', clientMsgId: 'c-new' };
    },
    withSession: async (sid, fn) => {
      h.chainHook?.(sid);
      return fn({
        meta: async () => h.sessions!.get(sid),
        send: async (text) => {
          h.prompts!.push({ sid, text });
          return { clientMsgId: 'c1', queued: h.sessions!.get(sid)?.state === 'running' };
        },
      });
    },
    broadcastSession: async () => {},
    emitTo: (to, body) => h.sent!.push({ to, body }),
  };
  let n = 0;
  const service = new ExtensionService({
    registry,
    links,
    records,
    host,
    runner: {
      run: async (req): Promise<RunResult> => {
        h.runs!.push({ op: req.op, input: req.input });
        const out = h.outputs!.get(req.op);
        const value = await (typeof out === 'function' ? (out as (r: unknown) => unknown)(req) : out);
        if (value instanceof Error) return { ok: false, code: 'timeout', message: value.message, stderr: '', durationMs: 1 };
        return { ok: true, output: value, stderr: '', durationMs: 1 };
      },
    },
    now: () => h.clock!.now,
    uuid: () => `id-${++n}`,
    setTimer: (fn) => {
      h.timers!.push(fn);
      return h.timers!.length;
    },
    clearTimer: () => {},
  });
  registry.onChange = (ext) => service.invalidate(ext);
  return Object.assign(h, {
    service,
    registry,
    links,
    records,
    last<T extends EventBody['type']>(type: T) {
      const found = [...h.sent!].reverse().find((s) => s.body.type === type);
      if (found === undefined) throw new Error(`没有 ${type}`);
      return found.body as Extract<EventBody, { type: T }>;
    },
  }) as Harness;
}

const VIEW: ExtRawView = {
  sections: [
    {
      id: 'active',
      items: [
        {
          id: 'task-a',
          title: 'Task A',
          link: { ref: 'task-a', label: 'Task A' },
          actions: [
            { id: 'resume-new', label: '新会话接续', effects: [{ type: 'session.create', prompt: '继续 task-a 任务', links: [{ ref: 'task-a', label: 'Task A' }] }] },
            { id: 'resume-here', label: '接续到本会话', effects: [{ type: 'prompt.send', text: '继续 task-a 任务' }] },
            { id: 'insert', label: '插入引用', effects: [{ type: 'prompt.insert', text: '.local/tasks/task-a/README.md' }] },
            { id: 'archive', label: '归档', destructive: true, invoke: { params: { slug: 'task-a' } } },
          ],
        },
      ],
    },
  ],
};

const read = (h: Harness, device = 'd1', extra: Record<string, unknown> = {}) =>
  h.service.read(device, {
    type: 'ext.read',
    ts: 1,
    seq: 1,
    dir: 'c2a',
    reqId: 'r1',
    ext: 'tasks',
    op: 'view',
    point: 'sessionPanel',
    targetSessionId: 's1',
    ...extra,
  } as never);

const actions = (h: Harness) => h.last('ext.read.response').view!.sections[0]!.items[0]!.actions!;
const tokenOf = (h: Harness, id: string) => actions(h).find((a) => a.id === id)!.token!;

const prepare = (h: Harness, token: string, invocationId = 'inv-1', device = 'd1') =>
  h.service.prepare(device, {
    type: 'ext.action.prepare',
    ts: 1,
    seq: 1,
    dir: 'c2a',
    reqId: `p-${invocationId}`,
    invocationId,
    token,
    newSession: { model: 'opus', permissionMode: 'bypassPermissions' },
  } as never);

const commit = (h: Harness, planId: string, invocationId = 'inv-1', device = 'd1') =>
  h.service.commit(device, { type: 'ext.action.commit', ts: 1, seq: 1, dir: 'c2a', reqId: 'c', invocationId, planId } as never);

describe('读取', () => {
  test('视图里只有展示信息：远端动作换成 token，本地动作带 local；读取不执行任何效果', async () => {
    const h = await harness();
    h.outputs.set('view', { view: VIEW });
    await read(h);
    const res = h.last('ext.read.response');
    expect(res).toMatchObject({ reqId: 'r1', ok: true, op: 'view', targetSessionId: 's1' });
    const acts = actions(h);
    expect(acts.find((a) => a.id === 'insert')).toMatchObject({ local: [{ type: 'prompt.insert' }] });
    expect(acts.find((a) => a.id === 'insert')!.token).toBeUndefined();
    for (const id of ['resume-new', 'resume-here', 'archive']) {
      const a = acts.find((x) => x.id === id)!;
      expect(a.token).toBeString();
      expect(JSON.stringify(a)).not.toContain('继续 task-a');
    }
    expect(h.created).toEqual([]);
    expect(h.prompts).toEqual([]);
    // 扩展收到的上下文
    expect(h.runs[0]!.input).toMatchObject({
      apiVersion: 1,
      op: 'view',
      point: 'sessionPanel',
      context: { machine: { id: 'm1' }, cwd: '/work/repo', session: { id: 's1', cwd: '/work/repo' } },
    });
  });

  test('未声明 / 被禁的能力：对应动作不出现在视图里', async () => {
    const h = await harness({ capabilities: ['prompt.insert'] });
    h.outputs.set('view', { view: VIEW });
    await read(h);
    expect(actions(h).map((a) => a.id)).toEqual(['insert']);
  });

  test('composerAction：只允许 prompt.insert / links.add，越界的项不可点击', async () => {
    const h = await harness();
    h.outputs.set('pick', {
      items: [
        { id: 'a', title: 'A', effects: [{ type: 'prompt.insert', text: 'x' }, { type: 'links.add', links: [{ ref: 'a', label: 'A' }] }] },
        { id: 'b', title: 'B', effects: [{ type: 'prompt.send', text: 'go' }] },
      ],
    });
    await read(h, 'd1', { op: 'pick', point: 'composerAction' });
    const items = h.last('ext.read.response').items!;
    expect(items[0]!.token).toBeString();
    expect(items[1]!.token).toBeUndefined();
    expect(items[1]!.local).toBeUndefined();
  });

  test('newSession：只允许 prompt.insert（预填），上下文只有目录、没有会话', async () => {
    const h = await harness({ contributes: { newSession: { title: '从任务开始' } } });
    h.outputs.set('pick', {
      items: [
        { id: 'a', title: 'A', link: { ref: 'a', label: 'A' }, effects: [{ type: 'prompt.insert', text: '继续 a' }] },
        { id: 'b', title: 'B', effects: [{ type: 'session.create', prompt: 'go' }] },
        { id: 'c', title: 'C', effects: [{ type: 'prompt.insert', text: 'x' }, { type: 'links.add', links: [{ ref: 'c', label: 'C' }] }] },
      ],
    });
    await read(h, 'd1', { op: 'pick', point: 'newSession', targetSessionId: undefined, cwd: '/work/other' });
    const items = h.last('ext.read.response').items!;
    expect(items[0]).toMatchObject({ link: { ref: 'a' }, local: [{ type: 'prompt.insert', text: '继续 a' }] });
    expect(items[0]!.token).toBeUndefined();
    for (const item of items.slice(1)) {
      expect(item.token).toBeUndefined();
      expect(item.local).toBeUndefined();
    }
    expect(h.runs[0]!.input).toMatchObject({ op: 'pick', point: 'newSession', context: { cwd: '/work/other' } });
    expect((h.runs[0]!.input as { context: Record<string, unknown> }).context.session).toBeUndefined();
    expect(h.service.tokenCount).toBe(0);
  });

  test('没有贡献这个点 → unsupported；扩展报错 → extension_error；非法输出 → invalid_output', async () => {
    const h = await harness({ contributes: { sessionPanel: { title: 'T' } } });
    await read(h, 'd1', { op: 'pick', point: 'linkPicker' });
    expect(h.last('ext.read.response')).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    h.outputs.set('view', { error: { code: 'no_store', message: '没有任务库' } });
    await read(h);
    expect(h.last('ext.read.response')).toMatchObject({ ok: false, error: { code: 'extension_error', message: '没有任务库' } });
    h.outputs.set('view', { view: { sections: [{ id: 's', items: [{ id: 'i', title: 'x', actions: [{ id: 'a', label: 'a', effects: [{ type: 'rm.rf' }] }] }] }] } });
    await read(h, 'd1', { force: true });
    expect(h.last('ext.read.response')).toMatchObject({ ok: false, error: { code: 'invalid_output' } });
  });

  test('缓存：相同读取不重复起进程；force 绕过', async () => {
    const h = await harness();
    h.outputs.set('view', { view: VIEW });
    await read(h);
    await read(h);
    expect(h.runs).toHaveLength(1);
    await read(h, 'd1', { force: true });
    expect(h.runs).toHaveLength(2);
  });

  test('badge 带回的新 label 刷新已有关联', async () => {
    const h = await harness();
    await h.links.update('s1', 'tasks', [{ ref: 'task-a', label: '旧名' }], [], 1);
    h.sessions.set('s1', meta('s1', { links: h.links.of('s1') }));
    h.outputs.set('badge', { badge: { text: 'active', tone: 'info' }, links: [{ ref: 'task-a', label: '新名' }] });
    await read(h, 'd1', { op: 'badge', point: 'sessionBadge' });
    expect(h.last('ext.read.response')).toMatchObject({ ok: true, badge: { text: 'active' } });
    expect(h.links.of('s1')![0]!.label).toBe('新名');
  });
});

describe('动作', () => {
  test('全托管：新会话接续直接执行，用发起设备的默认值，自动关联', async () => {
    const h = await harness({}, { trust: 'full' });
    h.outputs.set('view', { view: VIEW });
    await read(h);
    await prepare(h, tokenOf(h, 'resume-new'));
    expect(h.created.map(({ precheck: _p, ...rest }) => rest)).toEqual([
      {
        cwd: '/work/repo',
        model: 'opus',
        permissionMode: 'bypassPermissions',
        ext: 'tasks',
        links: [{ ref: 'task-a', label: 'Task A' }],
        prompt: '继续 task-a 任务',
      },
    ]);
    expect(h.last('ext.action.result')).toMatchObject({ invocationId: 'inv-1', ok: true, createdSessionId: 'new1' });
  });

  test('自定义权限：发送要确认；确认的是固定计划，commit 后执行；重复 commit 返回原结果', async () => {
    const h = await harness();
    h.outputs.set('view', { view: VIEW });
    await read(h);
    await prepare(h, tokenOf(h, 'resume-here'));
    const plan = h.last('ext.action.plan');
    expect(plan.plan.steps).toEqual([
      { type: 'prompt.send', targetSessionId: 's1', sessionTitle: '会话 s1', cwd: '/work/repo', permissionMode: 'default', busy: false, text: '继续 task-a 任务' },
    ]);
    expect(h.prompts).toEqual([]);
    await commit(h, plan.planId);
    expect(h.prompts).toEqual([{ sid: 's1', text: '继续 task-a 任务' }]);
    expect(h.last('ext.action.result')).toMatchObject({ ok: true, sent: { clientMsgId: 'c1', queued: false } });
    await commit(h, plan.planId);
    expect(h.prompts).toHaveLength(1);
    expect(h.last('ext.action.result')).toMatchObject({ ok: true, state: 'done' });
  });

  test('token 一次性、只对签发设备有效、过期即失效', async () => {
    const h = await harness({}, { trust: 'full' });
    h.outputs.set('view', { view: VIEW });
    await read(h);
    const token = tokenOf(h, 'resume-here');
    await prepare(h, token, 'inv-other', 'd2');
    expect(h.last('ext.action.result')).toMatchObject({ ok: false, error: { code: 'stale' } });
    // 被别的设备试过一次也作废了（一次性）
    await prepare(h, token, 'inv-1');
    expect(h.last('ext.action.result')).toMatchObject({ ok: false, error: { code: 'stale' } });
    await read(h, 'd1', { force: true });
    const fresh = tokenOf(h, 'resume-here');
    h.clock.now += 11 * 60_000;
    await prepare(h, fresh, 'inv-2');
    expect(h.last('ext.action.result')).toMatchObject({ ok: false, error: { code: 'stale' } });
    expect(h.prompts).toEqual([]);
  });

  test('同一 invocationId 重复 prepare 只执行一次', async () => {
    const h = await harness({}, { trust: 'full' });
    h.outputs.set('view', { view: VIEW });
    await read(h);
    const token = tokenOf(h, 'resume-here');
    await prepare(h, token);
    await prepare(h, token);
    expect(h.prompts).toHaveLength(1);
    expect(h.last('ext.action.result')).toMatchObject({ ok: true, state: 'done' });
  });

  test('确认期间会话权限模式变了 → stale，不执行', async () => {
    const h = await harness();
    h.outputs.set('view', { view: VIEW });
    await read(h);
    await prepare(h, tokenOf(h, 'resume-here'));
    const plan = h.last('ext.action.plan');
    h.sessions.set('s1', meta('s1', { permissionMode: 'bypassPermissions' }));
    await commit(h, plan.planId);
    expect(h.last('ext.action.result')).toMatchObject({ ok: false, error: { code: 'stale' } });
    expect(h.prompts).toEqual([]);
  });

  test('改权限 / 停用作废未执行的 token 与 plan', async () => {
    const h = await harness();
    h.outputs.set('view', { view: VIEW });
    await read(h);
    const pending = tokenOf(h, 'resume-new');
    await prepare(h, tokenOf(h, 'resume-here'));
    const plan = h.last('ext.action.plan');
    await h.registry.setConfig('tasks', { policy: { trust: 'custom', capabilities: { 'prompt.send': 'deny' } } });
    await commit(h, plan.planId);
    expect(h.last('ext.action.result')).toMatchObject({ ok: false, error: { code: 'stale' } });
    await prepare(h, pending, 'inv-2');
    expect(h.last('ext.action.result')).toMatchObject({ ok: false, error: { code: 'stale' } });
    expect(h.prompts).toEqual([]);
    expect(h.created).toEqual([]);
  });

  test('invoke（destructive，自定义权限）：确认在起进程之前；全托管不确认', async () => {
    const h = await harness();
    h.outputs.set('view', { view: VIEW });
    h.outputs.set('action', { ok: true, message: '已归档' });
    await read(h);
    await prepare(h, tokenOf(h, 'archive'));
    const plan = h.last('ext.action.plan');
    expect(plan.plan.steps).toEqual([{ type: 'invoke', actionLabel: '归档', destructive: true }]);
    expect(h.runs.filter((r) => r.op === 'action')).toHaveLength(0);
    await commit(h, plan.planId);
    expect(h.runs.filter((r) => r.op === 'action')).toHaveLength(1);
    expect(h.runs.at(-1)!.input).toMatchObject({ args: { actionId: 'archive', itemId: 'task-a', params: { slug: 'task-a' }, invocationId: 'inv-1' } });
    expect(h.last('ext.action.result')).toMatchObject({ ok: true, message: '已归档' });

    const full = await harness({}, { trust: 'full' });
    full.outputs.set('view', { view: VIEW });
    full.outputs.set('action', { ok: true });
    await read(full);
    await prepare(full, tokenOf(full, 'archive'));
    expect(full.sent.some((s) => s.body.type === 'ext.action.plan')).toBe(false);
    expect(full.last('ext.action.result')).toMatchObject({ ok: true });
  });

  test('invoke 返回的效果同样受检查：本地效果交给发起设备；需要确认的进第二阶段计划', async () => {
    const h = await harness({}, { trust: 'custom', capabilities: { invoke: 'allow' } });
    const view: ExtRawView = { sections: [{ id: 's', items: [{ id: 'i', title: 'x', actions: [{ id: 'go', label: 'go', invoke: {} }] }] }] };
    h.outputs.set('view', { view });
    h.outputs.set('action', {
      effects: [
        { type: 'prompt.insert', text: '引用' },
        { type: 'prompt.send', text: '继续' },
      ],
    });
    await read(h);
    await prepare(h, tokenOf(h, 'go'));
    const plan = h.last('ext.action.plan');
    expect(plan.plan.steps.map((s) => s.type)).toEqual(['prompt.send']);
    await commit(h, plan.planId);
    expect(h.last('ext.action.result')).toMatchObject({ ok: true, local: [{ type: 'prompt.insert', text: '引用' }], sent: { text: '继续' } });
    // 状态查询重放结果时不再带本地效果
    h.service.status('d1', { type: 'ext.action.status', ts: 1, seq: 1, dir: 'c2a', reqId: 's', invocationId: 'inv-1' } as never);
    const replay = h.last('ext.action.result');
    expect(replay.state).toBe('done');
    expect(replay.local).toBeUndefined();
  });

  test('composerAction 的 links.add 由 agent 执行并写入关联', async () => {
    const h = await harness({}, { trust: 'full' });
    h.outputs.set('pick', { items: [{ id: 'a', title: 'A', effects: [{ type: 'links.add', links: [{ ref: 'a', label: 'A' }] }] }] });
    await read(h, 'd1', { op: 'pick', point: 'composerAction' });
    await prepare(h, h.last('ext.read.response').items![0]!.token!);
    expect(h.last('ext.action.result')).toMatchObject({ ok: true });
    expect(h.links.of('s1')).toMatchObject([{ ext: 'tasks', ref: 'a', label: 'A' }]);
  });

  test('时间线记录：会话面板的 invoke 成功后记一条；关联增删各记一条', async () => {
    const h = await harness({}, { trust: 'full' });
    h.outputs.set('view', { view: VIEW });
    h.outputs.set('action', { ok: true, message: '已归档' });
    await read(h);
    await prepare(h, tokenOf(h, 'archive'));
    expect(h.records.of('s1')).toMatchObject([{ ext: 'tasks', extName: 'Tasks', kind: 'action', label: '归档', subject: 'Task A', message: '已归档' }]);

    h.outputs.set('pick', { items: [{ id: 'a', title: 'A', effects: [{ type: 'links.add', links: [{ ref: 'a', label: 'A' }] }] }] });
    await read(h, 'd1', { op: 'pick', point: 'composerAction' });
    await prepare(h, h.last('ext.read.response').items![0]!.token!, 'inv-2');
    expect(h.records.of('s1').map((r) => [r.kind, r.label])).toEqual([
      ['action', '归档'],
      ['linked', 'A'],
    ]);
    // 已有的关联再加一次 / 只改 label：不记
    await h.links.update('s1', 'tasks', [{ ref: 'a', label: 'A2' }], [], 1);
    await h.links.update('s1', 'tasks', [], ['a'], 2);
    expect(h.records.of('s1').map((r) => [r.kind, r.label])).toEqual([
      ['action', '归档'],
      ['linked', 'A'],
      ['unlinked', 'A2'],
    ]);
  });

  test('时间线记录：失败的 invoke、工作区面板的 invoke 不记', async () => {
    const h = await harness({ contributes: { sessionPanel: { title: 'T' }, workspacePanel: { title: 'T' } } }, { trust: 'full' });
    h.outputs.set('view', { view: VIEW });
    h.outputs.set('action', { ok: false, message: '失败' });
    await read(h);
    await prepare(h, tokenOf(h, 'archive'));
    expect(h.last('ext.action.result')).toMatchObject({ ok: false });
    h.outputs.set('action', { ok: true });
    await read(h, 'd1', { point: 'workspacePanel', targetSessionId: undefined, cwd: '/work/repo' });
    await prepare(h, tokenOf(h, 'archive'), 'inv-2');
    expect(h.last('ext.action.result')).toMatchObject({ ok: true });
    expect(h.records.of('s1')).toEqual([]);
  });

  test('等待确认时查询状态：返回当前计划', async () => {
    const h = await harness();
    h.outputs.set('view', { view: VIEW });
    await read(h);
    await prepare(h, tokenOf(h, 'resume-here'));
    const plan = h.last('ext.action.plan');
    h.service.status('d1', { type: 'ext.action.status', ts: 1, seq: 1, dir: 'c2a', reqId: 's', invocationId: 'inv-1' } as never);
    expect(h.last('ext.action.result')).toMatchObject({ ok: false, state: 'awaiting_confirmation', pending: { planId: plan.planId } });
  });
});

describe('订阅', () => {
  test('一轮结束 → 防抖后推送新视图给订阅设备；退订后不再推', async () => {
    const h = await harness();
    h.outputs.set('view', { view: VIEW });
    await read(h, 'd1', { watch: { ttlMs: 60_000 } });
    expect(h.service.watchCount).toBe(1);
    h.service.onRunEnd('s1');
    expect(h.timers).toHaveLength(1);
    // 缓存同样会被一轮结束之后的动作作废；这里直接作废模拟数据变化
    h.service.onLinksChanged('tasks');
    const before = h.sent.length;
    h.timers.shift()!();
    await Bun.sleep(0);
    await Bun.sleep(0);
    const pushed = h.sent.slice(before).filter((s) => s.body.type === 'ext.read.response');
    expect(pushed).toHaveLength(1);
    expect((pushed[0]!.body as { reqId?: string }).reqId).toBeUndefined();
    await read(h, 'd1', { watch: { ttlMs: 0 } });
    expect(h.service.watchCount).toBe(0);
    expect(REFRESH_DEBOUNCE_MS).toBe(1_000);
  });
});

describe('评审回归（Codex 代码 review）', () => {
  test('前置条件在会话链里复查：排在前面的改权限生效后才判断，不按旧权限发送', async () => {
    const h = await harness();
    h.outputs.set('view', { view: VIEW });
    await read(h);
    await prepare(h, tokenOf(h, 'resume-here'));
    const plan = h.last('ext.action.plan');
    // commit 前的快查看到的还是旧值；进链时前面排着的改权限才落地
    h.chainHook = () => h.sessions.set('s1', meta('s1', { permissionMode: 'bypassPermissions' }));
    await commit(h, plan.planId);
    expect(h.last('ext.action.result')).toMatchObject({ ok: false, error: { code: 'stale' } });
    expect(h.prompts).toEqual([]);
  });

  test('links 步骤：确认期间会话被删 → stale，不写关联', async () => {
    const h = await harness({}, { trust: 'custom', capabilities: { 'links.write': 'confirm' } });
    h.outputs.set('pick', { items: [{ id: 'a', title: 'A', effects: [{ type: 'links.add', links: [{ ref: 'a', label: 'A' }] }] }] });
    await read(h, 'd1', { op: 'pick', point: 'linkPicker' });
    await prepare(h, h.last('ext.read.response').items![0]!.token!);
    const plan = h.last('ext.action.plan');
    h.chainHook = () => h.sessions.delete('s1');
    await commit(h, plan.planId);
    expect(h.last('ext.action.result')).toMatchObject({ ok: false, error: { code: 'stale' } });
    expect(h.links.of('s1')).toBeUndefined();
  });

  test('invoke：确认后会话换了目录 → 不起扩展进程', async () => {
    const h = await harness();
    h.outputs.set('view', { view: VIEW });
    h.outputs.set('action', { ok: true });
    await read(h);
    await prepare(h, tokenOf(h, 'archive'));
    const plan = h.last('ext.action.plan');
    h.sessions.set('s1', meta('s1', { cwd: '/elsewhere' }));
    await commit(h, plan.planId);
    expect(h.last('ext.action.result')).toMatchObject({ ok: false, error: { code: 'stale' } });
    expect(h.runs.filter((r) => r.op === 'action')).toHaveLength(0);
  });

  test('invoke 执行期间扩展被停用：返回的效果不再执行', async () => {
    const h = await harness({}, { trust: 'full' });
    const view: ExtRawView = { sections: [{ id: 's', items: [{ id: 'i', title: 'x', actions: [{ id: 'go', label: 'go', invoke: {} }] }] }] };
    h.outputs.set('view', { view });
    h.outputs.set('action', async () => {
      // 进程运行期间用户在另一台设备上停用了扩展
      await h.registry.setConfig('tasks', { enabled: false });
      return { effects: [{ type: 'prompt.send', text: '不该发出' }] };
    });
    await read(h);
    await prepare(h, tokenOf(h, 'go'));
    await Bun.sleep(0);
    expect(h.last('ext.action.result')).toMatchObject({ ok: false, error: { code: 'stale' } });
    expect(h.prompts).toEqual([]);
  });

  test('dispose 之后的动作不执行', async () => {
    const h = await harness({}, { trust: 'full' });
    h.outputs.set('view', { view: VIEW });
    await read(h);
    const token = tokenOf(h, 'resume-here');
    h.service.dispose();
    await prepare(h, token);
    expect(h.prompts).toEqual([]);
  });

  test('session.create 带关联需要 links.write：没声明 → 拒绝', async () => {
    const h = await harness({ capabilities: ['session.create'] }, { trust: 'full' });
    h.outputs.set('view', { view: VIEW });
    await read(h);
    await prepare(h, tokenOf(h, 'resume-new'));
    expect(h.last('ext.action.result')).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(h.created).toEqual([]);
  });

  test('rev 在读取开始时分配：先开始、后完成的旧读取 rev 更小', async () => {
    const h = await harness();
    let release!: () => void;
    let first = true;
    h.outputs.set('view', () => {
      if (!first) return { view: { sections: [] } };
      first = false;
      return new Promise((resolve) => {
        release = () => resolve({ view: VIEW });
      });
    });
    // runner 桩里的返回值可以是 Promise：包一层
    const slow = read(h, 'd1', { reqId: 'slow' });
    await Bun.sleep(0);
    await read(h, 'd1', { reqId: 'fast', force: true });
    release();
    await slow;
    const byReq = (id: string) => h.sent.map((s) => s.body).find((b) => b.type === 'ext.read.response' && b.reqId === id) as { rev: number };
    expect(byReq('slow').rev).toBeLessThan(byReq('fast').rev);
  });

  test('一轮结束推送跑新进程，不复用缓存', async () => {
    const h = await harness();
    h.outputs.set('view', { view: VIEW });
    await read(h, 'd1', { watch: { ttlMs: 60_000 } });
    expect(h.runs).toHaveLength(1);
    h.service.onRunEnd('s1');
    h.timers.shift()!();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(h.runs).toHaveLength(2);
  });
});

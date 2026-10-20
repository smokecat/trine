/**
 * 会话动作的能力探测与回调组装（session-list-v2 §4.1，评审 S2）。
 */
import { describe, expect, test } from 'bun:test';
import {
  buildCopyCwd,
  buildSessionActions,
  compareVersions,
  supportedMachinesKey,
  supportsPin,
  supportsSessionMutations,
  type Notifier,
  type SessionMutationClient,
} from './session-actions.ts';
// 刻意不 import SessionRowMenu.tsx：它经 radix 静态引入 react-dom，本文件按路径排在
// DOM 组件测试之前，先加载 react-dom 会让后者的受控 input 失灵（learnings 2026-09-25）。
// 行菜单按 supports 过滤的 DOM 行为在 session-list.test.tsx 里验。

describe('compareVersions（semver 优先级）', () => {
  test('数值逐段比，不按字典序', () => {
    expect(compareVersions('0.10.0', '0.2.0')! > 0).toBe(true);
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('1.0.0', '0.99.99')! > 0).toBe(true);
    expect(compareVersions('0.1.9', '0.2.0')! < 0).toBe(true);
  });
  test('预发布低于同号正式版；build 元数据忽略；v 前缀与省略段可解析', () => {
    expect(compareVersions('0.2.0-rc.1', '0.2.0')! < 0).toBe(true);
    expect(compareVersions('0.2.0-rc.2', '0.2.0-rc.10')! < 0).toBe(true);
    expect(compareVersions('0.2.0-alpha', '0.2.0-1')! > 0).toBe(true);
    expect(compareVersions('0.2.0+abc', '0.2.0')).toBe(0);
    expect(compareVersions('v0.2', '0.2.0')).toBe(0);
  });
  test('解析不了 → null', () => {
    expect(compareVersions('', '0.2.0')).toBeNull();
    expect(compareVersions('dev', '0.2.0')).toBeNull();
    expect(compareVersions('0.2.0.1', '0.2.0')).toBeNull();
  });
});

describe('supportsSessionMutations（阈值 >= 0.2.0）', () => {
  test.each([
    ['0.2.0', true],
    ['0.2.1', true],
    ['1.0.0', true],
    ['0.1.0', false],
    ['0.1.99', false],
    ['0.2.0-rc.1', false],
    ['', false],
    ['unknown', false],
  ])('%s → %p', (agentVersion, ok) => {
    expect(supportsSessionMutations({ agentVersion })).toBe(ok);
  });
  test('还没收到 machine.info 的机器当不支持', () => {
    expect(supportsSessionMutations(null)).toBe(false);
    expect(supportsSessionMutations(undefined)).toBe(false);
  });
  test('supportedMachinesKey：只收支持的机器、排序稳定', () => {
    expect(
      supportedMachinesKey({
        z: { info: { agentVersion: '0.2.0' } },
        a: { info: { agentVersion: '0.3.0' } },
        old: { info: { agentVersion: '0.1.0' } },
        none: { info: null },
      }),
    ).toBe('a,z');
  });
});

function fakeClient(fail?: Error): SessionMutationClient & { calls: string[] } {
  const calls: string[] = [];
  const op = async (line: string): Promise<void> => {
    calls.push(line);
    if (fail) throw fail;
  };
  return {
    calls,
    renameSession: (m, s, t) => op(`rename ${m}/${s} ${t}`),
    archiveSession: (m, s, a) => op(`archive ${m}/${s} ${a}`),
    pinSession: (m, s, p) => op(`pin ${m}/${s} ${p}`),
    pinWorkspace: (m, c, p) => {
      calls.push(`pinWorkspace ${m}:${c} ${p}`);
      return fail === undefined;
    },
    deleteSession: (m, s) => op(`delete ${m}/${s}`),
  };
}

function fakeNotify(): Notifier & { log: string[]; actions: (() => void)[] } {
  const log: string[] = [];
  const actions: (() => void)[] = [];
  return {
    log,
    actions,
    success: (msg, opts) => {
      log.push(`ok:${msg}`);
      if (opts?.action) actions.push(opts.action.onClick);
    },
    error: (msg, opts) => void log.push(`err:${msg}:${opts.description}`),
  };
}

describe('buildSessionActions', () => {
  test('从标签页（无 client）或没有支持的机器 → 一个回调都不给', () => {
    const notify = fakeNotify();
    expect(buildSessionActions({ client: null, supportedMachineIds: new Set(['m']), notify })).toEqual({});
    expect(buildSessionActions({ client: fakeClient(), supportedMachineIds: new Set(), notify })).toEqual({});
  });

  test('聊天页只看那一台：旧 agent → 不给（/rename 与头部菜单随之隐藏）', () => {
    const args = { client: fakeClient(), supportedMachineIds: new Set(['new']), notify: fakeNotify() };
    expect(buildSessionActions({ ...args, onlyMachine: 'old' })).toEqual({});
    expect(buildSessionActions({ ...args, onlyMachine: 'new' }).onRename).toBeDefined();
  });

  test('列表混排新旧 agent：回调照给，另带 supports 逐机器判', () => {
    const actions = buildSessionActions({ client: fakeClient(), supportedMachineIds: new Set(['new']), notify: fakeNotify() });
    expect(actions.supports?.('new')).toBe(true);
    expect(actions.supports?.('old')).toBe(false);
    expect(actions.onRename && actions.onArchive && actions.onDelete).toBeDefined();
  });

  test('成功：调对应 client 方法并轻提示；归档带「撤销」→ 取消归档', async () => {
    const client = fakeClient();
    const notify = fakeNotify();
    const actions = buildSessionActions({ client, supportedMachineIds: new Set(['m']), notify });
    await actions.onRename!('m', 's', '新');
    await actions.onArchive!('m', 's', true);
    await actions.onDelete!('m', 's');
    expect(client.calls).toEqual(['rename m/s 新', 'archive m/s true', 'delete m/s']);
    expect(notify.log).toEqual(['ok:已重命名', 'ok:已归档', 'ok:已永久删除']);
    notify.actions[0]!();
    await Promise.resolve();
    expect(client.calls.at(-1)).toBe('archive m/s false');
  });

  test('失败：toast 用错误原话（agent 的 busy 说明 / 超时提示），并 reject 让对话框保持打开', async () => {
    const notify = fakeNotify();
    const actions = buildSessionActions({
      client: fakeClient(new Error('会话运行中、等待批准或有排队消息')),
      supportedMachineIds: new Set(['m']),
      notify,
    });
    await expect(Promise.resolve(actions.onArchive!('m', 's', true))).rejects.toThrow('会话运行中');
    await expect(Promise.resolve(actions.onDelete!('m', 's'))).rejects.toThrow();
    expect(notify.log).toEqual([
      'err:归档失败:会话运行中、等待批准或有排队消息',
      'err:永久删除失败:会话运行中、等待批准或有排队消息',
    ]);
  });
});

describe('置顶 onPin / onPinWorkspace', () => {
  test('只在支持置顶的机器上给（agent ≥ 0.14.0），supportsPin 逐机器判', () => {
    const base = { client: fakeClient(), supportedMachineIds: new Set(['new', 'old']), notify: fakeNotify() };
    expect(buildSessionActions(base).onPin).toBeUndefined();
    const actions = buildSessionActions({ ...base, pinMachineIds: new Set(['new']) });
    expect(actions.supportsPin?.('new')).toBe(true);
    expect(actions.supportsPin?.('old')).toBe(false);
    expect(buildSessionActions({ ...base, pinMachineIds: new Set(['new']), onlyMachine: 'old' }).onPin).toBeUndefined();
    expect(supportsPin({ agentVersion: '0.14.0' })).toBe(true);
    expect(supportsPin({ agentVersion: '0.13.9' })).toBe(false);
  });

  test('调对应 client 方法；工作区置顶发不出去时报错', async () => {
    const client = fakeClient();
    const notify = fakeNotify();
    const actions = buildSessionActions({ client, supportedMachineIds: new Set(['m']), pinMachineIds: new Set(['m']), notify });
    await actions.onPin?.('m', 's', true);
    actions.onPinWorkspace?.('m', '/repo', false);
    expect(client.calls).toEqual(['pin m/s true', 'pinWorkspace m:/repo false']);
    const offline = fakeClient(new Error('x'));
    const n2 = fakeNotify();
    buildSessionActions({ client: offline, supportedMachineIds: new Set(['m']), pinMachineIds: new Set(['m']), notify: n2 })
      .onPinWorkspace?.('m', '/repo', true);
    expect(n2.log[0]).toStartWith('err:置顶失败');
  });
});

describe('批量归档 onArchiveMany', () => {
  test('逐条发、一条汇总 toast；撤销只撤成功的', async () => {
    const client = fakeClient();
    const notify = fakeNotify();
    const actions = buildSessionActions({ client, supportedMachineIds: new Set(['m']), notify });
    await actions.onArchiveMany!(
      [
        { machineId: 'm', sessionId: 'a' },
        { machineId: 'm', sessionId: 'b' },
      ],
      true,
    );
    expect(client.calls).toEqual(['archive m/a true', 'archive m/b true']);
    expect(notify.log).toEqual(['ok:已归档 2 个会话']);
    notify.actions[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(client.calls.slice(2)).toEqual(['archive m/a false', 'archive m/b false']);
  });

  test('部分失败：成功的照样提示，失败的汇总报错并 reject；不支持的机器算失败', async () => {
    const calls: string[] = [];
    const client: SessionMutationClient = {
      renameSession: async () => {},
      deleteSession: async () => {},
      pinSession: async () => {},
      pinWorkspace: () => true,
      archiveSession: async (m, s) => {
        calls.push(`${m}/${s}`);
        if (s === 'busy') throw new Error('会话运行中');
      },
    };
    const notify = fakeNotify();
    const actions = buildSessionActions({ client, supportedMachineIds: new Set(['m']), notify });
    await expect(
      Promise.resolve(
        actions.onArchiveMany!(
          [
            { machineId: 'm', sessionId: 'ok' },
            { machineId: 'm', sessionId: 'busy' },
            { machineId: 'old', sessionId: 'x' },
          ],
          true,
        ),
      ),
    ).rejects.toThrow('会话运行中');
    expect(calls).toEqual(['m/ok', 'm/busy']);
    expect(notify.log).toEqual(['ok:已归档 1 个会话', 'err:2 个会话归档失败:会话运行中']);
  });

  test('取消归档不带撤销', async () => {
    const notify = fakeNotify();
    const actions = buildSessionActions({ client: fakeClient(), supportedMachineIds: new Set(['m']), notify });
    await actions.onArchiveMany!([{ machineId: 'm', sessionId: 'a' }], false);
    expect(notify.log).toEqual(['ok:已取消归档 1 个会话']);
    expect(notify.actions).toHaveLength(0);
  });
});

describe('buildCopyCwd', () => {
  test('成功提示；失败报错并 reject', async () => {
    const copied: string[] = [];
    const notify = fakeNotify();
    await buildCopyCwd(async (t) => void copied.push(t), notify)('/home/me/repo');
    expect(copied).toEqual(['/home/me/repo']);
    const failing = buildCopyCwd(async () => {
      throw new Error('denied');
    }, notify);
    await expect(failing('/x')).rejects.toThrow('denied');
    expect(notify.log).toEqual(['ok:已复制工作目录', 'err:复制失败:denied']);
  });
});

/**
 * 权限桥：决策 2 的三条语义逐条验证。
 *
 * 1. remember 命中即 allow，不挂起不发帧
 * 2. 不自动超时拒绝（超时只计时）
 * 3. abort → 清 pending + permission.invalidated + 向 SDK 返回 deny
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_DENY_MESSAGE, PermissionBridge } from './permission.ts';
import type { EventBody } from './types.ts';

function bridge(options?: { now?: () => number }) {
  const events: EventBody[] = [];
  let counter = 0;
  const instance = new PermissionBridge({
    emit: (body) => events.push(body),
    newRequestId: () => `req-${++counter}`,
    ...(options?.now === undefined ? {} : { now: options.now }),
  });
  return { instance, events };
}

/** 造一个 canUseTool 的 options 参数 */
function callOptions(signal: AbortSignal, suggestions?: unknown[]) {
  return {
    signal,
    toolUseID: 'tu_1',
    requestId: 'sdk-req-1',
    ...(suggestions === undefined ? {} : { suggestions }),
  } as unknown as Parameters<PermissionBridge['canUseTool']>[2];
}

describe('PermissionBridge · 挂起与应答', () => {
  test('新请求发 permission.request 并挂起', async () => {
    const { instance, events } = bridge({ now: () => 5_000 });
    const controller = new AbortController();

    const pending = instance.canUseTool(
      'Bash',
      { command: 'rm -rf /' },
      callOptions(controller.signal),
    );

    expect(instance.pendingCount).toBe(1);
    expect(events[0]).toMatchObject({
      type: 'permission.request',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      requestedAt: 5_000,
    });

    instance.respond({ requestId: 'req-1', verdict: 'allow' });
    await expect(pending).resolves.toEqual({ behavior: 'allow' });
    expect(instance.pendingCount).toBe(0);
  });

  test('allow 带 updatedInput 透传给 SDK', async () => {
    const { instance } = bridge();
    const controller = new AbortController();
    const pending = instance.canUseTool('Bash', { command: 'ls' }, callOptions(controller.signal));

    instance.respond({
      requestId: 'req-1',
      verdict: 'allow',
      updatedInput: { command: 'ls -la' },
    });

    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    });
  });

  test('allow 带 updatedInput 时，permission.resolved 也带上同一份值', async () => {
    const { instance, events } = bridge();
    const controller = new AbortController();
    const approved = { command: 'ls -la' };
    void instance.canUseTool('Bash', { command: 'rm -rf /tmp/x' }, callOptions(controller.signal));

    instance.respond({ requestId: 'req-1', verdict: 'allow', updatedInput: approved });

    // 各端只有最初的 request.input，改后的值若不随 resolved 发出来，
    // 就只活在批准那台设备的组件 state 里，刷新即丢（验收 5）
    expect(events.at(-1)).toMatchObject({
      type: 'permission.resolved',
      requestId: 'req-1',
      verdict: 'allow',
      updatedInput: approved,
    });
  });

  test('没改参数 / deny / 非对象 updatedInput：resolved 不带这个字段', async () => {
    for (const verdict of [
      { requestId: 'req-1', verdict: 'allow' as const },
      { requestId: 'req-1', verdict: 'allow' as const, updatedInput: 'not an object' },
      { requestId: 'req-1', verdict: 'allow' as const, updatedInput: null },
      { requestId: 'req-1', verdict: 'deny' as const, updatedInput: { command: 'ls' } },
    ]) {
      const { instance, events } = bridge();
      const controller = new AbortController();
      void instance.canUseTool('Bash', { command: 'x' }, callOptions(controller.signal));
      instance.respond(verdict);
      // 判据与「交给 SDK 的到底是不是改后的 input」是同一个：只有真的换掉
      // 入参才声称换过，否则各端会显示一份其实没生效的「已按修改后的参数批准」
      expect(events.at(-1)).not.toHaveProperty('updatedInput');
    }
  });

  test('deny 返回带 message 的拒绝（SDK 要求 message 必填）', async () => {
    const { instance } = bridge();
    const controller = new AbortController();
    const pending = instance.canUseTool('Bash', {}, callOptions(controller.signal));

    instance.respond({ requestId: 'req-1', verdict: 'deny' });
    const result = await pending;

    expect(result).toMatchObject({ behavior: 'deny' });
    expect((result as { message: string }).message.length).toBeGreaterThan(0);
  });

  test('应答后发 permission.resolved 供多设备同步', async () => {
    const { instance, events } = bridge();
    const controller = new AbortController();
    void instance.canUseTool('Bash', {}, callOptions(controller.signal));

    instance.respond({ requestId: 'req-1', verdict: 'allow', resolvedBy: 'iPhone' });

    expect(events.at(-1)).toMatchObject({
      type: 'permission.resolved',
      requestId: 'req-1',
      verdict: 'allow',
      resolvedBy: 'iPhone',
    });
  });

  test('重复应答返回 false，不重复 resolve', () => {
    const { instance } = bridge();
    const controller = new AbortController();
    void instance.canUseTool('Bash', {}, callOptions(controller.signal));

    expect(instance.respond({ requestId: 'req-1', verdict: 'allow' })).toBe(true);
    expect(instance.respond({ requestId: 'req-1', verdict: 'allow' })).toBe(false);
  });

  test('suggestions 原样透传', () => {
    const { instance, events } = bridge();
    const controller = new AbortController();
    void instance.canUseTool(
      'Bash',
      {},
      callOptions(controller.signal, [{ type: 'addRules', rules: [] }]),
    );

    expect(events[0]).toMatchObject({
      suggestions: [{ type: 'addRules', rules: [] }],
    });
  });
});

describe('PermissionBridge · remember（决策 2 第 1 条）', () => {
  test('登记后同 pattern 直接 allow，不挂起不发帧', async () => {
    const { instance, events } = bridge();
    const controller = new AbortController();

    // 第一次：挂起并批准，带 remember
    void instance.canUseTool('Bash', { command: 'git status' }, callOptions(controller.signal));
    instance.respond({
      requestId: 'req-1',
      verdict: 'allow',
      remember: { scope: 'session', pattern: 'Bash(git *)' },
    });
    const countAfterFirst = events.length;

    // 第二次：同 pattern 命中，应当直接放行
    const second = await instance.canUseTool(
      'Bash',
      { command: 'git diff' },
      callOptions(controller.signal),
    );

    expect(second).toEqual({ behavior: 'allow' });
    expect(instance.pendingCount).toBe(0);
    // 没有新增任何帧——不打扰
    expect(events.length).toBe(countAfterFirst);
  });

  test('不匹配的调用仍然挂起', () => {
    const { instance } = bridge();
    const controller = new AbortController();
    void instance.canUseTool('Bash', { command: 'git status' }, callOptions(controller.signal));
    instance.respond({
      requestId: 'req-1',
      verdict: 'allow',
      remember: { scope: 'session', pattern: 'Bash(git *)' },
    });

    void instance.canUseTool('Bash', { command: 'rm -rf /' }, callOptions(controller.signal));
    expect(instance.pendingCount).toBe(1);
  });

  test('deny 不登记 remember（记住拒绝会让人无从补救）', () => {
    const { instance } = bridge();
    const controller = new AbortController();
    void instance.canUseTool('Bash', { command: 'x' }, callOptions(controller.signal));
    instance.respond({
      requestId: 'req-1',
      verdict: 'deny',
      remember: { scope: 'session', pattern: 'Bash' },
    });

    expect(instance.rememberedPatterns).toEqual([]);
  });
});

describe('PermissionBridge · abort（决策 2 第 3 条）', () => {
  test('abort → 清 pending + invalidated + 返回 deny', async () => {
    const { instance, events } = bridge();
    const controller = new AbortController();
    const pending = instance.canUseTool('Bash', {}, callOptions(controller.signal));

    expect(instance.pendingCount).toBe(1);
    controller.abort();

    const result = await pending;
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(instance.pendingCount).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: 'permission.invalidated',
      requestId: 'req-1',
    });
  });

  test('已 abort 的 signal 立即结束，不留挂起项', async () => {
    const { instance } = bridge();
    const controller = new AbortController();
    controller.abort();

    const result = await instance.canUseTool('Bash', {}, callOptions(controller.signal));
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(instance.pendingCount).toBe(0);
  });

  test('invalidateAll 作废全部挂起并逐条发帧', async () => {
    const { instance, events } = bridge();
    const controller = new AbortController();
    const a = instance.canUseTool('Bash', {}, callOptions(controller.signal));
    const b = instance.canUseTool('Read', {}, callOptions(controller.signal));

    instance.invalidateAll('agent 重启');

    await expect(a).resolves.toMatchObject({ behavior: 'deny' });
    await expect(b).resolves.toMatchObject({ behavior: 'deny' });
    expect(instance.pendingCount).toBe(0);
    const invalidated = events.filter((e) => e.type === 'permission.invalidated');
    expect(invalidated).toHaveLength(2);
  });

  test('不设自超时：挂起很久也不自动拒绝（决策 2 第 2 条）', async () => {
    let clock = 0;
    const { instance } = bridge({ now: () => clock });
    const controller = new AbortController();
    const pending = instance.canUseTool('Bash', {}, callOptions(controller.signal));

    // 推进「一小时」，期间没有任何定时器会拒绝它
    clock += 3_600_000;
    await Bun.sleep(5);

    expect(instance.pendingCount).toBe(1);
    // 仍能被正常应答
    instance.respond({ requestId: 'req-1', verdict: 'allow' });
    await expect(pending).resolves.toEqual({ behavior: 'allow' });
  });

  test('snapshot 暴露挂起项供重连补发', () => {
    const { instance } = bridge({ now: () => 999 });
    const controller = new AbortController();
    void instance.canUseTool('Bash', { command: 'touch /tmp/x' }, callOptions(controller.signal));

    // 带完整 input：重连后要拿它原样重发 permission.request
    expect(instance.snapshot()).toEqual([
      {
        requestId: 'req-1',
        toolName: 'Bash',
        input: { command: 'touch /tmp/x' },
        requestedAt: 999,
      },
    ]);
  });
});

describe('isSafeRememberPattern · 登记入口（判定本身的单测在 @trine/core/permission）', () => {
  test('登记入口拦截不安全 pattern', () => {
    const { instance } = bridge();
    const controller = new AbortController();
    void instance.canUseTool('Bash', { command: 'x' }, callOptions(controller.signal));

    instance.respond({
      requestId: 'req-1',
      verdict: 'allow',
      remember: { scope: 'session', pattern: '*' },
    });

    // 不安全的 pattern 不得进入记忆表
    expect(instance.rememberedPatterns).toEqual([]);
  });

  test('不安全 pattern 被拒后，后续调用仍然挂起询问', async () => {
    const { instance } = bridge();
    const controller = new AbortController();
    void instance.canUseTool('Bash', { command: 'ls' }, callOptions(controller.signal));
    instance.respond({
      requestId: 'req-1',
      verdict: 'allow',
      remember: { scope: 'session', pattern: 'Bash' },
    });

    void instance.canUseTool('Bash', { command: 'rm -rf /' }, callOptions(controller.signal));
    expect(instance.pendingCount).toBe(1);
  });
});

describe('PermissionBridge · 拒绝附言 / 批准切模式（exit-plan-mode）', () => {
  test('deny 带 message：trim 后原样送给 Claude，resolved 回报同一份附言', async () => {
    const { instance, events } = bridge();
    const controller = new AbortController();
    const pending = instance.canUseTool('ExitPlanMode', { plan: '# p' }, callOptions(controller.signal));

    instance.respond({ requestId: 'req-1', verdict: 'deny', message: '  请把文件名改成 hi.txt  ' });
    await expect(pending).resolves.toEqual({ behavior: 'deny', message: '请把文件名改成 hi.txt' });
    expect(events.at(-1)).toEqual({
      type: 'permission.resolved',
      requestId: 'req-1',
      verdict: 'deny',
      message: '请把文件名改成 hi.txt',
    });
  });

  test('deny 的 message 为空白：用默认文案，resolved 不带 message', async () => {
    const { instance, events } = bridge();
    const controller = new AbortController();
    const pending = instance.canUseTool('Bash', { command: 'x' }, callOptions(controller.signal));

    instance.respond({ requestId: 'req-1', verdict: 'deny', message: '   \n ' });
    await expect(pending).resolves.toEqual({ behavior: 'deny', message: DEFAULT_DENY_MESSAGE });
    expect(events.at(-1)).not.toHaveProperty('message');
  });

  test('allow + setMode：PermissionResult 带 session 级 setMode，resolved 回报 setMode', async () => {
    const { instance, events } = bridge();
    const controller = new AbortController();
    const input = { plan: '# p', planFilePath: '/p.md' };
    const pending = instance.canUseTool('ExitPlanMode', input, callOptions(controller.signal));

    instance.respond({ requestId: 'req-1', verdict: 'allow', updatedInput: input, setMode: 'acceptEdits' });
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: input,
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    expect(events.at(-1)).toEqual({
      type: 'permission.resolved',
      requestId: 'req-1',
      verdict: 'allow',
      updatedInput: input,
      setMode: 'acceptEdits',
    });
  });

  test('字段只在对应 verdict 下生效：allow 忽略 message，deny 忽略 setMode', async () => {
    const { instance, events } = bridge();
    const controller = new AbortController();
    const a = instance.canUseTool('Bash', { command: 'a' }, callOptions(controller.signal));
    const b = instance.canUseTool('Bash', { command: 'b' }, callOptions(controller.signal));

    instance.respond({ requestId: 'req-1', verdict: 'allow', message: '不该出现' });
    instance.respond({ requestId: 'req-2', verdict: 'deny', setMode: 'acceptEdits' });
    await expect(a).resolves.toEqual({ behavior: 'allow' });
    await expect(b).resolves.toEqual({ behavior: 'deny', message: DEFAULT_DENY_MESSAGE });
    const resolved = events.filter((e) => e.type === 'permission.resolved');
    expect(resolved[0]).not.toHaveProperty('message');
    expect(resolved[1]).not.toHaveProperty('setMode');
  });
});

describe('PermissionBridge · waitingFor 与 onPendingChanged', () => {
  test('waitingFor 取最早一条挂起项的类型；答掉最早一条后换成下一条', () => {
    const changes: string[] = [];
    let drained = 0;
    let counter = 0;
    const instance = new PermissionBridge({
      emit: () => {},
      newRequestId: () => `req-${++counter}`,
      onPendingChanged: () => changes.push(String(instance.waitingFor)),
      onDrained: () => {
        drained += 1;
      },
    });
    const controller = new AbortController();
    expect(instance.waitingFor).toBeUndefined();

    void instance.canUseTool('AskUserQuestion', { questions: [] }, callOptions(controller.signal));
    expect(instance.waitingFor).toBe('question');
    void instance.canUseTool('ExitPlanMode', { plan: 'p' }, callOptions(controller.signal));
    void instance.canUseTool('Bash', { command: 'x' }, callOptions(controller.signal));
    // 新请求追加在后，最早一条不变
    expect(instance.waitingFor).toBe('question');

    instance.respond({ requestId: 'req-1', verdict: 'allow' });
    expect(instance.waitingFor).toBe('plan');
    instance.respond({ requestId: 'req-2', verdict: 'deny' });
    expect(instance.waitingFor).toBe('permission');
    instance.respond({ requestId: 'req-3', verdict: 'allow' });
    expect(instance.waitingFor).toBeUndefined();

    // 有剩余时报 changed，归零时只走 drained
    expect(changes).toEqual(['plan', 'permission']);
    expect(drained).toBe(1);
  });
});

describe('PermissionBridge · 子 agent 来源（subagent-view）', () => {
  function withParents(map: Record<string, string>) {
    const events: EventBody[] = [];
    let counter = 0;
    const instance = new PermissionBridge({
      emit: (body) => events.push(body),
      newRequestId: () => `req-${++counter}`,
      parentToolUseIdOf: (agentId) => map[agentId],
    });
    return { instance, events };
  }
  const opts = (signal: AbortSignal, agentID?: string) =>
    ({ signal, toolUseID: 'toolu_w', requestId: 'r', ...(agentID === undefined ? {} : { agentID }) }) as unknown as Parameters<
      PermissionBridge['canUseTool']
    >[2];

  test('agentID（= task_id）查得到 → permission.request 带父 toolUseId；快照（重发用）也带', () => {
    const { instance, events } = withParents({ a000000000000001: 'toolu_parent' });
    void instance.canUseTool('Write', { file_path: '/x' }, opts(new AbortController().signal, 'a000000000000001'));
    expect(events[0]).toMatchObject({ type: 'permission.request', toolName: 'Write', parentToolUseId: 'toolu_parent' });
    expect(instance.snapshot()[0]).toMatchObject({ parentToolUseId: 'toolu_parent' });
  });

  test('主线程（无 agentID）/ 映射缺失 / 解析器抛错 → 不带来源', () => {
    const { instance, events } = withParents({});
    void instance.canUseTool('Bash', { command: 'a' }, opts(new AbortController().signal));
    void instance.canUseTool('Bash', { command: 'b' }, opts(new AbortController().signal, 'unknown-task'));
    expect(events.map((e) => 'parentToolUseId' in e)).toEqual([false, false]);
    expect(instance.snapshot().map((p) => 'parentToolUseId' in p)).toEqual([false, false]);

    const throwing = new PermissionBridge({
      emit: (body) => events.push(body),
      parentToolUseIdOf: () => {
        throw new Error('boom');
      },
    });
    void throwing.canUseTool('Bash', { command: 'c' }, opts(new AbortController().signal, 't1'));
    expect(events.at(-1)).toMatchObject({ type: 'permission.request' });
    expect('parentToolUseId' in events.at(-1)!).toBe(false);
  });
});

describe('PermissionBridge · 来源兜底（评审 m6）', () => {
  test('agentID 映射缺失时按 toolUseID 查在途工具的父 id', () => {
    const events: EventBody[] = [];
    const instance = new PermissionBridge({
      emit: (body) => events.push(body),
      parentToolUseIdOf: () => undefined,
      parentToolUseIdOfToolUse: (id) => (id === 'toolu_w' ? 'toolu_parent' : undefined),
    });
    const signal = new AbortController().signal;
    void instance.canUseTool('Write', {}, { signal, toolUseID: 'toolu_w', requestId: 'r', agentID: 'unmapped' } as never);
    // 主线程（无 agentID）即便 toolUseID 查得到也不标来源
    void instance.canUseTool('Write', {}, { signal, toolUseID: 'toolu_w', requestId: 'r2' } as never);
    expect(events.map((e) => ('parentToolUseId' in e ? e.parentToolUseId : null))).toEqual(['toolu_parent', null]);
  });
});

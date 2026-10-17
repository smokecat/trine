/**
 * BgTaskTracker：用真 claude 2.1.282 实测的消息形状（见 bgtasks.ts 文件头）喂，
 * 验证收录规则、状态迁移、快照裁剪与自发轮触发说明。
 */
import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { BgTaskTracker, MAX_ENDED, spontaneousDetailOf } from './bgtasks.ts';

function sys(subtype: string, fields: Record<string, unknown>): SDKMessage {
  return { type: 'system', subtype, ...fields, uuid: 'u', session_id: 's1' } as unknown as SDKMessage;
}

/** 实测：后台 Bash 从启动到完成的全部 system 消息 */
const bashStart = (id = 'bd4zj554r', desc = '在后台等待 25 秒后输出完成标记'): SDKMessage[] => [
  sys('background_tasks_changed', { tasks: [{ task_id: id, task_type: 'local_bash', description: desc }] }),
  sys('task_started', { task_id: id, tool_use_id: `toolu_${id}`, description: desc, is_backgrounded: true, task_type: 'local_bash' }),
];
const bashDone = (id = 'bd4zj554r', desc = '在后台等待 25 秒后输出完成标记'): SDKMessage[] => [
  sys('background_tasks_changed', { tasks: [] }),
  sys('task_updated', { task_id: id, patch: { status: 'completed', end_time: 1790397318094 } }),
  sys('task_notification', {
    task_id: id,
    tool_use_id: `toolu_${id}`,
    status: 'completed',
    output_file: '/tmp/x.output',
    summary: `Background command "${desc}" completed (exit code 0)`,
  }),
];

function feed(tracker: BgTaskTracker, messages: SDKMessage[]): boolean[] {
  return messages.map((m) => tracker.observe(m));
}

describe('BgTaskTracker · 收录与状态', () => {
  test('后台 Bash：level 先到即收录，task_started 补 toolUseId；结束三连改状态 + 摘要', () => {
    let now = 1000;
    const tracker = new BgTaskTracker({ now: () => now });
    expect(feed(tracker, bashStart())).toEqual([true, true]);
    expect(tracker.runningCount).toBe(1);
    expect(tracker.snapshot()).toEqual([
      {
        taskId: 'bd4zj554r',
        kind: 'bash',
        description: '在后台等待 25 秒后输出完成标记',
        status: 'running',
        startedAt: 1000,
        toolUseId: 'toolu_bd4zj554r',
      },
    ]);

    now = 5000;
    const changed = feed(tracker, bashDone());
    // level 把它标成 completed（变了）；task_updated 状态相同、end_time 不覆盖已有 endedAt（没变）；通知补摘要（变了）
    expect(changed).toEqual([true, false, true]);
    expect(tracker.runningCount).toBe(0);
    const [task] = tracker.snapshot();
    expect(task).toMatchObject({ status: 'completed', endedAt: 5000, summary: 'Background command "在后台等待 25 秒后输出完成标记" completed (exit code 0)' });
    expect(tracker.lastNotification()).toMatchObject({ taskId: 'bd4zj554r', status: 'completed', at: 5000 });
  });

  test('task_updated 先于 level 到达时用 end_time 作结束时刻', () => {
    const tracker = new BgTaskTracker({ now: () => 1000 });
    feed(tracker, bashStart());
    expect(tracker.observe(sys('task_updated', { task_id: 'bd4zj554r', patch: { status: 'completed', end_time: 1790397318094 } }))).toBe(true);
    expect(tracker.snapshot()[0]).toMatchObject({ status: 'completed', endedAt: 1790397318094 });
    // 随后的 level 空快照不再改变
    expect(tracker.observe(sys('background_tasks_changed', { tasks: [] }))).toBe(false);
  });

  test('TaskStop：task_updated killed → stopped，通知 stopped 与之一致', () => {
    const tracker = new BgTaskTracker({ now: () => 1 });
    feed(tracker, bashStart('bnhjy1pyc', 'Sleep for 300 seconds in background'));
    feed(tracker, [
      sys('background_tasks_changed', { tasks: [] }),
      sys('task_updated', { task_id: 'bnhjy1pyc', patch: { status: 'killed', end_time: 1790397297339 } }),
      sys('task_notification', { task_id: 'bnhjy1pyc', tool_use_id: 't', status: 'stopped', output_file: '', summary: 'Sleep for 300 seconds in background' }),
    ]);
    expect(tracker.snapshot()[0]).toMatchObject({ status: 'stopped' });
    expect(tracker.lastNotification()).toMatchObject({ status: 'stopped' });
  });

  test('后台子 agent：task_progress 更新进度；子 agent 内部同步 Bash（owned_by_subagent）不收', () => {
    const tracker = new BgTaskTracker({ now: () => 1 });
    feed(tracker, [
      sys('background_tasks_changed', { tasks: [{ task_id: 'afef8add', task_type: 'local_agent', description: '后台执行 sleep 并回报' }] }),
      sys('task_started', {
        task_id: 'afef8add',
        tool_use_id: 'toolu_agent',
        description: '后台执行 sleep 并回报',
        subagent_type: 'general-purpose',
        is_backgrounded: true,
        spawn_depth: 1,
        task_type: 'local_agent',
        prompt: '用 Bash 执行 sleep',
      }),
    ]);
    expect(
      tracker.observe(
        sys('task_progress', {
          task_id: 'afef8add',
          tool_use_id: 'toolu_agent',
          description: 'Running Wait 15 seconds then print marker',
          subagent_type: 'general-purpose',
          usage: { total_tokens: 22012, tool_uses: 1, duration_ms: 3320 },
          last_tool_name: 'Bash',
        }),
      ),
    ).toBe(true);
    // 子 agent 内部同步跑的 Bash：不是后台任务
    expect(
      tracker.observe(
        sys('task_started', { task_id: 'b47uexs4e', owned_by_subagent: true, tool_use_id: 'toolu_sub', description: 'Wait 15 seconds', is_backgrounded: false, task_type: 'local_bash' }),
      ),
    ).toBe(false);
    expect(tracker.observe(sys('task_notification', { task_id: 'b47uexs4e', tool_use_id: 'toolu_sub', status: 'completed', output_file: '', summary: 'Wait' }))).toBe(false);
    expect(tracker.snapshot()).toHaveLength(1);
    expect(tracker.snapshot()[0]).toMatchObject({ kind: 'agent', status: 'running', toolUses: 1, durationMs: 3320, lastToolName: 'Bash' });
    // 描述保持发起时的，不被 task_progress 的「Running …」覆盖
    expect(tracker.snapshot()[0]!.description).toBe('后台执行 sleep 并回报');
    // 相同进度不算变化
    expect(
      tracker.observe(
        sys('task_progress', { task_id: 'afef8add', description: 'x', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 3320 }, last_tool_name: 'Bash' }),
      ),
    ).toBe(false);
  });

  test('前台任务经 is_backgrounded 补丁转成后台任务（Ctrl+B 语义）', () => {
    const tracker = new BgTaskTracker({ now: () => 7 });
    expect(tracker.observe(sys('task_started', { task_id: 'fg1', tool_use_id: 't1', description: 'bun test', is_backgrounded: false, task_type: 'local_bash' }))).toBe(false);
    expect(tracker.snapshot()).toHaveLength(0);
    expect(tracker.observe(sys('task_updated', { task_id: 'fg1', patch: { is_backgrounded: true } }))).toBe(true);
    expect(tracker.snapshot()[0]).toMatchObject({ taskId: 'fg1', kind: 'bash', status: 'running', startedAt: 7, toolUseId: 't1' });
    // 没有候选的 task_updated 不凭空造任务
    expect(tracker.observe(sys('task_updated', { task_id: 'nope', patch: { status: 'completed' } }))).toBe(false);
  });

  test('ambient / skip_transcript 任务不收；level 里 ambient 也不收', () => {
    const tracker = new BgTaskTracker();
    expect(tracker.observe(sys('task_started', { task_id: 'amb', description: 'watch', is_backgrounded: true, task_type: 'local_bash', ambient: true }))).toBe(false);
    expect(tracker.observe(sys('background_tasks_changed', { tasks: [{ task_id: 'amb', task_type: 'local_bash', description: 'watch', ambient: true }] }))).toBe(false);
    expect(tracker.snapshot()).toHaveLength(0);
  });

  test('已结束的只留最近 MAX_ENDED 条，在跑的不裁', () => {
    let now = 0;
    const tracker = new BgTaskTracker({ now: () => ++now });
    for (let i = 0; i < MAX_ENDED + 3; i++) {
      feed(tracker, bashStart(`t${i}`, `job ${i}`));
      feed(tracker, bashDone(`t${i}`, `job ${i}`));
    }
    feed(tracker, bashStart('live', 'still running'));
    const snap = tracker.snapshot();
    expect(snap.filter((t) => t.status !== 'running')).toHaveLength(MAX_ENDED);
    expect(snap.some((t) => t.taskId === 'live' && t.status === 'running')).toBe(true);
    // 最早结束的被丢掉
    expect(snap.some((t) => t.taskId === 't0')).toBe(false);
    expect(snap.some((t) => t.taskId === `t${MAX_ENDED + 2}`)).toBe(true);
  });

  test('markAllStopped：子进程没了，在跑的全部标 stopped', () => {
    const tracker = new BgTaskTracker({ now: () => 9 });
    // level 信号是全量：第二个任务启动时列表里两个都在，a 结束时列表里只剩 b
    feed(tracker, [
      sys('background_tasks_changed', { tasks: [{ task_id: 'a', task_type: 'local_bash', description: 'a' }] }),
      sys('task_started', { task_id: 'a', tool_use_id: 'ta', description: 'a', is_backgrounded: true, task_type: 'local_bash' }),
      sys('background_tasks_changed', {
        tasks: [
          { task_id: 'a', task_type: 'local_bash', description: 'a' },
          { task_id: 'b', task_type: 'local_bash', description: 'b' },
        ],
      }),
      sys('task_started', { task_id: 'b', tool_use_id: 'tb', description: 'b', is_backgrounded: true, task_type: 'local_bash' }),
      sys('background_tasks_changed', { tasks: [{ task_id: 'b', task_type: 'local_bash', description: 'b' }] }),
      sys('task_notification', { task_id: 'a', status: 'completed', output_file: '', summary: 'a done' }),
    ]);
    expect(tracker.runningCount).toBe(1);
    expect(tracker.markAllStopped()).toBe(true);
    expect(tracker.snapshot().map((t) => [t.taskId, t.status])).toEqual([
      ['a', 'completed'],
      ['b', 'stopped'],
    ]);
    expect(tracker.markAllStopped()).toBe(false);
  });

  test('非 task 类消息不影响', () => {
    const tracker = new BgTaskTracker();
    expect(tracker.observe(sys('init', { model: 'm', slash_commands: [], mcp_servers: [] }))).toBe(false);
    expect(tracker.observe({ type: 'result', subtype: 'success' } as unknown as SDKMessage)).toBe(false);
  });
});

describe('spontaneousDetailOf', () => {
  test('按最近通知的状态与描述组文案；没有通知时给通用说明', () => {
    expect(spontaneousDetailOf(undefined)).toBe('后台任务完成');
    expect(spontaneousDetailOf({ taskId: 't', description: '跑测试', status: 'completed', at: 1 })).toBe('后台任务“跑测试”已完成');
    expect(spontaneousDetailOf({ taskId: 't', description: '跑测试', status: 'failed', at: 1 })).toBe('后台任务“跑测试”失败');
    expect(spontaneousDetailOf({ taskId: 't', description: '', status: 'stopped', at: 1 })).toBe('后台任务已停止');
  });

  test('lastNotification(consume) 取走后为空', () => {
    const tracker = new BgTaskTracker({ now: () => 1 });
    feed(tracker, bashStart());
    feed(tracker, bashDone());
    expect(tracker.lastNotification(true)).toBeDefined();
    expect(tracker.lastNotification()).toBeUndefined();
  });
});

describe('BgTaskTracker · 评审回归（m1 / m2 / m3 / B2）', () => {
  test('m1（探针 J）：level 先到收进来的子 agent 后台任务，bookend 带 owned_by_subagent 即撤掉', () => {
    const t = new BgTaskTracker({ now: () => 1 });
    expect(t.observe(sys('background_tasks_changed', { tasks: [{ task_id: 'sub-bg', task_type: 'local_bash', description: 'subagent bg' }] }))).toBe(true);
    expect(t.runningCount).toBe(1);
    expect(t.observe(sys('task_started', { task_id: 'sub-bg', description: 'subagent bg', is_backgrounded: true, owned_by_subagent: true, task_type: 'local_bash' }))).toBe(true);
    expect(t.runningCount).toBe(0);
    expect(t.snapshot()).toHaveLength(0);
  });

  test('m2（探针 I）：前台任务结束后候选作废，迟到的 is_backgrounded 补丁不能复活它；候选表有上限', () => {
    const t = new BgTaskTracker({ now: () => 1 });
    t.observe(sys('task_started', { task_id: 'fg', description: 'ls', is_backgrounded: false, task_type: 'local_bash', tool_use_id: 'x' }));
    t.observe(sys('task_updated', { task_id: 'fg', patch: { status: 'completed', end_time: 5 } }));
    t.observe(sys('task_notification', { task_id: 'fg', status: 'completed', output_file: '', summary: 'ok' }));
    expect(t.observe(sys('task_updated', { task_id: 'fg', patch: { is_backgrounded: true } }))).toBe(false);
    expect(t.runningCount).toBe(0);
    // 只经通知结束的候选同样作废
    t.observe(sys('task_started', { task_id: 'fg2', description: 'ls', is_backgrounded: false, task_type: 'local_bash' }));
    t.observe(sys('task_notification', { task_id: 'fg2', status: 'completed', output_file: '', summary: 'ok' }));
    expect(t.observe(sys('task_updated', { task_id: 'fg2', patch: { is_backgrounded: true } }))).toBe(false);
    // 上限：塞 60 个前台候选，最早的被淘汰、不能再转后台
    for (let i = 0; i < 60; i++) t.observe(sys('task_started', { task_id: `c${i}`, description: 'x', is_backgrounded: false, task_type: 'local_bash' }));
    expect(t.observe(sys('task_updated', { task_id: 'c0', patch: { is_backgrounded: true } }))).toBe(false);
    expect(t.observe(sys('task_updated', { task_id: 'c59', patch: { is_backgrounded: true } }))).toBe(true);
  });

  test('m3（探针 K）：只变 durationMs 的 task_progress 不算变化；toolUses / lastToolName 变了才发', () => {
    const t = new BgTaskTracker({ now: () => 1 });
    t.observe(sys('background_tasks_changed', { tasks: [{ task_id: 'ag', task_type: 'local_agent', description: 'agent' }] }));
    let n = 0;
    for (let i = 1; i <= 20; i++) {
      if (t.observe(sys('task_progress', { task_id: 'ag', description: 'agent', usage: { total_tokens: 1, tool_uses: 1, duration_ms: i * 1000 }, last_tool_name: 'Bash' }))) n += 1;
    }
    // 第一条带来 toolUses / lastToolName 算变化，之后 19 条只变 durationMs
    expect(n).toBe(1);
    expect(t.snapshot()[0]!.durationMs).toBe(20_000);
    expect(t.observe(sys('task_progress', { task_id: 'ag', description: 'agent', usage: { total_tokens: 1, tool_uses: 2, duration_ms: 21_000 }, last_tool_name: 'Bash' }))).toBe(true);
    expect(t.observe(sys('task_progress', { task_id: 'ag', description: 'agent', usage: { total_tokens: 1, tool_uses: 2, duration_ms: 22_000 }, last_tool_name: 'Read' }))).toBe(true);
  });

  test('B2（探针 L）：畸形消息不抛——缺 tasks / patch / task_id、tasks 里混非法项', () => {
    const t = new BgTaskTracker({ now: () => 1 });
    expect(t.observe(sys('background_tasks_changed', {}))).toBe(false);
    expect(t.observe(sys('background_tasks_changed', { tasks: 'nope' }))).toBe(false);
    expect(t.observe(sys('task_updated', { task_id: 't' }))).toBe(false);
    expect(t.observe(sys('task_updated', { patch: { status: 'completed' } }))).toBe(false);
    expect(t.observe(sys('task_started', {}))).toBe(false);
    expect(t.observe(sys('task_progress', {}))).toBe(false);
    expect(t.observe(sys('task_notification', {}))).toBe(false);
    // 合法项照收，非法项跳过
    expect(t.observe(sys('background_tasks_changed', { tasks: [null, 7, { task_type: 'local_bash' }, { task_id: 'ok', task_type: 'local_bash', description: 'd' }] }))).toBe(true);
    expect(t.snapshot().map((x) => x.taskId)).toEqual(['ok']);
  });
});

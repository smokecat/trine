/**
 * 子 agent 工具卡（subagent-view）渲染：折叠态进度行、展开子工具卡（嵌套）、历史卡
 * 展开时按需回看（加载中 / 空 / 失败重试 / 版本不够不拉）、权限类卡片的来源标注。
 * 与其他 DOM 测试同款：先注册 happy-dom，再动态 import react-dom。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { BgTask } from '@trine/core';
import type { TimelineEntry, ToolEntry } from '@/lib/reducer.ts';

await import('@/lib/dom-test-env.ts');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
type Root = ReturnType<typeof createRoot>;
const { ToolCard, subagentProgressText } = await import('./ToolCard.tsx');
const { Timeline, subagentSourceOf, toolLabels } = await import('./Timeline.tsx');

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: React.ReactNode): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}
const $ = (el: ParentNode, id: string): HTMLElement | null => el.querySelector(`[data-testid="${id}"]`);
const $$ = (el: ParentNode, id: string): HTMLElement[] => Array.from(el.querySelectorAll(`[data-testid="${id}"]`));
const click = (el: HTMLElement | null): void => {
  if (el === null) throw new Error('元素不存在');
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};
const header = (el: ParentNode): HTMLElement => el.querySelector('[data-testid="entry-tool"] [data-testid="tool-header"]') as HTMLElement;

const child = (id: string, toolName: string, argSummary: string, done = true): ToolEntry => ({
  kind: 'tool',
  id,
  toolName,
  argSummary,
  ...(done ? { status: 'ok' as const, resultSummary: '✓' } : {}),
  seq: 1,
  ts: 1,
});
const agent = (over: Partial<ToolEntry> = {}): ToolEntry => ({ kind: 'tool', id: 'P', toolName: 'Agent', argSummary: 'Run echo, write, read file', seq: 1, ts: 1, ...over });

describe('subagentProgressText', () => {
  test('运行中且有子工具：N 次工具调用 · 当前：最新在跑的；全跑完：最近；已结束 / 非 Agent / 无子工具 null', () => {
    const running = agent({ children: [child('c1', 'Bash', 'echo SUB1'), child('c2', 'Write', 'sub.txt', false)] });
    expect(subagentProgressText(running)).toBe('2 次工具调用 · 当前：Write sub.txt');
    expect(subagentProgressText(agent({ children: [child('c1', 'Bash', 'echo')] }))).toBe('1 次工具调用 · 最近：Bash echo');
    expect(subagentProgressText(agent({ childCount: 205, children: [child('c1', 'Read', '/a', false)] }))).toBe('205 次工具调用 · 当前：Read /a');
    // 父已结束但最新子工具还在跑（后台子 agent，评审 M1）：照样显示
    expect(subagentProgressText({ ...running, status: 'ok' })).toBe('2 次工具调用 · 当前：Write sub.txt');
    // 父已结束、子工具也都跑完：看右侧 resultSummary
    expect(subagentProgressText(agent({ status: 'ok', children: [child('c1', 'Bash', 'echo')] }))).toBeNull();
    expect(subagentProgressText(agent())).toBeNull();
    expect(subagentProgressText({ ...running, toolName: 'Bash' })).toBeNull();
  });
});

describe('ToolCard · 子 agent', () => {
  test('折叠态有进度行；展开后列出子工具卡（缩进一级），嵌套的子 Agent 再展开是孙工具', () => {
    const inner = { ...child('I', 'Agent', 'inner'), children: [child('g', 'Read', '/a')] };
    const el = mount(<ToolCard entry={agent({ children: [child('c1', 'Bash', 'echo SUB1'), inner, child('c3', 'Write', 'x', false)] })} runningElapsedMs={null} />);
    expect($(el, 'tool-subagent-progress')?.textContent).toBe('3 次工具调用 · 当前：Write x');
    click(header(el));
    expect($(el, 'tool-subagent-progress')).toBeNull();
    const list = $(el, 'tool-children')!;
    const kids = Array.from(list.children).filter((n) => n.getAttribute('data-testid') === 'entry-tool');
    expect(kids.map((k) => [k.getAttribute('data-tool'), k.getAttribute('data-depth')])).toEqual([
      ['Bash', '1'],
      ['Agent', '1'],
      ['Write', '1'],
    ]);
    click(kids[1]!.querySelector('button') as HTMLElement);
    expect($$(el, 'entry-tool').some((n) => n.getAttribute('data-depth') === '2' && n.getAttribute('data-tool') === 'Read')).toBe(true);
  });

  test('历史卡（已结束、无子条目）展开 → 拉回看，加载中有提示；失败给重试', async () => {
    const calls: string[] = [];
    let reject: (e: Error) => void = () => {};
    const load = (id: string): Promise<void> => {
      calls.push(id);
      return new Promise<void>((_res, rej) => {
        reject = rej;
      });
    };
    const el = mount(<ToolCard entry={agent({ status: 'ok', resultSummary: '✓ 3 次工具调用 · 18.3s' })} runningElapsedMs={null} onLoadChildren={load} />);
    click(header(el));
    expect(calls).toEqual(['P']);
    expect($(el, 'tool-children-loading')).not.toBeNull();
    await act(async () => {
      reject(new Error('timeout'));
      await Promise.resolve();
    });
    expect($(el, 'tool-children-error')).not.toBeNull();
    click($(el, 'tool-children-error')!.querySelector('button'));
    expect(calls).toEqual(['P', 'P']);
  });

  test('拉过但为空：显示没有记录，展开不再拉；没有回调（agent 版本不够）不拉并说明', () => {
    const calls: string[] = [];
    const load = (id: string): Promise<void> => {
      calls.push(id);
      return Promise.resolve();
    };
    const el = mount(<ToolCard entry={agent({ status: 'ok', childrenLoaded: true })} runningElapsedMs={null} onLoadChildren={load} />);
    click(header(el));
    expect(calls).toEqual([]);
    expect($(el, 'tool-children-empty')?.textContent).toContain('没有找到');
    act(() => root?.unmount());
    host?.remove();

    // 没有回调也没有预览：无可展开；有预览（报告）时展开并说明看不了过程
    const el2 = mount(<ToolCard entry={agent({ status: 'ok' })} runningElapsedMs={null} />);
    expect((header(el2) as HTMLButtonElement).disabled).toBe(true);
    act(() => root?.unmount());
    host?.remove();
    const el3 = mount(<ToolCard entry={agent({ status: 'ok', outputPreview: '报告' })} runningElapsedMs={null} />);
    click(header(el3));
    expect($(el3, 'tool-children-empty')?.textContent).toContain('版本过旧');
  });

  test('已有部分实时子条目的已结束卡：展开时补拉一次回看（评审 M3）；子工具还在跑则不拉', () => {
    const calls: string[] = [];
    const load = (id: string): Promise<void> => {
      calls.push(id);
      return new Promise<void>(() => {});
    };
    const el = mount(<ToolCard entry={agent({ status: 'ok', children: [child('c5', 'Bash', 'five')] })} runningElapsedMs={null} onLoadChildren={load} />);
    click(header(el));
    expect(calls).toEqual(['P']);
    expect($(el, 'tool-children')).not.toBeNull();
    expect($(el, 'tool-children-loading')).not.toBeNull();
    act(() => root?.unmount());
    host?.remove();

    const el2 = mount(<ToolCard entry={agent({ status: 'ok', children: [child('c1', 'Bash', 'x', false)] })} runningElapsedMs={null} onLoadChildren={load} />);
    click(header(el2));
    expect(calls).toEqual(['P']);
  });

  test('非 Agent 工具的行为不变：无预览不可展开', () => {
    const el = mount(<ToolCard entry={child('c', 'Bash', 'ls')} runningElapsedMs={null} />);
    expect((header(el) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('回看能力未知（评审 m4）', () => {
  const mountTimeline = (subagentHistory: boolean | null): HTMLDivElement =>
    mount(
      <Timeline
        entries={[agent({ status: 'ok', outputPreview: '报告' })]}
        syncing={undefined}
        deviceId="d1"
        now={10}
        runningToolId={null}
        runningElapsedMs={0}
        handlers={{ onUserAction: () => {}, onRespondPermission: () => {}, onResumeAt: () => {}, onStop: () => {} }}
        subagentHistory={subagentHistory}
      />,
    );

  test('machine.info 未到（null）：不说版本过旧；确知不支持（false）才说', () => {
    const el = mountTimeline(null);
    click(header(el));
    expect($(el, 'tool-children-empty')?.textContent).toContain('正在获取 agent 信息');
    act(() => root?.unmount());
    host?.remove();
    const el2 = mountTimeline(false);
    click(header(el2));
    expect($(el2, 'tool-children-empty')?.textContent).toContain('版本过旧');
  });
});

describe('权限类卡片的来源标注', () => {
  const entries: TimelineEntry[] = [
    agent({ children: [{ ...child('I', 'Agent', '内层任务'), children: [] }] }),
    { kind: 'permission', id: 'r1', toolName: 'Write', input: { file_path: '/tmp/a', content: 'hi' }, requestedAt: 1, state: 'pending', parentToolUseId: 'P', seq: 2, ts: 2 },
    { kind: 'permission', id: 'r2', toolName: 'Bash', input: { command: 'ls' }, requestedAt: 1, state: 'pending', parentToolUseId: 'ghost', seq: 3, ts: 3 },
    { kind: 'permission', id: 'r3', toolName: 'Bash', input: { command: 'pwd' }, requestedAt: 1, state: 'pending', seq: 4, ts: 4 },
    {
      kind: 'permission',
      id: 'r4',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: '选哪个？', header: 'Q', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: false }] },
      requestedAt: 1,
      state: 'pending',
      parentToolUseId: 'I',
      seq: 5,
      ts: 5,
    },
  ];

  test('subagentSourceOf：父卡描述 / 找不到父卡 "" / 主线程 undefined（嵌套父卡也找得到）', () => {
    const labels = toolLabels(entries);
    expect(entries.map((e) => subagentSourceOf(e, labels))).toEqual([undefined, 'Run echo, write, read file', '', undefined, '内层任务']);
  });

  test('时间线里：子 agent 的权限卡 / 提问卡顶部标注来源，主线程的不标', () => {
    const el = mount(
      <Timeline
        entries={entries}
        syncing={undefined}
        deviceId="d1"
        now={10}
        runningToolId={null}
        runningElapsedMs={0}
        handlers={{ onUserAction: () => {}, onRespondPermission: () => {}, onResumeAt: () => {}, onStop: () => {} }}
      />,
    );
    const perms = $$(el, 'entry-permission');
    expect(perms.map((p) => $(p, 'perm-subagent-source')?.textContent ?? null)).toEqual([
      '🤖来自子 agent：Run echo, write, read file',
      '🤖来自子 agent',
      null,
    ]);
    expect($($(el, 'entry-ask-question')!, 'perm-subagent-source')?.textContent).toBe('🤖来自子 agent：内层任务');
  });
});

describe('ToolCard · 前台 / 后台与子任务状态（plan §7）', () => {
  const launched = { status: 'ok' as const, resultSummary: '✓ 后台子 agent 已启动' };
  const bgTask = (over: Partial<BgTask> = {}): BgTask => ({
    taskId: 'task-1',
    kind: 'agent',
    description: 'probe',
    status: 'running',
    startedAt: 1_000,
    toolUseId: 'P',
    ...over,
  });
  const handlers = { onUserAction: () => {}, onRespondPermission: () => {}, onResumeAt: () => {}, onStop: () => {} };

  test('后台运行中：标题带类型与「后台」，右侧「后台运行中 · 计时」；展开看提示词', () => {
    const entry = agent({ argSummary: '后台 · probe', argDetail: '写给子 agent 的提示词', ...launched, subagent: { agentType: 'Explore', background: true } });
    const el = mount(<ToolCard entry={entry} runningElapsedMs={null} bgTask={bgTask()} now={66_000} />);
    expect($(el, 'tool-name')?.textContent).toBe('Agent · Explore · 后台');
    expect(header(el).textContent).toContain('probe');
    expect(header(el).textContent).not.toContain('后台 · probe');
    expect($(el, 'tool-subagent-status')?.textContent).toContain('后台运行中 · 1:05');
    expect(el.querySelector('[data-testid="entry-tool"]')?.getAttribute('data-subagent-state')).toBe('running');
    click(header(el));
    expect($(el, 'tool-args')?.textContent).toContain('提示词');
    expect($(el, 'tool-args-text')?.textContent).toBe('写给子 agent 的提示词');
  });

  test('结束后：显示 agent 的收尾摘要；没有收尾帧只有快照结束 → 状态词；快照陈旧 / 历史无证据 → 状态未知', () => {
    const done = agent({ status: 'ok', resultSummary: '✓ 3 次工具调用 · 0:20', subagent: { background: true, state: 'completed' } });
    expect($(mount(<ToolCard entry={done} runningElapsedMs={null} bgTask={bgTask({ status: 'completed' })} />), 'tool-subagent-status')?.textContent).toBe(
      '✓ 3 次工具调用 · 0:20',
    );
    act(() => root?.unmount());
    const pending = agent({ ...launched, subagent: { background: true } });
    expect($(mount(<ToolCard entry={pending} runningElapsedMs={null} bgTask={bgTask({ status: 'failed' })} />), 'tool-subagent-status')?.textContent).toBe('✗ 失败');
    act(() => root?.unmount());
    expect($(mount(<ToolCard entry={pending} runningElapsedMs={null} bgTask={bgTask()} bgStale />), 'tool-subagent-status')?.textContent).toBe('? 状态未知');
    act(() => root?.unmount());
    const history = agent({ ...launched, subagent: { background: true, state: 'unknown' } });
    expect($(mount(<ToolCard entry={history} runningElapsedMs={null} />), 'tool-subagent-status')?.textContent).toBe('? 状态未知');
  });

  test('Codex 子 agent 卡：右侧是调用状态，另起一行是子 agent 的昵称 / 状态 / 模型', () => {
    const entry: ToolEntry = {
      kind: 'tool',
      id: 'call_1',
      toolName: 'SubAgent',
      argSummary: '派生子 agent · probe',
      status: 'ok',
      resultSummary: '已派生',
      subagent: { agentId: 'thread-1', nickname: 'Meitner', state: 'running', model: 'm-1' },
      seq: 1,
      ts: 1,
    };
    const el = mount(<ToolCard entry={entry} runningElapsedMs={null} />);
    expect($(el, 'tool-result')?.textContent).toBe('已派生');
    expect($(el, 'tool-subagent-line')?.textContent).toBe('子 agent：Meitner · 运行中 · m-1');
    expect($(el, 'tool-subagent-status')).toBeNull();
  });

  test('评审 中9：显式后台但启动就失败 → 卡头显示失败摘要，不是状态未知', () => {
    const entry = agent({ argSummary: '后台 · probe', status: 'error', resultSummary: '✗ Agent type not found · 0.1s', subagent: { background: true } });
    const el = mount(<ToolCard entry={entry} runningElapsedMs={null} />);
    expect($(el, 'tool-subagent-status')?.textContent).toBe('✗ Agent type not found · 0.1s');
    expect(el.querySelector('[data-testid="entry-tool"]')?.getAttribute('data-subagent-state')).toBe('failed');
  });

  test('规格缺口：只知道已结束 → 「已结束 · 结果未知」，不显示成功', () => {
    const entry = agent({ ...launched, subagent: { background: true, state: 'ended' } });
    const el = mount(<ToolCard entry={entry} runningElapsedMs={null} />);
    expect($(el, 'tool-subagent-status')?.textContent).toBe('⊙ 已结束 · 结果未知');
  });

  test('评审 中8：对不上派生卡的子 thread 审批也标来源（短 id）', () => {
    const perm: TimelineEntry = { kind: 'permission', id: 'p', toolName: 'Shell', input: {}, requestedAt: 1, state: 'pending', subagentId: 'thread-0000abcd1234', seq: 1, ts: 1 };
    expect(subagentSourceOf(perm, new Map())).toBe('子 thread …abcd1234');
  });

  test('前台：标「前台」，结束照常显示结果摘要', () => {
    const el = mount(<ToolCard entry={agent({ status: 'ok', resultSummary: '✓ 2 次工具调用', subagent: { agentType: 'Plan' } })} runningElapsedMs={null} />);
    expect($(el, 'tool-name')?.textContent).toBe('Agent · Plan · 前台');
    expect($(el, 'tool-result')?.textContent).toBe('✓ 2 次工具调用');
    expect($(el, 'tool-subagent-status')).toBeNull();
  });

  test('时间线里并行的两个子 agent 各自计时：心跳只跟一个，另一个按自己的开始时刻走秒；后台的按快照', () => {
    const entries: TimelineEntry[] = [
      agent({ id: 'A1', ts: 4_000 }),
      agent({ id: 'A2', ts: 1_000 }),
      agent({ id: 'B1', ...launched, subagent: { background: true } }),
    ];
    const el = mount(
      <Timeline
        entries={entries}
        syncing={undefined}
        deviceId="d1"
        now={10_000}
        runningToolId="A1"
        runningElapsedMs={3_000}
        handlers={handlers}
        bgTasks={[bgTask({ toolUseId: 'B1', startedAt: 7_000 })]}
      />,
    );
    const cards = $$(el, 'entry-tool');
    expect(cards[0]!.textContent).toContain('3s');
    expect(cards[1]!.textContent).toContain('9s');
    expect($(cards[2]!, 'tool-subagent-status')?.textContent).toContain('后台运行中 · 3s');
  });
});

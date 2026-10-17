/**
 * ExitPlanMode 计划卡的真渲染断言：
 * - 静态渲染：pending 画出标题 / 计时 / 文件路径 / markdown 计划 / 三个动作；
 *   resolved 各态文案与反馈原文；invalidated；外链图片不出 src；
 * - DOM 交互：三个按钮发出的 decision 形状、反馈文本进 message、旧 agent 降级、
 *   resolved 态计划仍可展开；
 * - Timeline 分流：合法 → 计划卡，坏 input → 回落普通权限卡。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';
import type { PermissionEntry } from '@/lib/reducer.ts';
import type { PermissionDecision } from './PermissionCard.tsx';
import { DEFAULT_KEEP_PLANNING_MESSAGE } from './plan-model.ts';

// react-dom 必须在 DOM 环境装好之后再加载，避免 React 在缺少 DOM 时初始化
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { PlanCard } = await import('./PlanCard.tsx');
const { Timeline } = await import('./Timeline.tsx');

const T0 = 1_700_000_000_000;
const INPUT = {
  plan: '# 重命名计划\n\n1. 新建 **hi.txt**\n2. 删除旧文件\n\n![x](http://evil.example/x.png)',
  planFilePath: '/Users/u/.claude/plans/rename.md',
};

function entry(over: Partial<PermissionEntry> = {}): PermissionEntry {
  return {
    kind: 'permission',
    id: 'r1',
    toolName: 'ExitPlanMode',
    input: INPUT,
    requestedAt: T0,
    state: 'pending',
    seq: 1,
    ts: T0,
    ...over,
  } as PermissionEntry;
}

function render(e: PermissionEntry, supportsOptions = true): string {
  return renderToStaticMarkup(
    <PlanCard entry={e} deviceId="web-1" now={T0 + 7_000} supportsOptions={supportsOptions} onRespond={() => {}} />,
  );
}

describe('PlanCard · 静态渲染', () => {
  test('pending：标题、计时、文件路径、markdown 计划、三个动作与反馈框', () => {
    const html = render(entry());
    expect(html).toContain('Claude 请求批准计划');
    expect(html).toContain('已等待');
    expect(html).toContain('/Users/u/.claude/plans/rename.md');
    // markdown 真渲染：标题与加粗成了元素，不是原样的 # / **
    expect(html).toMatch(/<h1[^>]*>重命名计划<\/h1>/);
    expect(html).toContain('data-streamdown="strong"');
    expect(html).not.toContain('**hi.txt**');
    expect(html).toContain('批准并自动接受编辑');
    expect(html).toContain('批准，逐个确认编辑');
    expect(html).toContain('继续规划');
    expect(html).toContain('data-testid="plan-feedback"');
    expect(html).not.toContain('data-testid="plan-legacy-note"');
  });

  test('计划里的外链图片不外连（沿用 Markdown 的拦截）', () => {
    expect(render(entry())).not.toContain('evil.example');
  });

  test('旧 agent：不给「自动接受编辑」与反馈框，并说明原因', () => {
    const html = render(entry(), false);
    expect(html).not.toContain('data-testid="plan-approve-auto"');
    expect(html).not.toContain('data-testid="plan-feedback"');
    expect(html).toContain('批准，逐个确认编辑');
    expect(html).toContain('data-testid="plan-legacy-note"');
  });

  test('resolved 批准并切 acceptEdits：结果行，按钮消失，计划折叠', () => {
    const html = render(
      entry({ state: 'resolved', verdict: 'allow', resolvedBy: 'web-1', approvedMode: 'acceptEdits', approvedInput: INPUT }),
    );
    expect(html).toContain('✓ 已批准（本设备） · 已切到自动接受编辑');
    expect(html).not.toContain('data-testid="plan-approve-auto"');
    expect(html).toContain('查看计划');
    expect(html).not.toContain('data-testid="plan-body"');
  });

  test('resolved 逐个确认：别的设备', () => {
    expect(render(entry({ state: 'resolved', verdict: 'allow', resolvedBy: 'phone-2' }))).toContain(
      '✓ 已批准（phone-2） · 逐个确认编辑',
    );
  });

  test('resolved 继续规划：显示反馈原文；默认附言不显示', () => {
    const html = render(entry({ state: 'resolved', verdict: 'deny', resolvedBy: 'web-1', denyMessage: '文件名改成 hi.txt' }));
    expect(html).toContain('↺ 继续规划（本设备）');
    expect(html).toContain('文件名改成 hi.txt');
    const plain = render(entry({ state: 'resolved', verdict: 'deny', denyMessage: DEFAULT_KEEP_PLANNING_MESSAGE }));
    expect(plain).toContain('↺ 继续规划');
    expect(plain).not.toContain('data-testid="plan-feedback-text"');
  });

  test('invalidated：复用权限卡失效文案', () => {
    expect(render(entry({ state: 'invalidated', reason: 'agent 重启' }))).toContain('请求已失效（agent 重启）');
  });
});

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

function click(el: Element | null | undefined): void {
  if (!el) throw new Error('element not found');
  act(() => (el as HTMLElement).click());
}

function typeInto(el: Element | null | undefined, value: string): void {
  if (!el) throw new Error('element not found');
  const input = el as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function mountCard(supportsOptions = true): { el: HTMLDivElement; decisions: PermissionDecision[] } {
  const decisions: PermissionDecision[] = [];
  const el = mount(
    <PlanCard
      entry={entry()}
      deviceId="web-1"
      now={T0}
      supportsOptions={supportsOptions}
      onRespond={(d) => decisions.push(d)}
    />,
  );
  return { el, decisions };
}

describe('PlanCard · 交互', () => {
  test('批准并自动接受编辑 → allow + 原 input + setMode acceptEdits', () => {
    const { el, decisions } = mountCard();
    click(el.querySelector('[data-testid="plan-approve-auto"]'));
    expect(decisions).toEqual([{ verdict: 'allow', updatedInput: INPUT, setMode: 'acceptEdits' }]);
  });

  test('批准，逐个确认编辑 → allow + 原 input，不带 setMode', () => {
    const { el, decisions } = mountCard();
    click(el.querySelector('[data-testid="plan-approve-manual"]'));
    expect(decisions).toEqual([{ verdict: 'allow', updatedInput: INPUT }]);
  });

  test('继续规划：填了反馈 → 作为 message；没填 → 默认附言', () => {
    const { el, decisions } = mountCard();
    click(el.querySelector('[data-testid="plan-keep-planning"]'));
    typeInto(el.querySelector('[data-testid="plan-feedback"]'), '  先加测试再改文件  ');
    click(el.querySelector('[data-testid="plan-keep-planning"]'));
    expect(decisions).toEqual([
      { verdict: 'deny', message: DEFAULT_KEEP_PLANNING_MESSAGE },
      { verdict: 'deny', message: '先加测试再改文件' },
    ]);
  });

  test('旧 agent：只剩两个动作，发出的 decision 不带 message / setMode', () => {
    const { el, decisions } = mountCard(false);
    expect(el.querySelector('[data-testid="plan-approve-auto"]')).toBeNull();
    click(el.querySelector('[data-testid="plan-approve-manual"]'));
    click(el.querySelector('[data-testid="plan-keep-planning"]'));
    expect(decisions).toEqual([{ verdict: 'allow', updatedInput: INPUT }, { verdict: 'deny' }]);
  });

  test('按钮高度 ≥ 40px（手机触控）', () => {
    const { el } = mountCard();
    for (const id of ['plan-approve-auto', 'plan-approve-manual', 'plan-keep-planning']) {
      expect(el.querySelector(`[data-testid="${id}"]`)?.className).toContain('h-10');
    }
  });

  test('resolved 态计划正文可展开查看', () => {
    const el = mount(
      <PlanCard entry={entry({ state: 'resolved', verdict: 'allow' })} deviceId="web-1" now={T0} onRespond={() => {}} />,
    );
    expect(el.querySelector('[data-testid="plan-body"]')).toBeNull();
    const toggle = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('查看计划'));
    click(toggle);
    expect(el.querySelector('[data-testid="plan-body"]')?.textContent).toContain('重命名计划');
  });
});

describe('Timeline · 计划卡分流', () => {
  const handlers = { onUserAction: () => {}, onRespondPermission: () => {}, onResumeAt: () => {}, onStop: () => {} };
  function mountTimeline(entries: PermissionEntry[], planOptions?: boolean): HTMLDivElement {
    return mount(
      <Timeline
        entries={entries}
        syncing={undefined}
        deviceId="web-1"
        now={T0}
        runningToolId={null}
        runningElapsedMs={0}
        handlers={handlers}
        {...(planOptions === undefined ? {} : { planOptions })}
      />,
    );
  }

  test('合法：画计划卡，不画权限卡', () => {
    const el = mountTimeline([entry()]);
    expect(el.querySelector('[data-testid="entry-plan"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="entry-permission"]')).toBeNull();
  });

  test('坏 input（plan 缺失 / 空串）：回落普通权限卡', () => {
    for (const input of [{}, { plan: '' }, { plan: 7 }]) {
      const el = mountTimeline([entry({ input })]);
      expect(el.querySelector('[data-testid="entry-plan"]')).toBeNull();
      expect(el.querySelector('[data-testid="entry-permission"]')).not.toBeNull();
      act(() => root?.unmount());
      host?.remove();
      root = null;
      host = null;
    }
  });

  test('planOptions=false 透传到卡片（旧 agent 降级）', () => {
    const el = mountTimeline([entry()], false);
    expect(el.querySelector('[data-testid="plan-approve-auto"]')).toBeNull();
    expect(el.querySelector('[data-testid="plan-legacy-note"]')).not.toBeNull();
  });
});

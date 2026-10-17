/**
 * AskUserQuestion 提问卡的真渲染断言：
 * - 静态渲染（renderToStaticMarkup）：pending 画出题目 / 选项 / header，
 *   resolved 读回 approvedInput 显示答案，deny 显示已跳过，invalidated 复用失效文案；
 * - DOM 交互：点选 → 提交发出的 decision 形状（allow + { ...input, answers }）、
 *   未答全禁用提交、跳过发 deny、preview 按纯文本出现；
 * - Timeline 分流：结构对 → 提问卡，坏 input → 回落普通权限卡。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';
import type { PermissionEntry } from '@/lib/reducer.ts';
import type { PermissionDecision } from './PermissionCard.tsx';

// react-dom 必须在 DOM 环境装好之后再加载，避免 React 在缺少 DOM 时初始化
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { AskQuestionCard } = await import('./AskQuestionCard.tsx');
const { Timeline } = await import('./Timeline.tsx');

const T0 = 1_700_000_000_000;
const INPUT = {
  questions: [
    {
      question: '你喜欢哪种颜色？',
      header: '颜色',
      multiSelect: false,
      options: [
        { label: '红色', description: '热烈的红' },
        { label: '蓝色', description: '冷静的蓝', preview: '<script>alert(1)</script>' },
      ],
    },
    {
      question: '要启用哪些功能？',
      header: '功能',
      multiSelect: true,
      options: [
        { label: 'A', description: 'aa' },
        { label: 'B', description: 'bb' },
      ],
    },
  ],
};

function entry(over: Partial<PermissionEntry> = {}): PermissionEntry {
  return {
    kind: 'permission',
    id: 'r1',
    toolName: 'AskUserQuestion',
    input: INPUT,
    requestedAt: T0,
    state: 'pending',
    seq: 1,
    ts: T0,
    ...over,
  } as PermissionEntry;
}

function render(e: PermissionEntry): string {
  return renderToStaticMarkup(<AskQuestionCard entry={e} deviceId="web-1" now={T0 + 5_000} onRespond={() => {}} />);
}

describe('AskQuestionCard · 静态渲染', () => {
  test('pending：头部、计时、header、问题、选项、其他、按钮', () => {
    const html = render(entry());
    expect(html).toContain('Claude 在提问');
    expect(html).toContain('已等待');
    expect(html).toContain('颜色');
    expect(html).toContain('你喜欢哪种颜色？');
    expect(html).toContain('热烈的红');
    expect(html).toContain('要启用哪些功能？');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="group"');
    expect(html).toContain('role="radio"');
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('其他');
    expect(html).toContain('提交回答');
    expect(html).toContain('跳过，改用文字回答');
    // 未选中时不出 preview
    expect(html).not.toContain('data-testid="ask-preview"');
  });

  test('resolved allow：逐题显示读回的答案，本设备回答标注', () => {
    const html = render(
      entry({
        state: 'resolved',
        verdict: 'allow',
        resolvedBy: 'web-1',
        approvedInput: { ...INPUT, answers: { '你喜欢哪种颜色？': '蓝色', '要启用哪些功能？': 'A, B' } },
      }),
    );
    expect(html).toContain('蓝色');
    expect(html).toContain('A, B');
    expect(html).toContain('已回答（本设备）');
    expect(html).not.toContain('提交回答');
  });

  test('resolved allow：别的设备回答显示设备 id', () => {
    const html = render(
      entry({
        state: 'resolved',
        verdict: 'allow',
        resolvedBy: 'phone-2',
        approvedInput: { ...INPUT, answers: { '你喜欢哪种颜色？': '红色', '要启用哪些功能？': 'B' } },
      }),
    );
    expect(html).toContain('已回答（phone-2）');
  });

  test('resolved allow 但没有 approvedInput（旧 agent）：只说已回答', () => {
    const html = render(entry({ state: 'resolved', verdict: 'allow' }));
    expect(html).toContain('已回答');
    expect(html).toContain('你喜欢哪种颜色？');
    expect(html).not.toContain('data-testid="ask-answer"');
  });

  test('deny：已跳过', () => {
    const html = render(entry({ state: 'resolved', verdict: 'deny', resolvedBy: 'web-1' }));
    expect(html).toContain('已跳过（本设备）');
    expect(html).not.toContain('提交回答');
  });

  test('invalidated：复用权限卡失效文案', () => {
    const html = render(entry({ state: 'invalidated', reason: 'agent 重启' }));
    expect(html).toContain('请求已失效（agent 重启）');
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
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('AskQuestionCard · 交互', () => {
  test('答全才能提交；提交 = allow + { ...input, answers }', () => {
    const decisions: PermissionDecision[] = [];
    const el = mount(<AskQuestionCard entry={entry()} deviceId="web-1" now={T0} onRespond={(d) => decisions.push(d)} />);
    const submit = (): HTMLButtonElement => el.querySelector('[data-testid="ask-submit"]') as HTMLButtonElement;
    const [q1, q2] = [...el.querySelectorAll('[data-testid="ask-question"]')];

    expect(submit().disabled).toBe(true);
    click(q1?.querySelectorAll('[data-testid="ask-option"]')[1]); // 蓝色
    expect(submit().disabled).toBe(true);
    // 选中带 preview 的项后出预览，且按纯文本展示
    const preview = el.querySelector('[data-testid="ask-preview"]');
    expect(preview?.textContent).toBe('<script>alert(1)</script>');
    expect(preview?.querySelector('script')).toBeNull();

    click(q2?.querySelectorAll('[data-testid="ask-option"]')[1]); // B
    typeInto(q2?.querySelector('[data-testid="ask-other-input"]'), '自定义');
    expect(q2?.querySelector('[data-testid="ask-other"]')?.getAttribute('aria-checked')).toBe('true');
    expect(submit().disabled).toBe(false);
    click(submit());

    expect(decisions).toEqual([
      {
        verdict: 'allow',
        updatedInput: { ...INPUT, answers: { '你喜欢哪种颜色？': '蓝色', '要启用哪些功能？': 'B, 自定义' } },
      },
    ]);
  });

  test('单选题填「其他」即作答', () => {
    const decisions: PermissionDecision[] = [];
    const el = mount(<AskQuestionCard entry={entry()} deviceId="web-1" now={T0} onRespond={(d) => decisions.push(d)} />);
    const [q1, q2] = [...el.querySelectorAll('[data-testid="ask-question"]')];
    click(q1?.querySelectorAll('[data-testid="ask-option"]')[0]); // 红色
    typeInto(q1?.querySelector('[data-testid="ask-other-input"]'), '绿色');
    // 单选：打字后原先选的红色被取消
    expect(q1?.querySelectorAll('[data-testid="ask-option"]')[0]?.getAttribute('aria-checked')).toBe('false');
    click(q2?.querySelectorAll('[data-testid="ask-option"]')[0]); // A
    click(el.querySelector('[data-testid="ask-submit"]'));
    const answers = (decisions[0]?.updatedInput as { answers: Record<string, string> }).answers;
    expect(answers).toEqual({ '你喜欢哪种颜色？': '绿色', '要启用哪些功能？': 'A' });
  });

  test('跳过 = deny，不带 updatedInput', () => {
    const decisions: PermissionDecision[] = [];
    const el = mount(<AskQuestionCard entry={entry()} deviceId="web-1" now={T0} onRespond={(d) => decisions.push(d)} />);
    click(el.querySelector('[data-testid="ask-skip"]'));
    expect(decisions).toEqual([{ verdict: 'deny' }]);
  });
});

describe('Timeline · 提问卡分流', () => {
  const handlers = { onUserAction: () => {}, onRespondPermission: () => {}, onResumeAt: () => {}, onStop: () => {} };
  function mountTimeline(entries: PermissionEntry[]): HTMLDivElement {
    return mount(
      <Timeline
        entries={entries}
        syncing={undefined}
        deviceId="web-1"
        now={T0}
        runningToolId={null}
        runningElapsedMs={0}
        handlers={handlers}
      />,
    );
  }

  test('结构对：画提问卡，不画权限卡', () => {
    const el = mountTimeline([entry()]);
    expect(el.querySelector('[data-testid="entry-ask-question"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="entry-permission"]')).toBeNull();
  });

  test('坏 input：回落普通权限卡', () => {
    const el = mountTimeline([entry({ input: { questions: [] } })]);
    expect(el.querySelector('[data-testid="entry-ask-question"]')).toBeNull();
    expect(el.querySelector('[data-testid="entry-permission"]')).not.toBeNull();
  });

  test('别的工具不受影响', () => {
    const el = mountTimeline([entry({ toolName: 'Bash', input: { command: 'ls' } })]);
    expect(el.querySelector('[data-testid="entry-permission"]')).not.toBeNull();
  });
});

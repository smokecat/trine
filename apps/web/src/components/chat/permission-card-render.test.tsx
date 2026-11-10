/**
 * 权限卡「改参数后批准」的**真渲染**断言（验收 5）。
 *
 * 早先卡片恒渲染 `entry.input`——也就是最初的请求。改后的值只活在批准那一刻
 * 的组件 state 里：刷新后按持久化条目回放的是原始请求，其他设备从头到尾
 * 看不到实际批准了什么。对「`rm -rf x` 被改成 `ls`」这样的记录来说，
 * 这是要命的失真。
 *
 * 用真渲染而不是测纯函数：要钉住的正是「卡片上写的是哪一份参数」。
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PermissionEntry } from '@/lib/reducer.ts';
import { PermissionCard } from './PermissionCard.tsx';

const T0 = 1_700_000_000_000;
const ORIGINAL = { command: 'rm -rf /tmp/danger' };
const APPROVED = { command: 'ls -la /tmp/danger' };

function entry(over: Partial<PermissionEntry> = {}): PermissionEntry {
  return {
    kind: 'permission',
    id: 'r1',
    toolName: 'Bash',
    input: ORIGINAL,
    requestedAt: T0,
    state: 'pending',
    seq: 1,
    ts: T0,
    ...over,
  } as PermissionEntry;
}

function render(e: PermissionEntry): string {
  return renderToStaticMarkup(
    <PermissionCard entry={e} deviceId="web-1" now={T0} onRespond={() => {}} />,
  );
}

describe('PermissionCard · 改参数后批准的参数显示（验收 5）', () => {
  test('已批准且带 approvedInput：显示实际执行的参数，并标注', () => {
    const html = render(entry({ state: 'resolved', verdict: 'allow', approvedInput: APPROVED }));
    expect(html).toContain('ls -la /tmp/danger');
    expect(html).not.toContain('rm -rf /tmp/danger');
    expect(html).toContain('已按修改后的参数批准');
  });

  test('没改参数（无 approvedInput）：照常显示原始请求，不加标注', () => {
    const html = render(entry({ state: 'resolved', verdict: 'allow' }));
    expect(html).toContain('rm -rf /tmp/danger');
    expect(html).not.toContain('已按修改后的参数批准');
  });

  test('pending 态显示的永远是请求本身（此时不该有 approvedInput）', () => {
    const html = render(entry());
    expect(html).toContain('rm -rf /tmp/danger');
    expect(html).not.toContain('已按修改后的参数批准');
  });

  test('旧 agent 不发 updatedInput 时行为不变（向后兼容）', () => {
    const html = render(entry({ state: 'resolved', verdict: 'deny' }));
    expect(html).toContain('rm -rf /tmp/danger');
    expect(html).toContain('已拒绝');
  });

  test('非 Bash 工具（JSON 形态）同样显示实际批准的那份', () => {
    const html = render(
      entry({
        toolName: 'Grep',
        input: { pattern: 'secret' },
        state: 'resolved',
        verdict: 'allow',
        approvedInput: { pattern: 'harmless' },
      }),
    );
    expect(html).toContain('harmless');
    expect(html).not.toContain('secret');
  });
});

describe('PermissionCard · 引擎给的决定选项', () => {
  const options = [
    { id: 'accept', label: '批准', kind: 'allow_once' as const },
    { id: 'acceptForSession', label: '本会话都批准', kind: 'allow_session' as const },
    { id: 'decline', label: '拒绝', kind: 'reject' as const },
  ];

  test('按选项显示按钮；没有改参数入口和「记住」', () => {
    const html = render(entry({ toolName: 'Shell', input: { command: 'touch x' }, options }));
    expect(html).toContain('touch x');
    expect(html).toContain('本会话都批准');
    expect(html).toContain('perm-allow-session');
    expect(html).not.toContain('perm-edit');
    expect(html).not.toContain('perm-remember');
  });

  test('Shell 命令按命令显示，不是 JSON', () => {
    const html = render(entry({ toolName: 'Shell', input: { command: 'touch x', cwd: '/a' }, options }));
    expect(html).not.toContain('完整参数');
  });

  test('没有 options：照旧（Claude）', () => {
    const html = render(entry());
    expect(html).toContain('perm-edit');
    expect(html).not.toContain('perm-allow-session');
  });

  test('已响应后不再显示选项按钮', () => {
    const html = render(entry({ options, state: 'resolved', verdict: 'allow' }));
    expect(html).not.toContain('perm-allow-session');
    expect(html).toContain('已响应');
  });

  test('手测反馈：作废的卡卡头写「已失效」，不写「已响应」', () => {
    const html = render(entry({ options, state: 'invalidated', reason: '子 agent 的这一轮已结束' }));
    expect(html).toContain('已失效');
    expect(html).not.toContain('已响应');
  });
});

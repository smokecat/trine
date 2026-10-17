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

/**
 * 「更新 Claude」区块的 DOM 行为：确认后才发请求、等待中按钮禁用、三种结论与
 * 输出展开。真挂 DOM：要钉住的是「点了什么才发请求」与 loading 态。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';
import type { ClaudeUpdateResult } from '@/lib/client.ts';

// react-dom 必须在 DOM 环境装好之后再加载（见 .local learnings / session-list.test.tsx）
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ClaudeUpdateSection } = await import('./ClaudeUpdateSection.tsx');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(props: { online?: boolean | null; update: () => Promise<ClaudeUpdateResult> }): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <ClaudeUpdateSection
        machineName="MBP"
        online={props.online === undefined ? true : props.online}
        claudeVersion="2.1.251 (Claude Code)"
        update={props.update}
      />,
    ),
  );
}

function $(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

function click(el: HTMLElement): void {
  act(() => el.click());
}

function result(over: Partial<ClaudeUpdateResult> = {}): ClaudeUpdateResult {
  return {
    type: 'machine.claude.update.response',
    ts: 1,
    seq: 1,
    dir: 'a2c',
    reqId: 'q',
    ok: true,
    fromVersion: '2.1.251 (Claude Code)',
    toVersion: '2.1.282 (Claude Code)',
    output: 'Successfully updated to 2.1.282',
    ...over,
  };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

describe('ClaudeUpdateSection', () => {
  test('点按钮只弹确认，确认后才发请求；等待中按钮禁用并显示进度；完成后给旧→新', async () => {
    let calls = 0;
    let resolve!: (r: ClaudeUpdateResult) => void;
    render({
      update: () => {
        calls++;
        return new Promise((r) => (resolve = r));
      },
    });
    click($('claude-update')!);
    expect(calls).toBe(0);
    expect($('confirm-claude-update')?.textContent).toContain('2.1.251');
    click($('confirm-claude-update-confirm')!);
    expect(calls).toBe(1);
    expect(($('claude-update') as HTMLButtonElement).disabled).toBe(true);
    expect($('claude-update')!.textContent).toContain('更新中');
    expect($('claude-update-progress')).not.toBeNull();

    await act(async () => {
      resolve(result());
    });
    expect(($('claude-update') as HTMLButtonElement).disabled).toBe(false);
    const box = $('claude-update-result')!;
    expect(box.dataset['tone']).toBe('success');
    expect(box.textContent).toContain('2.1.251 → 2.1.282');
    expect(box.textContent).toContain('运行中的会话仍是旧版本');
    // 输出默认收起，点开可见
    expect($('claude-update-output')).toBeNull();
    click($('claude-update-output-toggle')!);
    expect($('claude-update-output')!.textContent).toBe('Successfully updated to 2.1.282');
  });

  test('版本不变 → 已是最新；失败 → 原因 + 截断输出带前略标记', async () => {
    render({ update: async () => result({ fromVersion: '2.1.282 (Claude Code)' }) });
    click($('claude-update')!);
    await act(async () => click($('confirm-claude-update-confirm')!));
    expect($('claude-update-result')!.dataset['tone']).toBe('info');
    expect($('claude-update-result')!.textContent).toContain('已是最新（2.1.282）');
    act(() => root?.unmount());
    document.body.innerHTML = '';

    render({
      update: async () =>
        result({ ok: false, output: 'EACCES', outputTruncated: true, error: { code: 'failed', message: '退出码 1' } }),
    });
    click($('claude-update')!);
    await act(async () => click($('confirm-claude-update-confirm')!));
    expect($('claude-update-result')!.dataset['tone']).toBe('error');
    expect($('claude-update-result')!.textContent).toContain('更新失败：退出码 1');
    click($('claude-update-output-toggle')!);
    expect($('claude-update-output')!.textContent).toBe('…（前略）\nEACCES');
  });

  test('请求抛错（离线 / 超时）也落成失败结论', async () => {
    render({ update: async () => Promise.reject(new Error('未收到 agent 应答：agent 版本过旧或离线')) });
    click($('claude-update')!);
    await act(async () => click($('confirm-claude-update-confirm')!));
    expect($('claude-update-result')!.textContent).toContain('agent 版本过旧或离线');
    expect($('claude-update-output-toggle')).toBeNull();
  });

  test('已知离线：按钮禁用', () => {
    render({ online: false, update: async () => result() });
    expect(($('claude-update') as HTMLButtonElement).disabled).toBe(true);
  });
});

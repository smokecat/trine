/**
 * 「重启 Codex 进程」区块：确认后才发请求、等待中禁用，结论按 daemon 结果分开说。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import '@/lib/dom-test-env.ts';
import type { EngineRestartResult } from '@/lib/client.ts';
import { summarizeEngineRestart, supportsEngineRestart } from './engine-restart.ts';

// react-dom 必须在 DOM 环境装好之后再加载
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EngineRestartSection } = await import('./EngineRestartSection.tsx');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(restart: () => Promise<EngineRestartResult>, online: boolean | null = true): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(<EngineRestartSection engineName="Codex" idPrefix="codex" machineName="MBP" online={online} restart={restart} />),
  );
}

function $(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

function click(el: HTMLElement): void {
  act(() => el.click());
}

function result(over: Partial<EngineRestartResult> = {}): EngineRestartResult {
  return { type: 'machine.engine.restart.response', ts: 1, seq: 1, dir: 'a2c', reqId: 'q', engine: 'codex', ok: true, ...over };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

describe('EngineRestartSection', () => {
  test('点按钮只弹确认，确认后才发请求；等待中禁用；完成后给结论', async () => {
    let calls = 0;
    let resolve!: (r: EngineRestartResult) => void;
    render(() => {
      calls++;
      return new Promise((r) => (resolve = r));
    });
    click($('codex-restart')!);
    expect(calls).toBe(0);
    expect($('confirm-codex-restart')?.textContent).toContain('常驻 daemon');
    click($('confirm-codex-restart-confirm')!);
    expect(calls).toBe(1);
    expect(($('codex-restart') as HTMLButtonElement).disabled).toBe(true);
    expect($('codex-restart')!.textContent).toContain('重启中');

    await act(async () => resolve(result({ daemon: 'restarted' })));
    expect(($('codex-restart') as HTMLButtonElement).disabled).toBe(false);
    expect($('codex-restart-result')!.dataset['tone']).toBe('success');
    expect($('codex-restart-result')!.textContent).toContain('已重启 Codex 进程和本机 daemon');
  });

  test('忙：info 并带原因；请求抛错：error', async () => {
    render(async () => result({ ok: false, error: { code: 'busy', message: '1 个 Codex 会话正在回复' } }));
    click($('codex-restart')!);
    await act(async () => click($('confirm-codex-restart-confirm')!));
    expect($('codex-restart-result')!.dataset['tone']).toBe('info');
    expect($('codex-restart-result')!.textContent).toContain('没有重启：1 个 Codex 会话正在回复');
    act(() => root?.unmount());
    document.body.innerHTML = '';

    render(async () => Promise.reject(new Error('未收到 agent 应答')));
    click($('codex-restart')!);
    await act(async () => click($('confirm-codex-restart-confirm')!));
    expect($('codex-restart-result')!.dataset['tone']).toBe('error');
  });

  test('已知离线：按钮禁用', () => {
    render(async () => result(), false);
    expect(($('codex-restart') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('engine-restart', () => {
  test('能力探测只看 capabilities.restart', () => {
    expect(supportsEngineRestart({ capabilities: { restart: true } })).toBe(true);
    expect(supportsEngineRestart({ capabilities: { update: true } })).toBe(false);
  });

  test('daemon 的三种结果分开说；daemon 失败仍算 trine 进程已重启', () => {
    expect(summarizeEngineRestart(result(), 'Codex').title).toBe('已重启 Codex 进程');
    expect(summarizeEngineRestart(result({ daemon: 'not_running' }), 'Codex').title).toContain('daemon 没在运行');
    const failed = summarizeEngineRestart(result({ daemon: 'failed', daemonMessage: 'daemon 重启超时' }), 'Codex');
    expect(failed).toEqual({ tone: 'error', title: '已重启 trine 的 Codex 进程，本机 daemon 没有重启：daemon 重启超时' });
    expect(summarizeEngineRestart(result({ ok: false, error: { code: 'failed', message: 'x' } }), 'Codex').tone).toBe('error');
  });
});

/**
 * 「重启 agent」区块的 DOM 行为：确认后才发请求、排空中切成「立即重启 / 取消」、
 * 不可用时禁用并说明原因。真挂 DOM。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import type { MachineRestartInfo } from '@trine/core';
import '@/lib/dom-test-env.ts';
import type { AgentRestartResult } from '@/lib/client.ts';

// react-dom 必须在 DOM 环境装好之后再加载
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { AgentRestartSection } = await import('./AgentRestartSection.tsx');

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(props: {
  restart: MachineRestartInfo;
  online?: boolean | null;
  request: (action: 'schedule' | 'now' | 'cancel') => Promise<AgentRestartResult>;
}): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AgentRestartSection
        machineName="MBP"
        online={props.online === undefined ? true : props.online}
        restart={props.restart}
        request={props.request}
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

function res(over: Partial<AgentRestartResult> = {}): AgentRestartResult {
  return { type: 'machine.agent.restart.response', ts: 1, seq: 1, dir: 'a2c', reqId: 'q', ok: true, phase: 'draining', ...over };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

describe('AgentRestartSection', () => {
  test('确认后才发 schedule；预检中按钮禁用；结论与预检输出', async () => {
    const actions: string[] = [];
    let resolve!: (r: AgentRestartResult) => void;
    render({
      restart: { available: true, revision: 'abc1234', workspaceRevision: 'def5678' },
      request: (action) => {
        actions.push(action);
        return new Promise((r) => (resolve = r));
      },
    });
    expect($('agent-revision')!.dataset['outdated']).toBe('true');
    click($('agent-restart')!);
    expect(actions).toEqual([]);
    click($('confirm-agent-restart-confirm')!);
    expect(actions).toEqual(['schedule']);
    expect(($('agent-restart') as HTMLButtonElement).disabled).toBe(true);
    expect($('agent-restart')!.textContent).toContain('预检中');

    await act(async () => {
      resolve(res({ ok: false, phase: undefined, error: { code: 'check_failed', message: 'selfcheck 失败', output: 'SyntaxError' } }));
    });
    expect($('agent-restart-result')!.dataset['tone']).toBe('error');
    click($('agent-restart-output-toggle')!);
    expect($('agent-restart-output')!.textContent).toBe('SyntaxError');
  });

  test('排空中：显示进度，可立即重启（需确认）或取消', async () => {
    const actions: string[] = [];
    render({
      restart: { available: true, pending: { phase: 'draining', requestedAt: 1, busySessions: 2 } },
      request: async (action) => {
        actions.push(action);
        return res({ phase: action === 'cancel' ? 'cancelled' : 'restarting' });
      },
    });
    expect($('agent-restart-pending')!.textContent).toContain('等待 2 个会话空闲');
    expect($('agent-restart')).toBeNull();
    click($('agent-restart-now')!);
    expect($('confirm-agent-restart')!.textContent).toContain('进行中的回复会被打断');
    await act(async () => click($('confirm-agent-restart-confirm')!));
    await act(async () => click($('agent-restart-cancel')!));
    expect(actions).toEqual(['now', 'cancel']);
    expect($('agent-restart-result')!.textContent).toContain('已取消重启');
  });

  test('自己发起的预检还没回应答时也能取消', async () => {
    const actions: string[] = [];
    const props = {
      request: (action: 'schedule' | 'now' | 'cancel') => {
        actions.push(action);
        return action === 'cancel' ? Promise.resolve(res({ phase: 'cancelled' })) : new Promise<AgentRestartResult>(() => {});
      },
    };
    render({ restart: { available: true }, ...props });
    click($('agent-restart')!);
    click($('confirm-agent-restart-confirm')!);
    // agent 广播了 checking
    act(() =>
      root!.render(
        <AgentRestartSection
          machineName="MBP"
          online
          restart={{ available: true, pending: { phase: 'checking', requestedAt: 1, busySessions: 0 } }}
          request={props.request}
        />,
      ),
    );
    expect(($('agent-restart-now') as HTMLButtonElement).disabled).toBe(true);
    expect(($('agent-restart-cancel') as HTMLButtonElement).disabled).toBe(false);
    await act(async () => click($('agent-restart-cancel')!));
    expect(actions).toEqual(['schedule', 'cancel']);
  });

  test('没有 supervisor：禁用并说明原因', () => {
    render({ restart: { available: false, unavailableReason: '没人拉起' }, request: async () => res() });
    expect(($('agent-restart') as HTMLButtonElement).disabled).toBe(true);
    expect($('agent-restart-unavailable')!.textContent).toContain('没人拉起');
  });

  test('已知离线：禁用', () => {
    render({ online: false, restart: { available: true }, request: async () => res() });
    expect(($('agent-restart') as HTMLButtonElement).disabled).toBe(true);
  });
});

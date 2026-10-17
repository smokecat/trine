/**
 * exit-plan-mode 新增的协议字段：全部可选、向后兼容。
 *
 * - permission.respond / permission.resolved 的 `message`（拒绝附言，限长）与
 *   `setMode`（批准时切模式）；
 * - SessionMeta 的 `waitingFor`；
 * - PushHint 的 `question_pending` / `plan_pending`；
 * - `waitingForTool` 映射。
 */
import { describe, expect, test } from 'bun:test';
import { waitingForTool } from '../permission/index.ts';
import { PushHintSchema, SessionMetaSchema } from '../types/index.ts';
import {
  AgentToClientEventSchema,
  ClientToAgentEventSchema,
  PERMISSION_MESSAGE_MAX,
  RelayFrameSchema,
} from './index.ts';

const ts = Date.now();
const a2c = { ts, seq: 1, dir: 'a2c', sessionId: 's1' } as const;
const c2a = { ts, seq: 1, dir: 'c2a', sessionId: 's1' } as const;

const respond = { type: 'permission.respond', ...c2a, requestId: 'r1', verdict: 'deny' } as const;
const resolved = { type: 'permission.resolved', ...a2c, requestId: 'r1', verdict: 'deny' } as const;

describe('permission.respond 的 message / setMode', () => {
  test('旧帧（不带新字段）照常通过', () => {
    const parsed = ClientToAgentEventSchema.parse(respond);
    expect(parsed).toEqual(respond);
  });

  test('message 原样保留（不做 trim 变换，空串也能过——语义由 agent 判）', () => {
    for (const message of ['请把文件名改成 hi.txt', '  带空白  ', '']) {
      const parsed = ClientToAgentEventSchema.parse({ ...respond, message });
      expect((parsed as { message?: string }).message).toBe(message);
    }
  });

  test('message 限长：恰好上限通过，超一字符拒绝', () => {
    expect(() => ClientToAgentEventSchema.parse({ ...respond, message: 'x'.repeat(PERMISSION_MESSAGE_MAX) })).not.toThrow();
    expect(() =>
      ClientToAgentEventSchema.parse({ ...respond, message: 'x'.repeat(PERMISSION_MESSAGE_MAX + 1) }),
    ).toThrow();
    expect(() => ClientToAgentEventSchema.parse({ ...respond, message: 42 })).toThrow();
  });

  test('setMode 只接受已知权限模式', () => {
    const allow = { ...respond, verdict: 'allow', setMode: 'acceptEdits' } as const;
    expect((ClientToAgentEventSchema.parse(allow) as { setMode?: string }).setMode).toBe('acceptEdits');
    expect(() => ClientToAgentEventSchema.parse({ ...allow, setMode: 'dontAsk' })).toThrow();
  });
});

describe('permission.resolved 的 message / setMode', () => {
  test('旧帧照常通过；新字段原样保留', () => {
    expect(AgentToClientEventSchema.parse(resolved)).toEqual(resolved);
    const withMsg = { ...resolved, message: '继续规划：先补测试' };
    expect(AgentToClientEventSchema.parse(withMsg)).toEqual(withMsg);
    const withMode = { ...resolved, verdict: 'allow', setMode: 'acceptEdits' } as const;
    expect(AgentToClientEventSchema.parse(withMode)).toEqual(withMode);
  });

  test('超长 message 拒绝', () => {
    expect(() =>
      AgentToClientEventSchema.parse({ ...resolved, message: 'x'.repeat(PERMISSION_MESSAGE_MAX + 1) }),
    ).toThrow();
  });
});

describe('SessionMeta.waitingFor', () => {
  const base = {
    sessionId: 's1',
    title: 't',
    state: 'waiting_permission',
    lastActivityAt: 1,
    cwd: '/w',
    model: '',
    permissionMode: 'plan',
    costUsd: 0,
  } as const;

  test('可选：旧 agent 不带照常通过', () => {
    expect(SessionMetaSchema.parse(base).waitingFor).toBeUndefined();
  });

  test('三个取值都能过，未知值拒绝', () => {
    for (const waitingFor of ['permission', 'question', 'plan'] as const) {
      expect(SessionMetaSchema.parse({ ...base, waitingFor }).waitingFor).toBe(waitingFor);
    }
    expect(() => SessionMetaSchema.parse({ ...base, waitingFor: 'other' })).toThrow();
  });
});

describe('PushHint 新增值', () => {
  test('question_pending / plan_pending 可进 relay 帧', () => {
    for (const pushHint of ['question_pending', 'plan_pending'] as const) {
      expect(PushHintSchema.parse(pushHint)).toBe(pushHint);
      const frame = RelayFrameSchema.parse({
        type: 'relay',
        machineId: 'm1',
        sessionId: 's1',
        recipientDeviceId: 'd1',
        seq: 1,
        nonce: 'n',
        ciphertext: 'c',
        pushHint,
      });
      expect(frame.pushHint).toBe(pushHint);
    }
  });
});

describe('waitingForTool', () => {
  test('AskUserQuestion → question，ExitPlanMode → plan，其余 → permission', () => {
    expect(waitingForTool('AskUserQuestion')).toBe('question');
    expect(waitingForTool('ExitPlanMode')).toBe('plan');
    expect(waitingForTool('Bash')).toBe('permission');
    expect(waitingForTool('')).toBe('permission');
  });
});

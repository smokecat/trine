import { describe, expect, test } from 'bun:test';
import { AgentToClientEventSchema, ClientToAgentEventSchema, CWD_CREATE_MAX_DEPTH } from './index.ts';
import { MachineInfoSchema } from '../types/index.ts';

const ts = 1;
const c2a = { ts, seq: 1, dir: 'c2a' } as const;
const a2c = { ts, seq: 1, dir: 'a2c' } as const;

describe('cwd-create 协议帧', () => {
  test('cwd.prepare.request：path 与 create 都必填', () => {
    const ok = ClientToAgentEventSchema.parse({ type: 'cwd.prepare.request', ...c2a, reqId: 'r', path: '~/p', create: false });
    expect(ok.type).toBe('cwd.prepare.request');
    expect(ClientToAgentEventSchema.safeParse({ type: 'cwd.prepare.request', ...c2a, reqId: 'r', path: '~/p' }).success).toBe(false);
    expect(ClientToAgentEventSchema.safeParse({ type: 'cwd.prepare.request', ...c2a, reqId: 'r', path: '', create: true }).success).toBe(false);
  });

  test('cwd.prepare.response：成功与失败两种形状', () => {
    const missing = AgentToClientEventSchema.parse({
      type: 'cwd.prepare.response',
      ...a2c,
      reqId: 'r',
      ok: true,
      path: '/w/p',
      status: 'missing',
      missing: ['/w', '/w/p'],
    });
    expect(missing.type).toBe('cwd.prepare.response');
    const failed = { type: 'cwd.prepare.response', ...a2c, reqId: 'r', ok: false, error: { code: 'not_dir', message: 'x' } };
    expect(AgentToClientEventSchema.parse(failed).type).toBe('cwd.prepare.response');
    const tooDeep = { type: 'cwd.prepare.response', ...a2c, reqId: 'r', ok: true, status: 'missing', missing: Array.from({ length: CWD_CREATE_MAX_DEPTH + 1 }, (_, i) => `/${i}`) };
    expect(AgentToClientEventSchema.safeParse(tooDeep).success).toBe(false);
  });

  test('MachineInfo.cwd.create 能力位可选', () => {
    const base = { name: 'm', platform: 'linux', osVersion: '', agentVersion: '0.27.0', claudeVersion: '', activeSessionCount: 0 };
    expect(MachineInfoSchema.parse({ ...base, cwd: { pinOrder: true, create: true } }).cwd?.create).toBe(true);
    expect(MachineInfoSchema.parse(base).cwd).toBeUndefined();
  });
});

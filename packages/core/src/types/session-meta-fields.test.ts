/**
 * SessionMeta 的 session-list-v2 可选字段（archived / archivedAt / createdAt /
 * gitBranch / firstPrompt）：新旧两端互通的前提是它们**全部可选**——
 * 旧 agent 不带、新 web 照常解析；旧 web 收到会 strip，不报错。
 */
import { describe, expect, test } from 'bun:test';
import { SessionMetaSchema } from './index.ts';

const base = {
  sessionId: 's1',
  title: 't',
  state: 'idle',
  lastActivityAt: 1,
  cwd: '/w',
  model: '',
  permissionMode: 'default',
  costUsd: 0,
} as const;

describe('SessionMeta 可选字段', () => {
  test('旧 agent 形状（不带新字段）照常通过', () => {
    const parsed = SessionMetaSchema.parse(base);
    expect(parsed.archived).toBeUndefined();
    expect(parsed.firstPrompt).toBeUndefined();
  });

  test('新字段原样保留', () => {
    const full = {
      ...base,
      archived: true,
      archivedAt: 5,
      createdAt: 2,
      gitBranch: 'main',
      firstPrompt: 'hello',
    };
    expect(SessionMetaSchema.parse(full)).toEqual(full);
  });

  test('类型错的新字段拒绝', () => {
    expect(() => SessionMetaSchema.parse({ ...base, archived: 'yes' })).toThrow();
    expect(() => SessionMetaSchema.parse({ ...base, archivedAt: -1 })).toThrow();
  });
});

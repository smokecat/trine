import { describe, expect, test } from 'bun:test';
import { describeReason, installProcessGuards, type GuardableProcess } from './process-guards.ts';

describe('installProcessGuards', () => {
  test('注册 unhandledRejection / uncaughtException 两个监听，只记日志不抛不退', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const proc: GuardableProcess = {
      on(event: string, listener: (...args: never[]) => void) {
        listeners.set(event, listener as (...args: unknown[]) => void);
        return proc;
      },
    } as GuardableProcess;
    const logs: string[] = [];
    installProcessGuards(proc, (line) => logs.push(line));
    expect([...listeners.keys()].sort()).toEqual(['uncaughtException', 'unhandledRejection']);

    expect(() => listeners.get('unhandledRejection')!(new TypeError('undefined is not an object'), Promise.resolve())).not.toThrow();
    expect(() => listeners.get('uncaughtException')!(new Error('boom'), 'uncaughtException')).not.toThrow();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('未处理的 Promise rejection');
    expect(logs[0]).toContain('undefined is not an object');
    expect(logs[1]).toContain('未捕获异常');
    expect(logs[1]).toContain('boom');
  });

  test('describeReason：Error 带堆栈；非 Error 原样', () => {
    expect(describeReason(new Error('x'))).toContain('Error: x');
    expect(describeReason('str')).toBe('str');
    expect(describeReason({ a: 1 })).toBe('{"a":1}');
  });
});

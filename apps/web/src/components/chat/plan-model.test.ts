/**
 * 计划卡纯逻辑：input 解析（坏结构回落）、三个动作的 decision 形状（含旧 agent
 * 降级）、已响应态文案。
 */
import { describe, expect, test } from 'bun:test';
import type { PermissionEntry } from '@/lib/reducer.ts';
import {
  DEFAULT_KEEP_PLANNING_MESSAGE,
  isPlanRequest,
  parsePlanInput,
  planDecision,
  planResultText,
} from './plan-model.ts';

const INPUT = { plan: '# 计划\n\n1. 写 hi.txt', planFilePath: '/Users/u/.claude/plans/x.md' };

function entry(over: Partial<PermissionEntry> = {}): PermissionEntry {
  return {
    kind: 'permission',
    id: 'r1',
    toolName: 'ExitPlanMode',
    input: INPUT,
    requestedAt: 1,
    state: 'pending',
    seq: 1,
    ts: 1,
    ...over,
  } as PermissionEntry;
}

describe('parsePlanInput / isPlanRequest', () => {
  test('合法 input：plan + planFilePath', () => {
    expect(parsePlanInput(INPUT)).toEqual(INPUT);
    expect(parsePlanInput({ plan: 'p' })).toEqual({ plan: 'p' });
    // planFilePath 类型不对只是不显示，不算坏输入
    expect(parsePlanInput({ plan: 'p', planFilePath: 3 })).toEqual({ plan: 'p' });
  });

  test('坏 input 返回 null（回落普通权限卡）', () => {
    for (const bad of [null, undefined, 'plan', [], {}, { plan: '' }, { plan: '  \n ' }, { plan: 42 }]) {
      expect(parsePlanInput(bad)).toBeNull();
    }
  });

  test('只有 ExitPlanMode 且 input 合法才画计划卡', () => {
    expect(isPlanRequest('ExitPlanMode', INPUT)).toBe(true);
    expect(isPlanRequest('ExitPlanMode', { plan: '' })).toBe(false);
    expect(isPlanRequest('Bash', INPUT)).toBe(false);
  });
});

describe('planDecision', () => {
  test('批准并自动接受编辑 = allow + 原 input + setMode acceptEdits', () => {
    expect(planDecision('approve_auto', INPUT, '')).toEqual({
      verdict: 'allow',
      updatedInput: INPUT,
      setMode: 'acceptEdits',
    });
  });

  test('批准，逐个确认编辑 = allow + 原 input，不带 setMode', () => {
    expect(planDecision('approve_manual', INPUT, '反馈不影响批准')).toEqual({ verdict: 'allow', updatedInput: INPUT });
  });

  test('继续规划：反馈 trim 后作为 message；空反馈用默认附言', () => {
    expect(planDecision('keep_planning', INPUT, '  文件名改成 hi.txt \n')).toEqual({
      verdict: 'deny',
      message: '文件名改成 hi.txt',
    });
    expect(planDecision('keep_planning', INPUT, '   ')).toEqual({
      verdict: 'deny',
      message: DEFAULT_KEEP_PLANNING_MESSAGE,
    });
  });

  test('旧 agent（不支持 message / setMode）：不带这两个字段', () => {
    const legacy = { supportsOptions: false };
    expect(planDecision('approve_auto', INPUT, '', legacy)).toEqual({ verdict: 'allow', updatedInput: INPUT });
    expect(planDecision('keep_planning', INPUT, '反馈', legacy)).toEqual({ verdict: 'deny' });
  });
});

describe('planResultText', () => {
  test('批准：按 approvedMode 区分，标注设备', () => {
    expect(planResultText(entry({ state: 'resolved', verdict: 'allow', resolvedBy: 'web-1', approvedMode: 'acceptEdits' }), 'web-1')).toEqual({
      text: '✓ 已批准（本设备） · 已切到自动接受编辑',
      tone: 'green',
    });
    expect(planResultText(entry({ state: 'resolved', verdict: 'allow', resolvedBy: 'phone' }), 'web-1').text).toBe(
      '✓ 已批准（phone） · 逐个确认编辑',
    );
  });

  test('继续规划：带反馈原文；默认附言不当反馈显示', () => {
    expect(
      planResultText(entry({ state: 'resolved', verdict: 'deny', resolvedBy: 'web-1', denyMessage: '先补测试' }), 'web-1'),
    ).toEqual({ text: '↺ 继续规划（本设备）', tone: 'amber', feedback: '先补测试' });
    expect(
      planResultText(entry({ state: 'resolved', verdict: 'deny', denyMessage: DEFAULT_KEEP_PLANNING_MESSAGE }), 'web-1'),
    ).toEqual({ text: '↺ 继续规划', tone: 'amber' });
  });

  test('失效：复用权限卡文案', () => {
    expect(planResultText(entry({ state: 'invalidated', reason: 'agent 重启' }), 'web-1').text).toContain(
      '请求已失效（agent 重启）',
    );
  });
});

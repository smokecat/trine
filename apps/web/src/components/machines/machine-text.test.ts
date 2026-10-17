import { describe, expect, test } from 'bun:test';
import {
  machineHeartbeatLine,
  machinePlatformLine,
  machineStatusLabel,
  machineTone,
  machineVersionLine,
  parkedWarnLine,
} from './machine-text.ts';

const NOW = 1_700_000_000_000;

describe('机器状态文案', () => {
  test('online === null 是「状态未知」，不是离线', () => {
    expect(machineStatusLabel(null)).toBe('状态未知');
    expect(machineStatusLabel(false)).toBe('离线');
    expect(machineStatusLabel(true)).toBe('在线');
    // 状态点上未知与离线同色（灰），但文案必须区分
    expect(machineTone(null)).toBe('off');
    expect(machineTone(false)).toBe('off');
    expect(machineTone(true)).toBe('on');
  });

  test('在线显示心跳，离线显示最后在线', () => {
    expect(machineHeartbeatLine(true, NOW - 3 * 60_000, NOW)).toBe('在线 · 心跳 3 分钟前');
    expect(machineHeartbeatLine(false, NOW - 2 * 3600_000, NOW)).toBe('离线 · 最后在线 2 小时前');
  });

  test('未知状态或没有 lastSeenAt 时只给状态词', () => {
    expect(machineHeartbeatLine(null, NOW, NOW)).toBe('状态未知');
    expect(machineHeartbeatLine(true, null, NOW)).toBe('在线');
    expect(machineHeartbeatLine(false, null, NOW)).toBe('离线');
  });

  test('版本缺失显示「未知」（新配对设备等 machine.info 补发时）', () => {
    expect(machineVersionLine(null)).toBe('agent 未知 · claude 未知');
    expect(machineVersionLine({ agentVersion: '', claudeVersion: '2.5.1' })).toBe(
      'agent 未知 · claude 2.5.1',
    );
    expect(machineVersionLine({ agentVersion: '0.1.0', claudeVersion: '2.5.1' })).toBe(
      'agent 0.1.0 · claude 2.5.1',
    );
  });

  test('平台行拼接，缺 info 给空串', () => {
    expect(machinePlatformLine(null)).toBe('');
    expect(machinePlatformLine({ platform: 'darwin', osVersion: '25.5.0' })).toBe('darwin 25.5.0');
    expect(machinePlatformLine({ platform: 'linux', osVersion: '' })).toBe('linux');
  });

  test('排队告警只在有排队时出现', () => {
    expect(parkedWarnLine(0)).toBe('');
    expect(parkedWarnLine(1)).toBe('1 条消息排队中，上线后自动发送');
    expect(parkedWarnLine(7)).toBe('7 条消息排队中，上线后自动发送');
  });
});

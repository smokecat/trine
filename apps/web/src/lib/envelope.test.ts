import { beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPair, sealJson, sodiumReady, type BoxKeyPair } from '@trine/core/crypto';
import type { AgentToClientEvent } from '@trine/core';
import { Inbound, type DroppedInfo } from './envelope.ts';
import { sealA2c, type A2cBody } from './test-utils.ts';

let agent: BoxKeyPair;
let client: BoxKeyPair;

beforeAll(async () => {
  await sodiumReady();
  agent = generateKeyPair();
  client = generateKeyPair();
});

interface Harness {
  inbound: Inbound;
  applied: { machineId: string; type: string; seq: number }[];
  dropped: DroppedInfo[];
  cursors: Map<string, number>;
  regressions: string[];
  frame: (body: A2cBody, seq: number, machineId?: string) => ReturnType<typeof sealA2c>;
}

function harness(over: { regression?: { minDrops: number; minGap: number } } = {}): Harness {
  const applied: Harness['applied'] = [];
  const dropped: DroppedInfo[] = [];
  const cursors = new Map<string, number>();
  const regressions: string[] = [];
  const inbound = new Inbound({
    boxSecretKey: client.secretKey,
    agentKeyFor: (m) => (m === 'mbp' ? agent.publicKey : undefined),
    cursor: {
      get: (m, s) => cursors.get(`${m}/${s}`) ?? 0,
      set: (m, s, v) => void cursors.set(`${m}/${s}`, v),
    },
    apply: (machineId, event) => void applied.push({ machineId, type: event.type, seq: event.seq }),
    onDropped: (info) => void dropped.push(info),
    onCursorRegression: (m, s) => void regressions.push(`${m}/${s}`),
    ...over,
  });
  const frame = (body: A2cBody, seq: number, machineId = 'mbp') =>
    sealA2c(body, seq, { agentSecretKey: agent.secretKey, clientPublicKey: client.publicKey }, machineId);
  return { inbound, applied, dropped, cursors, regressions, frame };
}

const runState = (sessionId: string): A2cBody => ({ type: 'run.state', sessionId, state: 'running' });

describe('envelope · 基本路径', () => {
  test('解密 → 校验 → 推进游标 → apply；seq ≤ 游标即重放丢弃', () => {
    const h = harness();
    h.inbound.onRelay(h.frame(runState('s1'), 1));
    h.inbound.onRelay(h.frame(runState('s1'), 2));
    h.inbound.onRelay(h.frame(runState('s1'), 2));
    h.inbound.onRelay(h.frame(runState('s1'), 1));
    expect(h.applied.map((a) => a.seq)).toEqual([1, 2]);
    expect(h.cursors.get('mbp/s1')).toBe(2);
    expect(h.dropped.map((d) => d.reason)).toEqual(['replay', 'replay']);
    // 机器级 scope 独立
    h.inbound.onRelay(h.frame({ type: 'machine.info', info: { name: 'x', platform: 'p', osVersion: 'o', agentVersion: 'a', claudeVersion: 'c', activeSessionCount: 0 } }, 1));
    expect(h.cursors.get('mbp/')).toBe(1);
  });

  test('未配对机器 / 解不开 / 信封不一致 / 反射帧 一律丢弃且不推进游标', () => {
    const h = harness();
    // 未配对
    h.inbound.onRelay(h.frame(runState('s1'), 1, 'ghost'));
    // 别的密钥封的
    const eve = generateKeyPair();
    h.inbound.onRelay(sealA2c(runState('s1'), 2, { agentSecretKey: eve.secretKey, clientPublicKey: client.publicKey }));
    // 跨会话拼接：密文里是 s1，信封挂到 s2
    h.inbound.onRelay({ ...h.frame(runState('s1'), 3), sessionId: 's2' });
    // 服务端改信封 seq
    h.inbound.onRelay({ ...h.frame(runState('s1'), 4), seq: 40 });
    // 反射：client 自己发的 c2a 密文被原样回送（共享密钥能解开，但 dir/type 不对）
    const c2a = { type: 'run.stop', ts: 1, seq: 5, dir: 'c2a', sessionId: 's1' };
    const box = sealJson(c2a, agent.publicKey, client.secretKey);
    h.inbound.onRelay({ type: 'relay', machineId: 'mbp', sessionId: 's1', recipientDeviceId: 'web', seq: 5, nonce: box.nonce, ciphertext: box.ciphertext });
    expect(h.applied).toHaveLength(0);
    expect(h.cursors.size).toBe(0);
    expect(h.dropped.map((d) => d.reason)).toEqual(['unknown_machine', 'decrypt', 'binding', 'binding', 'schema']);
  });
});

describe('envelope · 补发期暂存与 sync.done', () => {
  test('同步中 live 帧抢先到达：暂存，sync.done 后按 seq 合并放行，不丢不重、顺序正确', () => {
    const h = harness();
    h.cursors.set('mbp/s1', 4);
    h.inbound.beginSync('mbp', 's1', 'normal');
    // live 帧 7 先到（agent 正在产出），补发 5、6 后到，且补发里 7 也来了一份
    h.inbound.onRelay(h.frame(runState('s1'), 7));
    h.inbound.onRelay(h.frame(runState('s1'), 5));
    h.inbound.onRelay(h.frame(runState('s1'), 6));
    h.inbound.onRelay(h.frame(runState('s1'), 7));
    expect(h.applied).toHaveLength(0);
    expect(h.cursors.get('mbp/s1')).toBe(4);
    expect(h.inbound.isSyncing('mbp', 's1')).toBe(true);
    h.inbound.onSyncDone({ type: 'sync.done', machineId: 'mbp', sessionId: 's1', upTo: 7 });
    expect(h.applied.map((a) => a.seq)).toEqual([5, 6, 7]);
    expect(h.cursors.get('mbp/s1')).toBe(7);
    expect(h.inbound.isSyncing('mbp', 's1')).toBe(false);
    // 同步结束后恢复直通
    h.inbound.onRelay(h.frame(runState('s1'), 8));
    expect(h.applied.at(-1)?.seq).toBe(8);
  });

  test('别的 scope 不受某一 scope 同步中的影响；无帧可补的 sync.done 直接结束', () => {
    const h = harness();
    h.inbound.beginSync('mbp', 's1', 'normal');
    h.inbound.onRelay(h.frame(runState('s2'), 1));
    expect(h.applied.map((a) => a.seq)).toEqual([1]);
    h.inbound.onSyncDone({ type: 'sync.done', machineId: 'mbp', sessionId: 's1', upTo: 0 });
    expect(h.inbound.syncingCount).toBe(0);
    // 没在同步的 scope 收到 sync.done：忽略
    h.inbound.onSyncDone({ type: 'sync.done', machineId: 'mbp', sessionId: 's9', upTo: 0 });
  });

  test('连接中途断了：暂存丢弃、游标不动，下次按原游标再补', () => {
    const h = harness();
    h.cursors.set('mbp/s1', 4);
    h.inbound.beginSync('mbp', 's1', 'normal');
    h.inbound.onRelay(h.frame(runState('s1'), 5));
    h.inbound.onConnectionReset();
    expect(h.applied).toHaveLength(0);
    expect(h.cursors.get('mbp/s1')).toBe(4);
    expect(h.inbound.syncingCount).toBe(0);
  });
});

describe('envelope · 回填模式', () => {
  test('空时间线游标 > 0：sinceSeq 0 窗口内放行 seq ≤ 游标的帧（按 seq 去重），done 后恢复单调', () => {
    const h = harness();
    h.cursors.set('mbp/s1', 10);
    h.inbound.beginSync('mbp', 's1', 'backfill');
    for (const seq of [3, 4, 4, 10, 11]) h.inbound.onRelay(h.frame(runState('s1'), seq));
    h.inbound.onSyncDone({ type: 'sync.done', machineId: 'mbp', sessionId: 's1', upTo: 11 });
    expect(h.applied.map((a) => a.seq)).toEqual([3, 4, 10, 11]);
    expect(h.cursors.get('mbp/s1')).toBe(11);
    // 回填结束：老帧又来 → 重放丢弃
    h.inbound.onRelay(h.frame(runState('s1'), 5));
    expect(h.dropped.at(-1)).toMatchObject({ reason: 'replay', seq: 5 });
    expect(h.applied).toHaveLength(4);
  });
});

describe('envelope · 游标倒退探测', () => {
  test('同一连接上连续 ≥N 帧被丢且 seq < 游标 − gap → 回调一次；新连接后可再报', () => {
    const h = harness({ regression: { minDrops: 3, minGap: 100 } });
    h.cursors.set('mbp/s1', 5_000);
    for (const seq of [1, 2]) h.inbound.onRelay(h.frame(runState('s1'), seq));
    expect(h.regressions).toHaveLength(0);
    h.inbound.onRelay(h.frame(runState('s1'), 3));
    expect(h.regressions).toEqual(['mbp/s1']);
    h.inbound.onRelay(h.frame(runState('s1'), 4));
    expect(h.regressions).toHaveLength(1);
    h.inbound.onConnectionReset();
    for (const seq of [1, 2, 3]) h.inbound.onRelay(h.frame(runState('s1'), seq));
    expect(h.regressions).toHaveLength(2);
  });

  test('接近游标的重放（正常重复投递）不算倒退，计数被重置', () => {
    const h = harness({ regression: { minDrops: 2, minGap: 100 } });
    h.cursors.set('mbp/s1', 5_000);
    h.inbound.onRelay(h.frame(runState('s1'), 1));
    h.inbound.onRelay(h.frame(runState('s1'), 4_999)); // 近游标：正常重放，计数清零
    h.inbound.onRelay(h.frame(runState('s1'), 2));
    expect(h.regressions).toHaveLength(0);
  });
});

void (null as unknown as AgentToClientEvent);

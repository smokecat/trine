import { beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPair, sodiumReady } from '@trine/core/crypto';
import { MemoryDocStore, MemoryKv } from '../lib/adapters.ts';
import { TrineClient } from '../lib/client.ts';
import { KV_PEER } from '../lib/storage.ts';
import { FakeClock, FakeSocketFactory, flushMicrotasks, sealA2c } from '../lib/test-utils.ts';
import { bindClient, createTrineStore } from './index.ts';

beforeAll(async () => {
  await sodiumReady();
});

describe('store · 镜像 client', () => {
  test('绑定即取快照；后续事件按切片更新；notice 去重、dropped 只计数', async () => {
    const agent = generateKeyPair();
    const kv = new MemoryKv();
    kv.set(
      KV_PEER,
      JSON.stringify({ v: 1, serverUrl: 'http://localhost:5173', machines: { mbp: { agentBoxPubKey: agent.publicKey, pairedAt: 1, outSeq: {}, inCursors: {}, sessions: { s1: { lastActivityAt: 1 } }, name: 'MBP' } } }),
    );
    const clock = new FakeClock();
    const sockets = new FakeSocketFactory();
    const client = await TrineClient.create({
      kv,
      docs: new MemoryDocStore(),
      createSocket: sockets.create,
      clock,
      fetchImpl: (async (input: unknown) =>
        Response.json(String(input).endsWith('/auth/challenge') ? { challenge: 'c', expiresAt: 1 } : { token: 't', expiresAt: 9e15 })) as unknown as typeof fetch,
    });
    const store = createTrineStore();
    bindClient(store, client, () => 42);
    expect(store.getState().paired).toBe(true);
    expect(store.getState().serverUrl).toBe('http://localhost:5173');
    expect(store.getState().machines['mbp']).toMatchObject({ name: 'MBP', online: null });
    expect(store.getState().timelines['mbp/s1']?.entries).toEqual([]);

    client.start();
    await flushMicrotasks(10);
    sockets.last.emitOpen();
    expect(store.getState().connection.status).toBe('open');
    sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', upTo: 0 });
    sockets.last.emitMessage({ type: 'machine.status', machineId: 'mbp', online: true, lastSeenAt: 5 });
    expect(store.getState().machines['mbp']).toMatchObject({ online: true, lastSeenAt: 5 });

    const id = client.sendInput('mbp', 's1', 'hi');
    expect(store.getState().timelines['mbp/s1']?.entries[0]).toMatchObject({ kind: 'user', id, status: 'sending' });
    // s1 首次打开触发同步：先 sync.done 再回显
    sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', sessionId: 's1', upTo: 0 });
    sockets.last.emitMessage(
      sealA2c({ type: 'user.message', sessionId: 's1', messageId: 'm', clientMsgId: id, text: 'hi' }, 1, { agentSecretKey: agent.secretKey, clientPublicKey: client.publicKeys.box }, 'mbp', client.deviceId),
    );
    expect(store.getState().timelines['mbp/s1']?.entries[0]).toMatchObject({ status: 'confirmed' });

    // 机器级 fatal → notice；同键去重
    const fatal = (seq: number) =>
      sealA2c({ type: 'error.fatal', kind: 'other', message: 'boom' }, seq, { agentSecretKey: agent.secretKey, clientPublicKey: client.publicKeys.box }, 'mbp', client.deviceId);
    sockets.last.emitMessage(fatal(1));
    sockets.last.emitMessage(fatal(2));
    expect(store.getState().notices).toHaveLength(1);
    expect(store.getState().notices[0]).toMatchObject({ id: 'machine_error:mbp:', at: 42 });
    // 重放帧被丢 → 只计数
    sockets.last.emitMessage(fatal(1));
    expect(store.getState().droppedCount).toBe(1);
    expect(store.getState().notices).toHaveLength(1);
    store.getState().dismissNotice('machine_error:mbp:');
    expect(store.getState().notices).toHaveLength(0);
    store.getState().setDraft('mbp/s1', 'draft');
    expect(store.getState().drafts['mbp/s1']).toBe('draft');
    client.stop();
  });
});

describe('store · 契约新增字段（阶段 1 评审）', () => {
  test('deviceId / syncing / queuedCount 由 client 事件驱动镜像', async () => {
    const agent = generateKeyPair();
    const kv = new MemoryKv();
    kv.set(
      KV_PEER,
      JSON.stringify({ v: 1, serverUrl: 'http://localhost:5173', machines: { mbp: { agentBoxPubKey: agent.publicKey, pairedAt: 1, outSeq: {}, inCursors: {}, sessions: {} } } }),
    );
    const clock = new FakeClock();
    const sockets = new FakeSocketFactory();
    const client = await TrineClient.create({
      kv,
      docs: new MemoryDocStore(),
      createSocket: sockets.create,
      clock,
      fetchImpl: (async (input: unknown) =>
        Response.json(String(input).endsWith('/auth/challenge') ? { challenge: 'c', expiresAt: 1 } : { token: 't', expiresAt: 9e15 })) as unknown as typeof fetch,
    });
    const store = createTrineStore();
    bindClient(store, client);
    expect(store.getState().deviceId).toBe(client.deviceId);
    expect(store.getState().deviceId).toMatch(/^web-/);
    // 连接不在：入队 → queue 事件（不是靠 connection/timeline 事件间接推断）
    client.send('mbp', { type: 'session.list.request', reqId: 'q' });
    expect(store.getState().queuedCount).toBe(1);
    client.start();
    await flushMicrotasks(10);
    sockets.last.emitOpen();
    // open：机器级 scope 进入同步、队列冲刷
    expect(store.getState().syncing).toEqual({ mbp: 'normal' });
    expect(store.getState().queuedCount).toBe(0);
    sockets.last.emitMessage({ type: 'sync.done', machineId: 'mbp', upTo: 0 });
    expect(store.getState().syncing).toEqual({});
    client.openSession('mbp', 's1');
    expect(store.getState().syncing).toEqual({ 'mbp/s1': 'normal' });
    // 断连清空同步标记
    sockets.last.emitClose(1006);
    expect(store.getState().syncing).toEqual({});
    client.stop();
  });
});

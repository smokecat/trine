import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sodiumReady } from '@trine/core/crypto';
import { loadOrCreateIdentity, readIdentity, writeIdentity } from './identity.ts';
import { RecipientBookStore } from './recipients.ts';

let dirs: string[] = [];

beforeAll(async () => {
  await sodiumReady();
});

afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'trine-identity-'));
  dirs.push(dir);
  return dir;
}

describe('身份持久化', () => {
  test('首次生成两套密钥并落盘，二次读取一字不差', async () => {
    const path = join(await tmp(), 'identity.json');
    const first = await loadOrCreateIdentity({ path, machineId: 'mbp' });
    expect(first.created).toBe(true);
    expect(first.identity.machineId).toBe('mbp');
    // 两套密钥刻意分离：Ed25519 认服务端，X25519 做 E2E
    expect(first.identity.sign.publicKey).not.toBe(first.identity.box.publicKey);

    const second = await loadOrCreateIdentity({ path });
    expect(second.created).toBe(false);
    expect(second.identity).toEqual(first.identity);
  });

  test('文件权限为 0600（里面有两把私钥）', async () => {
    const path = join(await tmp(), 'identity.json');
    await loadOrCreateIdentity({ path });
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('损坏的身份文件抛错而不是静默重建', async () => {
    const path = join(await tmp(), 'identity.json');
    await writeFile(path, '{ 这不是 JSON');
    // 静默重建 = 悄悄换掉 machineId 与公钥，已配对设备全部失联
    await expect(readIdentity(path)).rejects.toThrow(/损坏/);
    await expect(loadOrCreateIdentity({ path })).rejects.toThrow(/损坏/);
  });

  test('不存在的路径读回 null', async () => {
    expect(await readIdentity(join(await tmp(), 'nope.json'))).toBeNull();
  });

  test('覆盖写入后权限仍是 0600', async () => {
    const path = join(await tmp(), 'identity.json');
    const { identity } = await loadOrCreateIdentity({ path });
    await writeIdentity({ ...identity, name: '改个名' }, path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readIdentity(path))?.name).toBe('改个名');
  });
});

describe('收件人名册', () => {
  test('新增后落盘，重新装载读得回来', async () => {
    const path = join(await tmp(), 'recipients.json');
    const store = await RecipientBookStore.load(path);
    expect(store.size).toBe(0);

    await store.add({
      deviceId: 'phone',
      boxPubKey: 'BOX-PHONE',
      signPubKey: 'SIGN-PHONE',
      pairedAt: 1,
    });
    const reloaded = await RecipientBookStore.load(path);
    expect(reloaded.get('phone')).toMatchObject({ boxPubKey: 'BOX-PHONE' });
  });

  test('多台设备各自独立（矩阵式配对）', async () => {
    const path = join(await tmp(), 'recipients.json');
    const store = await RecipientBookStore.load(path);
    await store.add({
      deviceId: 'phone',
      boxPubKey: 'BOX-PHONE',
      signPubKey: 'S1',
      pairedAt: 1,
    });
    await store.add({
      deviceId: 'tablet',
      boxPubKey: 'BOX-TABLET',
      signPubKey: 'S2',
      pairedAt: 2,
    });
    expect(store.size).toBe(2);
    // 撤销一台不牵连另一台——这正是选方案 A 的理由
    await store.remove('phone');
    expect(store.has('phone')).toBe(false);
    expect(store.has('tablet')).toBe(true);
    expect((await RecipientBookStore.load(path)).size).toBe(1);
  });

  test('同 deviceId 重复配对覆盖公钥', async () => {
    const path = join(await tmp(), 'recipients.json');
    const store = await RecipientBookStore.load(path);
    await store.add({
      deviceId: 'phone',
      boxPubKey: 'OLD',
      signPubKey: 'S',
      pairedAt: 1,
    });
    await store.add({
      deviceId: 'phone',
      boxPubKey: 'NEW',
      signPubKey: 'S',
      pairedAt: 2,
    });
    expect(store.size).toBe(1);
    expect(store.get('phone')?.boxPubKey).toBe('NEW');
  });

  test('文件不存在视为空名册（全新 agent）', async () => {
    const store = await RecipientBookStore.load(join(await tmp(), 'none.json'));
    expect(store.list()).toEqual([]);
  });

  test('损坏的名册抛错而不是静默清空', async () => {
    const path = join(await tmp(), 'recipients.json');
    await writeFile(path, '{"v":1,"recipients":"不是数组"}');
    await expect(RecipientBookStore.load(path)).rejects.toThrow();
  });
});

import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sodiumReady } from '@trine/core/crypto';
import { createInvitation } from '../../../server/src/auth/invitations.ts';
import { startServer, type TrineServer } from '../../../server/src/server.ts';
import { AgentNode } from './node.ts';

let server: TrineServer;
let dir: string;
let nodes: AgentNode[];
beforeAll(sodiumReady);
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trine-enrollment-'));
  nodes = [];
  server = await startServer({ port: 0, hostname: '127.0.0.1', dbPath: ':memory:', allowOpenRegistration: false });
});
afterEach(async () => {
  for (const node of nodes) await node.disconnect();
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});
async function make(extra: Partial<Parameters<typeof AgentNode.create>[0]> = {}) {
  const node = await AgentNode.create({ serverUrl: `http://127.0.0.1:${server.port}`,
    identityPath: join(dir, 'identity.json'), recipientsPath: join(dir, 'recipients.json'), ...extra });
  nodes.push(node);
  return node;
}
async function online(node: AgentNode) {
  for (let i = 0; i < 100 && !node.online; i++) await Bun.sleep(5);
  expect(node.online).toBe(true);
}

test('missing invitation is actionable and preserves identity for the next attempt', async () => {
  const node = await make();
  await expect(node.connect()).rejects.toThrow('--enroll');
  expect(server.store.countDevices()).toBe(0);
  const identity = await readFile(join(dir, 'identity.json'), 'utf8');
  const retry = await make({ getInvitation: async () => createInvitation(server.store).token });
  await retry.connect();
  await online(retry);
  expect(await readFile(join(dir, 'identity.json'), 'utf8')).toBe(identity);
});

test('lost registration response recovers using the committed identity; restart does not request an invite', async () => {
  const invitation = createInvitation(server.store).token;
  let prompts = 0;
  let registerCalls = 0;
  const lines: string[] = [];
  const nativeFetch = globalThis.fetch;
  const node = await make({ getInvitation: async () => { prompts++; return invitation; }, log: (line) => lines.push(line),
    fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await nativeFetch(url, init);
      if (String(url).endsWith('/auth/register')) {
        registerCalls++;
        await response.text();
        throw new TypeError('synthetic dropped response');
      }
      return response;
    }) as unknown as typeof fetch });
  await node.connect();
  await online(node);
  await node.disconnect();
  const restarted = await make({ getInvitation: async () => { throw new Error('must not prompt on reconnect'); } });
  await restarted.connect();
  await online(restarted);
  expect(prompts).toBe(1);
  expect(registerCalls).toBe(1);
  expect(server.store.countDevices()).toBe(1);
  expect(lines.join('\n')).not.toContain(invitation);
  for (const file of await readdir(dir)) expect(await readFile(join(dir, file), 'utf8')).not.toContain(invitation);
});

test('expired invite fails once, then a new invite works with the same identity', async () => {
  const expired = createInvitation(server.store, 1000, Date.now() - 1000).token;
  let prompts = 0;
  const node = await make({ getInvitation: async () => { prompts++; return expired; } });
  await expect(node.connect()).rejects.toMatchObject({ reason: 'invalid_invitation' });
  expect(prompts).toBe(1);
  const retry = await make({ getInvitation: async () => createInvitation(server.store).token });
  expect(retry.machineId).toBe(node.machineId);
  await retry.connect();
  await online(retry);
});

test('remote plaintext URL is rejected before prompting or submitting an invitation', async () => {
  let prompts = 0;
  const node = await make({ serverUrl: 'http://relay.example', getInvitation: async () => { prompts++; return ''; },
    fetchImpl: (async () => Response.json({ error: 'unknown_device' }, { status: 401 })) as unknown as typeof fetch });
  await expect(node.connect()).rejects.toThrow('HTTPS');
  expect(prompts).toBe(0);
});

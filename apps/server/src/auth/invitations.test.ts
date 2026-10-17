import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSignKeyPair, randomToken, sodiumReady } from '@trine/core/crypto';
import { AuthClient } from '@trine/core/net';
import { loadConfig } from '../config.ts';
import { createHttpApp } from '../http.ts';
import { Store } from '../store/index.ts';
import { migrate } from '../store/schema.ts';
import { AuthService, hashToken } from './index.ts';
import { createInvitation, listInvitations, revokeInvitation, MAX_PENDING_INVITES } from './invitations.ts';

let dir: string;
let store: Store;
let auth: AuthService;
let logs: string[];
const epoch = 1_800_000_000_000;
beforeAll(sodiumReady);
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trine-invite-'));
  store = new Store(join(dir, 'relay.sqlite'));
  logs = [];
  // Even legacy "open" settings cannot bypass invitations.
  auth = new AuthService(store, loadConfig({ allowOpenRegistration: true }), (line) => logs.push(line));
});
afterEach(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

function enroll(token?: string, id = 'agent-a', now = epoch, key = generateSignKeyPair().publicKey) {
  return auth.register(id, 'agent', key, 'invitation', now, token);
}

describe('agent invitation trust boundary', () => {
  test('empty database rejects agents and clients; open switch is inert', () => {
    expect(enroll()).toEqual({ ok: false, error: 'registration_closed' });
    expect(auth.register('browser', 'client', generateSignKeyPair().publicKey, 'invitation')).toEqual({ ok: false, error: 'registration_closed' });
    expect(store.countDevices()).toBe(0);
  });

  test('hash-only storage, one agent per invite; same-identity retry needs no credential', async () => {
    const invite = createInvitation(store, 60_000, epoch);
    const keys = generateSignKeyPair();
    const row = store.db.query('SELECT * FROM agent_invitations').get();
    expect(JSON.stringify(row)).not.toContain(invite.token);
    expect(row).toMatchObject({ token_hash: hashToken(invite.token) });
    expect(enroll(invite.token, 'agent-a', epoch, keys.publicKey)).toEqual({ ok: true, value: { created: true } });
    expect(enroll(invite.token, 'agent-b')).toEqual({ ok: false, error: 'invalid_invitation' });
    expect(enroll(undefined, 'agent-a', epoch + 120_000, keys.publicKey)).toEqual({ ok: true, value: { created: false } });
    expect(listInvitations(store, epoch)).toHaveLength(0);
    expect(logs.join('\n')).not.toContain(invite.token);
    const app = createHttpApp({ auth, store, isAgentOnline: () => false, version: 'test' });
    const client = new AuthClient({ baseUrl: 'https://relay.example', deviceId: 'agent-a', signKeys: keys,
      fetchImpl: ((url, init) => app.request(String(url), init)) as typeof fetch });
    // Public-key knowledge and idempotent success still cannot mint auth tokens.
    const attacker = new AuthClient({ baseUrl: 'https://relay.example', deviceId: 'agent-a', signKeys: generateSignKeyPair(),
      fetchImpl: ((url, init) => app.request(String(url), init)) as typeof fetch });
    await expect(attacker.authenticate()).rejects.toMatchObject({ reason: 'bad_signature' });
    expect((await client.authenticate()).token).toBeTruthy();
  });

  test('expiration boundary, revocation and incorrect credentials never create a device', () => {
    const expired = createInvitation(store, 1000, epoch);
    expect(enroll(expired.token, 'expired', epoch + 1000)).toEqual({ ok: false, error: 'invalid_invitation' });
    const revoked = createInvitation(store, 1000, epoch);
    expect(revokeInvitation(store, revoked.id)).toBe(true);
    expect(revokeInvitation(store, revoked.id)).toBe(false);
    expect(enroll(revoked.token)).toEqual({ ok: false, error: 'invalid_invitation' });
    expect(enroll(randomToken(32))).toEqual({ ok: false, error: 'invalid_invitation' });
    expect(store.countDevices()).toBe(0);
  });

  test('invalid keys, clients, conflicting identity/role and revoked identities do not burn an invite', () => {
    const invite = createInvitation(store, 60_000, epoch);
    const keys = generateSignKeyPair();
    expect(enroll(invite.token, 'bad-key', epoch, 'invalid')).toEqual({ ok: false, error: 'invalid_public_key' });
    expect(auth.register('browser', 'client', keys.publicKey, 'invitation', epoch, invite.token)).toEqual({ ok: false, error: 'registration_closed' });
    store.registerDevice('existing', 'agent', keys.publicKey);
    expect(enroll(invite.token, 'existing')).toEqual({ ok: false, error: 'device_exists_with_other_key' });
    expect(auth.register('existing', 'client', keys.publicKey, 'invitation', epoch, invite.token)).toEqual({ ok: false, error: 'role_mismatch' });
    store.revokeDevice('existing');
    expect(enroll(invite.token, 'existing', epoch, keys.publicKey)).toEqual({ ok: false, error: 'device_revoked' });
    expect(auth.register('fake-pairing-agent', 'agent', keys.publicKey, 'pairing')).toEqual({ ok: false, error: 'role_mismatch' });
    expect(listInvitations(store, epoch)).toHaveLength(1);
    expect(enroll(invite.token).ok).toBe(true);
  });

  test('failed device write rolls back invitation consumption', () => {
    const invite = createInvitation(store, 60_000, epoch);
    store.db.exec("CREATE TRIGGER reject_device BEFORE INSERT ON devices BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
    expect(() => enroll(invite.token)).toThrow('synthetic failure');
    expect(listInvitations(store, epoch)).toHaveLength(1);
    store.db.exec('DROP TRIGGER reject_device');
    expect(enroll(invite.token).ok).toBe(true);
  });

  test('TTL and pending invite cap are bounded, expired rows can be replaced', () => {
    for (const ttl of [0, -1, NaN, Infinity, 999, 3_600_001]) expect(() => createInvitation(store, ttl, epoch)).toThrow();
    for (let i = 0; i < MAX_PENDING_INVITES; i++) createInvitation(store, 1000, epoch);
    expect(() => createInvitation(store, 1000, epoch)).toThrow('Too many');
    expect(createInvitation(store, 1000, epoch + 1000).token).toHaveLength(43);
    expect(listInvitations(store, epoch + 1000)).toHaveLength(1);
  });

  test('two OS processes redeeming the same invitation commit exactly one identity', async () => {
    const invite = createInvitation(store);
    const source = `
      import { Store } from ${JSON.stringify(new URL('../store/index.ts', import.meta.url).pathname)};
      import { AuthService } from ${JSON.stringify(new URL('./index.ts', import.meta.url).pathname)};
      import { loadConfig } from ${JSON.stringify(new URL('../config.ts', import.meta.url).pathname)};
      import { sodiumReady } from '@trine/core/crypto';
      await sodiumReady();
      const input = JSON.parse(await Bun.stdin.text());
      const store = new Store(input.db);
      const auth = new AuthService(store, loadConfig(), () => {});
      console.log(JSON.stringify(auth.register(input.id, 'agent', input.key, 'invitation', Date.now(), input.token)));
      store.close();
    `;
    const results = await Promise.all(['contender-a', 'contender-b'].map(async (id) => {
      const child = Bun.spawn([process.execPath, '-e', source], { cwd: new URL('../..', import.meta.url).pathname, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      child.stdin.write(JSON.stringify({ db: join(dir, 'relay.sqlite'), id, key: generateSignKeyPair().publicKey, token: invite.token }));
      child.stdin.end();
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return JSON.parse(output) as { ok: boolean; error?: string };
    }));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.error === 'invalid_invitation')).toHaveLength(1);
    expect(store.countDevices()).toBe(1);
  });

  test('v3 migration preserves device identity and auth tokens; no implicit enrollment grant', () => {
    const db = new Database(':memory:');
    migrate(db as never, { upTo: 3 });
    const keys = generateSignKeyPair();
    db.query('INSERT INTO devices (device_id, role, sign_pub_key, created_at) VALUES (?, ?, ?, ?)').run('legacy', 'agent', keys.publicKey, epoch);
    const token = randomToken(32);
    db.query('INSERT INTO auth_tokens VALUES (?, ?, ?, ?)').run(hashToken(token), 'legacy', epoch, epoch + 1000);
    const upgraded = new Store(db);
    try {
      const service = new AuthService(upgraded, loadConfig());
      expect(service.authenticateToken(token, epoch)).toEqual({ ok: true, value: { deviceId: 'legacy', role: 'agent' } });
      expect(upgraded.getDevice('legacy')?.signPubKey).toBe(keys.publicKey);
      expect(listInvitations(upgraded, epoch)).toHaveLength(0);
    } finally { upgraded.close(); }
  });
});

describe('public enrollment abuse limits', () => {
  test('bounded bodies, no-store, client role rejection and per-source budget', async () => {
    const app = createHttpApp({ auth, store, isAgentOnline: () => false, version: 'test', trustProxyHeader: false });
    const post = (body: string) => app.request('/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': crypto.randomUUID() }, body });
    expect((await post('x'.repeat(5000))).status).toBe(413);
    const invite = createInvitation(store);
    const body = JSON.stringify({ deviceId: 'browser', role: 'client', signPubKey: generateSignKeyPair().publicKey, invitation: invite.token });
    const first = await post(body);
    expect(first.status).toBe(403);
    expect(first.headers.get('cache-control')).toBe('no-store');
    for (let i = 1; i < 20; i++) expect((await post('{}')).status).toBe(400);
    expect((await post('{}')).status).toBe(429);
    expect(listInvitations(store)).toHaveLength(1);
  });

  test('rotating sources cannot bypass global quota or grow counters indefinitely', () => {
    for (let i = 0; i < 200; i++) expect(auth.allowRegistrationAttempt(`synthetic-${i}`, epoch)).toBe(true);
    expect(auth.allowRegistrationAttempt('new-source', epoch)).toBe(false);
    const count = () => (store.db.query("SELECT COUNT(*) AS n FROM auth_failures WHERE source LIKE 'registration:%'").get() as { n: number }).n;
    expect(count()).toBe(201);
    expect(auth.allowRegistrationAttempt('next-window', epoch + 60_000)).toBe(true);
    expect(count()).toBe(2);
  });
});

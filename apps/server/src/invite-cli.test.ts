import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store/index.ts';
import { hashToken } from './auth/index.ts';
let dir: string;
let db: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trine-invite-cli-'));
  db = join(dir, 'relay.sqlite');
  new Store(db).close();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, new URL('./invite-cli.ts', import.meta.url).pathname, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

test('local administrator can issue, list metadata and revoke without logging the credential', async () => {
  const created = await run(['create', '--db', db]);
  expect(created.exit).toBe(0);
  const token = created.stdout.trim();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(created.stderr).not.toContain(token);
  const store = new Store(db);
  try {
    expect(store.db.query('SELECT token_hash FROM agent_invitations').get()).toEqual({ token_hash: hashToken(token) });
    const listed = await run(['list', '--db', db]);
    expect(listed.exit).toBe(0);
    expect(listed.stdout).not.toContain(token);
    const [metadata] = JSON.parse(listed.stdout) as { id: string; expiresAt: number }[];
    expect(metadata!.expiresAt).toBeGreaterThan(Date.now());
    expect((await run(['revoke', metadata!.id, '--db', db])).exit).toBe(0);
    expect(store.db.query('SELECT * FROM agent_invitations').get()).toBeNull();
  } finally { store.close(); }
});

test('wrong database path is not created; invalid TTL prints no secret', async () => {
  const missing = join(dir, 'missing.sqlite');
  expect((await run(['create', '--db', missing])).exit).toBe(1);
  expect(await Bun.file(missing).exists()).toBe(false);
  const bad = await run(['create', '--db', db, '--ttl', '3601']);
  expect(bad.exit).toBe(1);
  expect(bad.stdout).toBe('');
});

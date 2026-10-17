import { Database } from 'bun:sqlite';
import { parseArgs } from 'node:util';
import { sodiumReady } from '@trine/core/crypto';
import { Store } from './store/index.ts';
import { SCHEMA_VERSION } from './store/schema.ts';
import { createInvitation, listInvitations, revokeInvitation } from './auth/invitations.ts';

export async function main(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    db: { type: 'string' }, ttl: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('agent:invite create|list|revoke ID --db PATH [--ttl SECONDS (1–3600; default 600)]\ncreate: secret on stdout once; ID/expiry on stderr. Use a private terminal or SSH pipe.');
    return;
  }
  const [command, id] = positionals;
  if (!values.db || !['create', 'list', 'revoke'].includes(command ?? '') ||
      positionals.length !== (command === 'revoke' ? 2 : 1) ||
      (values.ttl !== undefined && command !== 'create')) {
    throw new Error('Use agent:invite --help; --db must name the existing relay database');
  }
  // Never silently create a different database or migrate a running older relay.
  const db = new Database(values.db, { readwrite: true });
  const version = db.query('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version !== SCHEMA_VERSION) {
    db.close();
    throw new Error('Upgrade/start the matching relay first, then issue invitations');
  }
  const store = new Store(db);
  try {
    if (command === 'create') {
      await sodiumReady();
      const invite = createInvitation(store, values.ttl === undefined ? undefined : Number(values.ttl) * 1000);
      console.error(`Invitation ID: ${invite.id}; expires: ${new Date(invite.expiresAt).toISOString()}`);
      console.log(invite.token);
    } else if (command === 'list') {
      console.log(JSON.stringify(listInvitations(store), null, 2));
    } else {
      console.log(revokeInvitation(store, id!) ? 'Revoked' : 'Not pending (used, expired/cleaned, revoked or unknown)');
    }
  } finally {
    store.close();
  }
}

if (import.meta.main) main(process.argv.slice(2)).catch(() => {
  // Arguments may contain secrets pasted into the wrong field; do not echo them.
  console.error('Invitation command failed. Check --help, database access/version, TTL and pending invitation limit.');
  process.exitCode = 1;
});

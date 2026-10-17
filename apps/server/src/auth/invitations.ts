import { randomToken } from '@trine/core/crypto';
import type { Store } from '../store/index.ts';
import { hashToken } from './index.ts';

export const DEFAULT_INVITE_TTL_MS = 10 * 60_000;
export const MAX_INVITE_TTL_MS = 60 * 60_000;
export const MAX_PENDING_INVITES = 100;

/** Local administration only: possession of relay database access is the trust root. */
export function createInvitation(store: Store, ttlMs = DEFAULT_INVITE_TTL_MS, now = Date.now()) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > MAX_INVITE_TTL_MS) {
    throw new Error('Invitation TTL must be 1–3600 seconds');
  }
  return store.db.transaction(() => {
    store.db.query('DELETE FROM agent_invitations WHERE expires_at <= ?').run(now);
    const count = store.db.query('SELECT COUNT(*) AS n FROM agent_invitations').get() as { n: number };
    if (count.n >= MAX_PENDING_INVITES) throw new Error('Too many pending invitations; revoke unused invitations');
    const token = randomToken(32);
    const id = crypto.randomUUID();
    const expiresAt = now + ttlMs;
    store.db.query('INSERT INTO agent_invitations (id, token_hash, expires_at) VALUES (?, ?, ?)')
      .run(id, hashToken(token), expiresAt);
    return { id, token, expiresAt };
  }).immediate();
}

export function revokeInvitation(store: Store, id: string): boolean {
  return store.db.query('DELETE FROM agent_invitations WHERE id = ?').run(id).changes > 0;
}

export function listInvitations(store: Store, now = Date.now()): { id: string; expiresAt: number }[] {
  return store.db.query('SELECT id, expires_at AS expiresAt FROM agent_invitations WHERE expires_at > ? ORDER BY expires_at')
    .all(now) as { id: string; expiresAt: number }[];
}

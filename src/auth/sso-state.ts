import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../crypto.js';
import { query } from '../db/pool.js';

const MAX_AGE_MS = 10 * 60 * 1000;

/** Create an opaque login state whose tenant is held server-side, never in the browser. */
export async function createSsoLoginState(
  tenantId: number,
  now: () => number = Date.now,
): Promise<string> {
  const normalizedTenantId = Number(tenantId);
  if (!Number.isInteger(normalizedTenantId) || normalizedTenantId <= 0) {
    throw new Error('invalid tenant');
  }
  const token = randomBytes(32).toString('base64url');
  await query(
    `DELETE FROM sso_login_states
      WHERE expires_at < now() - interval '1 day'
         OR consumed_at < now() - interval '1 day'`,
  );
  await query(
    `INSERT INTO sso_login_states (token_hash,tenant_id,expires_at)
     VALUES ($1,$2,$3)`,
    [sha256Hex(token), normalizedTenantId, new Date(now() + MAX_AGE_MS)],
  );
  return token;
}

/** Atomically resolve and consume a login state exactly once. */
export async function consumeSsoLoginState(token: string): Promise<number | null> {
  if (!token) return null;
  const { rows } = await query<{ tenant_id: number }>(
    `UPDATE sso_login_states
        SET consumed_at=now()
      WHERE token_hash=$1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING tenant_id`,
    [sha256Hex(token)],
  );
  return rows[0] ? Number(rows[0].tenant_id) : null;
}

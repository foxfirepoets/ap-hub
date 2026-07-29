import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../crypto.js';
import { query } from '../db/pool.js';

export type ConnectProvider = 'gmail' | 'qbo' | 'xero';
const MAX_AGE_MS = 5 * 60 * 1000;

export interface ConnectStateActor {
  tenantId: number;
  userId: number;
  sessionId: number;
  email?: string;
}

/** Mint an opaque, persistent OAuth state bound to the initiating authenticated session. */
export async function createConnectState(
  actor: ConnectStateActor,
  provider: ConnectProvider,
  now: () => number = Date.now,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now() + MAX_AGE_MS);
  await query(
    `DELETE FROM oauth_connect_states
      WHERE expires_at < now() - interval '1 day'
         OR consumed_at < now() - interval '1 day'`,
  );
  await query(
    `INSERT INTO oauth_connect_states
       (token_hash, tenant_id, user_id, session_id, provider, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [sha256Hex(token), actor.tenantId, actor.userId, actor.sessionId, provider, expiresAt],
  );
  return token;
}

/**
 * Atomically consume a state exactly once. The join revalidates the initiating
 * session and user at callback time, so logout, expiry, disablement, or deletion
 * invalidates an otherwise unexpired state.
 */
export async function consumeConnectState(
  token: string,
  provider: ConnectProvider,
  expectedSessionId: number,
): Promise<ConnectStateActor | null> {
  if (!token || !Number.isInteger(expectedSessionId) || expectedSessionId <= 0) return null;
  const { rows } = await query<ConnectStateActor>(
    `UPDATE oauth_connect_states cs
        SET consumed_at=now()
       FROM sessions s, users u
      WHERE cs.token_hash=$1
        AND cs.provider=$2
        AND cs.session_id=$3
        AND cs.consumed_at IS NULL
        AND cs.expires_at > now()
        AND s.id=cs.session_id
        AND s.user_id=cs.user_id
        AND s.revoked=false
        AND s.expires_at > now()
        AND u.id=cs.user_id
        AND u.tenant_id=cs.tenant_id
        AND u.status='active'
      RETURNING cs.tenant_id AS "tenantId",
                cs.user_id AS "userId",
                cs.session_id AS "sessionId",
                u.email`,
    [sha256Hex(token), provider, expectedSessionId],
  );
  const row = rows[0];
  return row
    ? {
        tenantId: Number(row.tenantId),
        userId: Number(row.userId),
        sessionId: Number(row.sessionId),
        email: row.email,
      }
    : null;
}

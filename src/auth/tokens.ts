import { query } from '../db/pool.js';
import { encrypt, decrypt } from '../crypto.js';
import { config } from '../config.js';

/**
 * Encrypted OAuth token store (CHUNK_2). Access + refresh tokens are AES-256-GCM
 * encrypted at rest. This module only reads/writes rows; token refresh itself lives
 * in `qbo-refresh.ts` (QBO) and googleapis (Gmail). When `refreshQboToken` runs it
 * calls `saveToken` here, so the newest rotated refresh token replaces the old one.
 */

export type Provider = 'gmail' | 'qbo' | 'xero' | 'sage_intacct' | 'qbd';

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  scope: string | null;
  realm: string | null;
}

export async function saveToken(
  tenantId: number,
  provider: Provider,
  tok: StoredToken,
): Promise<void> {
  const key = config().ENCRYPTION_KEY;
  await query(
    `INSERT INTO oauth_tokens (tenant_id, provider, access_token_enc, refresh_token_enc, expires_at, scope, realm, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (tenant_id, provider) DO UPDATE SET
       access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       expires_at = EXCLUDED.expires_at,
       scope = EXCLUDED.scope,
       realm = EXCLUDED.realm,
       updated_at = now()`,
    [
      tenantId,
      provider,
      encrypt(tok.accessToken, key),
      encrypt(tok.refreshToken, key),
      tok.expiresAt,
      tok.scope,
      tok.realm,
    ],
  );
}

export async function loadToken(
  tenantId: number,
  provider: Provider,
): Promise<StoredToken | null> {
  const key = config().ENCRYPTION_KEY;
  const { rows } = await query<{
    access_token_enc: string;
    refresh_token_enc: string;
    expires_at: Date | null;
    scope: string | null;
    realm: string | null;
  }>(
    `SELECT access_token_enc, refresh_token_enc, expires_at, scope, realm
     FROM oauth_tokens WHERE tenant_id=$1 AND provider=$2`,
    [tenantId, provider],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    accessToken: decrypt(row.access_token_enc, key),
    refreshToken: decrypt(row.refresh_token_enc, key),
    expiresAt: row.expires_at,
    scope: row.scope,
    realm: row.realm,
  };
}

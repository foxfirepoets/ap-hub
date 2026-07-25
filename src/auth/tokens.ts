import { query, withTransaction } from '../db/pool.js';
import { encrypt, decrypt, verifySecretMaterial } from '../crypto.js';
import { config } from '../config.js';
import type { SecretStore } from '../host/types.js';
import { assertCredentialTarget } from '../host/types.js';
import { migrateLegacySecret } from '../host/secret-migration.js';

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

export interface TokenSecretAuthority {
  store: SecretStore;
  installId: string;
}

let tokenSecretAuthority: TokenSecretAuthority | null = null;

/** Runtime composition hook. Tests and the Windows host inject the task-2 store. */
export function configureTokenSecretAuthority(authority: TokenSecretAuthority | null): void {
  tokenSecretAuthority = authority;
}

function credentialTarget(
  authority: TokenSecretAuthority,
  tenantId: number,
  provider: Provider,
): string {
  const target = `APHub/${authority.installId}/${provider}.oauth.${tenantId}`;
  assertCredentialTarget(target);
  return target;
}

function serializeToken(tok: StoredToken): string {
  return JSON.stringify({
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken,
    expiresAt: tok.expiresAt?.toISOString() ?? null,
    scope: tok.scope,
    realm: tok.realm,
  });
}

function deserializeToken(value: string): StoredToken {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string') {
      throw new Error();
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: typeof parsed.expiresAt === 'string' ? new Date(parsed.expiresAt) : null,
      scope: typeof parsed.scope === 'string' ? parsed.scope : null,
      realm: typeof parsed.realm === 'string' ? parsed.realm : null,
    };
  } catch {
    throw new Error('TOKEN_CREDENTIAL_INVALID');
  }
}

function tokenMetadata(tok: StoredToken): Record<string, unknown> {
  return {
    ...(tok.scope ? { scope: tok.scope.split(/\s+/).filter(Boolean) } : {}),
    ...(tok.expiresAt ? { expires_at: tok.expiresAt.toISOString() } : {}),
    ...(tok.realm ? { provider_account_id: tok.realm } : {}),
    last_refresh_status: { state: 'healthy', attempts: 0, checked_at: new Date().toISOString() },
  };
}

export async function saveToken(
  tenantId: number,
  provider: Provider,
  tok: StoredToken,
): Promise<void> {
  if (tokenSecretAuthority) {
    const authority = tokenSecretAuthority;
    const target = credentialTarget(authority, tenantId, provider);
    const material = serializeToken(tok);
    await authority.store.put(target, material);
    const readBack = await authority.store.get(target);
    if (readBack === null || !verifySecretMaterial(material, readBack)) {
      throw new Error('TOKEN_CREDENTIAL_VERIFICATION_FAILED');
    }
    await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `oauth:${tenantId}:${provider}`,
      ]);
      await client.query(
        `INSERT INTO credential_refs (tenant_id, provider, purpose, credential_target, metadata)
         VALUES ($1,$2,'oauth_tokens',$3,$4::jsonb)
         ON CONFLICT (tenant_id, provider, purpose) DO UPDATE SET
           credential_target=EXCLUDED.credential_target,
           metadata=EXCLUDED.metadata,
           updated_at=now()`,
        [tenantId, provider, target, JSON.stringify(tokenMetadata(tok))],
      );
      await client.query('DELETE FROM oauth_tokens WHERE tenant_id=$1 AND provider=$2', [
        tenantId,
        provider,
      ]);
    });
    return;
  }
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
  const ref = await query<{ credential_target: string }>(
    `SELECT credential_target FROM credential_refs
     WHERE tenant_id=$1 AND provider=$2 AND purpose='oauth_tokens'`,
    [tenantId, provider],
  );
  if (ref.rows[0]) {
    if (!tokenSecretAuthority) throw new Error('TOKEN_CREDENTIAL_STORE_UNAVAILABLE');
    const material = await tokenSecretAuthority.store.get(ref.rows[0].credential_target);
    if (material === null) throw new Error('TOKEN_CREDENTIAL_MISSING');
    return deserializeToken(material);
  }
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

/** Idempotent cutover for one existing encrypted OAuth row. */
export async function migrateLegacyOAuthToken(
  tenantId: number,
  provider: Provider,
  authority: TokenSecretAuthority = tokenSecretAuthority as TokenSecretAuthority,
  verify?: (expected: string, actual: string) => boolean | Promise<boolean>,
): Promise<'migrated' | 'absent'> {
  if (!authority) throw new Error('TOKEN_CREDENTIAL_STORE_UNAVAILABLE');
  const target = credentialTarget(authority, tenantId, provider);
  let token: StoredToken | null = null;
  return migrateLegacySecret({
    lockKey: `oauth:${tenantId}:${provider}`,
    target,
    store: authority.store,
    verify,
    async readLegacy(client) {
      const { rows } = await client.query<{
        access_token_enc: string;
        refresh_token_enc: string;
        expires_at: Date | null;
        scope: string | null;
        realm: string | null;
      }>(
        `SELECT access_token_enc, refresh_token_enc, expires_at, scope, realm
         FROM oauth_tokens WHERE tenant_id=$1 AND provider=$2 FOR UPDATE`,
        [tenantId, provider],
      );
      if (!rows[0]) return null;
      const key = config().ENCRYPTION_KEY;
      token = {
        accessToken: decrypt(rows[0].access_token_enc, key),
        refreshToken: decrypt(rows[0].refresh_token_enc, key),
        expiresAt: rows[0].expires_at,
        scope: rows[0].scope,
        realm: rows[0].realm,
      };
      return serializeToken(token);
    },
    async persistReference(client) {
      if (!token) throw new Error('SECRET_MIGRATION_FAILED');
      await client.query(
        `INSERT INTO credential_refs (tenant_id, provider, purpose, credential_target, metadata)
         VALUES ($1,$2,'oauth_tokens',$3,$4::jsonb)
         ON CONFLICT (tenant_id, provider, purpose) DO UPDATE SET
           credential_target=EXCLUDED.credential_target,
           metadata=EXCLUDED.metadata,
           updated_at=now()`,
        [tenantId, provider, target, JSON.stringify(tokenMetadata(token))],
      );
    },
    async deleteLegacy(client) {
      await client.query('DELETE FROM oauth_tokens WHERE tenant_id=$1 AND provider=$2', [
        tenantId,
        provider,
      ]);
    },
  });
}

/**
 * Production startup composition: install the Windows authority first, then
 * resume every outstanding per-tenant OAuth cutover. A failed row aborts boot
 * with its legacy ciphertext transactionally preserved.
 */
export async function initializeTokenCredentialAuthority(
  authority: TokenSecretAuthority,
): Promise<void> {
  configureTokenSecretAuthority(authority);
  const { rows } = await query<{ tenant_id: number; provider: Provider }>(
    `SELECT tenant_id, provider FROM oauth_tokens ORDER BY tenant_id, provider`,
  );
  for (const row of rows) {
    await migrateLegacyOAuthToken(row.tenant_id, row.provider, authority);
  }
}

/**
 * F5 seam (migration 006 `connections` table). Real OAuth completion for a cloud
 * provider (qbo today) must leave a `connections` row so `findActiveConnectionForTenant`
 * (src/mapping/dimensionMappingStore.ts) can resolve it for tax/dimension gating —
 * without this, those gates hold forever for real tenants (connections stays empty
 * outside tests). Upsert on the table's natural key (tenant_id, provider,
 * external_company) so a reconnect of the same company is idempotent, not a duplicate.
 */
export async function upsertConnection(
  tenantId: number,
  provider: Provider,
  externalCompany: string,
): Promise<void> {
  await query(
    `INSERT INTO connections (tenant_id, provider, connection_class, external_company, status)
     VALUES ($1, $2, 'cloud', $3, 'active')
     ON CONFLICT (tenant_id, provider, external_company) DO UPDATE SET
       status = 'active',
       updated_at = now()`,
    [tenantId, provider, externalCompany],
  );
}

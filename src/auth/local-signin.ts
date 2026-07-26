import { withTransaction, query } from '../db/pool.js';
import { createSession, type NewSession } from './session.js';
import { writeAudit } from '../audit.js';

/**
 * Local sign-in (CHUNK_4_IDENTITY) — the product's entry point, replacing Google SSO.
 *
 * The OS account that already authenticated the user IS the product's identity: no password,
 * no browser tab, no invitation. `osAccountId` is the stable identifier the host adapter
 * resolves (the Windows SID); it is stored in the existing `users.google_sub` column, reused
 * rather than migrated — that column already means "the external identity subject for this
 * row", and Version 1 has exactly one external identity source at a time. No schema change.
 *
 * First launch for a given OS account creates its own tenant and its own owner row: there is
 * no invite gate, because nobody else can reach this computer's private install to be invited
 * into it. Every later launch finds that same row by `osAccountId` and reuses it, refreshing
 * the display name in case the Windows account was renamed. A disabled owner stays disabled —
 * local sign-in never re-activates a row a human has turned off.
 *
 * Tenant and role authorization are entirely unchanged: this only ever produces the same
 * `AuthContext` shape (`src/auth/guard.ts`) that Google SSO used to, resolved the same way, by
 * `requireSession` reading the session it creates. Nothing downstream can tell the difference.
 */

export interface LocalSignInResult {
  userId: number;
  tenantId: number;
  role: string;
  /** True when this call just created the tenant and owner — the second-OS-account UI hook. */
  isFirstRun: boolean;
  session: NewSession;
}

interface OwnerRow {
  id: number;
  tenant_id: number;
  role: string;
  status: string;
}

async function findOwner(osAccountId: string): Promise<OwnerRow | null> {
  const { rows } = await query<OwnerRow>(
    `SELECT id, tenant_id, role, status FROM users WHERE google_sub = $1 AND role = 'owner_controller' LIMIT 1`,
    [osAccountId],
  );
  return rows[0] ?? null;
}

/**
 * First launch for this OS account: its own tenant and its own owner row, created together so
 * neither can exist without the other. `displayName` is a plain label only (e.g. the Windows
 * account name) — never shown as, or validated as, an email address.
 */
async function createTenantAndOwner(osAccountId: string, displayName: string): Promise<OwnerRow> {
  return withTransaction(async (client) => {
    const t = await client.query<{ id: number }>(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [
      'My Business',
    ]);
    const tenantId = t.rows[0]!.id;
    const u = await client.query<OwnerRow>(
      `INSERT INTO users (tenant_id, email, name, role, status, google_sub)
       VALUES ($1, $2, $3, 'owner_controller', 'active', $4)
       RETURNING id, tenant_id, role, status`,
      [tenantId, displayName, displayName, osAccountId],
    );
    await writeAudit(
      {
        tenantId,
        actor: `os-account:${osAccountId}`,
        action: 'tenant.bootstrap',
        entity: `tenant:${tenantId}`,
      },
      client,
    );
    return u.rows[0]!;
  });
}

/** Refresh the display label on every launch — a Windows account can be renamed. */
async function touchOwner(userId: number, displayName: string): Promise<void> {
  await query(`UPDATE users SET name = $2, email = $2 WHERE id = $1`, [userId, displayName]);
}

export class LocalSignInDisabled extends Error {
  constructor() {
    super('this account has been disabled');
    this.name = 'LocalSignInDisabled';
  }
}

/**
 * Resolve (or create) the owner row for this OS account and mint a session for it.
 *
 * Strictly scoped by `osAccountId`: a row belonging to a different account is never matched,
 * reused or exposed, regardless of what else exists in the database — the isolation guarantee
 * does not depend on there being only one account's data present.
 */
export async function localSignIn(osAccountId: string, displayName: string): Promise<LocalSignInResult> {
  if (!osAccountId) throw new Error('local sign-in requires an OS account id');

  const existing = await findOwner(osAccountId);
  let owner: OwnerRow;
  let isFirstRun: boolean;
  if (existing) {
    if (existing.status !== 'active') throw new LocalSignInDisabled();
    await touchOwner(existing.id, displayName);
    owner = existing;
    isFirstRun = false;
  } else {
    owner = await createTenantAndOwner(osAccountId, displayName);
    isFirstRun = true;
  }

  const session = await createSession(owner.id);
  await writeAudit({
    tenantId: owner.tenant_id,
    actor: `os-account:${osAccountId}`,
    action: 'auth.local_signin',
    entity: `user:${owner.id}`,
  });

  return { userId: owner.id, tenantId: owner.tenant_id, role: owner.role, isFirstRun, session };
}

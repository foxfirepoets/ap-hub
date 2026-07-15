import { withTransaction } from '../db/pool.js';
import { writeAudit } from '../audit.js';
import { ServiceError } from './index.js';

/**
 * First-owner tenant provisioning (gap flagged by HKO-audit remediation, see
 * ralph-northstar-ux/.ralph/state.md). SSO login is invite-gated / UPDATE-only
 * (src/auth/google-sso.ts activateUserForLogin) and never auto-creates a tenant
 * or user — so a brand-new tenant needs an out-of-band path to create its first
 * user before anyone can log in at all. This is that path: CLI-only (the `cli
 * bootstrap-tenant` command), never reachable from a public/HTTP route, since no
 * session can exist yet to authorize it. The created user is 'invited'; its
 * first Google login activates it via the existing completeLogin flow.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface BootstrapTenantInput {
  tenantName: string;
  ownerEmail: string;
  ownerName?: string;
}

export interface BootstrapTenantResult {
  tenantId: number;
  userId: number;
  ownerEmail: string;
}

export async function bootstrapTenant(input: BootstrapTenantInput): Promise<BootstrapTenantResult> {
  const tenantName = input.tenantName.trim();
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  if (!tenantName) throw new ServiceError('VALIDATION', 'tenant name is required');
  if (!EMAIL_RE.test(ownerEmail)) throw new ServiceError('VALIDATION', 'invalid owner email');

  return withTransaction(async (client) => {
    const t = await client.query<{ id: number }>(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [tenantName],
    );
    const tenantId = t.rows[0]!.id;
    const u = await client.query<{ id: number }>(
      `INSERT INTO users (tenant_id, email, name, role, status)
       VALUES ($1, $2, $3, 'owner_controller', 'invited') RETURNING id`,
      [tenantId, ownerEmail, input.ownerName?.trim() || null],
    );
    const userId = u.rows[0]!.id;
    await writeAudit(
      {
        tenantId,
        actor: 'cli:bootstrap-tenant',
        action: 'tenant.bootstrap',
        entity: `tenant:${tenantId}`,
        detail: { ownerEmail },
      },
      client,
    );
    return { tenantId, userId, ownerEmail };
  });
}

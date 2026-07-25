import { config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { writeAudit } from '../audit.js';
import { actorLabel, assertEntityId, ensurePermission, ServiceError, type ActorContext } from '../services/index.js';

export async function setOwnerWriteGate(
  ctx: ActorContext,
  connectionId: number,
  input: { enabled: boolean; confirmedCompanyId: string; backupConfirmed: boolean; confirmation: string },
): Promise<{ enabled: boolean }> {
  ensurePermission(ctx, 'onboard');
  assertEntityId(connectionId);
  if (input.confirmation !== 'ENABLE WRITES' && input.enabled) {
    throw new ServiceError('VALIDATION', 'type ENABLE WRITES to confirm');
  }
  const companyId = input.confirmedCompanyId.trim();
  if (input.enabled && (!companyId || !input.backupConfirmed)) {
    throw new ServiceError('VALIDATION', 'exact company identity and verified backup are required');
  }
  const cfg = config();
  return withTransaction(async (client) => {
    const row = (await client.query<{
      provider: string; external_company: string | null; status: string; metadata: Record<string, unknown>;
    }>(
      `SELECT provider,external_company,status,metadata FROM connections
        WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [ctx.tenantId, connectionId],
    )).rows[0];
    if (!row) throw new ServiceError('connection_not_found');
    if (!['qbo', 'qbd'].includes(row.provider) || row.status !== 'active') {
      throw new ServiceError('VALIDATION', 'an active supported QuickBooks connection is required');
    }
    const expected = row.provider === 'qbd'
      ? String(row.metadata.expectedCompanyId ?? row.external_company ?? '')
      : String(row.external_company ?? '');
    if (input.enabled && companyId !== expected) throw new ServiceError('VALIDATION', 'company identity does not match');
    if (input.enabled && row.provider === 'qbo' && cfg.QBO_ENV === 'production' &&
      (!cfg.QBO_PRODUCTION_WRITE_ENABLED || cfg.QBO_PRODUCTION_REALM_ID !== companyId)) {
      throw new ServiceError('VALIDATION', 'QBO production master switch and exact realm must be configured first');
    }
    if (input.enabled && row.provider === 'qbd' &&
      (!cfg.QB_DESKTOP_ENABLED || !cfg.QB_DESKTOP_WRITE_ENABLED ||
       Number(cfg.QB_DESKTOP_TENANT_ID) !== ctx.tenantId ||
       Number(cfg.QB_DESKTOP_CONNECTION_ID) !== connectionId ||
       cfg.QB_DESKTOP_COMPANY_ID !== companyId ||
       row.metadata.observedCompanyId !== companyId)) {
      throw new ServiceError('VALIDATION', 'Desktop master switch, connection binding, and observed company must match first');
    }
    const gate = input.enabled ? {
      enabled: true, confirmedCompanyId: companyId, backupConfirmedAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(), confirmedBy: ctx.userId,
    } : { enabled: false, disabledAt: new Date().toISOString(), disabledBy: ctx.userId };
    await client.query(
      `UPDATE connections SET metadata=COALESCE(metadata,'{}'::jsonb) || $3::jsonb,updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [ctx.tenantId, connectionId, JSON.stringify({ ownerWriteGate: gate })],
    );
    await writeAudit({
      tenantId: ctx.tenantId, actor: actorLabel(ctx), action: input.enabled ? 'provider.write_gate_enabled' : 'provider.write_gate_disabled',
      entity: `connection:${connectionId}`,
      detail: { role: ctx.role, provider: row.provider, companyId, backupConfirmed: input.enabled },
    }, client);
    return { enabled: input.enabled };
  });
}

export function ownerGateEnabled(metadata: Record<string, unknown>, companyId: string): boolean {
  const gate = metadata.ownerWriteGate;
  return Boolean(gate && typeof gate === 'object' &&
    (gate as Record<string, unknown>).enabled === true &&
    (gate as Record<string, unknown>).confirmedCompanyId === companyId &&
    typeof (gate as Record<string, unknown>).backupConfirmedAt === 'string');
}

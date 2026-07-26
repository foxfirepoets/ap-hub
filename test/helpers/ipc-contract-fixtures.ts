import { query } from '../../src/db/pool.js';

/**
 * B6 — fixtures for `test/ipc-contract.test.ts` ONLY.
 *
 * `test/helpers.ts` already covers the common tables (tenants, users, connections, messages,
 * attachments, extractions, proposals, dimension_mappings). This file adds the remaining tables
 * the 50-channel cross-tenant replay needs, each insert taking a `marker` string that lands in a
 * column the channel's response would actually surface — so a leak shows up as a literal
 * substring in the envelope, not merely as a changed `ok` flag.
 *
 * Every id here is unique per test run (`uniqueMarker`), because the database is shared across
 * concurrently running worktree suites (integration lead's note): a fixed literal like
 * `'sha-1'` would collide with another suite's row and turn a real assertion into a false
 * positive or a false negative.
 */

let counter = 0;

/** A value that will not collide with another concurrently running suite's fixtures. */
export function uniqueMarker(label: string): string {
  counter += 1;
  return `ZZ-${label}-${process.pid}-${Date.now()}-${counter}-${Math.random().toString(36).slice(2)}`;
}

export async function insertMarkedProposal(
  tenantId: number,
  opts: { status?: string; vendorName?: string; totalAmt?: number; docNumber?: string } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO proposals (tenant_id, proposed_txn, confidence, status)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [
      tenantId,
      JSON.stringify({
        vendorRef: { name: opts.vendorName ?? 'Unmarked Vendor' },
        TotalAmt: opts.totalAmt ?? 100,
        DocNumber: opts.docNumber ?? 'INV-1',
      }),
      0.9,
      opts.status ?? 'review',
    ],
  );
  return rows[0]!.id;
}

export async function insertMarkedException(
  tenantId: number,
  opts: { entityRef?: string; reasonCode?: string } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO exceptions (tenant_id, entity_ref, reason_code, status)
     VALUES ($1,$2,$3,'open') RETURNING id`,
    [tenantId, opts.entityRef ?? 'unmarked-entity-ref', opts.reasonCode ?? 'no_vendor_match'],
  );
  return rows[0]!.id;
}

export async function insertMarkedNotification(
  tenantId: number,
  opts: { marker?: string; kind?: string } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO notifications (tenant_id, kind, severity, payload)
     VALUES ($1,$2,'info',$3) RETURNING id`,
    [tenantId, opts.kind ?? 'risk_alert', JSON.stringify({ marker: opts.marker ?? 'unmarked' })],
  );
  return rows[0]!.id;
}

export async function insertMarkedAccountingDocument(
  tenantId: number,
  messageId: number,
  opts: { kind?: 'invoice' | 'bank_statement' | 'unknown'; status?: string; holdReason?: string; sha256?: string } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO accounting_documents (tenant_id, message_id, kind, sha256, status, hold_reason)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      tenantId,
      messageId,
      opts.kind ?? 'unknown',
      opts.sha256 ?? uniqueMarker('doc-sha'),
      opts.status ?? 'held',
      opts.holdReason ?? null,
    ],
  );
  return rows[0]!.id;
}

export async function insertMarkedBankStatement(
  tenantId: number,
  documentId: number,
  opts: { institutionName?: string } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO bank_statements
       (tenant_id, document_id, institution_name, period_start, period_end, opening_balance, closing_balance, status)
     VALUES ($1,$2,$3,'2026-01-01','2026-01-31',0,0,'review') RETURNING id`,
    [tenantId, documentId, opts.institutionName ?? 'Unmarked Bank'],
  );
  return rows[0]!.id;
}

export async function insertMarkedBankStatementLine(
  tenantId: number,
  statementId: number,
  opts: { description?: string; lineNo?: number; amount?: number } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO bank_statement_lines (tenant_id, statement_id, line_no, description, amount, fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      tenantId,
      statementId,
      opts.lineNo ?? 1,
      opts.description ?? 'Unmarked line',
      opts.amount ?? 10,
      uniqueMarker('line-fp'),
    ],
  );
  return rows[0]!.id;
}

export async function insertMarkedReplyDraft(
  tenantId: number,
  messageId: number,
  createdBy: number,
  opts: { subject?: string; threadId?: string; toAddr?: string } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO reply_drafts (tenant_id, message_id, thread_id, to_addr, subject, body_text, created_by)
     VALUES ($1,$2,$3,$4,$5,'body',$6) RETURNING id`,
    [
      tenantId,
      messageId,
      opts.threadId ?? uniqueMarker('thread'),
      opts.toAddr ?? 'vendor@example.com',
      opts.subject ?? 'Unmarked draft',
      createdBy,
    ],
  );
  return rows[0]!.id;
}

export async function insertMarkedForward(
  tenantId: number,
  messageId: number,
  opts: { subjectTag?: string; status?: string } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO forwards (tenant_id, message_id, sha256, status, subject_tag)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tenantId, messageId, uniqueMarker('fwd-sha'), opts.status ?? 'held', opts.subjectTag ?? uniqueMarker('subj-tag')],
  );
  return rows[0]!.id;
}

export async function insertMarkedTaxMapping(
  tenantId: number,
  connectionId: number,
  opts: { providerTaxCode?: string; active?: boolean } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO tax_mappings
       (tenant_id, connection_id, provider, provider_tax_code, internal_tax_treatment, tax_mode, active)
     VALUES ($1,$2,'qbo',$3,'standard','exclusive',$4) RETURNING id`,
    [tenantId, connectionId, opts.providerTaxCode ?? 'UNMARKED-CODE', opts.active ?? true],
  );
  return rows[0]!.id;
}

export async function insertMarkedTaxMappingAudit(
  tenantId: number,
  taxMappingId: number,
  connectionId: number,
  opts: { reason?: string } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO tax_mapping_audit (tenant_id, tax_mapping_id, connection_id, provider, action, reason)
     VALUES ($1,$2,$3,'qbo','create',$4) RETURNING id`,
    [tenantId, taxMappingId, connectionId, opts.reason ?? 'unmarked-audit-reason'],
  );
  return rows[0]!.id;
}

export async function insertMarkedProviderJob(
  tenantId: number,
  connectionId: number,
  opts: { status?: string; idempotencyKey?: string } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO provider_jobs (tenant_id, connection_id, operation, request_payload, status, idempotency_key)
     VALUES ($1,$2,'query',$3,$4,$5) RETURNING id`,
    [
      tenantId,
      connectionId,
      JSON.stringify({ marker: 'unmarked-job' }),
      opts.status ?? 'failed',
      opts.idempotencyKey ?? uniqueMarker('job-idem'),
    ],
  );
  return rows[0]!.id;
}

/** Opens the DRY_RUN_LOCKED gate (`assertNotDryRunLocked`) so `aphub:proposals:approve`/`:retry`
 * role and cross-tenant assertions are not masked by the onboarding business rule, which
 * `normalizeCode` maps onto the SAME `FORBIDDEN` code as an RBAC refusal. */
export async function openDryRunGate(tenantId: number): Promise<void> {
  await query(
    `INSERT INTO onboarding_state (tenant_id, automation_level)
     VALUES ($1, 'assisted')
     ON CONFLICT (tenant_id) DO UPDATE SET automation_level = 'assisted'`,
    [tenantId],
  );
}

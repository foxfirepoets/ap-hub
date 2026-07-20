import { query, closePool } from '../src/db/pool.js';

/** Truncate all domain tables between tests (keeps schema + _migrations). */
export async function resetTables(): Promise<void> {
  // `postings_ap` is the base table (migration 006); `postings` is a back-compat view
  // over it, so TRUNCATE targets the base table. `connections` is truncated too.
  await query(`
    TRUNCATE sessions, users, forwards, proof_refs, postings_ap, reconciliation, corrections,
             exceptions, proposals, extractions, mappings, attachments, attachment_blobs,
             messages, oauth_tokens, audit_log, llm_calls, notifications, connections, tenants RESTART IDENTITY CASCADE;
  `);
}

export async function createTenant(name = 'Test Co'): Promise<number> {
  const { rows } = await query<{ id: number }>(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [name],
  );
  return rows[0]!.id;
}

export async function createUser(
  tenantId: number,
  opts: { email?: string; role?: string; status?: string; googleSub?: string; name?: string } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO users (tenant_id, email, name, role, google_sub, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      tenantId,
      opts.email ?? `user-${Math.floor(performance.now() * 1000)}@example.com`,
      opts.name ?? 'Test User',
      opts.role ?? 'owner_controller',
      opts.googleSub ?? `sub-${Math.floor(performance.now() * 1000)}`,
      opts.status ?? 'active',
    ],
  );
  return rows[0]!.id;
}

export async function createConnection(
  tenantId: number,
  opts: { provider?: string; connectionClass?: string; externalCompany?: string; status?: string } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO connections (tenant_id, provider, connection_class, external_company, status)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [
      tenantId,
      opts.provider ?? 'qbo',
      opts.connectionClass ?? 'cloud',
      opts.externalCompany ?? `co-${Math.floor(performance.now() * 1000)}`,
      opts.status ?? 'active',
    ],
  );
  return rows[0]!.id;
}

export async function insertMessage(
  tenantId: number,
  opts: { gmailId?: string; subject?: string; from?: string; bodyOnly?: boolean } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO messages (tenant_id, gmail_message_id, subject, from_addr, body_only, status)
     VALUES ($1,$2,$3,$4,$5,'ingested') RETURNING id`,
    [
      tenantId,
      opts.gmailId ?? `gm-${Math.floor(performance.now() * 1000)}`,
      opts.subject ?? 'Invoice from Acme',
      opts.from ?? 'billing@acme.com',
      opts.bodyOnly ?? false,
    ],
  );
  return rows[0]!.id;
}

export async function insertAttachment(
  tenantId: number,
  messageId: number,
  opts: { sha256?: string; mime?: string; filename?: string } = {},
): Promise<number> {
  const sha = opts.sha256 ?? `sha-${Math.floor(performance.now() * 1000)}`;
  await query(
    `INSERT INTO attachment_blobs (sha256, bytes, mime, size) VALUES ($1,$2,$3,$4)
     ON CONFLICT (sha256) DO NOTHING`,
    [sha, Buffer.from('%PDF-1.4 test'), opts.mime ?? 'application/pdf', 12],
  );
  const { rows } = await query<{ id: number }>(
    `INSERT INTO attachments (tenant_id, message_id, filename, mime, sha256, storage_key, size)
     VALUES ($1,$2,$3,$4,$5,$5,$6) RETURNING id`,
    [tenantId, messageId, opts.filename ?? 'invoice.pdf', opts.mime ?? 'application/pdf', sha, 12],
  );
  return rows[0]!.id;
}

export async function insertExtraction(
  tenantId: number,
  messageId: number,
  attachmentId: number | null,
  fields: Record<string, unknown>,
  confidence = 0.95,
): Promise<number> {
  const full = {
    vendor_name: 'Acme',
    invoice_number: 'INV-1',
    invoice_date: '2026-07-01',
    due_date: null,
    total: 100,
    tax: 0,
    line_items: [{ description: 'work', amount: 100 }],
    doc_type: 'invoice',
    direction: 'AP',
    field_confidence: {},
    confidence,
    missing_fields: [],
    flags: [],
    ...fields,
  };
  const { rows } = await query<{ id: number }>(
    `INSERT INTO extractions (tenant_id, attachment_id, message_id, fields, confidence, missing_fields, flags, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'test') RETURNING id`,
    [tenantId, attachmentId, messageId, JSON.stringify(full), confidence, full.missing_fields, full.flags],
  );
  return rows[0]!.id;
}

export async function insertProposal(
  tenantId: number,
  opts: { attachmentId?: number | null; extractionId?: number | null; confidence?: number; status?: string } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO proposals (tenant_id, attachment_id, extraction_id, proposed_txn, confidence, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      tenantId,
      opts.attachmentId ?? null,
      opts.extractionId ?? null,
      JSON.stringify({}),
      opts.confidence ?? 0.9,
      opts.status ?? 'review',
    ],
  );
  return rows[0]!.id;
}

/** F_DIMENSION_MAPPING_API fixture: dimension_mappings rows come from the extraction
 * pipeline (there is no create-via-API endpoint), so tests insert them directly. */
export async function insertDimensionMapping(
  tenantId: number,
  connectionId: number,
  proposalId: number,
  opts: {
    provider?: string;
    dimensionType?: string;
    rawValue?: string;
    normalizedValue?: string | null;
    proposedProviderId?: string | null;
    proposedMatchLabel?: string | null;
    providerId?: string | null;
    mappingMethod?: string | null;
    reviewStatus?: string;
    resolutionState?: string;
    extractionConfidence?: number;
  } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO dimension_mappings
       (tenant_id, connection_id, provider, proposal_id, dimension_type, raw_value, normalized_value,
        extraction_confidence, proposed_provider_id, proposed_match_label, provider_id, mapping_method,
        review_status, resolution_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      tenantId,
      connectionId,
      opts.provider ?? 'qbo',
      proposalId,
      opts.dimensionType ?? 'class',
      opts.rawValue ?? 'Marketing Dept',
      opts.normalizedValue ?? null,
      opts.extractionConfidence ?? 0.8,
      opts.proposedProviderId ?? null,
      opts.proposedMatchLabel ?? null,
      opts.providerId ?? null,
      opts.mappingMethod ?? null,
      opts.reviewStatus ?? 'pending',
      opts.resolutionState ?? 'not_mapped',
    ],
  );
  return rows[0]!.id;
}

export async function countRows(table: string, where = '', params: unknown[] = []): Promise<number> {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} ${where ? 'WHERE ' + where : ''}`,
    params,
  );
  return rows[0]?.n ?? 0;
}

export async function closeAll(): Promise<void> {
  // Null the singleton so a later test file recreates the pool instead of reusing an ended one.
  await closePool().catch(() => {});
}

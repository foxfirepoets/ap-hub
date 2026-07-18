import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { query } from '../src/db/pool.js';
import { recordProofRef, hasProofRef } from '../src/swarmsync/proof.js';
import { persistMessage } from '../src/ingest/repo.js';
import { config } from '../src/config.js';
import { resetTables, createTenant, countRows, closeAll } from './helpers.js';
import type { GmailMessage } from '../src/gmail/client.js';

function msg(id: string, attachments: GmailMessage['attachments'] = []): GmailMessage {
  return {
    id,
    threadId: 't',
    from: 'billing@acme.com',
    subject: 'Invoice',
    receivedAt: '2026-07-01T00:00:00Z',
    bodyText: '',
    attachments,
  };
}

describe('CHUNK_1 infra: schema', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('created every table + the review view', async () => {
    const { rows } = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`,
    );
    const names = new Set(rows.map((r) => r.table_name));
    for (const t of [
      'tenants', 'oauth_tokens', 'messages', 'attachments', 'extractions', 'mappings',
      'proposals', 'postings', 'reconciliation', 'exceptions', 'audit_log', 'corrections',
      'llm_calls', 'proof_refs', 'forwards', 'attachment_blobs',
    ]) {
      expect(names.has(t), `missing table ${t}`).toBe(true);
    }
    const views = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.views WHERE table_schema='public'`,
    );
    expect(views.rows.map((r) => r.table_name)).toContain('v_proposal_review');
  });
});

describe('proof_refs idempotency (no_proof_dup)', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('records once; a repeat submit is a no-op', async () => {
    const t = await createTenant();
    await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: '1', product: 'verify_api', proofId: 'p1', chainHash: 'h1' });
    await recordProofRef({ tenantId: t, entityKind: 'extraction', entityId: '1', product: 'verify_api', proofId: 'p2', chainHash: 'h2' });
    expect(await countRows('proof_refs')).toBe(1);
    expect(await hasProofRef(t, 'extraction', '1', 'verify_api')).toBe(true);
    expect(await hasProofRef(t, 'extraction', '1', 'invoiceproof')).toBe(false);
  });
});

describe('CHUNK_3 ingest: dedup', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('double-poll inserts zero duplicate messages', async () => {
    const t = await createTenant();
    const first = await persistMessage(t, msg('gmail-1'));
    expect(first.isNew).toBe(true);
    const second = await persistMessage(t, msg('gmail-1'));
    expect(second.isNew).toBe(false);
    expect(await countRows('messages')).toBe(1);
  });

  it('dedup_same_file: identical attachment stored once, later link marked duplicate', async () => {
    const t = await createTenant();
    const bytes = Buffer.from('%PDF-1.4 identical');
    await persistMessage(t, msg('gmail-1', [{ filename: 'a.pdf', mimeType: 'application/pdf', data: bytes }]));
    await persistMessage(t, msg('gmail-2', [{ filename: 'a-copy.pdf', mimeType: 'application/pdf', data: bytes }]));
    expect(await countRows('attachment_blobs')).toBe(1);
    // One attachments row per (tenant, sha256); it is flagged duplicate.
    expect(await countRows('attachments')).toBe(1);
    expect(await countRows('attachments', 'is_duplicate = true')).toBe(1);
  });

  it('persists body-only messages flagged for body extraction', async () => {
    const t = await createTenant();
    const r = await persistMessage(t, msg('gmail-body'));
    expect(r.bodyOnly).toBe(true);
    expect(await countRows('messages', 'body_only = true')).toBe(1);
  });
});

describe('FIX-F8: oversized attachment rejection', () => {
  beforeEach(resetTables);
  afterAll(closeAll);

  it('rejects an attachment over MAX_ATTACHMENT_BYTES: not stored, raises a visible exception', async () => {
    const t = await createTenant();
    const maxBytes = config().MAX_ATTACHMENT_BYTES;
    const oversized = Buffer.alloc(maxBytes + 1, 1);
    const r = await persistMessage(
      t,
      msg('gmail-oversized', [{ filename: 'huge.pdf', mimeType: 'application/pdf', data: oversized }]),
    );
    // Message itself is still ingested; the oversized attachment is dropped, not stored.
    expect(r.attachmentIds).toEqual([]);
    expect(await countRows('attachments')).toBe(0);
    expect(await countRows('attachment_blobs')).toBe(0);

    const { rows } = await query<{ reason_code: string; entity_ref: string }>(
      `SELECT reason_code, entity_ref FROM exceptions WHERE tenant_id=$1`,
      [t],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason_code).toBe('attachment_failed');
    expect(rows[0]!.entity_ref).toBe(`message:${r.messageId}`);
  });

  it('stores a normal-size attachment and raises no exception', async () => {
    const t = await createTenant();
    const normal = Buffer.from('%PDF-1.4 normal size attachment');
    const r = await persistMessage(
      t,
      msg('gmail-normal', [{ filename: 'invoice.pdf', mimeType: 'application/pdf', data: normal }]),
    );
    expect(r.attachmentIds).toHaveLength(1);
    expect(await countRows('attachments')).toBe(1);
    expect(await countRows('attachment_blobs')).toBe(1);
    expect(await countRows('exceptions')).toBe(0);
  });
});

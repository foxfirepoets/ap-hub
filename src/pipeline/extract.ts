import { query } from '../db/pool.js';
import { JOBS } from '../queue.js';
import { classifyDeterministic } from '../extract/classify.js';
import {
  validateRaw,
  normalizeExtraction,
  type Extractor,
} from '../extract/model.js';
import type { ExtractionResult } from '../extract/schema.js';
import { loadAttachmentBytes } from '../ingest/repo.js';
import { raiseException } from '../exceptions.js';
import { recordProofRef, hasProofRef } from '../swarmsync/proof.js';
import { writeAudit } from '../audit.js';
import { logger } from '../logger.js';
import type { VerifyResult } from '../swarmsync/client.js';
import { classifyAccountingAttachment } from '../statements/ingest.js';

export interface ClassifyJob {
  tenantId: number;
  messageId: number;
}
export interface ExtractJob {
  tenantId: number;
  messageId: number;
  attachmentId: number | null;
}

/** CHUNK_5 classify: deterministic rules first; flag needs_review when not confident. */
export async function classifyOnce(
  job: { data: ClassifyJob },
  enqueue: (jobName: string, data: ExtractJob) => Promise<void>,
): Promise<void> {
  const { tenantId, messageId } = job.data;
  const msg = (
    await query<{ subject: string | null; from_addr: string | null; body_only: boolean }>(
      'SELECT subject, from_addr, body_only FROM messages WHERE tenant_id=$1 AND id=$2',
      [tenantId, messageId],
    )
  ).rows[0];
  if (!msg) return;

  const atts = (
    await query<{ id: number; mime: string | null; filename: string | null; sha256: string }>(
      'SELECT id, mime, filename, sha256 FROM attachments WHERE tenant_id=$1 AND message_id=$2',
      [tenantId, messageId],
    )
  ).rows;

  const result = classifyDeterministic({
    subject: msg.subject ?? '',
    fromAddr: msg.from_addr ?? '',
    hasAttachment: atts.length > 0,
    mimeTypes: atts.map((a) => a.mime ?? ''),
  });

  await query('UPDATE messages SET doc_type=$2, direction=$3, needs_review=$4 WHERE id=$1', [
    messageId,
    result.docType,
    result.direction,
    !result.confident,
  ]);

  if (atts.length === 0) {
    await enqueue(JOBS.extract, { tenantId, messageId, attachmentId: null });
  } else {
    for (const a of atts) {
      const route = classifyAccountingAttachment({
        subject: msg.subject ?? '',
        filename: a.filename ?? '',
        mime: a.mime ?? '',
      });
      await query(
        `INSERT INTO accounting_documents
           (tenant_id,message_id,attachment_id,kind,sha256,status,classification_confidence,hold_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id,sha256,kind) DO NOTHING`,
        [
          tenantId,
          messageId,
          a.id,
          route.kind,
          a.sha256,
          route.status,
          route.confidence,
          route.holdReason,
        ],
      );
      if (route.kind === 'invoice') {
        await enqueue(JOBS.extract, { tenantId, messageId, attachmentId: a.id });
      }
    }
  }
}

export async function classifyHandler(job: { data: ClassifyJob }): Promise<void> {
  const { getQueue } = await import('../queue.js');
  await classifyOnce(job, async (jobName, data) => {
    await getQueue().send(jobName, data);
  });
}

export interface ExtractDeps {
  extractor: Extractor;
  verify: (output: unknown, evidence: unknown) => Promise<VerifyResult>;
  enqueueMap: (extractionId: number, attachmentId: number | null, messageId: number) => Promise<void>;
  model?: string;
  /** Verify-API notarization runs only when SwarmSync is enabled (default true). */
  swarmSyncEnabled?: boolean;
}

/** Core extraction (testable). Retries the model up to 3× on invalid JSON. */
export async function extractOnce(
  tenantId: number,
  job: ExtractJob,
  deps: ExtractDeps,
): Promise<{ extractionId: number | null; status: 'ok' | 'failed' }> {
  const { messageId, attachmentId } = job;

  let bytes: Buffer | null = null;
  let mime: string | null = null;
  let bodyText = '';
  if (attachmentId) {
    const a = (
      await query<{ sha256: string; mime: string | null }>(
        'SELECT sha256, mime FROM attachments WHERE id=$1 AND tenant_id=$2',
        [attachmentId, tenantId],
      )
    ).rows[0];
    if (!a) return { extractionId: null, status: 'failed' };
    mime = a.mime;
    bytes = await loadAttachmentBytes(a.sha256);
    if ((mime ?? '').includes('pdf') && !bytes) {
      await raiseException({ tenantId, reasonCode: 'bad_pdf', entityRef: `attachment:${attachmentId}` });
      return { extractionId: null, status: 'failed' };
    }
    if (mime && !/pdf|image\//i.test(mime)) {
      await raiseException({ tenantId, reasonCode: 'unsupported_file', entityRef: `attachment:${attachmentId}` });
      return { extractionId: null, status: 'failed' };
    }
  } else {
    bodyText = (
      await query<{ subject: string | null }>('SELECT subject FROM messages WHERE id=$1', [messageId])
    ).rows[0]?.subject ?? '';
  }

  // Extract with retry×3; never persist raw malformed output.
  let normalized: ExtractionResult | null = null;
  for (let attempt = 0; attempt < 3 && !normalized; attempt++) {
    try {
      const raw = await deps.extractor.extract({ bytes: bytes ?? undefined, mime: mime ?? undefined, bodyText });
      normalized = normalizeExtraction(validateRaw(raw));
    } catch (err) {
      logger.warn({ err: String(err), attempt, attachmentId }, 'extraction attempt failed');
    }
  }
  if (!normalized) {
    await raiseException({
      tenantId,
      reasonCode: 'extraction_failed',
      entityRef: attachmentId ? `attachment:${attachmentId}` : `message:${messageId}`,
    });
    return { extractionId: null, status: 'failed' };
  }

  // Bank-change detection vs last-seen for this vendor (flag only — never acted on).
  if (normalized.bank_info && normalized.vendor_name) {
    const last = (
      await query<{ fields: any }>(
        `SELECT fields FROM extractions WHERE tenant_id=$1 AND fields->>'vendor_name'=$2
         AND fields->>'bank_info' IS NOT NULL ORDER BY id DESC LIMIT 1`,
        [tenantId, normalized.vendor_name],
      )
    ).rows[0];
    if (last && last.fields?.bank_info && last.fields.bank_info !== normalized.bank_info) {
      normalized.flags.push('bank_change_warning');
    }
  }

  const extractionId = (
    await query<{ id: number }>(
      `INSERT INTO extractions (tenant_id, attachment_id, message_id, fields, confidence, missing_fields, flags, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        tenantId,
        attachmentId,
        messageId,
        JSON.stringify(normalized),
        normalized.confidence,
        normalized.missing_fields,
        normalized.flags,
        deps.model ?? 'claude',
      ],
    )
  ).rows[0]!.id;

  if (normalized.flags.includes('total_mismatch')) {
    await raiseException({ tenantId, reasonCode: 'total_mismatch', entityRef: `extraction:${extractionId}` });
  }
  if (normalized.doc_type === 'invoice' && normalized.missing_fields.includes('invoice_number')) {
    await raiseException({ tenantId, reasonCode: 'missing_invoice_no', entityRef: `extraction:${extractionId}` });
  }

  // Verify-API (Amendment A1): submit the extraction, record proof_ref (check-before-submit).
  // Skipped entirely when SwarmSync is disabled (no outbound call, no proof_scan_unavailable).
  if (deps.swarmSyncEnabled !== false && !(await hasProofRef(tenantId, 'extraction', String(extractionId), 'verify_api'))) {
    try {
      const v = await deps.verify(normalized, {
        gmail_message_id: messageId,
        attachment_sha256: attachmentId,
        model: deps.model ?? 'claude',
      });
      await recordProofRef({
        tenantId,
        entityKind: 'extraction',
        entityId: String(extractionId),
        product: 'verify_api',
        proofId: v.proof_id,
        chainHash: v.chain_hash,
        verdict: v.verification_status,
        response: v.raw,
      });
      if (v.verification_status && /fail/i.test(v.verification_status)) {
        await query(
          `UPDATE extractions SET flags = array_append(flags,'verify_failed') WHERE id=$1`,
          [extractionId],
        );
      }
    } catch (err) {
      logger.warn({ err: String(err), extractionId }, 'verify-api failed');
      await raiseException({
        tenantId,
        reasonCode: 'proof_scan_unavailable',
        entityRef: `extraction:${extractionId}`,
        detail: `Verify-API failed: ${(err as Error).message}`,
      });
    }
  }

  await writeAudit({ tenantId, action: 'extract.done', entity: `extraction:${extractionId}` });
  await deps.enqueueMap(extractionId, attachmentId, messageId);
  return { extractionId, status: 'ok' };
}

// Resolve the LLM backend (and its up-to-3s local-runtime detection) ONCE per
// process, not on every job. The provider is config-driven and stable for the
// process lifetime; a newly-started local runtime is picked up on next restart.
let cachedExtractor: Extractor | null = null;

export async function extractHandler(job: { data: ExtractJob }): Promise<void> {
  const { config } = await import('../config.js');
  const { getExtractor } = await import('../extract/model.js');
  const { swarmsync } = await import('../services.js');
  const { getQueue } = await import('../queue.js');
  const cfg = config();
  if (!cachedExtractor) {
    try {
      cachedExtractor = await getExtractor(cfg);
    } catch (err) {
      // getExtractor / resolveProvider can throw LlmNotConfiguredError (no local
      // runtime, no key, no explicitly-chosen CLI) — never cached, so a later job
      // retries after the operator fixes config, without a process restart. Must
      // surface as a typed exceptions row like every other pipeline failure, never
      // a bare job throw only visible in pg-boss retry logs (CLAUDE.md: "no silent
      // failures").
      logger.warn({ err: String(err), tenantId: job.data.tenantId }, 'LLM backend not configured');
      await raiseException({
        tenantId: job.data.tenantId,
        reasonCode: 'extractor_not_configured',
        entityRef: job.data.attachmentId
          ? `attachment:${job.data.attachmentId}`
          : `message:${job.data.messageId}`,
        detail: (err as Error).message,
      });
      return;
    }
  }
  const extractor = cachedExtractor;
  await extractOnce(job.data.tenantId, job.data, {
    extractor,
    swarmSyncEnabled: cfg.SWARMSYNC_ENABLED,
    verify: (output, evidence) => swarmsync().verifyDocument(output, evidence),
    enqueueMap: async (extractionId, attachmentId, messageId) => {
      await getQueue().send(JOBS.map, { tenantId: job.data.tenantId, extractionId, attachmentId, messageId });
    },
    model: 'claude',
  });
}

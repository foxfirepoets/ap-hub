import { scopedQuery } from '../../db/scoped.js';
import { isValidId } from '../index.js';
import { sandboxLink } from './http.js';

/**
 * CHUNK_3_READ — the Evidence chain for one item (a proposal). Assembles: the source
 * email ref, the attachment ref + sha256 (or a "missing" marker), the extracted fields
 * + confidence, the prior mapping rule (if any), the proof references, and the QBO link
 * (if posted). Reuses `v_proposal_review` semantics via direct tenant-scoped joins.
 *
 * Returns `null` when the proposal is not in the caller's tenant → 404 (no foreign rows).
 * When a present-in-DB field exists it is returned; an absent attachment adds
 * `'attachment'` to `missing` and leaves `attachment: null`.
 */

export interface EvidenceEmail {
  messageId: number;
  gmailMessageId: string | null;
  subject: string | null;
  from: string | null;
  receivedAt: string | null;
}

export interface EvidenceAttachment {
  attachmentId: number;
  filename: string | null;
  sha256: string;
  mime: string | null;
}

export interface EvidenceExtraction {
  extractionId: number;
  fields: Record<string, unknown>;
  confidence: number;
  missingFields: string[];
  flags: string[];
}

export interface EvidencePriorRule {
  mappingId: number;
  kind: string;
  sourceKey: string;
  targetQboType: string | null;
  targetQboId: string | null;
  targetName: string | null;
  learnedFrom: string | null;
}

export interface EvidenceProof {
  product: string;
  entityKind: string;
  verdict: string | null;
  proofId: string | null;
  chainHash: string | null;
}

export interface EvidencePosting {
  postingId: number;
  qboType: string | null;
  qboId: string | null;
  status: string;
}

export interface Evidence {
  proposalId: number;
  status: string;
  confidence: number;
  email: EvidenceEmail | null;
  attachment: EvidenceAttachment | null;
  extraction: EvidenceExtraction | null;
  priorRule: EvidencePriorRule | null;
  proofs: EvidenceProof[];
  posting: EvidencePosting | null;
  qboLink: string | null;
  /** Names of expected-but-absent evidence pieces, e.g. `['attachment']`. */
  missing: string[];
}

export async function getEvidence(tenantId: number, proposalId: number): Promise<Evidence | null> {
  if (!isValidId(proposalId)) return null;
  const proposal = (
    await scopedQuery<{
      id: number;
      status: string;
      confidence: string;
      attachment_id: number | null;
      extraction_id: number | null;
    }>(
      tenantId,
      `SELECT id, status, confidence, attachment_id, extraction_id
         FROM proposals WHERE tenant_id = $1 AND id = $2`,
      [proposalId],
    )
  ).rows[0];
  if (!proposal) return null;

  const missing: string[] = [];

  // --- Extraction (source of extracted fields + the vendor key for prior-rule lookup) ---
  let extraction: EvidenceExtraction | null = null;
  let extractionMessageId: number | null = null;
  let vendorKey: string | null = null;
  if (proposal.extraction_id != null) {
    const e = (
      await scopedQuery<{
        id: number;
        fields: Record<string, unknown>;
        confidence: string;
        missing_fields: string[];
        flags: string[];
        message_id: number;
      }>(
        tenantId,
        `SELECT id, fields, confidence, missing_fields, flags, message_id
           FROM extractions WHERE tenant_id = $1 AND id = $2`,
        [proposal.extraction_id],
      )
    ).rows[0];
    if (e) {
      extraction = {
        extractionId: e.id,
        fields: e.fields,
        confidence: Number(e.confidence),
        missingFields: e.missing_fields ?? [],
        flags: e.flags ?? [],
      };
      extractionMessageId = e.message_id;
      const vn = (e.fields?.vendor_name ?? null) as string | null;
      vendorKey = vn ? vn.trim().toLowerCase() : null;
    }
  }
  if (!extraction) missing.push('extraction');

  // --- Attachment (ref + sha256) or a "missing" marker ---
  let attachment: EvidenceAttachment | null = null;
  let attachmentMessageId: number | null = null;
  if (proposal.attachment_id != null) {
    const a = (
      await scopedQuery<{
        id: number;
        filename: string | null;
        sha256: string;
        mime: string | null;
        message_id: number;
      }>(
        tenantId,
        `SELECT id, filename, sha256, mime, message_id
           FROM attachments WHERE tenant_id = $1 AND id = $2`,
        [proposal.attachment_id],
      )
    ).rows[0];
    if (a) {
      attachment = { attachmentId: a.id, filename: a.filename, sha256: a.sha256, mime: a.mime };
      attachmentMessageId = a.message_id;
    }
  }
  if (!attachment) missing.push('attachment');

  // --- Source email ---
  const messageId = extractionMessageId ?? attachmentMessageId;
  let email: EvidenceEmail | null = null;
  if (messageId != null) {
    const m = (
      await scopedQuery<{
        id: number;
        gmail_message_id: string | null;
        subject: string | null;
        from_addr: string | null;
        received_at: Date | null;
      }>(
        tenantId,
        `SELECT id, gmail_message_id, subject, from_addr, received_at
           FROM messages WHERE tenant_id = $1 AND id = $2`,
        [messageId],
      )
    ).rows[0];
    if (m) {
      email = {
        messageId: m.id,
        gmailMessageId: m.gmail_message_id,
        subject: m.subject,
        from: m.from_addr,
        receivedAt: m.received_at ? m.received_at.toISOString() : null,
      };
    }
  }
  if (!email) missing.push('email');

  // --- Prior mapping rule (vendor), if any ---
  let priorRule: EvidencePriorRule | null = null;
  if (vendorKey) {
    const mp = (
      await scopedQuery<{
        id: number;
        kind: string;
        source_key: string;
        target_qbo_type: string | null;
        target_qbo_id: string | null;
        target_name: string | null;
        learned_from: string | null;
      }>(
        tenantId,
        `SELECT id, kind, source_key, target_qbo_type, target_qbo_id, target_name, learned_from
           FROM mappings WHERE tenant_id = $1 AND kind = 'vendor' AND source_key = $2`,
        [vendorKey],
      )
    ).rows[0];
    if (mp) {
      priorRule = {
        mappingId: mp.id,
        kind: mp.kind,
        sourceKey: mp.source_key,
        targetQboType: mp.target_qbo_type,
        targetQboId: mp.target_qbo_id,
        targetName: mp.target_name,
        learnedFrom: mp.learned_from,
      };
    }
  }

  // --- Posting + QBO link ---
  const posting = (
    await scopedQuery<{ id: number; qbo_type: string | null; qbo_id: string | null; realm: string | null; status: string }>(
      tenantId,
      `SELECT id, qbo_type, qbo_id, realm, status
         FROM postings WHERE tenant_id = $1 AND proposal_id = $2
        ORDER BY id DESC LIMIT 1`,
      [proposalId],
    )
  ).rows[0];
  const postingOut: EvidencePosting | null = posting
    ? { postingId: posting.id, qboType: posting.qbo_type, qboId: posting.qbo_id, status: posting.status }
    : null;
  const qboLink =
    posting && posting.qbo_type && posting.qbo_id && posting.realm
      ? sandboxLink(posting.realm, posting.qbo_type, posting.qbo_id)
      : null;

  // --- Proof references across the chain (extraction / proposal / posting) ---
  const proofRows = (
    await scopedQuery<{ product: string; entity_kind: string; verdict: string | null; proof_id: string | null; chain_hash: string | null }>(
      tenantId,
      `SELECT product, entity_kind, verdict, proof_id, chain_hash
         FROM proof_refs
        WHERE tenant_id = $1
          AND ( (entity_kind = 'proposal'   AND entity_id = $2)
             OR (entity_kind = 'extraction' AND entity_id = $3)
             OR (entity_kind = 'posting'    AND entity_id = $4) )
        ORDER BY id ASC`,
      [
        String(proposalId),
        proposal.extraction_id != null ? String(proposal.extraction_id) : '',
        posting ? String(posting.id) : '',
      ],
    )
  ).rows;
  const proofs: EvidenceProof[] = proofRows.map((p) => ({
    product: p.product,
    entityKind: p.entity_kind,
    verdict: p.verdict,
    proofId: p.proof_id,
    chainHash: p.chain_hash,
  }));

  return {
    proposalId: proposal.id,
    status: proposal.status,
    confidence: Number(proposal.confidence),
    email,
    attachment,
    extraction,
    priorRule,
    proofs,
    posting: postingOut,
    qboLink,
    missing,
  };
}

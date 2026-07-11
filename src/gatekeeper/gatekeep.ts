import { query } from '../db/pool.js';
import { sha256Hex } from '../crypto.js';
import { classifyFindings } from '../swarmsync/severity.js';
import { raiseException, type ReasonCode } from '../exceptions.js';
import { recordProofRef } from '../swarmsync/proof.js';
import { writeAudit } from '../audit.js';
import { logger } from '../logger.js';
import type { InvoiceScanInput, InvoiceScanResult } from '../swarmsync/client.js';
import type { LockedForwarder } from './forwarder.js';
import type { TelegramSender } from './telegram.js';
import { holdAlertText } from './telegram.js';
import { loadAttachmentBytes } from '../ingest/repo.js';
import { upsertForwardIntent, setForwardStatus, markAlerted } from './repo.js';

/**
 * CHUNK_4 gatekeeper decision engine. Scans each incoming invoice via InvoiceProof
 * and either auto-forwards a clean message to the QBO capture address (once) or HOLDS
 * it with a typed exception + Telegram alert. Fail-safe: outage/unscannable = HOLD,
 * never forward-unscanned.
 */

export interface GatekeepDeps {
  scan: (input: InvoiceScanInput) => Promise<InvoiceScanResult>;
  forwarder: LockedForwarder;
  telegram: TelegramSender;
}

export type GatekeepAction = 'forwarded' | 'held' | 'noop';

export interface GatekeepOutcome {
  action: GatekeepAction;
  reason?: ReasonCode;
  forwardId?: number;
}

interface AttachmentRow {
  id: number;
  sha256: string;
  mime: string | null;
  filename: string | null;
}

const isPdf = (mime: string | null): boolean => (mime ?? '').toLowerCase().includes('pdf');

export async function gatekeepOnce(
  tenantId: number,
  messageId: number,
  deps: GatekeepDeps,
): Promise<GatekeepOutcome> {
  const msgRes = await query<{ id: number; gmail_message_id: string; subject: string | null; from_addr: string | null; body_only: boolean }>(
    'SELECT id, gmail_message_id, subject, from_addr, body_only FROM messages WHERE tenant_id=$1 AND id=$2',
    [tenantId, messageId],
  );
  const msg = msgRes.rows[0];
  if (!msg) return { action: 'noop' };

  const attRes = await query<AttachmentRow>(
    'SELECT id, sha256, mime, filename FROM attachments WHERE tenant_id=$1 AND message_id=$2 ORDER BY id',
    [tenantId, messageId],
  );
  const attachments = attRes.rows;

  // Representative key for the double-forward guard + subject tag.
  const repSha =
    attachments.length > 0
      ? sha256Hex(attachments.map((a) => a.sha256).sort().join('|'))
      : sha256Hex(`body:${msg.gmail_message_id}`);
  const subjectTag = `[APH-${repSha.slice(0, 8)}]`;

  const { row: forward, created } = await upsertForwardIntent({
    tenantId,
    messageId,
    attachmentId: attachments[0]?.id ?? null,
    sha256: repSha,
    subjectTag,
    status: 'scanning',
  });
  // Already resolved by a prior run → do not act again (idempotent).
  if (!created && (forward.status === 'forwarded' || forward.status === 'held')) {
    return { action: forward.status === 'forwarded' ? 'forwarded' : 'held', forwardId: forward.id };
  }

  const hold = async (reason: ReasonCode, detail: string, vendor?: string) => {
    await setForwardStatus(forward.id, 'held', { holdReason: reason });
    await raiseException({ tenantId, reasonCode: reason, entityRef: `forward:${forward.id}`, detail });
    await writeAudit({ tenantId, action: 'gatekeep.hold', entity: `forward:${forward.id}`, detail: { reason } });
    await sendAlert(deps, tenantId, forward.id, reason, vendor);
    return { action: 'held' as const, reason, forwardId: forward.id };
  };

  // No attachment → cannot scan → hold.
  if (attachments.length === 0) {
    return hold('no_attachment', 'accounting email with no attachment');
  }
  // Any non-PDF attachment is unscannable in v1 → hold the whole message.
  if (attachments.some((a) => !isPdf(a.mime))) {
    return hold('unscannable_format', 'message contains a non-PDF/unscannable attachment');
  }

  // Scan every attachment's bytes via InvoiceProof.
  let scanResult: InvoiceScanResult;
  try {
    const invoices = [];
    for (const a of attachments) {
      const bytes = await loadAttachmentBytes(a.sha256);
      invoices.push({
        filename: a.filename ?? 'invoice.pdf',
        sha256: a.sha256,
        pdfBase64: bytes ? bytes.toString('base64') : undefined,
      });
    }
    scanResult = await deps.scan({ invoices });
  } catch (err) {
    logger.warn({ err: String(err), messageId }, 'gatekeeper scan failed');
    return hold('proof_scan_unavailable', `InvoiceProof scan failed: ${(err as Error).message}`);
  }

  // Record the proof reference for each attachment (idempotent).
  for (const a of attachments) {
    await recordProofRef({
      tenantId,
      entityKind: 'attachment',
      entityId: String(a.id),
      product: 'invoiceproof',
      findings: scanResult.findings,
      response: scanResult.raw,
    });
  }

  const cls = classifyFindings(scanResult.findings);
  if (cls.hasCritical || cls.hasHigh) {
    const reason = cls.criticalReason ?? 'fraud_flag';
    return hold(reason, `InvoiceProof: ${cls.evidence}`);
  }

  // Clean (or medium-only) → forward exactly once.
  await setForwardStatus(forward.id, 'forwarding');
  try {
    const sent = await deps.forwarder.forward(msg.gmail_message_id);
    await setForwardStatus(forward.id, 'forwarded', { gmailSendId: sent.sendId });
    await writeAudit({
      tenantId,
      action: 'gatekeep.forward',
      entity: `forward:${forward.id}`,
      detail: { to: sent.to, sendId: sent.sendId },
    });
    return { action: 'forwarded', forwardId: forward.id };
  } catch (err) {
    logger.error({ err: String(err), messageId }, 'gatekeeper forward failed');
    await setForwardStatus(forward.id, 'failed', { holdReason: 'forward_failed' });
    await raiseException({
      tenantId,
      reasonCode: 'forward_failed',
      entityRef: `forward:${forward.id}`,
      detail: (err as Error).message,
    });
    await sendAlert(deps, tenantId, forward.id, 'forward_failed');
    return { action: 'held', reason: 'forward_failed', forwardId: forward.id };
  }
}

async function sendAlert(
  deps: GatekeepDeps,
  tenantId: number,
  forwardId: number,
  reason: ReasonCode,
  vendor?: string,
): Promise<void> {
  try {
    await deps.telegram.send(holdAlertText({ vendor, reason, forwardId }));
    await markAlerted(forwardId).catch(() => {});
  } catch (err) {
    // The hold must survive an alert failure — record alert_failed, keep the hold.
    logger.error({ err: String(err), forwardId }, 'telegram alert failed');
    await raiseException({
      tenantId,
      reasonCode: 'alert_failed',
      entityRef: `forward:${forwardId}`,
      detail: (err as Error).message,
    });
  }
}

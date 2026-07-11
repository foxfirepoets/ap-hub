import type { InvoiceFinding } from './client.js';
import type { ReasonCode } from '../exceptions.js';

/**
 * Classifies InvoiceProof findings into the ap-hub gate decision (Amendment A1.3).
 * Shared by the gatekeeper (CHUNK_4) and the proposal gate (CHUNK_6).
 *
 *  critical → exception, mapped: duplicates→`duplicate`, bank change→`bank_change_warning`
 *  high     → cap at `review` + `fraud_flag`
 *  medium   → non-blocking flag only
 */

const CRITICAL_PATTERNS = new Set([
  'EXACT_DUPLICATE',
  'MODIFIED_DUPLICATE',
  'RECENT_DUPLICATE_IN_PAYMENT_HISTORY',
  'BANK_ACCOUNT_CHANGE_DETECTED',
]);
const HIGH_PATTERNS = new Set([
  'PO_AMOUNT_EXCEEDED',
  'MISSING_PO_REFERENCE',
  'vendor_address_mismatch',
  'LINE_ITEM_MATH_ERROR',
]);

export interface FindingClassification {
  hasCritical: boolean;
  hasHigh: boolean;
  hasMedium: boolean;
  /** Reason code to raise for the strongest finding, if any. */
  criticalReason: ReasonCode | null;
  patterns: string[];
  evidence: string;
}

function isCritical(f: InvoiceFinding): boolean {
  return f.severity === 'critical' || CRITICAL_PATTERNS.has(f.pattern);
}
function isHigh(f: InvoiceFinding): boolean {
  return f.severity === 'high' || HIGH_PATTERNS.has(f.pattern);
}

export function classifyFindings(findings: InvoiceFinding[]): FindingClassification {
  const patterns = findings.map((f) => f.pattern);
  const hasCritical = findings.some(isCritical);
  const hasHigh = !hasCritical && findings.some(isHigh);
  const hasMedium = !hasCritical && !hasHigh && findings.length > 0;

  let criticalReason: ReasonCode | null = null;
  if (hasCritical) {
    const bankChange = findings.find((f) => f.pattern === 'BANK_ACCOUNT_CHANGE_DETECTED');
    criticalReason = bankChange ? 'bank_change_warning' : 'duplicate';
  } else if (hasHigh) {
    criticalReason = 'fraud_flag';
  }

  const evidence = findings
    .map((f) => `${f.pattern}${f.evidence ? `:${f.evidence}` : ''}`)
    .join('; ')
    .slice(0, 500);

  return { hasCritical, hasHigh, hasMedium, criticalReason, patterns, evidence };
}

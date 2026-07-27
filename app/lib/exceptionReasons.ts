// Pure reasonCode -> plain-English mapper for the Exceptions review screen
// (app/(app)/exceptions/page.tsx). No DOM/React/fetch/DB — a presentational helper only,
// unit-testable in isolation. Same shape as app/lib/onboardingErrors.ts's
// friendlyOnboardingError, applied to the exceptions taxonomy instead of IPC error codes.
//
// Mirrors `REASON_CODES` in `src/exceptions.ts`, the CLOSED taxonomy every `raiseException(...)`
// call site is restricted to. This file imports only the TYPE (`import type`, erased at compile
// time — no runtime code, and none of `src/exceptions.ts`'s `pg`/db-pool dependency graph is
// pulled into the browser bundle) and mirrors the values as its own array, so app/lib stays out
// of the server module graph — same reasoning `onboardingErrors.ts` gives for mirroring
// `IPC_ERROR_CODES` instead of importing `desktop/ipc/errors.ts`. `test/exception-reasons-mapping
// .test.ts` imports the real `REASON_CODES` to prove this mirror has not drifted.
//
// The `detail` question: `detail` is a free-form string set at each `raiseException(...)` call
// site (e.g. "AuditProof anchor failed: ${err.message}") — operator/log-facing text, never
// written for a non-technical audience, and NOT a closed enumerable set the way `reasonCode` is,
// so it cannot be mapped like the codes below. CLAUDE.md and .ralph/guardrails.md ban raw
// provider errors, stack traces, and error codes in the UI with no stated exception for a
// disclosure toggle ("DO NOT BUILD: raw provider errors, stack traces, or error codes in the
// UI."). So this screen shows ONLY the mapped plain-language explanation for the reasonCode and
// never renders raw `detail` at all — not even behind a "show technical details" affordance,
// since that would still be raw technical text reaching the UI.

import type { ReasonCode } from '../../src/exceptions.js';

export interface FriendlyExceptionReason {
  title: string;
  text: string;
}

/**
 * Mirrors `REASON_CODES` in `src/exceptions.ts` value-for-value (see file header for why this is
 * a mirror rather than a runtime import).
 */
export const EXCEPTION_REASON_CODES = [
  'low_confidence',
  'unknown_vendor',
  'unmapped_account',
  'unmapped_dimension',
  'duplicate',
  'duplicate_in_qbo',
  'missing_invoice_no',
  'total_mismatch',
  'no_attachment',
  'bad_pdf',
  'unsupported_file',
  'bank_change_warning',
  'extraction_failed',
  'verify_mismatch',
  'attachment_failed',
  'qbo_api_error',
  'auth_failure',
  'fraud_flag',
  'proof_scan_unavailable',
  'unscannable_format',
  'forward_failed',
  'alert_failed',
  'dry_run_locked',
  'dedup_unavailable',
  'company_mismatch',
  'dimension_unsupported',
  'dimension_mismatch',
  'tax_unmapped',
  'tax_unreconciled',
  'tax_mapping_not_found',
  'tax_mapping_inactive',
  'tax_mapping_needs_revalidation',
  'dimension_mapping_not_found',
  'dimension_mapping_not_mapped',
  'dimension_mapping_not_reviewed',
  'extractor_not_configured',
  'statement_unreadable',
  'swarmsync_required_unavailable',
] as const;

function isReasonCode(code: string): code is ReasonCode {
  return (EXCEPTION_REASON_CODES as readonly string[]).includes(code);
}

// Fixed and generic on purpose — never built from `code`, so there is nothing here for a raw
// code to hide inside. Reached only if a code outside the closed set above somehow arrives
// (should not happen — see file header).
const GENERIC_FALLBACK: FriendlyExceptionReason = {
  title: 'Needs your review',
  text: "This item needs a quick look before AP-Hub can continue. Open it to see what's needed.",
};

/**
 * Exhaustive over `ReasonCode`. If `src/exceptions.ts` ever adds a code to `REASON_CODES` without
 * a matching case here, the `never` assignment in `default` fails `tsc --noEmit` — a build break,
 * not a silent raw-code leak at runtime.
 */
function mapKnownCode(code: ReasonCode): FriendlyExceptionReason {
  switch (code) {
    case 'low_confidence':
      return {
        title: 'Needs a second look',
        text: "AP-Hub wasn't confident enough about what it read from this document to post it automatically. Review the details and confirm before it goes to your accounting system.",
      };
    case 'unknown_vendor':
      return {
        title: 'Unrecognized vendor',
        text: "We don't recognize this vendor yet — review and confirm who this is.",
      };
    case 'unmapped_account':
      return {
        title: 'Account not set up yet',
        text: "This item isn't linked to an account in your accounting system yet. Choose the right account so AP-Hub can post it.",
      };
    case 'unmapped_dimension':
      return {
        title: 'Missing a category',
        text: "A class, location, or other category on this item hasn't been set up yet. Review and choose one before this can post.",
      };
    case 'duplicate':
      return {
        title: 'Possible duplicate',
        text: 'This looks like it might already be in your queue or already handled. Check before approving.',
      };
    case 'duplicate_in_qbo':
      return {
        title: 'Might already be in QuickBooks',
        text: 'This looks like it may already exist in QuickBooks. Check before approving to avoid creating it twice.',
      };
    case 'missing_invoice_no':
      return {
        title: 'Missing invoice number',
        text: "AP-Hub couldn't find an invoice number on this document. Add one or confirm it's correct before posting.",
      };
    case 'total_mismatch':
      return {
        title: "Amounts don't match",
        text: "The total on this document doesn't match what AP-Hub expected. Review the amounts before approving.",
      };
    case 'no_attachment':
      return {
        title: 'No document attached',
        text: "This email didn't include a document AP-Hub could process. Check the source email for the invoice or statement.",
      };
    case 'bad_pdf':
      return {
        title: "Document couldn't be opened",
        text: "AP-Hub couldn't open this file — it may be damaged or saved in an unusual way. You may need to ask the sender for a fresh copy.",
      };
    case 'unsupported_file':
      return {
        title: 'File type not supported',
        text: "This file isn't a type AP-Hub can read yet. You may need to ask the sender for a PDF or another supported format.",
      };
    case 'bank_change_warning':
      return {
        title: 'Bank details changed',
        text: "The bank account or payment details for this vendor look different from before. Verify this is legitimate before approving.",
      };
    case 'extraction_failed':
      return {
        title: "Couldn't read the document",
        text: 'AP-Hub ran into a problem reading this document. Try again, or review it yourself to enter the details.',
      };
    case 'verify_mismatch':
      return {
        title: 'Verification found a mismatch',
        text: "An automatic check found something on this item that doesn't line up. Review it closely before approving.",
      };
    case 'attachment_failed':
      return {
        title: "Couldn't download the document",
        text: "AP-Hub wasn't able to download the attachment from this email. Try again, or check the source email directly.",
      };
    case 'qbo_api_error':
      return {
        title: "QuickBooks didn't respond",
        text: "QuickBooks didn't respond correctly. This will be retried automatically — no action needed unless it keeps happening.",
      };
    case 'auth_failure':
      return {
        title: 'Connection needs attention',
        text: 'AP-Hub lost its connection to one of your accounts. Reconnect it in Settings to continue.',
      };
    case 'fraud_flag':
      return {
        title: 'Flagged for review',
        text: "This item was flagged by AP-Hub's fraud check and is being held for your review before anything is sent or posted.",
      };
    case 'proof_scan_unavailable':
      return {
        title: 'Verification check unavailable',
        text: "AP-Hub couldn't run its usual verification check on this item, so it's holding here for you to review by hand.",
      };
    case 'unscannable_format':
      return {
        title: "Couldn't be verified automatically",
        text: "This item is in a format AP-Hub's verification check can't read, so it's holding here for your review.",
      };
    case 'forward_failed':
      return {
        title: "Couldn't send for verification",
        text: "AP-Hub couldn't send this item out for its usual verification step. It will be retried, or you can review it directly.",
      };
    case 'alert_failed':
      return {
        title: "Alert didn't go out",
        text: "AP-Hub tried to notify you about this item but the alert didn't go through. The item itself is safe here in the queue.",
      };
    case 'dry_run_locked':
      return {
        title: 'Automation is still off',
        text: "AP-Hub is still in test mode and hasn't been turned on to post automatically yet. Finish setup to enable it.",
      };
    case 'dedup_unavailable':
      return {
        title: "Couldn't check for duplicates",
        text: "AP-Hub couldn't safely confirm this isn't a duplicate, so it's holding here rather than risk posting it twice.",
      };
    case 'company_mismatch':
      return {
        title: 'Wrong company detected',
        text: "This doesn't match the QuickBooks company AP-Hub expects to post to. Review before continuing.",
      };
    case 'dimension_unsupported':
      return {
        title: 'Category not supported',
        text: "Your accounting system can't represent one of the categories on this item. Review it and choose an alternative.",
      };
    case 'dimension_mismatch':
      return {
        title: "Category didn't match after saving",
        text: 'AP-Hub double-checked a category after saving it and the result came back different than expected. Review it.',
      };
    case 'tax_unmapped':
      return {
        title: 'Tax code not set up',
        text: 'This item needs a tax code that has not been set up yet. Add the mapping before this can post.',
      };
    case 'tax_unreconciled':
      return {
        title: "Tax amount doesn't add up",
        text: 'The tax on this document does not match the invoice total closely enough. Review the amounts.',
      };
    case 'tax_mapping_not_found':
      return {
        title: 'Tax code not recognized',
        text: 'AP-Hub does not have this tax code set up yet. Add it before this item can post.',
      };
    case 'tax_mapping_inactive':
      return {
        title: 'Tax code no longer active',
        text: 'The tax code this item would use has been replaced or turned off. Choose a current one.',
      };
    case 'tax_mapping_needs_revalidation':
      return {
        title: 'Tax code needs a re-check',
        text: 'This tax code was flagged for a fresh review before it can be used again. Confirm it is still correct.',
      };
    case 'dimension_mapping_not_found':
      return {
        title: 'Category not recognized',
        text: 'AP-Hub does not have this category set up yet. Choose or confirm the right one before this can post.',
      };
    case 'dimension_mapping_not_mapped':
      return {
        title: 'Category needs to be finished',
        text: 'This category was started but never finished being set up. Complete the mapping.',
      };
    case 'dimension_mapping_not_reviewed':
      return {
        title: 'Category awaiting your review',
        text: 'This category mapping is waiting on your review before it can be used.',
      };
    case 'extractor_not_configured':
      return {
        title: "Document reading isn't set up yet",
        text: 'AP-Hub does not have a way to read documents configured yet. Finish that part of setup, then this item can be processed.',
      };
    case 'statement_unreadable':
      return {
        title: "Bank statement couldn't be read",
        text: 'AP-Hub could not read this bank statement. Try a different file, or review it manually.',
      };
    case 'swarmsync_required_unavailable':
      return {
        title: 'Extra verification required but unavailable',
        text: "Your company's settings require an extra verification step for this item, but that check isn't available right now. It's holding here until you review it.",
      };
    default: {
      const exhaustiveCheck: never = code;
      return exhaustiveCheck;
    }
  }
}

/**
 * Maps a (possibly-untrusted) reasonCode string to plain English. `detail` is intentionally NOT a
 * parameter — see file header: raw `detail` must never reach the UI, so this function has no way
 * to leak it even by accident.
 */
export function friendlyExceptionReason(reasonCode: string): FriendlyExceptionReason {
  return isReasonCode(reasonCode) ? mapKnownCode(reasonCode) : GENERIC_FALLBACK;
}

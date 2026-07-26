/**
 * CHUNK_3_IPC — human classification of a held accounting document.
 *
 * Replaces `app/api/accounting-documents/[id]/classify/route.ts`.
 *
 * Role, verified in the wrapper: `runClassifyDocument` does NOT use a shared wrapper. It calls
 * `readContext(request, ['owner_controller', 'bookkeeper'])` inline
 * (`src/accounting/document-review-http.ts:16`) and then `request.json()` UNCONDITIONALLY, which
 * is why `synthesize` must send a body — it does, for every non-GET method
 * (`desktop/ipc/envelope.ts:110`).
 *
 * `classification` is narrowed to the exact three values the service itself allowlists
 * (`src/accounting/document-review.ts:6` and the `includes` check at `:110`), so the schema
 * rejects nothing the service would have accepted. `reason` carries the service's own 1000-char
 * cap (`:109`).
 */

import { z } from 'zod';

import { runClassifyDocument } from '../../../src/accounting/document-review-http.js';
import { defineChannel, entityId, passthrough, reason, strict, type RegistryEntry } from '../registry.js';

export const accountingDocumentEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:accounting-documents:classify',
    role: ['owner_controller', 'bookkeeper'],
    method: 'POST',
    pathTemplate: '/api/accounting-documents/:documentId/classify',
    bodyKeys: ['classification', 'reason'],
    request: strict({
      documentId: entityId,
      classification: z.enum(['invoice', 'bank_statement', 'irrelevant']),
      reason,
    }),
    response: passthrough({ classification: z.string(), queued: z.boolean() }),
    validationMessage:
      'Choose what this document is and add a short reason before saving. The document stays on hold until you do.',
    invoke: (request, payload) => runClassifyDocument(request, payload.documentId as number),
  }),
];

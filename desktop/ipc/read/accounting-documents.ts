import { z } from 'zod';
import { runClassificationReview } from '../../../src/accounting/document-review-http.js';
import { defineChannel, passthrough, strict, type RegistryEntry } from '../registry.js';

/**
 * B3 — GET /api/accounting-documents/review (owner, bookkeeper, cpa).
 *
 * Calls the real, unmodified exported wrapper `runClassificationReview`, which already bakes
 * in `role: ['owner_controller', 'bookkeeper', 'cpa']` via `runRead` — matching
 * `route-to-service-map.md`. `id`/`messageId`/`attachmentId` are plain `z.number()`:
 * `listClassificationReview` explicitly `Number(row.id)`-casts them, so they are real numbers
 * on the wire, unlike the bigint-passthrough fields elsewhere.
 */
export const accountingDocumentsEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:accounting-documents:review',
    role: ['owner_controller', 'bookkeeper', 'cpa'],
    method: 'GET',
    pathTemplate: '/api/accounting-documents/review',
    request: strict({}),
    response: z.array(
      passthrough({
        id: z.number(),
        messageId: z.number(),
        attachmentId: z.number().nullable(),
        filename: z.string().nullable(),
        subject: z.string().nullable(),
        holdReason: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    validationMessage: 'BookScout OS could not load documents waiting for review.',
    invoke: (request) => runClassificationReview(request),
  }),
];

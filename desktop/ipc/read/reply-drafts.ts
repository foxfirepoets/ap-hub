import { z } from 'zod';
import { runReadReplyDraft } from '../../../src/reply-drafts/http.js';
import { defineChannel, entityId, passthrough, strict, type RegistryEntry } from '../registry.js';

/**
 * B3 — GET /api/reply-drafts?messageId= (owner, bookkeeper, cpa).
 *
 * Calls the real, unmodified exported wrapper `runReadReplyDraft`, which reads `messageId`
 * off `new URL(request.url).searchParams` itself (`src/reply-drafts/http.ts:65`) and enforces
 * `['owner_controller', 'bookkeeper', 'cpa']` internally — matching `route-to-service-map.md`.
 * `queryParams` must carry `messageId` into the synthesized URL for that read to succeed.
 *
 * Every id here is a plain `z.number()`: `mapDraft` explicitly `Number(row.id)`-casts
 * `id`/`messageId`/`createdBy`.
 */
export const replyDraftsEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:reply-drafts:get',
    role: ['owner_controller', 'bookkeeper', 'cpa'],
    method: 'GET',
    pathTemplate: '/api/reply-drafts',
    queryParams: ['messageId'],
    request: strict({ messageId: entityId }),
    response: passthrough({
      id: z.number(),
      messageId: z.number(),
      externalDraftId: z.string().nullable(),
      threadId: z.string(),
      toAddress: z.string(),
      subject: z.string(),
      bodyText: z.string(),
      status: z.string(),
      reason: z.string().nullable(),
      createdBy: z.number(),
      createdAt: z.string(),
      updatedAt: z.string(),
      sendControl: z.literal('human_in_gmail'),
    }),
    validationMessage: 'AP-Hub could not find a reply draft for that email.',
    invoke: (request) => runReadReplyDraft(request),
  }),
];

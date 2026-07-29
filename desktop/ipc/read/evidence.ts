import { z } from 'zod';
import { getEvidence, runRead } from '../../../src/services/read/index.js';
import { defineChannel, entityId, passthrough, persistedId, strict, type RegistryEntry } from '../registry.js';

/**
 * B3 — GET /api/items/:id/evidence (any authenticated role). Every id-shaped field here is
 * `persistedId`, not `z.number()`: the `Evidence*` interfaces type them `number`, but
 * `getEvidence` projects them straight off `bigserial` columns (proposals/extractions/
 * attachments/messages/mappings/postings), which pg returns as strings.
 */

const evidenceEmail = passthrough({
  messageId: persistedId,
  gmailMessageId: z.string().nullable(),
  subject: z.string().nullable(),
  from: z.string().nullable(),
  receivedAt: z.string().nullable(),
}).nullable();

const evidenceAttachment = passthrough({
  attachmentId: persistedId,
  filename: z.string().nullable(),
  sha256: z.string(),
  mime: z.string().nullable(),
}).nullable();

const evidenceExtraction = passthrough({
  extractionId: persistedId,
  fields: z.record(z.unknown()),
  confidence: z.number(),
  missingFields: z.array(z.string()),
  flags: z.array(z.string()),
}).nullable();

const evidencePriorRule = passthrough({
  mappingId: persistedId,
  kind: z.string(),
  sourceKey: z.string(),
  targetQboType: z.string().nullable(),
  targetQboId: z.string().nullable(),
  targetName: z.string().nullable(),
  learnedFrom: z.string().nullable(),
}).nullable();

const evidenceProof = passthrough({
  product: z.string(),
  entityKind: z.string(),
  verdict: z.string().nullable(),
  proofId: z.string().nullable(),
  chainHash: z.string().nullable(),
});

const evidencePosting = passthrough({
  postingId: persistedId,
  qboType: z.string().nullable(),
  qboId: z.string().nullable(),
  status: z.string(),
}).nullable();

export const evidenceEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:evidence:get',
    role: 'any',
    method: 'GET',
    pathTemplate: '/api/items/:id/evidence',
    request: strict({ id: entityId }),
    response: passthrough({
      proposalId: persistedId,
      status: z.string(),
      confidence: z.number(),
      email: evidenceEmail,
      attachment: evidenceAttachment,
      extraction: evidenceExtraction,
      priorRule: evidencePriorRule,
      proofs: z.array(evidenceProof),
      posting: evidencePosting,
      qboLink: z.string().nullable(),
      missing: z.array(z.string()),
    }),
    validationMessage: 'BookScout OS could not find the evidence for that item.',
    invoke: (request, payload) => runRead(request, (ctx) => getEvidence(ctx.tenantId, payload.id as number)),
  }),
];

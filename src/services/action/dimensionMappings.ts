import type { AuthContext } from '../../auth/guard.js';
import { AuthError } from '../../auth/guard.js';
import { ServiceError, toActorContext } from '../index.js';
import { jsonResponse, errorResponse, readContext } from '../read/http.js';
import {
  listDimensionMappings,
  acceptDimensionMapping,
  selectAlternateDimensionMapping,
  correctDimensionMapping,
  saveDimensionMappingRule,
  rejectDimensionMapping,
  type SelectAlternateDimensionMappingInput,
} from '../dimensionMappings.js';
import { qboDimensionProviderValidator } from '../../mapping/dimensionEntityDiscovery.js';
import type { DimensionMappingRow, DimensionMappingRuleRow } from '../../mapping/dimensionMappingStore.js';

/**
 * F_DIMENSION_MAPPING_API action bridge — same shape as the F_TAX_MAPPING_API bridge:
 * ALL logic (auth, body parsing, error->HTTP mapping) lives here where lint/typecheck/test
 * cover it; `app/api/dimension-mappings/**` route files only wire a path to one `run*`
 * function. Every route is owner_controller-only, matching the tax-mapping precedent.
 */

function serviceErrorResponse(err: ServiceError): Response {
  const status = err.code.endsWith('_not_found')
    ? 404
    : err.code === 'read_back_failed'
      ? 500
      : 400;
  return errorResponse(err.code.toUpperCase(), err.message, status);
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text || text.trim() === '') return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function runDimensionMappingAction(
  request: Request,
  handler: (ctx: AuthContext, body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> {
  let ctx: AuthContext;
  try {
    ctx = await readContext(request, 'owner_controller');
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'auth failed', 500);
  }
  let body: Record<string, unknown>;
  try {
    body = await parseBody(request);
  } catch {
    return errorResponse('VALIDATION', 'invalid JSON body', 400);
  }
  try {
    return await handler(ctx, body);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    if (err instanceof ServiceError) return serviceErrorResponse(err);
    return errorResponse('INTERNAL', 'dimension mapping action failed', 500);
  }
}

async function runDimensionMappingRead(
  request: Request,
  handler: (ctx: AuthContext) => Promise<Response>,
): Promise<Response> {
  let ctx: AuthContext;
  try {
    ctx = await readContext(request, 'owner_controller');
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    return errorResponse('INTERNAL', 'auth failed', 500);
  }
  try {
    return await handler(ctx);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.code, err.message, err.status);
    if (err instanceof ServiceError) return serviceErrorResponse(err);
    return errorResponse('INTERNAL', 'dimension mapping read failed', 500);
  }
}

function mappingJson(row: DimensionMappingRow) {
  return {
    id: row.id,
    connection_id: row.connectionId,
    provider: row.provider,
    proposal_id: row.proposalId,
    dimension_type: row.dimensionType,
    raw_value: row.rawValue,
    normalized_value: row.normalizedValue,
    source_evidence: row.sourceEvidence,
    extraction_confidence: row.extractionConfidence,
    proposed_provider_id: row.proposedProviderId,
    proposed_match_label: row.proposedMatchLabel,
    provider_id: row.providerId,
    mapping_method: row.mappingMethod,
    review_status: row.reviewStatus,
    resolution_state: row.resolutionState,
    active: row.active,
    mapping_version: row.mappingVersion,
    revalidated_at: row.revalidatedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function ruleJson(row: DimensionMappingRuleRow) {
  return {
    id: row.id,
    connection_id: row.connectionId,
    provider: row.provider,
    dimension_type: row.dimensionType,
    normalized_value: row.normalizedValue,
    raw_value: row.rawValue,
    provider_id: row.providerId,
    provider_label: row.providerLabel,
    mapping_method: row.mappingMethod,
    active: row.active,
    mapping_version: row.mappingVersion,
    created_from_id: row.createdFromId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function numField(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ServiceError('VALIDATION', `${field} must be a number`);
  return n;
}

// --- GET /api/dimension-mappings -----------------------------------------------------------

export async function runListDimensionMappings(request: Request): Promise<Response> {
  return runDimensionMappingRead(request, async (ctx) => {
    const url = new URL(request.url);
    const connectionIdRaw = url.searchParams.get('connectionId');
    const rows = await listDimensionMappings(toActorContext(ctx), {
      connectionId: connectionIdRaw ? numField(connectionIdRaw, 'connectionId') : undefined,
      dimensionType: url.searchParams.get('dimensionType') ?? undefined,
      reviewStatus: url.searchParams.get('reviewStatus') ?? undefined,
      resolutionState: url.searchParams.get('resolutionState') ?? undefined,
      provider: url.searchParams.get('provider') ?? undefined,
    });
    return jsonResponse({ mappings: rows.map(mappingJson) });
  });
}

// --- POST /api/dimension-mappings/:id/accept -----------------------------------------------

export async function runAcceptDimensionMapping(request: Request, id: number): Promise<Response> {
  return runDimensionMappingAction(request, async (ctx, body) => {
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const row = await acceptDimensionMapping(toActorContext(ctx), id, { reason });
    return jsonResponse({ mapping: mappingJson(row) });
  });
}

// --- POST /api/dimension-mappings/:id/select-alternate --------------------------------------

export async function runSelectAlternateDimensionMapping(request: Request, id: number): Promise<Response> {
  return runDimensionMappingAction(request, async (ctx, body) => {
    const input: SelectAlternateDimensionMappingInput = {
      providerId: typeof body.providerId === 'string' ? body.providerId : undefined,
      providerLabel: typeof body.providerLabel === 'string' ? body.providerLabel : undefined,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    };
    const row = await selectAlternateDimensionMapping(toActorContext(ctx), id, input, qboDimensionProviderValidator);
    return jsonResponse({ mapping: mappingJson(row) });
  });
}

// --- POST /api/dimension-mappings/:id/correct ------------------------------------------------

export async function runCorrectDimensionMapping(request: Request, id: number): Promise<Response> {
  return runDimensionMappingAction(request, async (ctx, body) => {
    const row = await correctDimensionMapping(toActorContext(ctx), id, {
      normalizedValue: String(body.normalizedValue ?? ''),
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    });
    return jsonResponse({ mapping: mappingJson(row) });
  });
}

// --- POST /api/dimension-mappings/:id/save-rule -----------------------------------------------

export async function runSaveRuleDimensionMapping(request: Request, id: number): Promise<Response> {
  return runDimensionMappingAction(request, async (ctx, body) => {
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const rule = await saveDimensionMappingRule(toActorContext(ctx), id, { reason });
    return jsonResponse({ rule: ruleJson(rule) }, 201);
  });
}

// --- POST /api/dimension-mappings/:id/reject --------------------------------------------------

export async function runRejectDimensionMapping(request: Request, id: number): Promise<Response> {
  return runDimensionMappingAction(request, async (ctx, body) => {
    const reason = typeof body.reason === 'string' ? body.reason : '';
    const status = body.status === 'held' ? 'held' : 'rejected';
    const row = await rejectDimensionMapping(toActorContext(ctx), id, { status, reason });
    return jsonResponse({ mapping: mappingJson(row) });
  });
}

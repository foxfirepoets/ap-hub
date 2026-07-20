import type { AuthContext } from '../../auth/guard.js';
import { AuthError } from '../../auth/guard.js';
import { ServiceError, toActorContext } from '../index.js';
import { jsonResponse, errorResponse, readContext } from '../read/http.js';
import {
  createTaxMapping,
  editTaxMapping,
  disableTaxMapping,
  replaceTaxMapping,
  revalidateTaxMapping,
  getTaxMapping,
  listTaxMappings,
  listTaxMappingAudit,
  type CreateTaxMappingInput,
  type EditTaxMappingInput,
  type ReplaceTaxMappingInput,
} from '../taxMappings.js';
import { discoverQboTaxCodes, validateQboTaxCode, qboProviderCodeValidator } from '../../mapping/taxCodeDiscovery.js';
import type { TaxMappingRow, TaxMappingAuditRow } from '../../mapping/taxMappingStore.js';

/**
 * F_TAX_MAPPING_API action bridge — same shape as CHUNK_4/CHUNK_6 action bridges: ALL
 * logic (auth, body parsing, error→HTTP mapping) lives here where lint/typecheck/test
 * cover it; `app/api/tax-mappings/**` route files only wire a path to one `run*`
 * function. Every route is owner_controller-only ("Owner/admin-only" in the task spec,
 * mapped onto the existing role model — no parallel admin concept is introduced).
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

async function runTaxMappingAction(
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
    return errorResponse('INTERNAL', 'tax mapping action failed', 500);
  }
}

async function runTaxMappingRead(request: Request, handler: (ctx: AuthContext) => Promise<Response>): Promise<Response> {
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
    return errorResponse('INTERNAL', 'tax mapping read failed', 500);
  }
}

function mappingJson(row: TaxMappingRow) {
  return {
    id: row.id,
    connection_id: row.connectionId,
    provider: row.provider,
    provider_tax_code: row.providerTaxCode,
    internal_tax_treatment: row.internalTaxTreatment,
    tax_mode: row.taxMode,
    applies_at: row.appliesAt,
    active: row.active,
    needs_revalidation: row.needsRevalidation,
    superseded_by_id: row.supersededById,
    replaced_at: row.replacedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function auditRowJson(row: TaxMappingAuditRow) {
  return {
    id: row.id,
    tax_mapping_id: row.taxMappingId,
    connection_id: row.connectionId,
    provider: row.provider,
    changed_by: row.changedBy,
    action: row.action,
    reason: row.reason,
    changed_at: row.changedAt,
  };
}

function numField(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ServiceError('VALIDATION', `${field} must be a number`);
  return n;
}

// --- GET /api/tax-mappings ------------------------------------------------------------

export async function runListTaxMappings(request: Request): Promise<Response> {
  return runTaxMappingRead(request, async (ctx) => {
    const url = new URL(request.url);
    const connectionIdRaw = url.searchParams.get('connectionId');
    const filterRaw = url.searchParams.get('filter');
    const filter = filterRaw === 'all' || filterRaw === 'exception' ? filterRaw : 'active';
    const rows = await listTaxMappings(toActorContext(ctx), {
      connectionId: connectionIdRaw ? numField(connectionIdRaw, 'connectionId') : undefined,
      filter,
      provider: url.searchParams.get('provider') ?? undefined,
    });
    return jsonResponse({ mappings: rows.map(mappingJson), filter });
  });
}

// --- POST /api/tax-mappings ------------------------------------------------------------

export async function runCreateTaxMapping(request: Request): Promise<Response> {
  return runTaxMappingAction(request, async (ctx, body) => {
    const input: CreateTaxMappingInput = {
      connectionId: numField(body.connectionId, 'connectionId'),
      provider: String(body.provider ?? ''),
      providerTaxCode: String(body.providerTaxCode ?? ''),
      internalTaxTreatment: String(body.internalTaxTreatment ?? ''),
      taxMode: String(body.taxMode ?? ''),
      appliesAt: typeof body.appliesAt === 'string' ? body.appliesAt : undefined,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    };
    const row = await createTaxMapping(toActorContext(ctx), input);
    return jsonResponse({ mapping: mappingJson(row) }, 201);
  });
}

// --- GET /api/tax-mappings/:id ----------------------------------------------------------

export async function runGetTaxMapping(request: Request, id: number): Promise<Response> {
  return runTaxMappingRead(request, async (ctx) => {
    const row = await getTaxMapping(toActorContext(ctx), id);
    if (!row) return errorResponse('NOT_FOUND', 'tax mapping not found', 404);
    return jsonResponse({ mapping: mappingJson(row) });
  });
}

// --- GET /api/tax-mappings/:id/audit -----------------------------------------------------

export async function runGetTaxMappingAudit(request: Request, id: number): Promise<Response> {
  return runTaxMappingRead(request, async (ctx) => {
    const rows = await listTaxMappingAudit(toActorContext(ctx), id);
    return jsonResponse({ audit: rows.map(auditRowJson) });
  });
}

// --- POST /api/tax-mappings/:id/edit -----------------------------------------------------

export async function runEditTaxMapping(request: Request, id: number): Promise<Response> {
  return runTaxMappingAction(request, async (ctx, body) => {
    const input: EditTaxMappingInput = {
      internalTaxTreatment: typeof body.internalTaxTreatment === 'string' ? body.internalTaxTreatment : undefined,
      taxMode: typeof body.taxMode === 'string' ? body.taxMode : undefined,
      appliesAt: typeof body.appliesAt === 'string' ? body.appliesAt : undefined,
      reason: typeof body.reason === 'string' ? body.reason : '',
    };
    const row = await editTaxMapping(toActorContext(ctx), id, input);
    return jsonResponse({ mapping: mappingJson(row) });
  });
}

// --- POST /api/tax-mappings/:id/disable --------------------------------------------------

export async function runDisableTaxMapping(request: Request, id: number): Promise<Response> {
  return runTaxMappingAction(request, async (ctx, body) => {
    const reason = typeof body.reason === 'string' ? body.reason : '';
    const row = await disableTaxMapping(toActorContext(ctx), id, reason);
    return jsonResponse({ mapping: mappingJson(row) });
  });
}

// --- POST /api/tax-mappings/:id/replace --------------------------------------------------

export async function runReplaceTaxMapping(request: Request, id: number): Promise<Response> {
  return runTaxMappingAction(request, async (ctx, body) => {
    const input: ReplaceTaxMappingInput = {
      providerTaxCode: typeof body.providerTaxCode === 'string' ? body.providerTaxCode : undefined,
      internalTaxTreatment: String(body.internalTaxTreatment ?? ''),
      taxMode: String(body.taxMode ?? ''),
      appliesAt: typeof body.appliesAt === 'string' ? body.appliesAt : undefined,
      reason: typeof body.reason === 'string' ? body.reason : '',
    };
    const result = await replaceTaxMapping(toActorContext(ctx), id, input);
    return jsonResponse({ old: mappingJson(result.old), replacement: mappingJson(result.replacement) }, 201);
  });
}

// --- POST /api/tax-mappings/:id/revalidate -----------------------------------------------

export async function runRevalidateTaxMapping(request: Request, id: number): Promise<Response> {
  return runTaxMappingAction(request, async (ctx, body) => {
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const row = await revalidateTaxMapping(toActorContext(ctx), id, { reason }, qboProviderCodeValidator);
    return jsonResponse({ mapping: mappingJson(row) });
  });
}

// --- GET /api/tax-mappings/discover -------------------------------------------------------

export async function runDiscoverTaxCodes(request: Request): Promise<Response> {
  return runTaxMappingRead(request, async (ctx) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    if (code) {
      const result = await validateQboTaxCode(ctx.tenantId, code);
      return jsonResponse({ code, ...result });
    }
    const codes = await discoverQboTaxCodes(ctx.tenantId);
    return jsonResponse({ taxCodes: codes });
  });
}

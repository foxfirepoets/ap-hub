import { writeAudit } from '../audit.js';
import { requirePermission, type AuthContext, type Permission } from '../auth/guard.js';

/**
 * CHUNK_2_SERVICES — the shared service layer. The CLI, the pipeline, and the (future)
 * API all call these functions; there is never a second implementation of a guarded
 * effect. Every mutation is tenant-scoped and is wrapped in `withAudit`, which appends
 * one `audit_log` row with the REAL human actor around the mutation.
 */

export interface ActorContext {
  userId: number;
  tenantId: number;
  role: string;
  /** Preferred human-readable audit actor (mirrors the auth.login actor). */
  email?: string;
  /** Explicit audit-actor override for non-user callers (e.g. the operator CLI). */
  actor?: string;
}

/** Adapt an auth guard context (session-resolved) into a service ActorContext. */
export function toActorContext(ctx: AuthContext): ActorContext {
  return { userId: ctx.userId, tenantId: ctx.tenantId, role: ctx.role, email: ctx.email };
}

/** The label recorded as `audit_log.actor` — an identifiable human, never 'system'. */
export function actorLabel(ctx: ActorContext): string {
  return ctx.actor ?? ctx.email ?? `user:${ctx.userId}`;
}

/** Enforce the role→permission matrix inside the service (defence in depth). Throws 403. */
export function ensurePermission(ctx: ActorContext, permission: Permission): void {
  const authCtx: AuthContext = {
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    role: ctx.role,
    email: ctx.email ?? '',
  };
  requirePermission(authCtx, permission);
}

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'ServiceError';
    this.code = code;
  }
}

/**
 * True for a usable entity id. Accepts a positive integer as a number OR a
 * numeric string — pg returns `bigint` columns as strings, so ids threaded from
 * the DB arrive as strings, while route params arrive as `Number(...)` (NaN if
 * the segment was non-numeric). Both forms are validated the same way, matching
 * the numeric-string tolerance of `scopedQuery`.
 */
export function isValidId(id: number | string): boolean {
  const n = typeof id === 'number' ? id : Number(id);
  return Number.isInteger(n) && n > 0;
}

/** Guard an action-path id: a non-numeric route segment → 400 VALIDATION, not a 500. */
export function assertEntityId(id: number | string): void {
  if (!isValidId(id)) throw new ServiceError('VALIDATION', 'invalid id');
}

/**
 * Run a mutation and, on success, append exactly one human-actor `audit_log` row.
 * A thrown mutation writes no audit row (nothing changed).
 */
export async function withAudit<T>(
  ctx: ActorContext,
  action: string,
  entity: string,
  fn: () => Promise<T>,
  detailOf?: (result: T) => Record<string, unknown>,
): Promise<T> {
  const result = await fn();
  await writeAudit({
    tenantId: ctx.tenantId,
    actor: actorLabel(ctx),
    action,
    entity,
    detail: { role: ctx.role, ...(detailOf ? detailOf(result) : {}) },
  });
  return result;
}

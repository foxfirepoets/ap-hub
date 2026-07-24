import { validateSession, type SessionReason } from './session.js';

/**
 * Session + RBAC guard (CHUNK_1_AUTH). `requireSession(token, role?)` resolves the
 * caller to a tenant-scoped AuthContext or throws an AuthError with the exact code
 * the API contract requires:
 *   - no/unknown/revoked token → 401 UNAUTHENTICATED
 *   - expired session          → 401 SESSION_EXPIRED
 *   - disabled user            → 401 UNAUTHENTICATED
 *   - role mismatch            → 403 FORBIDDEN
 *
 * Every later action/read route calls this before doing anything (spec §14: no route
 * ships before this guard exists).
 */

export const ROLES = ['owner_controller', 'bookkeeper', 'cpa'] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'read'
  | 'approve'
  | 'reject'
  | 'remap'
  | 'learn'
  | 'retry'
  | 'reply'
  | 'draft_reply'
  | 'onboard'
  | 'tax_mapping'
  | 'dimension_mapping';

/** Role → permission matrix. CPA is read-only; bookkeeper cannot approve→post. */
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner_controller: new Set<Permission>([
    'read', 'approve', 'reject', 'remap', 'learn', 'retry', 'reply', 'draft_reply', 'onboard', 'tax_mapping', 'dimension_mapping',
  ]),
  bookkeeper: new Set<Permission>(['read', 'reject', 'remap', 'learn', 'draft_reply']),
  cpa: new Set<Permission>(['read']),
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function can(role: string, permission: Permission): boolean {
  return isRole(role) && ROLE_PERMISSIONS[role].has(permission);
}

export type AuthErrorCode = 'UNAUTHENTICATED' | 'SESSION_EXPIRED' | 'FORBIDDEN';

export class AuthError extends Error {
  readonly status: number;
  readonly code: AuthErrorCode;
  constructor(status: number, code: AuthErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

export interface AuthContext {
  userId: number;
  tenantId: number;
  role: string;
  email: string;
}

function reasonToError(reason: SessionReason): AuthError {
  if (reason === 'expired') return new AuthError(401, 'SESSION_EXPIRED');
  return new AuthError(401, 'UNAUTHENTICATED');
}

/**
 * Resolve a raw session token to an AuthContext, optionally enforcing a role.
 * `role` may be a single role or a set of allowed roles.
 */
export async function requireSession(
  rawToken: string | null | undefined,
  role?: Role | readonly Role[],
): Promise<AuthContext> {
  if (!rawToken) throw new AuthError(401, 'UNAUTHENTICATED');
  const result = await validateSession(rawToken);
  if (!result.ok) throw reasonToError(result.reason);

  const ctx: AuthContext = {
    userId: result.session.userId,
    tenantId: result.session.tenantId,
    role: result.session.role,
    email: result.session.email,
  };

  if (role !== undefined) {
    const allowed = Array.isArray(role) ? role : [role as Role];
    if (!allowed.includes(ctx.role as Role)) {
      throw new AuthError(403, 'FORBIDDEN');
    }
  }
  return ctx;
}

/** Throw 403 unless the context's role holds the given permission. */
export function requirePermission(ctx: AuthContext, permission: Permission): void {
  if (!can(ctx.role, permission)) throw new AuthError(403, 'FORBIDDEN');
}

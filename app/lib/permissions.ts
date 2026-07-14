// UI-side role gating for button visibility ONLY. This MIRRORS the authoritative role
// matrix in src/auth/guard.ts (ROLE_PERMISSIONS). Server routes remain the single source
// of truth — every action re-checks the role and rejects 403; hiding a button never grants
// access. Roles are config/data-driven; no tenant-specific value is encoded here.

export function canApprovePost(role: string): boolean {
  return role === 'owner_controller';
}

// reject / remap / learn — bookkeeper and owner may review; cpa may not.
export function canReview(role: string): boolean {
  return role === 'owner_controller' || role === 'bookkeeper';
}

export function isReadOnly(role: string): boolean {
  return !canReview(role);
}

# CHUNK_1_AUTH: Add Google-SSO login with tenant-scoped, role-based sessions

## Summary

Builds the human-identity foundation the whole UX layer depends on: `users` and `sessions` tables, Google SSO login (reusing existing Google OAuth infra), and session middleware that authenticates every request, resolves the role, and scopes it to exactly one `tenant_id`. Comes first because no read or action route may exist without it. Hands off a `requireSession(role?)` guard the later chunks apply to every route.

## Acceptance Criteria

- [ ] Migration creates `users` and `sessions` tables (see Database Changes); `npm run migrate:up` is idempotent and reversible.
- [ ] Google SSO login issues an httpOnly, Secure, SameSite=Lax cookie; only the sha256 hash is stored in `sessions`.
- [ ] Session middleware rejects unauthenticated requests to protected routes with exactly `401 UNAUTHENTICATED`.
- [ ] Role model enforced: `owner_controller`, `bookkeeper`, `cpa`; a `requireRole()` helper returns `403 FORBIDDEN` on mismatch.
- [ ] Every session carries a `tenant_id`; a scoped-query helper filters by it.
- [ ] Logout revokes the session; a disabled user's sessions are invalid on next request.
- [ ] All tests pass with zero failures (including the existing six-guarantee suite).

## Endpoints / Interfaces

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/auth/login | Redirect to Google SSO |
| GET | /api/auth/callback | Google callback → create session + cookie |
| POST | /api/auth/logout | Revoke current session |
| — | requireSession(role?) | Middleware/guard used by all later routes |

## Database Changes

- `users`: id, tenant_id (FK tenants), email, name, role, google_sub, status; UNIQUE(tenant_id, email) (NEW)
- `sessions`: id, user_id (FK users), token_hash, expires_at, revoked; UNIQUE(token_hash) (NEW)
- Indexes: `idx_users_tenant`, `idx_sessions_user` (NEW)

## Test Scenarios

- **Happy path**: valid Google login → session cookie set → protected route returns 200 scoped to the user's tenant.
- **Edge case**: expired session → 401 SESSION_EXPIRED; disabled user mid-session → 401 on next request.
- **Failure case**: unauthenticated request → 401 UNAUTHENTICATED; wrong role → 403 FORBIDDEN.
- **Integration**: exposes `requireSession(role?)` and the tenant-scoped query helper consumed by CHUNK_3/4.

## Dependencies

- **Requires**: None (existing backend + Google OAuth infra assumed present)
- **Blocks**: CHUNK_2_SERVICES, CHUNK_3_READ, CHUNK_4_ACTION, CHUNK_5_FRONTEND, CHUNK_6_ONBOARDING, CHUNK_7_DIGEST

## Completion Promise

<promise>CHUNK COMPLETE: CHUNK_1_AUTH</promise>

import { runRead } from '../../../src/services/read/index.js';

// GET /api/me — the session's identity + role, for the UI's client-side auth guard
// and role-based button gating. No new logic: `runRead` resolves the session cookie to
// an AuthContext (401 if unauthenticated) and this handler just echoes the safe fields.
export async function GET(request: Request): Promise<Response> {
  return runRead(request, async (ctx) => ({
    email: ctx.email,
    role: ctx.role,
    tenantId: ctx.tenantId,
  }));
}

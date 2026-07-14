import { runRead, listAudit } from '../../../src/services/read/index.js';

// GET /api/audit?action=&entity= — read-only audit trail for the session tenant.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const action = url.searchParams.get('action') ?? undefined;
  const entity = url.searchParams.get('entity') ?? undefined;
  return runRead(request, (ctx) => listAudit(ctx.tenantId, { action, entity }));
}

import { runRead, getToday } from '../../../src/services/read/index.js';

// GET /api/today — digest + counts + item list for the session tenant (any role).
export async function GET(request: Request): Promise<Response> {
  return runRead(request, (ctx) => getToday(ctx.tenantId));
}

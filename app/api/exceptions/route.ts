import { runRead, listExceptions } from '../../../src/services/read/index.js';

// GET /api/exceptions?status=open — exception queue for the session tenant.
export async function GET(request: Request): Promise<Response> {
  const status = new URL(request.url).searchParams.get('status') ?? undefined;
  return runRead(request, (ctx) => listExceptions(ctx.tenantId, { status }));
}

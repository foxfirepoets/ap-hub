import { runRead, listTransactions, type UxStatus } from '../../../src/services/read/index.js';

// GET /api/transactions?status=posted — transaction list for the session tenant.
export async function GET(request: Request): Promise<Response> {
  const status = (new URL(request.url).searchParams.get('status') ?? undefined) as UxStatus | undefined;
  return runRead(request, (ctx) => listTransactions(ctx.tenantId, { status }));
}

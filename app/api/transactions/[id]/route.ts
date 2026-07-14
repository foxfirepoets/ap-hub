import { runRead, getTransactionById } from '../../../../src/services/read/index.js';

// GET /api/transactions/:id — single transaction detail (404 if not in tenant).
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  return runRead(request, (ctx) => getTransactionById(ctx.tenantId, id));
}

import { runRead, getExceptionById } from '../../../../src/services/read/index.js';

// GET /api/exceptions/:id — single exception detail (404 if not in tenant).
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  return runRead(request, (ctx) => getExceptionById(ctx.tenantId, id));
}

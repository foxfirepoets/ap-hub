import { runRead, getEvidence } from '../../../../../src/services/read/index.js';

// GET /api/items/:id/evidence — full evidence chain for an item (404 if not in tenant).
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  return runRead(request, (ctx) => getEvidence(ctx.tenantId, id));
}

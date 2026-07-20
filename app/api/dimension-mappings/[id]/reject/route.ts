import { runRejectDimensionMapping } from '../../../../../src/services/action/index.js';

// POST /api/dimension-mappings/:id/reject — owner_controller only. Body: { reason,
// status?: 'rejected'|'held' } (default 'rejected'); `reason` is required (400 if missing).
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  return runRejectDimensionMapping(request, id);
}

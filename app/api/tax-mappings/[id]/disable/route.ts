import { runDisableTaxMapping } from '../../../../../src/services/action/index.js';

// POST /api/tax-mappings/:id/disable — owner_controller only; `reason` is required (400 if missing).
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  return runDisableTaxMapping(request, id);
}

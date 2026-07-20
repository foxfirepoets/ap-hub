import { runEditTaxMapping } from '../../../../../src/services/action/index.js';

// POST /api/tax-mappings/:id/edit — owner_controller only; `reason` is required (400 if missing).
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  return runEditTaxMapping(request, id);
}

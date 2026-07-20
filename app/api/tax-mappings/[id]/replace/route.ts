import { runReplaceTaxMapping } from '../../../../../src/services/action/index.js';

// POST /api/tax-mappings/:id/replace — owner_controller only; `reason` is required (400 if
// missing). Creates a new active mapping row and marks the old one superseded (never a DELETE).
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  return runReplaceTaxMapping(request, id);
}

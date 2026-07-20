import { runRevalidateTaxMapping } from '../../../../../src/services/action/index.js';

// POST /api/tax-mappings/:id/revalidate — owner_controller only; re-checks the provider tax
// code against QBO and flips active/needs_revalidation accordingly (fail-closed on any doubt).
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  return runRevalidateTaxMapping(request, id);
}

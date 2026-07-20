import { runGetTaxMapping } from '../../../../src/services/action/index.js';

// GET /api/tax-mappings/:id — single tax mapping detail (404 if not in tenant).
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  return runGetTaxMapping(request, id);
}

import { runGetTaxMappingAudit } from '../../../../../src/services/action/index.js';

// GET /api/tax-mappings/:id/audit — who/when/why/action trail for one tax mapping (404 if not in tenant).
export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  return runGetTaxMappingAudit(request, id);
}

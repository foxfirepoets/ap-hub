import { runSaveRuleDimensionMapping } from '../../../../../src/services/action/index.js';

// POST /api/dimension-mappings/:id/save-rule — owner_controller only. Saves the mapping's
// resolved provider_id as a reusable dimension_mapping_rules row, scoped to
// (tenant, connection, provider, dimension_type, normalized_value) — never cross-company.
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  return runSaveRuleDimensionMapping(request, id);
}

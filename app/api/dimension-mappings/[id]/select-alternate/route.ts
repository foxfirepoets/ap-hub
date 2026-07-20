import { runSelectAlternateDimensionMapping } from '../../../../../src/services/action/index.js';

// POST /api/dimension-mappings/:id/select-alternate — owner_controller only. Body:
// { providerId?, providerLabel?, reason? } — re-runs READ-ONLY provider discovery/validation
// (src/mapping/dimensionEntityDiscovery.ts) before writing provider_id; never guesses.
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  return runSelectAlternateDimensionMapping(request, id);
}

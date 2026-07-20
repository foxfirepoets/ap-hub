import { runAcceptDimensionMapping } from '../../../../../src/services/action/index.js';

// POST /api/dimension-mappings/:id/accept — owner_controller only. Accepts the proposed
// mapping: review_status -> 'accepted', provider_id <- proposed_provider_id.
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  return runAcceptDimensionMapping(request, id);
}

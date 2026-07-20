import { runCorrectDimensionMapping } from '../../../../../src/services/action/index.js';

// POST /api/dimension-mappings/:id/correct — owner_controller only. Body: { normalizedValue,
// reason? } — corrects the extracted value: review_status -> 'corrected'.
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const id = Number(params.id);
  return runCorrectDimensionMapping(request, id);
}

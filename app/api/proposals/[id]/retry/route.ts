import { runRetry } from '../../../../../src/services/action/index.js';

// POST /api/proposals/:id/retry — owner_controller only: safe re-post via the same key.
export async function POST(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  return runRetry(request, Number(params.id));
}

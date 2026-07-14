import { runReject } from '../../../../../src/services/action/index.js';

// POST /api/proposals/:id/reject — owner_controller | bookkeeper: reject / mark duplicate.
export async function POST(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  return runReject(request, Number(params.id));
}

import { runApprove } from '../../../../../src/services/action/index.js';

// POST /api/proposals/:id/approve — owner_controller only: approve → post to QBO sandbox.
export async function POST(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  return runApprove(request, Number(params.id));
}

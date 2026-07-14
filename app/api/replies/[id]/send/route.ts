import { runSendReply } from '../../../../../src/services/action/index.js';

// POST /api/replies/:id/send — owner_controller only: release a held gatekeeper forward via
// the locked forwarder. No recipient field is accepted (send-lockdown, guarantee 2).
export async function POST(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  return runSendReply(request, Number(params.id));
}

import { runQboConnectStart } from '../../../../../src/services/action/index.js';

// GET /api/connections/qbo/start — session-gated (owner_controller); 302 to the real
// Intuit OAuth consent URL, signed with the caller's SESSION-resolved tenant id.
export async function GET(request: Request): Promise<Response> {
  return runQboConnectStart(request);
}

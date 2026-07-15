import { runGmailConnectStart } from '../../../../../src/services/action/index.js';

// GET /api/connections/gmail/start — session-gated (owner_controller); 302 to the real
// Google OAuth consent URL, signed with the caller's SESSION-resolved tenant id.
export async function GET(request: Request): Promise<Response> {
  return runGmailConnectStart(request);
}

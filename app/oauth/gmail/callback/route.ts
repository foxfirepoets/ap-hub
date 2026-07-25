import { runGmailOAuthCallback } from '../../../../src/services/action/oauth-callback.js';

// Public OAuth return endpoint. The existing callback service validates the persisted,
// single-use state against the initiating signed session before storing any token.
export async function GET(request: Request): Promise<Response> {
  return runGmailOAuthCallback(request);
}

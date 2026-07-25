import { runQboOAuthCallback } from '../../../../src/services/action/oauth-callback.js';

// Public OAuth return endpoint. Company and realm verification remain in the shared QBO
// callback service; this route only adapts it to the Next.js/Vercel request boundary.
export async function GET(request: Request): Promise<Response> {
  return runQboOAuthCallback(request);
}

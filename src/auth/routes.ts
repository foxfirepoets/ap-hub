import { registerRoute } from '../http.js';
import { readSessionCookie, validateSession } from './session.js';

/**
 * OAuth callback routes. Registered by CHUNK_2 (Gmail + QBO). Kept in its own module
 * so the HTTP layer (CHUNK_1) has no auth knowledge.
 */
let registered = false;

export function registerAuthRoutes(): void {
  if (registered) return;
  registered = true;

  registerRoute(async (method, url, respond, redirect, req) => {
    const resolveSessionId = async (): Promise<number | null> => {
      const token = readSessionCookie(req.headers.cookie);
      if (!token) return null;
      const result = await validateSession(token);
      return result.ok ? result.session.sessionId : null;
    };
    if (method === 'GET' && url.pathname === '/oauth/gmail/callback') {
      const { handleGmailCallback } = await import('./gmail-oauth.js');
      await handleGmailCallback(url, respond, redirect, (await resolveSessionId()) ?? 0);
      return true;
    }
    if (method === 'GET' && url.pathname === '/oauth/qbo/callback') {
      const { handleQboCallback } = await import('./qbo-oauth.js');
      await handleQboCallback(url, respond, redirect, (await resolveSessionId()) ?? 0);
      return true;
    }
    return false;
  });
}

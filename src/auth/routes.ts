import { registerRoute } from '../http.js';

/**
 * OAuth callback routes. Registered by CHUNK_2 (Gmail + QBO). Kept in its own module
 * so the HTTP layer (CHUNK_1) has no auth knowledge.
 */
let registered = false;

export function registerAuthRoutes(): void {
  if (registered) return;
  registered = true;

  registerRoute(async (method, url, respond) => {
    if (method === 'GET' && url.pathname === '/oauth/gmail/callback') {
      const { handleGmailCallback } = await import('./gmail-oauth.js');
      await handleGmailCallback(url, respond);
      return true;
    }
    if (method === 'GET' && url.pathname === '/oauth/qbo/callback') {
      const { handleQboCallback } = await import('./qbo-oauth.js');
      await handleQboCallback(url, respond);
      return true;
    }
    return false;
  });
}

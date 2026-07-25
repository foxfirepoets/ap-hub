import { readSessionCookie, validateSession } from '../../auth/session.js';
import { handleGmailCallback } from '../../auth/gmail-oauth.js';
import { handleQboCallback } from '../../auth/qbo-oauth.js';

type OAuthHandler = (
  url: URL,
  respond: (status: number, body: unknown) => void,
  redirect: (location: string) => void,
  expectedSessionId: number,
) => Promise<void>;

async function expectedSessionId(request: Request): Promise<number> {
  const token = readSessionCookie(request.headers.get('cookie'));
  if (!token) return 0;
  const result = await validateSession(token);
  return result.ok ? result.session.sessionId : 0;
}

async function runOAuthCallback(request: Request, handler: OAuthHandler): Promise<Response> {
  let result: Response | null = null;
  const respond = (status: number, body: unknown) => {
    result = new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const redirect = (location: string) => {
    result = new Response(null, { status: 302, headers: { location } });
  };

  await handler(new URL(request.url), respond, redirect, await expectedSessionId(request));
  return result ?? new Response(
    JSON.stringify({ error: 'oauth_callback_incomplete' }),
    { status: 500, headers: { 'content-type': 'application/json' } },
  );
}

/** Vercel/Next entry point for the existing Gmail callback implementation. */
export function runGmailOAuthCallback(request: Request): Promise<Response> {
  return runOAuthCallback(request, handleGmailCallback);
}

/** Vercel/Next entry point for the existing QBO callback implementation. */
export function runQboOAuthCallback(request: Request): Promise<Response> {
  return runOAuthCallback(request, handleQboCallback);
}

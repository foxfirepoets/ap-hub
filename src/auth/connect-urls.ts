import type { Config } from '../config.js';

/**
 * Shared Gmail/QBO OAuth authorize-URL builders (CHUNK_4_STARTROUTES). Single source of
 * truth for the URL shape — used by both the CLI's `connect` command and the new
 * session-gated `app/api/connections/{gmail,qbo}/start` routes. `state` is always the caller's
 * signed CHUNK_1 connect-state token; nothing here trusts unsigned input.
 */

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const QBO_SCOPE = 'com.intuit.quickbooks.accounting';

export function buildGmailAuthorizeUrl(cfg: Config, state: string): string {
  return (
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${cfg.GMAIL_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(cfg.GMAIL_REDIRECT_URI)}` +
    `&response_type=code&access_type=offline&prompt=consent` +
    `&scope=${encodeURIComponent(GMAIL_SCOPE)}&state=${encodeURIComponent(state)}`
  );
}

export function buildQboAuthorizeUrl(cfg: Config, state: string): string {
  return (
    `https://appcenter.intuit.com/connect/oauth2?client_id=${cfg.QBO_SANDBOX_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(cfg.QBO_SANDBOX_REDIRECT_URI)}` +
    `&response_type=code&scope=${encodeURIComponent(QBO_SCOPE)}&state=${encodeURIComponent(state)}`
  );
}

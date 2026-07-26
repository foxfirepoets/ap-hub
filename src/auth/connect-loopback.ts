import { randomBytes, createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { config } from '../config.js';
import { writeAudit } from '../audit.js';
import { logger } from '../logger.js';
import { buildGmailAuthorizeUrl, buildQboAuthorizeUrl } from './connect-urls.js';
import { exchangeGmailCode, mergeGmailScopes } from './gmail-oauth.js';
import { exchangeQboCode } from './qbo-oauth.js';
import { loadToken, saveToken, upsertConnection } from './tokens.js';

/**
 * CHUNK_5_CONNECT — the desktop connect flow: system-browser consent + a single-use,
 * ephemeral loopback callback, decoupled from `src/http.ts`'s pre-existing pilot HTTP service
 * and from `src/auth/routes.ts`'s `/oauth/{gmail,qbo}/callback` (the CHUNK_2 web flow, which
 * keeps working unchanged for its own callers).
 *
 * DESIGN DECISION — connect-state custody: `src/auth/connect-state.ts` mints a DB-persisted,
 * session-revalidated state token, built for a web flow whose "start" and "callback" requests
 * can land on different processes minutes apart. This flow never leaves one process: `start`
 * mints the state, opens the browser and stands up the listener in one call, and the listener
 * itself receives the callback — there is no second hop to survive. AP-Hub v1 is also one
 * computer, one OS account (`.ralph/guardrails.md`), so there is no second session to
 * revalidate against. A simpler, in-memory, single-use nonce — scoped to this module, matched
 * by exact string comparison, deleted the instant it is read — is therefore a better fit than
 * reusing `connect-state.ts`: it avoids coupling this flow's 10-minute expiry to the shared
 * 5-minute constant `createConnectState` uses for the web flow, and it avoids a DB round trip
 * (and the `oauth_connect_states` schema, sized for multi-session revalidation) for a value
 * that never needs to outlive the single in-process `await`. `connect-state.ts` itself is left
 * untouched.
 */

export type ConnectProvider = 'gmail' | 'qbo';

export interface ConnectFlowActor {
  tenantId: number;
  userId: number;
  sessionId: number;
  email: string;
}

/** The desktop shell's side of this flow: open the user's system browser, and bring the
 * AP-Hub window back to the front once consent completes. Wired once at boot
 * (`desktop/main.ts`) — never a per-call argument, so nothing here can be handed a stand-in in
 * production. */
export interface ConnectFlowHost {
  openExternal(url: string): Promise<void> | void;
  focusWindow(): void;
}

let host: ConnectFlowHost | null = null;

export function configureConnectFlowHost(next: ConnectFlowHost | null): void {
  host = next;
}

/** Thrown when `startConnectFlow` runs with no host configured — always a wiring gap (a
 * desktop boot always configures one), never a user-facing condition on its own. */
export class ConnectFlowNotConfigured extends Error {
  constructor() {
    super('CONNECT_FLOW_NOT_CONFIGURED');
    this.name = 'ConnectFlowNotConfigured';
  }
}

const CALLBACK_PATH = '/callback';
const DEFAULT_FLOW_TIMEOUT_MS = 10 * 60 * 1000;

const CLOSE_PAGE_BODY =
  '<!doctype html><html><head><meta charset="utf-8"><title>AP-Hub</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:2.5rem;color:#1a1a1a">' +
  '<p>You can close this and return to AP-Hub.</p></body></html>';

function randomToken(): string {
  // 32 bytes -> 43 base64url characters: the RFC 7636 PKCE verifier minimum, and (used for
  // `state` too) plenty of entropy for a single-use nonce.
  return randomBytes(32).toString('base64url');
}

function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

interface PendingFlow {
  readonly server: Server;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** One in-flight attempt per provider. Starting a new one for the same provider supersedes —
 * closes and forgets — any prior attempt, rather than racing it. */
const pending = new Map<ConnectProvider, PendingFlow>();

async function closeFlow(provider: ConnectProvider): Promise<void> {
  const flow = pending.get(provider);
  if (!flow) return;
  pending.delete(provider);
  clearTimeout(flow.timer);
  const closed = new Promise<void>((resolve) => flow.server.close(() => resolve()));
  // `close()` alone only stops NEW connections — it waits for existing ones to end, and a
  // keep-alive HTTP client (the system browser, or Node's own `fetch`) can hold its one
  // request/response connection open well past the response being fully sent. This is a
  // single-shot, single-request listener: nothing will ever reuse that connection, so ending
  // it now (rather than "immediately after the exchange", as the spec puts it, but only once a
  // client-side keep-alive timeout happens to elapse) is correct, not just expedient.
  flow.server.closeIdleConnections();
  await closed;
}

/**
 * A state mismatch, a replay, and an expiry are the SAME outcome from the caller's point of
 * view — the attempt did not complete legitimately — and the closed IPC error code for all
 * three is `CONNECT_TIMEOUT` (`desktop/ipc/errors.ts`). Recorded literally in the audit detail,
 * not just in this module's internal `reason` vocabulary, so "refused as CONNECT_TIMEOUT" is a
 * checkable fact about the audit row, not only a comment.
 */
async function auditRefusal(provider: ConnectProvider, actor: ConnectFlowActor, reason: string): Promise<void> {
  await writeAudit({
    tenantId: actor.tenantId,
    actor: actor.email || `user:${actor.userId}`,
    action: `${provider}.connect_refused`,
    entity: provider,
    detail: { code: 'CONNECT_TIMEOUT', reason },
  }).catch(() => {});
}

function respondClosePage(res: ServerResponse): void {
  // `Connection: close` deterministically, rather than merely "eventually once idle": this
  // listener answers exactly one request in its whole lifetime, so there is nothing to keep the
  // socket alive FOR, and closing it here is what lets the tear-down below proceed without
  // waiting on a client-side keep-alive timeout it has no control over.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
  res.end(CLOSE_PAGE_BODY);
}

async function completeGmail(
  actor: ConnectFlowActor,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<void> {
  const tok = await exchangeGmailCode(code, codeVerifier, redirectUri);
  const previous = await loadToken(actor.tenantId, 'gmail');
  const refreshToken = tok.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) throw new Error('Gmail OAuth: token response missing refresh_token');
  await saveToken(actor.tenantId, 'gmail', {
    accessToken: tok.access_token,
    refreshToken,
    expiresAt: tok.expiry_date ? new Date(tok.expiry_date) : null,
    scope: mergeGmailScopes(previous?.scope, tok.scope),
    realm: null,
  });
  // Gmail has no realm/company id the way QBO does; the signed-in account's own email is the
  // closest real identifier, and it is what lets `aphub:connections:status` show Gmail as
  // active — the CHUNK_5 acceptance criterion the old web flow never needed, because it never
  // wrote a `connections` row for gmail at all.
  await upsertConnection(actor.tenantId, 'gmail', actor.email || 'gmail');
  await writeAudit({
    tenantId: actor.tenantId,
    actor: actor.email || `user:${actor.userId}`,
    action: 'gmail.connect',
    entity: 'gmail',
  });
}

async function completeQbo(
  actor: ConnectFlowActor,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  realmIdFromCallback: string | null,
): Promise<void> {
  const cfg = config();
  const tok = await exchangeQboCode(code, redirectUri, globalThis.fetch, codeVerifier);
  // Scope decision: the CHUNK_2 web flow's confirm-realm company-name check
  // (`assertExpectedCompany` in `qbo-oauth.ts`) is pilot-era, single-hardcoded-company
  // machinery, not a CHUNK_5 requirement (the spec's connect-flow acceptance criteria say
  // nothing about it) — this flow stores whatever realm QBO's own consent screen returned.
  const realmId =
    realmIdFromCallback ?? (cfg.QBO_ENV === 'production' ? cfg.QBO_PRODUCTION_REALM_ID : cfg.QBO_SANDBOX_REALM_ID);
  await saveToken(actor.tenantId, 'qbo', {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: new Date(Date.now() + tok.expires_in * 1000),
    scope: 'com.intuit.quickbooks.accounting',
    realm: realmId,
  });
  await upsertConnection(actor.tenantId, 'qbo', realmId);
  await writeAudit({
    tenantId: actor.tenantId,
    actor: actor.email || `user:${actor.userId}`,
    action: 'qbo.connect',
    entity: `realm:${realmId}`,
    realm: realmId,
  });
}

function authorizeUrlFor(
  provider: ConnectProvider,
  state: string,
  redirectUri: string,
  codeChallenge: string,
): string {
  const cfg = config();
  return provider === 'gmail'
    ? buildGmailAuthorizeUrl(cfg, state, { redirectUri, codeChallenge })
    : buildQboAuthorizeUrl(cfg, state, { redirectUri, codeChallenge });
}

export interface StartConnectFlowOptions {
  /** Test seam only: shortens the 10-minute expiry so the timeout path is provable quickly. */
  timeoutMs?: number;
}

/**
 * Open the provider's consent screen in the system browser and stand up the ephemeral loopback
 * listener that will receive its callback. Resolves as soon as the browser has been asked to
 * open — the code exchange, token storage and window focus all happen later, off this call, when
 * (and if) the callback actually arrives.
 */
export async function startConnectFlow(
  provider: ConnectProvider,
  actor: ConnectFlowActor,
  options: StartConnectFlowOptions = {},
): Promise<'browser_opened'> {
  if (host === null) throw new ConnectFlowNotConfigured();
  const activeHost = host;
  await closeFlow(provider);

  const state = randomToken();
  const codeVerifier = randomToken();
  const codeChallenge = codeChallengeS256(codeVerifier);
  let redirectUri = '';
  let settled = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      // Always shown, whatever the outcome — never a raw provider error, a code or a stack
      // trace on this page (`.ralph/guardrails.md`).
      respondClosePage(res);
      if (settled) return; // a repeated hit gets the same page and nothing more (single-use)
      settled = true;

      const receivedState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const errorParam = url.searchParams.get('error');
      const realmId = url.searchParams.get('realmId');

      if (receivedState === null || receivedState !== state) {
        await closeFlow(provider);
        await auditRefusal(provider, actor, 'state_mismatch');
        return;
      }
      // Single-use: the flow is torn down before any async exchange, so a genuine replay of
      // this exact (correct) state — a resent request, the browser back button — finds
      // nothing pending and is refused by the `pending.get` check below, never re-exchanged.
      await closeFlow(provider);

      if (errorParam || !code) {
        await auditRefusal(provider, actor, errorParam ? 'denied' : 'missing_code');
        return;
      }

      try {
        if (provider === 'gmail') await completeGmail(actor, code, codeVerifier, redirectUri);
        else await completeQbo(actor, code, codeVerifier, redirectUri, realmId);
        activeHost.focusWindow();
      } catch (err) {
        logger.warn({ err: String(err) }, `${provider} connect failed`);
        await auditRefusal(provider, actor, 'exchange_failed');
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('AP-Hub could not open a local listener for the sign-in callback.');
  }
  redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;

  const timeoutMs = options.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;
  const timer = setTimeout(() => {
    // Close BEFORE auditing, and in the same order as every other refusal path: the listener
    // is never left running while the audit write is still in flight.
    void (async () => {
      await closeFlow(provider);
      await auditRefusal(provider, actor, 'expired');
    })();
  }, timeoutMs);
  // Ten minutes is a long time for a timer to hold the process open for no other reason;
  // `unref` lets AP-Hub quit in the meantime without waiting on an abandoned sign-in.
  timer.unref?.();

  pending.set(provider, { server, timer });

  const consentUrl = authorizeUrlFor(provider, state, redirectUri, codeChallenge);
  await activeHost.openExternal(consentUrl);
  return 'browser_opened';
}

/** Test/diagnostic seam: whether a provider currently has an in-flight attempt. */
export function hasPendingConnectFlow(provider: ConnectProvider): boolean {
  return pending.has(provider);
}

/** Test seam: force-close every in-flight attempt, so a test that starts a flow but never
 * drives it to completion cannot leak a live listener into the next test. */
export async function closeAllConnectFlows(): Promise<void> {
  await Promise.all([...pending.keys()].map((provider) => closeFlow(provider)));
}

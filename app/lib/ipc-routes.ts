/**
 * CHUNK_3_IPC (B5) — the renderer's path → IPC channel resolver.
 *
 * `app/lib/api.ts` still takes HTTP-shaped paths from 14 page components (`/api/statements/5`,
 * `/api/tax-mappings/discover?code=TAX8`, …) because zero page components change for this
 * chunk. This table is what turns a `(method, path)` pair back into `{ channel, payload }` for
 * `window.aphub.invoke`.
 *
 * ZERO IMPORTS, ON PURPOSE. This ships in the static renderer export — no Node, no bundler
 * module resolution the way the Electron main process has it. It CANNOT import
 * `desktop/ipc/registry.ts` (drags in `zod`) or anything under `src/**`. That means this table
 * duplicates knowledge that already lives in `desktop/ipc/{read,action}/*.ts`'s `pathTemplate`,
 * `method`, `queryParams` and the path-param names each entry's schema requires.
 *
 * The duplication is made safe by `test/ipc-renderer-transport.test.ts`, which — unlike this
 * file — is allowed to import both sides, and asserts every `(method, pathTemplate)` pair here
 * has exactly one match in `READ_ENTRIES`/`ACTION_ENTRIES` and vice versa, and that every
 * `channel` this table can produce is a real member of `IPC_CHANNELS`. Without that test this
 * duplication is a drift risk; with it, a mismatch fails the gate before it ships.
 *
 * Every path param below is numeric: every `:name` segment across all 50 channels resolves to
 * the shared `entityId` primitive (`z.number().int().positive()`) in the registry, never a
 * string id — verified entry by entry while building this table. `resolveRoute` therefore
 * always `Number()`-coerces path segments.
 */

export type IpcMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

type QueryParamType = 'string' | 'number' | 'boolean';

interface RouteSpec {
  readonly method: IpcMethod;
  /** e.g. `/api/statements/:statementId/lines/:lineId/match`. Matched literal-segment-first. */
  readonly pathTemplate: string;
  readonly channel: string;
  /** Query-string keys this channel's schema declares, and how to coerce each one. */
  readonly query?: Readonly<Record<string, QueryParamType>>;
}

/**
 * One entry per `(method, pathTemplate)` pair from `READ_ENTRIES` + `ACTION_ENTRIES`.
 *
 * Order matters for exactly one pair: `/api/tax-mappings/discover` and `/api/tax-mappings/:id`
 * are both two segments under GET, and a `:id` template structurally accepts the literal
 * segment `discover` too. `resolveRoute` matches top-to-bottom, so the literal route MUST
 * precede the parameterized one — `resolveRoute`'s own matcher never prefers a literal match
 * over a param match on its own; the ordering here is what does.
 */
const ROUTES: readonly RouteSpec[] = [
  // --- read domains (desktop/ipc/read/*.ts) --------------------------------------------------
  { method: 'GET', pathTemplate: '/api/today', channel: 'aphub:today:get' },
  {
    method: 'GET',
    pathTemplate: '/api/transactions',
    channel: 'aphub:transactions:list',
    query: { status: 'string' },
  },
  { method: 'GET', pathTemplate: '/api/transactions/:id', channel: 'aphub:transactions:get' },
  {
    method: 'GET',
    pathTemplate: '/api/exceptions',
    channel: 'aphub:exceptions:list',
    query: { status: 'string' },
  },
  { method: 'GET', pathTemplate: '/api/exceptions/:id', channel: 'aphub:exceptions:get' },
  { method: 'GET', pathTemplate: '/api/items/:id/evidence', channel: 'aphub:evidence:get' },
  {
    method: 'GET',
    pathTemplate: '/api/audit',
    channel: 'aphub:audit:list',
    query: { action: 'string', entity: 'string' },
  },
  {
    method: 'GET',
    pathTemplate: '/api/notifications',
    channel: 'aphub:notifications:list',
    query: { unreadOnly: 'boolean' },
  },
  { method: 'GET', pathTemplate: '/api/me', channel: 'aphub:me:get' },
  {
    method: 'GET',
    pathTemplate: '/api/accounting-documents/review',
    channel: 'aphub:accounting-documents:review',
  },
  {
    method: 'GET',
    pathTemplate: '/api/statements',
    channel: 'aphub:statements:list',
    query: { status: 'string' },
  },
  { method: 'GET', pathTemplate: '/api/statements/:id', channel: 'aphub:statements:get' },
  {
    method: 'GET',
    pathTemplate: '/api/reply-drafts',
    channel: 'aphub:reply-drafts:get',
    query: { messageId: 'number' },
  },
  {
    method: 'GET',
    pathTemplate: '/api/provider-capabilities',
    channel: 'aphub:provider-capabilities:list',
  },
  { method: 'GET', pathTemplate: '/api/provider-jobs', channel: 'aphub:provider-jobs:list' },
  {
    method: 'GET',
    pathTemplate: '/api/dimension-mappings',
    channel: 'aphub:dimension-mappings:list',
    query: {
      connectionId: 'number',
      dimensionType: 'string',
      reviewStatus: 'string',
      resolutionState: 'string',
      provider: 'string',
    },
  },
  {
    method: 'GET',
    pathTemplate: '/api/tax-mappings',
    channel: 'aphub:tax-mappings:list',
    query: { connectionId: 'number', filter: 'string', provider: 'string' },
  },
  // Literal, must precede '/api/tax-mappings/:id' below — see the ordering note above.
  {
    method: 'GET',
    pathTemplate: '/api/tax-mappings/discover',
    channel: 'aphub:tax-mappings:discover',
    query: { code: 'string' },
  },
  { method: 'GET', pathTemplate: '/api/tax-mappings/:id', channel: 'aphub:tax-mappings:get' },
  { method: 'GET', pathTemplate: '/api/tax-mappings/:id/audit', channel: 'aphub:tax-mappings:audit' },
  { method: 'GET', pathTemplate: '/api/onboarding', channel: 'aphub:onboarding:get' },
  { method: 'GET', pathTemplate: '/api/connections/status', channel: 'aphub:connections:status' },
  { method: 'GET', pathTemplate: '/api/backup/list', channel: 'aphub:backup:list' },

  // --- action domains (desktop/ipc/action/*.ts) ----------------------------------------------
  { method: 'POST', pathTemplate: '/api/proposals/:proposalId/approve', channel: 'aphub:proposals:approve' },
  { method: 'POST', pathTemplate: '/api/proposals/:proposalId/reject', channel: 'aphub:proposals:reject' },
  { method: 'POST', pathTemplate: '/api/proposals/:proposalId/retry', channel: 'aphub:proposals:retry' },
  { method: 'POST', pathTemplate: '/api/corrections/learn', channel: 'aphub:corrections:learn' },
  { method: 'POST', pathTemplate: '/api/mappings/remap', channel: 'aphub:mappings:remap' },
  {
    method: 'POST',
    pathTemplate: '/api/accounting-documents/:documentId/classify',
    channel: 'aphub:accounting-documents:classify',
  },
  {
    method: 'POST',
    pathTemplate: '/api/notifications/:notificationId/read',
    channel: 'aphub:notifications:read',
  },
  { method: 'POST', pathTemplate: '/api/onboarding/step', channel: 'aphub:onboarding:step' },
  { method: 'POST', pathTemplate: '/api/onboarding/dry-run', channel: 'aphub:onboarding:dry-run' },
  {
    method: 'POST',
    pathTemplate: '/api/provider-connections/:connectionId/write-gate',
    channel: 'aphub:provider-connections:write-gate',
  },
  { method: 'POST', pathTemplate: '/api/replies/:replyId/send', channel: 'aphub:replies:send' },
  { method: 'POST', pathTemplate: '/api/reply-drafts', channel: 'aphub:reply-drafts:create' },
  { method: 'PATCH', pathTemplate: '/api/reply-drafts/:draftId', channel: 'aphub:reply-drafts:update' },
  { method: 'DELETE', pathTemplate: '/api/reply-drafts/:draftId', channel: 'aphub:reply-drafts:discard' },
  {
    method: 'POST',
    pathTemplate: '/api/statements/:statementId/correct',
    channel: 'aphub:statements:correct',
  },
  { method: 'POST', pathTemplate: '/api/statements/:statementId/file', channel: 'aphub:statements:file' },
  {
    method: 'POST',
    pathTemplate: '/api/statements/:statementId/lines/:lineId/match',
    channel: 'aphub:statements:match-line',
  },
  {
    method: 'POST',
    pathTemplate: '/api/statements/:statementId/lines/:lineId/exclude',
    channel: 'aphub:statements:exclude-line',
  },
  { method: 'POST', pathTemplate: '/api/tax-mappings', channel: 'aphub:tax-mappings:create' },
  { method: 'POST', pathTemplate: '/api/tax-mappings/:taxMappingId/edit', channel: 'aphub:tax-mappings:edit' },
  {
    method: 'POST',
    pathTemplate: '/api/tax-mappings/:taxMappingId/disable',
    channel: 'aphub:tax-mappings:disable',
  },
  {
    method: 'POST',
    pathTemplate: '/api/tax-mappings/:taxMappingId/replace',
    channel: 'aphub:tax-mappings:replace',
  },
  {
    method: 'POST',
    pathTemplate: '/api/tax-mappings/:taxMappingId/revalidate',
    channel: 'aphub:tax-mappings:revalidate',
  },
  {
    method: 'POST',
    pathTemplate: '/api/dimension-mappings/:mappingId/accept',
    channel: 'aphub:dimension-mappings:accept',
  },
  {
    method: 'POST',
    pathTemplate: '/api/dimension-mappings/:mappingId/correct',
    channel: 'aphub:dimension-mappings:correct',
  },
  {
    method: 'POST',
    pathTemplate: '/api/dimension-mappings/:mappingId/reject',
    channel: 'aphub:dimension-mappings:reject',
  },
  {
    method: 'POST',
    pathTemplate: '/api/dimension-mappings/:mappingId/save-rule',
    channel: 'aphub:dimension-mappings:save-rule',
  },
  {
    method: 'POST',
    pathTemplate: '/api/dimension-mappings/:mappingId/select-alternate',
    channel: 'aphub:dimension-mappings:select-alternate',
  },
  { method: 'POST', pathTemplate: '/api/provider-jobs/:jobId/retry', channel: 'aphub:provider-jobs:retry' },
  { method: 'POST', pathTemplate: '/api/connections/start', channel: 'aphub:connections:start' },
  { method: 'POST', pathTemplate: '/api/backup/:backupId/restore', channel: 'aphub:backup:restore' },
  { method: 'POST', pathTemplate: '/api/backup/:backupId/export', channel: 'aphub:backup:export' },
];

/** Exported so the parity test can walk every declared route without re-deriving this table. */
export function allRoutes(): readonly RouteSpec[] {
  return ROUTES;
}

export interface ResolvedRoute {
  readonly channel: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Match `pathname` (no query string) against `template` segment by segment. A `:name` segment
 * accepts any single path segment; every other segment must match literally. Returns the
 * captured `:name` values (still strings — the caller coerces) or `null` on any mismatch,
 * including a segment-count mismatch.
 */
function matchTemplate(pathname: string, template: string): Record<string, string> | null {
  const pathSegments = pathname.split('/').filter((segment) => segment.length > 0);
  const templateSegments = template.split('/').filter((segment) => segment.length > 0);
  if (pathSegments.length !== templateSegments.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < templateSegments.length; i += 1) {
    const templateSegment = templateSegments[i] as string;
    const pathSegment = pathSegments[i] as string;
    if (templateSegment.startsWith(':')) {
      params[templateSegment.slice(1)] = decodeURIComponent(pathSegment);
    } else if (templateSegment !== pathSegment) {
      return null;
    }
  }
  return params;
}

function coerceQueryValue(raw: string, type: QueryParamType): unknown {
  if (type === 'number') return Number(raw);
  if (type === 'boolean') return raw === 'true';
  return raw;
}

/**
 * Resolve a caller's `(method, path)` — and, for a mutation, its body payload — into the
 * channel and payload `window.aphub.invoke` expects. Returns `null` when nothing in the table
 * matches; every path shape the 14 page components actually send is covered by
 * `test/ipc-renderer-transport.test.ts`; `null` should only be reachable in defensive code.
 */
export function resolveRoute(
  method: IpcMethod,
  path: string,
  body?: Record<string, unknown>,
): ResolvedRoute | null {
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);
  const queryString = queryIndex === -1 ? '' : path.slice(queryIndex + 1);

  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const pathParams = matchTemplate(pathname, route.pathTemplate);
    if (pathParams === null) continue;

    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(pathParams)) {
      payload[key] = Number(value);
    }

    if (route.query) {
      const search = new URLSearchParams(queryString);
      for (const [key, type] of Object.entries(route.query)) {
        const raw = search.get(key);
        if (raw !== null) payload[key] = coerceQueryValue(raw, type);
      }
    }

    if (body !== undefined) {
      for (const [key, value] of Object.entries(body)) {
        payload[key] = value;
      }
    }

    return { channel: route.channel, payload };
  }

  return null;
}

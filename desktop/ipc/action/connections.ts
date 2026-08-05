import { z } from 'zod';
import { runConnectionsStart } from '../../../src/services/action/connections.js';
import { defineChannel, passthrough, strict, type RegistryEntry } from '../registry.js';

/**
 * CHUNK_5_CONNECT — `aphub:connections:start`. Replaces the redirect-based
 * `/api/connections/{gmail,qbo}/start` for the desktop shell (deliberately NOT registered here —
 * see `desktop/ipc/action/index.ts`'s doc comment): the desktop window has no address bar to
 * redirect, so this opens the system browser directly and stands up the loopback listener that
 * receives its callback (`src/auth/connect-loopback.ts`).
 *
 * Owner-only, matching `runConnectionsStart`'s own `readContext(request, 'owner_controller')` —
 * this channel does not gate a second time; the wrapper does.
 */
export const connectionsEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:connections:start',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/connections/start',
    bodyKeys: ['provider'],
    request: strict({ provider: z.enum(['gmail', 'qbo', 'xero']) }),
    response: passthrough({ state: z.literal('browser_opened') }),
    validationMessage: 'BookScout OS could not start connecting that account. Try again from Settings.',
    invoke: (request) => runConnectionsStart(request),
  }),
];

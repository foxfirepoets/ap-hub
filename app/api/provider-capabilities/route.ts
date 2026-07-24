import { ROLES } from '../../../src/auth/guard.js';
import {
  listProviderCapabilities,
  runRead,
} from '../../../src/services/read/index.js';

// GET /api/provider-capabilities — read-only capability truth for the session tenant.
export async function GET(request: Request): Promise<Response> {
  return runRead(
    request,
    (ctx) => listProviderCapabilities(ctx.tenantId),
    { role: ROLES },
  );
}


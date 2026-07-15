import { runRead, listNotifications } from '../../../src/services/read/index.js';

// GET /api/notifications?unread=true — the tenant's notification feed (any role).
export async function GET(request: Request): Promise<Response> {
  const unreadOnly = new URL(request.url).searchParams.get('unread') === 'true';
  return runRead(request, (ctx) => listNotifications(ctx.tenantId, { unreadOnly }));
}

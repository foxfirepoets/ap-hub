import { runMarkNotificationRead } from '../../../../../src/services/action/index.js';

// POST /api/notifications/:id/read — mark one notification read (any authenticated role).
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return runMarkNotificationRead(request, Number(params.id));
}

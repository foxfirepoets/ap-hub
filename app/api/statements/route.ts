import { listStatements } from '../../../src/statements/review.js';
import { runRead } from '../../../src/services/read/http.js';

export function GET(request: Request): Promise<Response> {
  const status = new URL(request.url).searchParams.get('status') ?? undefined;
  return runRead(request, (ctx) => listStatements(ctx.tenantId, status), {
    role: ['owner_controller', 'bookkeeper', 'cpa'],
  });
}

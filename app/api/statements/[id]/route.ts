import { getStatement } from '../../../../src/statements/review.js';
import { runRead } from '../../../../src/services/read/http.js';

export function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return runRead(request, (ctx) => getStatement(ctx.tenantId, Number(params.id)), {
    role: ['owner_controller', 'bookkeeper', 'cpa'],
  });
}

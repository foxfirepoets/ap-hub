import { runMatchStatementLine } from '../../../../../../../src/statements/http.js';

export function POST(
  request: Request,
  { params }: { params: { id: string; lineId: string } },
): Promise<Response> {
  return runMatchStatementLine(request, Number(params.id), Number(params.lineId));
}

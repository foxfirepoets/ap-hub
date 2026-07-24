import { runFileStatement } from '../../../../../src/statements/http.js';

export function POST(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  return runFileStatement(request, Number(params.id));
}

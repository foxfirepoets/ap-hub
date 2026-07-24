import { runCorrectStatement } from '../../../../../src/statements/http.js';

export function POST(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  return runCorrectStatement(request, Number(params.id));
}

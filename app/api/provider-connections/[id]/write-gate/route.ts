import { runSetOwnerWriteGate } from '../../../../../src/accounting/write-gates-http.js';

export function POST(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  return runSetOwnerWriteGate(request, Number(params.id));
}

import { runClassifyDocument } from '../../../../../src/accounting/document-review-http.js';

export function POST(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  return runClassifyDocument(request, Number(params.id));
}

import { runClassificationReview } from '../../../../src/accounting/document-review-http.js';

export function GET(request: Request): Promise<Response> {
  return runClassificationReview(request);
}

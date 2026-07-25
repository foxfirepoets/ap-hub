import { AuthError } from '../auth/guard.js';
import { ServiceError, toActorContext } from '../services/index.js';
import { errorResponse, jsonResponse, readContext, runRead } from '../services/read/http.js';
import { classifyHeldDocument, listClassificationReview, type HumanDocumentClassification } from './document-review.js';

export function runClassificationReview(request: Request): Promise<Response> {
  return runRead(request, (ctx) => listClassificationReview(ctx.tenantId), {
    role: ['owner_controller', 'bookkeeper', 'cpa'],
  });
}

export async function runClassifyDocument(request: Request, documentId: number): Promise<Response> {
  try {
    const ctx = await readContext(request, ['owner_controller', 'bookkeeper']);
    const body = await request.json() as { classification?: unknown; reason?: unknown };
    if (typeof body.classification !== 'string' || typeof body.reason !== 'string') {
      return errorResponse('VALIDATION', 'classification and reason are required', 400);
    }
    const result = await classifyHeldDocument(
      toActorContext(ctx), documentId, body.classification as HumanDocumentClassification, body.reason,
    );
    return jsonResponse(result);
  } catch (error) {
    if (error instanceof AuthError) return errorResponse(error.code, error.message, error.status);
    if (error instanceof ServiceError) {
      return errorResponse(error.code.toUpperCase(), error.message, error.code.endsWith('_not_found') ? 404 : 400);
    }
    return errorResponse('INTERNAL', 'classification failed safely; the document remains held', 500);
  }
}

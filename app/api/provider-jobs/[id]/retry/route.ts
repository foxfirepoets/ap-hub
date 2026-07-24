import { AuthError, requireSession } from '../../../../../src/auth/guard.js';
import { tokenFromRequest, errorResponse, jsonResponse } from '../../../../../src/services/read/http.js';
import {
  DurableProviderJobs,
  UnsafeProviderJobRetryError,
} from '../../../../../src/qbdesktop/durable-jobs.js';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireSession(tokenFromRequest(request), 'owner_controller');
    const { id } = await context.params;
    const jobId = Number(id);
    if (!Number.isInteger(jobId) || jobId <= 0) return errorResponse('INVALID_ID', 'invalid job id', 400);
    const job = await new DurableProviderJobs().retry(actor.tenantId, jobId);
    return job ? jsonResponse(job) : errorResponse('NOT_FOUND', 'not found', 404);
  } catch (error) {
    if (error instanceof AuthError) return errorResponse(error.code, error.message, error.status);
    if (error instanceof UnsafeProviderJobRetryError) {
      return errorResponse('UNSAFE_RETRY', error.message, 409);
    }
    return errorResponse('INTERNAL', 'retry failed', 500);
  }
}

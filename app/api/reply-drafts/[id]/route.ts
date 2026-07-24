import {
  runDiscardReplyDraft,
  runUpdateReplyDraft,
} from '../../../../src/reply-drafts/http.js';

export function PATCH(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return runUpdateReplyDraft(request, Number(params.id));
}

export function DELETE(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return runDiscardReplyDraft(request, Number(params.id));
}

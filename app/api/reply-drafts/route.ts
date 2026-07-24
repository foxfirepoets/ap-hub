import {
  runCreateReplyDraft,
  runReadReplyDraft,
} from '../../../src/reply-drafts/http.js';

export function GET(request: Request): Promise<Response> {
  return runReadReplyDraft(request);
}

export function POST(request: Request): Promise<Response> {
  return runCreateReplyDraft(request);
}

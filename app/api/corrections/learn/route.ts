import { runLearn } from '../../../../src/services/action/index.js';

// POST /api/corrections/learn — owner_controller | bookkeeper: learn-forever correction rule.
export async function POST(request: Request): Promise<Response> {
  return runLearn(request);
}

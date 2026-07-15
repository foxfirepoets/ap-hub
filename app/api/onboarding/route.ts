import { runOnboardingGet } from '../../../src/services/action/index.js';

// GET /api/onboarding — current onboarding_state + discovery (any authenticated role).
export async function GET(request: Request): Promise<Response> {
  return runOnboardingGet(request);
}

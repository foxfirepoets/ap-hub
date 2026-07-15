import { runOnboardingStep } from '../../../../src/services/action/index.js';

// POST /api/onboarding/step — advance the wizard step / persist a choice (owner_controller).
export async function POST(request: Request): Promise<Response> {
  return runOnboardingStep(request);
}

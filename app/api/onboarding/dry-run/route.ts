import { runOnboardingDryRunAction } from '../../../../src/services/action/index.js';

// POST /api/onboarding/dry-run — propose-only scan (never posts); owner_controller only.
export async function POST(request: Request): Promise<Response> {
  return runOnboardingDryRunAction(request);
}

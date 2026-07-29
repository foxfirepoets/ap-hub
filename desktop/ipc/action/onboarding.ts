/**
 * CHUNK_3_IPC — the first-run wizard's two mutations.
 *
 * Replaces `app/api/onboarding/step/route.ts` and `app/api/onboarding/dry-run/route.ts`.
 * `GET /api/onboarding` is a READ and belongs to the read domains, not here.
 *
 * ── `method` MUST BE EXACTLY 'POST' ON BOTH CHANNELS ────────────────────────────────────────
 * `runOnboardingAction` branches on it: `if (request.method === 'POST')` is the ONLY thing that
 * makes it parse a body (`src/services/action/onboarding.ts:43-49`). Declared as `GET`, the
 * wrapper would hand `{}` to the handler and `step` and `automationLevel` would be silently
 * lost — a wizard that appears to work and never advances. This is why `RegistryEntry.method` is
 * declared rather than inferred (`desktop/ipc/envelope.ts:65-70`).
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Roles, verified in the wrapper:
 *   runOnboardingStep         → runOnboardingAction(request, 'owner_controller', …)  onboarding.ts:69
 *   runOnboardingDryRunAction → runOnboardingAction(request, 'owner_controller', …)  onboarding.ts:79
 *
 * (`runOnboardingGet` passes `undefined` for the role — that clone's role default is what makes
 * unifying these wrappers an authorization change.)
 *
 * The dry run is propose-only and never reaches `post_sandbox`; a `dry_run_locked` ServiceError
 * arrives as 403 and normalizes to `FORBIDDEN` (`desktop/ipc/errors.ts:76`).
 */

import { runOnboardingDryRunAction, runOnboardingStep } from '../../../src/services/action/index.js';
import { defineChannel, passthrough, shortText, strict, type RegistryEntry } from '../registry.js';

export const onboardingEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:onboarding:step',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/onboarding/step',
    bodyKeys: ['step', 'automationLevel'],
    // Both optional, exactly as the wrapper reads them (onboarding.ts:70-71): the screen posts
    // one, the other, or both. `advanceOnboardingStep` owns which values are legal — narrowing
    // to an enum here would silently reject a step the service later adds.
    request: strict({ step: shortText.optional(), automationLevel: shortText.optional() }),
    response: passthrough({}),
    validationMessage: 'BookScout OS could not save that setup choice. Go back a step and choose again.',
    invoke: (request) => runOnboardingStep(request),
  }),

  defineChannel({
    channel: 'aphub:onboarding:dry-run',
    role: ['owner_controller'],
    method: 'POST',
    pathTemplate: '/api/onboarding/dry-run',
    bodyKeys: [],
    request: strict({}),
    response: passthrough({}),
    validationMessage: 'BookScout OS could not start the practice run. Try again from the setup screen.',
    invoke: (request) => runOnboardingDryRunAction(request),
  }),
];

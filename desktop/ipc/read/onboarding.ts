import { z } from 'zod';
import { runOnboardingGet } from '../../../src/services/action/index.js';
import { defineChannel, passthrough, strict, type RegistryEntry } from '../registry.js';

/**
 * B3 — GET /api/onboarding (any authenticated role).
 *
 * This one is B3's, not B4's: `runOnboardingGet` (`src/services/action/onboarding.ts:60`)
 * calls the shared `runOnboardingAction(request, undefined, ...)` with `role: undefined` — any
 * authenticated role — and only ever READS state (`getOnboardingState`); it never advances the
 * wizard or writes anything. `route-to-service-map.md`'s Read-only tables omit `/api/onboarding`
 * (it only lists the mutating `/api/onboarding/step` and `/api/onboarding/dry-run`, both
 * owner-only, both B4's), but the GET route itself is read-only and belongs alongside the
 * other any-role reads.
 *
 * `runOnboardingAction` branches on `request.method === 'POST'` to decide whether to parse a
 * body (`onboarding.ts:43`); this channel is declared `GET`, so no body is ever sent or parsed
 * — matching the real route.
 */
export const onboardingEntries: readonly RegistryEntry[] = [
  defineChannel({
    channel: 'aphub:onboarding:get',
    role: 'any',
    method: 'GET',
    pathTemplate: '/api/onboarding',
    request: strict({}),
    response: passthrough({
      step: z.string(),
      dryRunComplete: z.boolean(),
      automationLevel: z.string(),
      updatedAt: z.string().nullable(),
      connections: passthrough({
        gmailConnected: z.boolean(),
        gmailScopeOk: z.boolean(),
        qboConnected: z.boolean(),
        qboCompanySelected: z.boolean(),
        qboCompanyName: z.string().nullable(),
      }),
      blockers: z.array(
        passthrough({ code: z.string(), group: z.string(), message: z.string(), fix: z.string() }),
      ),
      priorData: passthrough({ emails: z.number(), invoices: z.number(), vendorsKnown: z.number() }),
    }),
    validationMessage: 'AP-Hub could not load your setup status.',
    invoke: (request) => runOnboardingGet(request),
  }),
];

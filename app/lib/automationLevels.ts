// Mirrors `AUTOMATION_LEVELS` in src/services/onboarding.ts. Frontend `app/lib` is kept
// free of `src/` imports (see app/lib/types.ts), so the three values are duplicated here
// rather than imported — a build-time constant, not a network-dependent lookup.
export const AUTOMATION_LEVELS = ['off', 'assisted', 'auto'] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];

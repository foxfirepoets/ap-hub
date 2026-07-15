# IMPLEMENTATION_PLAN.md

Project: guided-onboarding-installer — a graphical wrapper for ap-hub's existing CHUNK_6_ONBOARDING.
Brownfield: presentational-only. DO NOT touch `src/services/onboarding.ts`, `app/api/onboarding/**`,
`migrations/**`, `src/qbo/write.ts`, `src/gatekeeper/forwarder.ts`, or anything under `src/pipeline/`.
Validation gate (every chunk): `npm run lint && npm run typecheck && npm test && npm run web:build` —
must exit 0; `test/onboarding.test.ts` (11 tests) must pass unmodified.

## Chunk Order

1. CHUNK_1_ERRORHELPERS — pure, testable error-code-to-plain-English mapper.
2. CHUNK_2_WELCOME — welcome overlay naming both onboarding prerequisites.
3. CHUNK_3_STEPPER — visual progress stepper across all 9 onboarding steps.
4. CHUNK_4_EXPLAINERS — per-step prerequisite explainers and graphical blocker cards.
5. CHUNK_5_INTEGRATION — wire the friendly failure panel into every existing failure path, final gate.

---

## Chunk 1: CHUNK_1_ERRORHELPERS
### Tasks (in order)
1. Create `app/lib/onboardingErrors.ts` exporting `friendlyOnboardingError(code: string, fallbackMessage: string): { text: string; retryable: boolean }`. Map `VALIDATION` → distinct plain-English text, `retryable: true`; `FORBIDDEN` → distinct text, `retryable: false`; `UNAUTHENTICATED` → distinct text, `retryable: false`; `DRY_RUN_LOCKED` → distinct text, `retryable: true`; any other code → a generic fallback whose text includes `fallbackMessage` verbatim (never drop it), `retryable: true`. No two recognized codes may produce identical `text`.
2. Create `test/onboarding-ui-errors.test.ts` (Vitest, no DB needed) covering all 4 named codes (assert distinct, non-raw-code text + correct `retryable`) and one unrecognized-code case (assert `fallbackMessage` appears in the output).
### Validation
- Command: `npm run lint && npm run typecheck && npm test && npm run web:build`
- Expected: exit 0, all tests green (new onboarding-ui-errors tests + all pre-existing)
### Promise
<promise>CHUNK COMPLETE: CHUNK_1_ERRORHELPERS</promise>

---

## Chunk 2: CHUNK_2_WELCOME
### Tasks (in order)
1. Create `app/components/OnboardingWelcome.tsx` — a presentational component, props `{ onGetStarted: () => void }`, rendering: a short explanation of what AP Hub is about to do, and both prerequisites by name ("Gmail" and "QuickBooks" or "QuickBooks Online"/"QBO"), and a "Get Started" primary button calling `onGetStarted`.
2. Modify `app/(app)/onboarding/page.tsx`: add `const [welcomeDismissed, setWelcomeDismissed] = useState(false)`. In the render, AFTER the existing non-owner early-return (`if (!owner) { ... }` must stay first), render `<OnboardingWelcome onGetStarted={() => setWelcomeDismissed(true)} />` instead of the step body when `!welcomeDismissed`; render the existing step body (starting at whatever `step` the backend reports — do not reset it) when `welcomeDismissed` is true.
### Validation
- Command: `npm run lint && npm run typecheck && npm test && npm run web:build`
- Expected: exit 0, all tests green, `web:build` still 25 routes
### Promise
<promise>CHUNK COMPLETE: CHUNK_2_WELCOME</promise>

---

## Chunk 3: CHUNK_3_STEPPER
### Tasks (in order)
1. Create `app/components/OnboardingStepper.tsx` — a presentational component, props `{ steps: { key: string; label: string }[]; currentStep: string }`, rendering one item per step; the item whose `key === currentStep` carries a distinguishing attribute (e.g. `data-current="true"` or an `active` class); items before it in the array carry a "completed" attribute/class; items after carry an "upcoming" one.
2. Modify `app/(app)/onboarding/page.tsx`: replace the current `<p className="page-sub">Step {STEPS.indexOf(step) + 1} of {STEPS.length}: {STEP_LABEL[step]}...</p>` line with `<OnboardingStepper steps={STEPS.map((s) => ({ key: s, label: STEP_LABEL[s] }))} currentStep={step} />`, keeping the automation-level notice text that currently shares that line (move it to its own element if needed — do not drop the "Automation is OFF — nothing can post yet" message).
### Validation
- Command: `npm run lint && npm run typecheck && npm test && npm run web:build`
- Expected: exit 0, all tests green, `web:build` still 25 routes
### Promise
<promise>CHUNK COMPLETE: CHUNK_3_STEPPER</promise>

---

## Chunk 4: CHUNK_4_EXPLAINERS
### Tasks (in order)
1. In `app/(app)/onboarding/page.tsx` (or a small colocated const), add `const STEP_EXPLAINER: Record<Step, string>` with one short sentence per of the 9 steps explaining what that step needs and why (e.g. `connect_gmail: 'AP Hub reads accounting email from this mailbox — nothing else.'`). Render the matching sentence above each step's existing content block.
2. Create `app/components/OnboardingBlockerCard.tsx` — a presentational component, props `{ group: string; message: string; fix: string }` (icon optional, derived from a small internal code→icon map with a sane default for unrecognized codes), rendering one visually distinct card. Replace the current per-blocker `<div className="notice warn" data-testid={\`blocker-${b.code}\`}>` rendering in `app/(app)/onboarding/page.tsx` with `<OnboardingBlockerCard .../>` per blocker, keeping the existing grouping-by-`group` logic and the `data-testid` attribute untouched (tests/tooling may depend on it).
### Validation
- Command: `npm run lint && npm run typecheck && npm test && npm run web:build`
- Expected: exit 0, all tests green, `web:build` still 25 routes
### Promise
<promise>CHUNK COMPLETE: CHUNK_4_EXPLAINERS</promise>

---

## Chunk 5: CHUNK_5_INTEGRATION
### Tasks (in order)
1. In `app/(app)/onboarding/page.tsx`, import `friendlyOnboardingError` from `../../lib/onboardingErrors.js`. In `goStep`'s bad-response branch, `runDryRun`'s bad-response branch, and `approveRule`'s bad-response branch, replace the raw `res.error?.message` notice text with `friendlyOnboardingError(res.error?.code ?? '', res.error?.message ?? 'Something went wrong.')`'s `.text`. When `.retryable` is true, render a "Try again" button that re-invokes the same failed action (`goStep`/`runDryRun`/`approveRule` with its original arguments); when false, no retry button. Keep the raw original message visible in a collapsed `<details><summary>Details</summary>...</details>` disclosure — never fully discard it.
2. Run the full gate: `npm run migrate:up && npm run lint && npm run typecheck && npm test && npm run web:build`. Confirm `web:build` still reports 25 routes. Confirm `git diff -- src/services/onboarding.ts app/api/onboarding/ migrations/ src/qbo/write.ts src/gatekeeper/forwarder.ts src/pipeline/` is empty. Confirm `npx vitest run test/onboarding.test.ts` passes unmodified (11 tests, 0 changed).
### Validation
- Command: `npm run migrate:up && npm run lint && npm run typecheck && npm test && npm run web:build`
- Expected: exit 0, all tests green, 25 routes, protected-file diff empty, test/onboarding.test.ts unmodified and green
### Promise
<promise>CHUNK COMPLETE: CHUNK_5_INTEGRATION</promise>

---

## Build Complete
When all 5 chunks are done and validation is green, emit:
<promise>BUILD COMPLETE</promise>
Then run /HKO-truth-audit on the diff, fix any issues found, then push to GitHub (per operator instruction).

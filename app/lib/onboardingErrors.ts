// Pure error-code → plain-English mapper for the onboarding wizard's failure panel.
// No DOM/React/fetch/DB — a presentational helper only, unit-testable in isolation.
// CHUNK_5 wires this into every step/dry-run/approve failure path.

export interface FriendlyOnboardingError {
  text: string;
  retryable: boolean;
}

export function friendlyOnboardingError(code: string, fallbackMessage: string): FriendlyOnboardingError {
  switch (code) {
    case 'VALIDATION':
      return {
        text: "That step isn't available yet — finish the current step first, then try again.",
        retryable: true,
      };
    case 'FORBIDDEN':
      return {
        text: 'Only the account owner can change setup.',
        retryable: false,
      };
    case 'UNAUTHENTICATED':
      return {
        text: 'Your session expired — sign in again to continue where you left off.',
        retryable: false,
      };
    case 'DRY_RUN_LOCKED':
      return {
        text: 'Posting is still locked — finish setup and choose an automation level to enable it.',
        retryable: true,
      };
    default:
      return {
        text: `Something went wrong on that step. Details: ${fallbackMessage}`,
        retryable: true,
      };
  }
}

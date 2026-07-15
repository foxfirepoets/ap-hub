'use client';

// CHUNK_3_STEPPER — presentational progress stepper across the 9 onboarding steps.
// Reads only what the parent already has (STEPS/STEP_LABEL + current step); no new data
// source, no navigation — items are not clickable (simpler, acceptable choice per spec).
export interface OnboardingStepperStep {
  key: string;
  label: string;
}

export interface OnboardingStepperProps {
  steps: OnboardingStepperStep[];
  currentStep: string;
}

export function OnboardingStepper({ steps, currentStep }: OnboardingStepperProps) {
  const currentIndex = steps.findIndex((s) => s.key === currentStep);

  return (
    <ol className="stepper" data-testid="onboarding-stepper">
      {steps.map((s, i) => {
        const status = i < currentIndex ? 'completed' : i === currentIndex ? 'current' : 'upcoming';
        return (
          <li
            key={s.key}
            className={`stepper-item ${status}`}
            data-current={status === 'current' ? 'true' : undefined}
            data-status={status}
          >
            <span className="stepper-dot" />
            <span className="stepper-label">{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

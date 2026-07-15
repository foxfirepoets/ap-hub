-- CHUNK_6_ONBOARDING: first-run wizard progress + the auto-post gate.
-- One row per tenant. `automation_level` starts 'off': the DRY_RUN_LOCKED guard
-- (src/services/onboarding.ts) refuses any post attempt until a human explicitly
-- moves it away from 'off' via POST /api/onboarding/step.

CREATE TABLE IF NOT EXISTS onboarding_state (
  tenant_id         bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  step              text NOT NULL DEFAULT 'connect_gmail',
  dry_run_complete  boolean NOT NULL DEFAULT false,
  automation_level  text NOT NULL DEFAULT 'off',   -- off | assisted | auto
  updated_at        timestamptz NOT NULL DEFAULT now()
);

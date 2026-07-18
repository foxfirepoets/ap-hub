-- Broker initial schema (CHUNK_2_BROKERAUTH) — SPEC §6 + §13-B.
-- Three tables: installs (identity + spend budget), heartbeats (liveness telemetry,
-- NO business data ever), spend_ledger (per-install upstream spend for the cap).
-- Additive-only; DOWN drops exactly these three tables.

CREATE EXTENSION IF NOT EXISTS pgcrypto;              -- gen_random_uuid()

-- installs: one row per pilot machine. Plaintext token is NEVER stored — only its SHA-256.
CREATE TABLE installs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label          text NOT NULL UNIQUE,               -- 'tester-jane'
  token_sha256   text NOT NULL UNIQUE,               -- SHA-256 of the bearer token
  revoked_at     timestamptz NULL,
  weekly_cap_usd numeric(10,2) NOT NULL DEFAULT 5.00,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NULL
);

-- heartbeats: liveness telemetry only. `event` is a closed enum; `detail` is capped
-- at 200 chars and is for error codes only — the mechanical guard against business
-- data leaking off-premises (a content-assertion test backs this in CHUNK_5).
CREATE TABLE heartbeats (
  id                bigserial PRIMARY KEY,
  install_id        uuid NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  observed_at       timestamptz NOT NULL DEFAULT now(),
  event             text NOT NULL CHECK (event IN ('alive','watchdog_restart','pg_health','shutdown')),
  pg_ok             boolean NULL,
  detail            text NULL CHECK (detail IS NULL OR length(detail) <= 200),
  tz_offset_minutes int NULL
);

-- spend_ledger: enforces the weekly cap.
CREATE TABLE spend_ledger (
  id          bigserial PRIMARY KEY,
  install_id  uuid NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  upstream    text NOT NULL CHECK (upstream IN ('anthropic','swarmsync')),
  est_usd     numeric(10,4) NOT NULL DEFAULT 0
);

-- Indexes backing the only two repeated queries (online-hours rollup + weekly-cap check).
CREATE INDEX idx_heartbeats_install_time ON heartbeats (install_id, observed_at DESC);
CREATE INDEX idx_spend_install_time      ON spend_ledger (install_id, occurred_at DESC);
CREATE UNIQUE INDEX idx_installs_token   ON installs (token_sha256);

-- Verification query (run after UP — must return 3):
--   SELECT count(*) FROM information_schema.tables
--   WHERE table_schema='public' AND table_name IN ('installs','heartbeats','spend_ledger');

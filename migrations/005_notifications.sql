-- CHUNK_7_DIGEST: in-app notifications — one daily digest batch/tenant/day plus
-- immediate risk_alert notifications for material-risk severity findings.
-- Notifications are earned: routine success writes nothing here.

CREATE TABLE IF NOT EXISTS notifications (
  id            bigserial PRIMARY KEY,
  tenant_id     bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       bigint REFERENCES users(id) ON DELETE SET NULL,
  kind          text NOT NULL,                    -- daily_digest | risk_alert
  severity      text NOT NULL DEFAULT 'info',
  payload       jsonb NOT NULL DEFAULT '{}',
  digest_batch  date,                              -- set for kind='daily_digest'; one per tenant/day
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_batch ON notifications(tenant_id, digest_batch);

-- Guarantee 4 (no double-post) mirrored for the digest job: at most one daily_digest
-- notification per tenant per day.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_daily_digest
  ON notifications (tenant_id, digest_batch)
  WHERE kind = 'daily_digest';

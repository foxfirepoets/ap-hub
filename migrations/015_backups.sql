-- 015_backups.sql — CHUNK_2_DATABASE (populated by CHUNK_7_BACKUP)
--
-- Backup bookkeeping. This table records WHAT EXISTS and WHETHER IT VERIFIED. It is the
-- mechanism behind the phase's P0 guarantee, so two properties are structural rather than
-- conventional:
--
--   1. verified_at IS NULL means "never counted as a usable backup". A backup is not usable
--      because a file was written; it is usable because it was re-read and its manifest hash
--      and row counts matched. Rotation queries verified_at IS NOT NULL and must never delete
--      the newest verified row. Silent backup failure is the exact failure mode this design
--      exists to prevent.
--
--   2. NO SECRET, KEY OR CREDENTIAL IS STORED HERE. The backup encryption key lives only in
--      the OS credential store. A backup file plus this table is still useless without the
--      key — which is the point, and also the documented limitation (spec §14 open question 3):
--      an exported backup cannot be opened on a different computer.
--
-- external_copy is the user-nominated folder (OneDrive, Drive, Dropbox, network share,
-- external drive). It is USER-SELECTED, NEVER AUTOMATIC, and never an AP-Hub-operated location.

CREATE TABLE backups (
  id            BIGSERIAL   PRIMARY KEY,
  kind          TEXT        NOT NULL CHECK (kind IN ('scheduled','pre_migration','pre_update','manual')),
  path          TEXT        NOT NULL,
  size_bytes    BIGINT      NOT NULL CHECK (size_bytes > 0),
  manifest_hash TEXT        NOT NULL,
  row_counts    JSONB       NOT NULL,
  verified_at   TIMESTAMPTZ,                     -- NULL = never counted as a usable backup
  external_copy TEXT,                            -- user-nominated folder, NULL if none
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rotation and the Settings "most recent verified backup" panel both read this ordering.
CREATE INDEX backups_verified ON backups (verified_at DESC NULLS LAST, created_at DESC);

COMMENT ON COLUMN backups.verified_at IS
  'Set only after the backup was re-read and its manifest hash and row counts matched. '
  'NULL means the backup FAILED verification and must never be counted or restored from.';
COMMENT ON COLUMN backups.external_copy IS
  'User-nominated external folder. Never automatic, never an AP-Hub-operated location.';

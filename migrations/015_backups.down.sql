-- 015_backups.down.sql — CHUNK_2_DATABASE
--
-- Drops only a table this phase created. Note this discards the RECORD of which backups
-- verified, not the backup files themselves — those live on disk and are re-discoverable.
-- UP -> DOWN -> UP is exercised by test/db-bootstrap.test.ts.

DROP INDEX IF EXISTS backups_verified;
DROP TABLE IF EXISTS backups;

-- 014_local_install.down.sql — CHUNK_2_DATABASE
--
-- Drops only a table this phase created. No existing table is altered by 014, so the DOWN
-- cannot damage pre-P1 data. UP -> DOWN -> UP is exercised by test/db-bootstrap.test.ts.

DROP INDEX IF EXISTS local_install_singleton;
DROP TABLE IF EXISTS local_install;

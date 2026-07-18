-- Reversal for 006_provider_neutral.sql. Fully reverses UP; UP -> DOWN -> UP is clean.

DROP INDEX IF EXISTS idx_connections_tenant;
DROP TABLE IF EXISTS connections;

DROP VIEW IF EXISTS v_postings_qbo;
DROP VIEW IF EXISTS postings;

ALTER TABLE postings_ap RENAME COLUMN revision    TO sync_token;
ALTER TABLE postings_ap RENAME COLUMN external_id TO qbo_id;
ALTER TABLE postings_ap RENAME COLUMN entity_type TO qbo_type;

ALTER TABLE postings_ap RENAME TO postings;

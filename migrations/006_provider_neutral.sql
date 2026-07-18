-- CHUNK_5_CONNECTOR: provider-neutral seam — additive migration.
--
-- Generalises the QBO-specific posting columns to provider-neutral names and adds a
-- non-OAuth `connections` metadata table. This is ADDITIVE: no column is dropped or
-- rewritten, and every existing query keeps working through a back-compat view.
--
-- Technique (a standard blue-green column rename): the physical table is renamed to
-- `postings_ap` and its columns become provider-neutral (entity_type / external_id /
-- revision). An auto-updatable view named `postings` re-exposes the OLD column names so
-- all existing readers AND writers (incl. the seed INSERT in test/read.test.ts) keep
-- working unchanged. `v_postings_qbo` is the spec-named back-compat view.
--
-- DOWN (006_provider_neutral.down.sql) fully reverses this; UP -> DOWN -> UP is clean.

ALTER TABLE postings RENAME TO postings_ap;

ALTER TABLE postings_ap RENAME COLUMN qbo_type  TO entity_type;
ALTER TABLE postings_ap RENAME COLUMN qbo_id    TO external_id;
ALTER TABLE postings_ap RENAME COLUMN sync_token TO revision;

-- Back-compat, auto-updatable view: old provider-specific column names over the
-- renamed base table. Simple column aliases keep the view INSERT/UPDATE/DELETE-able,
-- so legacy code and existing tests that write `postings(qbo_type, qbo_id, sync_token)`
-- continue to work with zero changes.
CREATE VIEW postings AS
  SELECT
    id,
    tenant_id,
    attachment_id,
    proposal_id,
    entity_type AS qbo_type,
    external_id AS qbo_id,
    revision    AS sync_token,
    realm,
    mode,
    idempotency_key,
    status,
    request,
    response,
    posted_at,
    created_at
  FROM postings_ap;

-- Spec-named back-compat view (§CHUNK_5). Exposes the same QBO-flavoured surface.
CREATE VIEW v_postings_qbo AS SELECT * FROM postings;

-- Non-OAuth connection metadata (e.g. a QBD Web Connector bridge, which is not OAuth).
-- Cloud providers still use oauth_tokens; this table describes the connection itself.
CREATE TABLE connections (
  id                bigserial PRIMARY KEY,
  tenant_id         bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider          text NOT NULL,                                   -- qbo | qbd | xero | sage_intacct
  connection_class  text NOT NULL CHECK (connection_class IN ('cloud', 'local_desktop')),
  display_name      text,
  external_company  text,                                            -- realm / tenant / org / company id
  status            text NOT NULL DEFAULT 'active',                  -- active | disabled | revoked
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_company)
);

CREATE INDEX idx_connections_tenant ON connections (tenant_id);

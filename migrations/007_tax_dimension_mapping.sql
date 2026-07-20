-- F5_TAX_DIMENSION_MAPPING: persist tenant/connection-scoped tax mapping and dimension
-- mapping/review state. Net-new, purely additive: no existing table is altered or dropped.
--
-- This is the backing store for the already-implemented (in-memory) pipeline logic in
-- src/mapping/tax.ts and src/mapping/dimensions.ts. Vocabulary is MIRRORED from those
-- modules and src/canonical/model.ts so the DB persists exactly what the code computes:
--   * tax hold reasons        -> tax.ts TaxDecision: 'tax_unmapped' | 'tax_unreconciled'
--   * tax_mode                 -> tax.ts TaxMode: 'exclusive' | 'inclusive'
--   * resolution_state         -> model.ts DimensionState (the five NEVER-collapsed states)
--
-- Scoping rule (six-guarantee white-label / no-cross-tenant-leak): every row is bound to a
-- single (tenant_id, connection_id) via FKs to the existing 006 `connections` table, and a
-- mapping can NEVER be reused by another company — enforced by FK + a partial-unique index,
-- not by convention.
--
-- FK / ON DELETE policy (deliberate, consistent with 001_init.sql's tenant-CASCADE pattern):
--   * FKs to tenants / connections / proposals: ON DELETE CASCADE. Tenant (and its
--     connection) teardown is the ONLY sanctioned bulk-delete path; there is no app-level
--     single-mapping hard delete — history is kept via active=false + supersede links, never
--     by DELETE. Making these RESTRICT would deadlock the established tenant cascade.
--   * changed_by -> users: ON DELETE SET NULL (nullable) so an append-only audit row OUTLIVES
--     the deletion/purge of an individual user; the actor id is captured at write time.
--   * supersede / created_from self-and-cross links: ON DELETE SET NULL so history links
--     break gracefully instead of blocking a cascade.
--
-- DOWN (007_tax_dimension_mapping.down.sql) drops all four tables in dependency order.
-- UP -> DOWN -> UP is clean.

-- 1. tax_mappings — one ACTIVE mapping per (tenant, connection, provider, provider_tax_code);
--    superseded versions are retained (active=false) for an immutable audit trail.
CREATE TABLE tax_mappings (
  id                     bigserial PRIMARY KEY,
  tenant_id              bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id          bigint NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider               text NOT NULL,                       -- qbo | qbd | xero | sage_intacct
  provider_tax_code      text NOT NULL,                       -- resolved provider tax-code id (tax.ts CanonicalTax.code)
  internal_tax_treatment text NOT NULL,                       -- internal canonical treatment name
  tax_mode               text NOT NULL CHECK (tax_mode IN ('exclusive', 'inclusive')),  -- mirrors tax.ts TaxMode
  applies_at             text NOT NULL DEFAULT 'invoice' CHECK (applies_at IN ('invoice', 'line')),
  active                 boolean NOT NULL DEFAULT true,
  needs_revalidation     boolean NOT NULL DEFAULT false,      -- revalidation hook: set true when this mapping changes
  superseded_by_id       bigint REFERENCES tax_mappings(id) ON DELETE SET NULL,  -- points active->replacement history
  replaced_at            timestamptz,                         -- when this row was superseded (NULL while active)
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()   -- app-managed (repo has no trigger infra; matches 006 connections)
);

-- At most ONE active mapping per code+company; unlimited superseded (inactive) history rows.
-- A plain UNIQUE would forbid the "new row + mark old inactive" replace flow, so this is partial.
CREATE UNIQUE INDEX uq_tax_mappings_active
  ON tax_mappings (tenant_id, connection_id, provider, provider_tax_code)
  WHERE active;

CREATE INDEX idx_tax_mappings_tenant ON tax_mappings (tenant_id);
CREATE INDEX idx_tax_mappings_connection ON tax_mappings (connection_id);
CREATE INDEX idx_tax_mappings_superseded ON tax_mappings (superseded_by_id);
CREATE INDEX idx_tax_mappings_revalidation ON tax_mappings (tenant_id, connection_id) WHERE needs_revalidation;

-- 2. tax_mapping_audit — append-only (no updated_at). Who / when / why / which company+provider.
CREATE TABLE tax_mapping_audit (
  id             bigserial PRIMARY KEY,
  tenant_id      bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tax_mapping_id bigint NOT NULL REFERENCES tax_mappings(id) ON DELETE CASCADE,
  connection_id  bigint NOT NULL REFERENCES connections(id) ON DELETE CASCADE,   -- denormalized for audit queries w/o join
  provider       text NOT NULL,
  changed_by     bigint REFERENCES users(id) ON DELETE SET NULL,                 -- actor; survives user purge (see header)
  action         text NOT NULL CHECK (action IN ('create', 'edit', 'disable', 'replace', 'revalidate')),
  reason         text,                                                           -- populated by the API layer
  changed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tax_mapping_audit_tenant ON tax_mapping_audit (tenant_id);
CREATE INDEX idx_tax_mapping_audit_mapping ON tax_mapping_audit (tax_mapping_id);
CREATE INDEX idx_tax_mapping_audit_connection ON tax_mapping_audit (connection_id);
CREATE INDEX idx_tax_mapping_audit_changed_by ON tax_mapping_audit (changed_by);

-- 3. dimension_mappings — one row per extracted dimension value pending/resolved review.
--    resolution_state MIRRORS src/canonical/model.ts DimensionState EXACTLY (the five states
--    that are NEVER collapsed into a single "missing"). Do not rename to ad-hoc synonyms.
CREATE TABLE dimension_mappings (
  id                    bigserial PRIMARY KEY,
  tenant_id             bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id         bigint NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider              text NOT NULL,
  proposal_id           bigint NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,  -- source document trace
  dimension_type        text NOT NULL CHECK (dimension_type IN (
                          'account', 'item', 'class', 'location', 'department', 'customer',
                          'project', 'job', 'tracking_category', 'entity', 'tax_code', 'currency')),
  raw_value             text NOT NULL,                     -- extracted raw value (dimensions.ts DimensionHint.raw)
  normalized_value      text,                              -- NULL for blank/absent values (no normalization)
  source_evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,-- extraction snippet/location
  extraction_confidence numeric(4,3) NOT NULL DEFAULT 0,   -- matches proposals.confidence precision
  proposed_provider_id  text,                              -- suggested provider-side id (pre-acceptance)
  proposed_match_label  text,
  provider_id           text,                              -- resolved/accepted provider-side id
  mapping_method        text CHECK (mapping_method IN ('exact', 'fuzzy', 'learned_rule', 'manual')),  -- NULL until resolved
  review_status         text NOT NULL DEFAULT 'pending'
                          CHECK (review_status IN ('pending', 'accepted', 'corrected', 'rejected', 'held')),
  resolution_state      text NOT NULL CHECK (resolution_state IN (
                          'mapped', 'not_provided', 'not_mapped', 'unsupported_by_provider', 'intentionally_blank')),
  active                boolean NOT NULL DEFAULT true,
  mapping_version       integer NOT NULL DEFAULT 1,        -- revalidation hook: bumped when a rule change makes this stale
  revalidated_at        timestamptz,                       -- last time this row was re-checked against current rules
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_dimension_mappings_tenant ON dimension_mappings (tenant_id);
CREATE INDEX idx_dimension_mappings_connection ON dimension_mappings (connection_id);
CREATE INDEX idx_dimension_mappings_proposal ON dimension_mappings (proposal_id);
-- Review-queue access paths (filter by status/type within a company).
CREATE INDEX idx_dimension_mappings_review_queue
  ON dimension_mappings (tenant_id, connection_id, review_status);
CREATE INDEX idx_dimension_mappings_type
  ON dimension_mappings (tenant_id, connection_id, dimension_type);

-- 4. dimension_mapping_rules — an accepted mapping saved for auto-apply to FUTURE extractions
--    of the same normalized_value for the same company+provider+dimension_type. Same scoping;
--    never crosses companies.
CREATE TABLE dimension_mapping_rules (
  id               bigserial PRIMARY KEY,
  tenant_id        bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id    bigint NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider         text NOT NULL,
  dimension_type   text NOT NULL CHECK (dimension_type IN (
                     'account', 'item', 'class', 'location', 'department', 'customer',
                     'project', 'job', 'tracking_category', 'entity', 'tax_code', 'currency')),
  normalized_value text NOT NULL,                          -- normalized key this rule matches on
  raw_value        text NOT NULL,                          -- exemplar raw value that created the rule
  provider_id      text NOT NULL,                          -- provider-side id to auto-apply
  provider_label   text,
  mapping_method   text NOT NULL DEFAULT 'learned_rule'
                     CHECK (mapping_method IN ('exact', 'fuzzy', 'learned_rule', 'manual')),
  active           boolean NOT NULL DEFAULT true,
  mapping_version  integer NOT NULL DEFAULT 1,             -- revalidation hook: bump to invalidate dependent review rows
  created_from_id  bigint REFERENCES dimension_mappings(id) ON DELETE SET NULL,  -- origin review row (may be purged)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- At most ONE active rule per normalized value+type+company.
CREATE UNIQUE INDEX uq_dimension_mapping_rules_active
  ON dimension_mapping_rules (tenant_id, connection_id, provider, dimension_type, normalized_value)
  WHERE active;

CREATE INDEX idx_dimension_mapping_rules_tenant ON dimension_mapping_rules (tenant_id);
CREATE INDEX idx_dimension_mapping_rules_connection ON dimension_mapping_rules (connection_id);
CREATE INDEX idx_dimension_mapping_rules_origin ON dimension_mapping_rules (created_from_id);

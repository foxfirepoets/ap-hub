-- AP-Hub initial schema (CHUNK_1_INFRA + Amendment A1 proof_refs + Phase 0.5 forwards)
-- All money is NUMERIC(14,2); JSON blobs are JSONB so new fields never block the schema.

CREATE TABLE tenants (
  id            bigserial PRIMARY KEY,
  name          text NOT NULL,
  gmail_email   text,
  qbo_realm_id  text,
  role          text NOT NULL DEFAULT 'owner',
  paused        boolean NOT NULL DEFAULT false,
  gmail_history_id text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_tokens (
  id                 bigserial PRIMARY KEY,
  tenant_id          bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider           text NOT NULL,                 -- 'gmail' | 'qbo'
  access_token_enc   text NOT NULL,
  refresh_token_enc  text NOT NULL,
  expires_at         timestamptz,
  scope              text,
  realm              text,                            -- QBO realm id (sandbox)
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

CREATE TABLE messages (
  id                bigserial PRIMARY KEY,
  tenant_id         bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  gmail_message_id  text NOT NULL,
  thread_id         text,
  from_addr         text,
  subject           text,
  received_at       timestamptz,
  doc_type          text,
  direction         text,                            -- AP | AR
  status            text NOT NULL DEFAULT 'received',
  needs_review      boolean NOT NULL DEFAULT false,
  body_only         boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, gmail_message_id)
);

CREATE TABLE attachments (
  id            bigserial PRIMARY KEY,
  tenant_id     bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id    bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename      text,
  mime          text,
  sha256        text NOT NULL,
  storage_key   text,
  size          bigint,
  is_duplicate  boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sha256)
);

CREATE TABLE extractions (
  id             bigserial PRIMARY KEY,
  tenant_id      bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attachment_id  bigint REFERENCES attachments(id) ON DELETE CASCADE,
  message_id     bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  fields         jsonb NOT NULL,
  confidence     numeric(4,3) NOT NULL DEFAULT 0,
  missing_fields text[] NOT NULL DEFAULT '{}',
  flags          text[] NOT NULL DEFAULT '{}',
  model          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mappings (
  id              bigserial PRIMARY KEY,
  tenant_id       bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            text NOT NULL,                     -- vendor|account|class|location|project|item|customer
  source_key      text NOT NULL,
  target_qbo_type text,
  target_qbo_id   text,
  target_name     text,
  confidence      numeric(4,3),
  learned_from    text,
  extra           jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, source_key)
);

CREATE TABLE proposals (
  id             bigserial PRIMARY KEY,
  tenant_id      bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attachment_id  bigint REFERENCES attachments(id) ON DELETE CASCADE,
  extraction_id  bigint REFERENCES extractions(id) ON DELETE CASCADE,
  proposed_txn   jsonb NOT NULL,
  idempotency_key text,
  confidence     numeric(4,3) NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'review',     -- ready|review|exception|posted_sandbox|rejected
  flags          text[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, attachment_id)
);

CREATE TABLE postings (
  id              bigserial PRIMARY KEY,
  tenant_id       bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attachment_id   bigint REFERENCES attachments(id) ON DELETE CASCADE,
  proposal_id     bigint REFERENCES proposals(id) ON DELETE CASCADE,
  qbo_type        text,
  qbo_id          text,
  sync_token      text,
  realm           text,
  mode            text,                              -- 'sandbox'
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  request         jsonb,
  response        jsonb,
  posted_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE reconciliation (
  id           bigserial PRIMARY KEY,
  tenant_id    bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  left_ref     text,
  right_ref    text,
  match_status text,
  variance     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exceptions (
  id           bigserial PRIMARY KEY,
  tenant_id    bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_ref   text,
  reason_code  text NOT NULL,
  detail       text,
  status       text NOT NULL DEFAULT 'open',
  resolved_by  text,
  resolution   jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  tenant_id    bigint REFERENCES tenants(id) ON DELETE CASCADE,
  actor        text NOT NULL DEFAULT 'system',
  action       text NOT NULL,
  entity       text,
  before_hash  text,
  after_hash   text,
  realm        text,
  detail       jsonb,
  at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE corrections (
  id           bigserial PRIMARY KEY,
  tenant_id    bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  proposal_id  bigint REFERENCES proposals(id) ON DELETE CASCADE,
  exception_id bigint REFERENCES exceptions(id) ON DELETE CASCADE,
  field        text,
  old_value    text,
  new_value    text,
  became_rule  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llm_calls (
  id          bigserial PRIMARY KEY,
  tenant_id   bigint REFERENCES tenants(id) ON DELETE CASCADE,
  purpose     text NOT NULL,
  model       text,
  latency_ms  integer,
  cost        numeric(10,5),
  confidence  numeric(4,3),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Amendment A1: proof references (Verify-API / InvoiceProof / AuditProof).
CREATE TABLE proof_refs (
  id           bigserial PRIMARY KEY,
  tenant_id    bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_kind  text NOT NULL,                        -- attachment|extraction|proposal|posting|audit_day
  entity_id    text NOT NULL,
  product      text NOT NULL,                        -- verify_api|invoiceproof|auditproof
  proof_id     text,
  chain_hash   text,
  verdict      text,
  findings     jsonb,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_kind, entity_id, product)
);

-- Phase 0.5 gatekeeper: forwarding-relay decisions.
CREATE TABLE forwards (
  id            bigserial PRIMARY KEY,
  tenant_id     bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id    bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id bigint REFERENCES attachments(id) ON DELETE CASCADE,
  sha256        text,
  status        text NOT NULL DEFAULT 'pending',     -- pending|scanning|held|released|forwarding|forwarded|failed
  hold_reason   text,
  gmail_send_id text,
  subject_tag   text NOT NULL,
  alerted_at    timestamptz,
  released_by   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sha256)
);

CREATE INDEX idx_messages_tenant_status ON messages(tenant_id, status);
CREATE INDEX idx_proposals_tenant_status ON proposals(tenant_id, status);
CREATE INDEX idx_exceptions_tenant_status ON exceptions(tenant_id, status);
CREATE INDEX idx_forwards_tenant_status ON forwards(tenant_id, status);
CREATE INDEX idx_proof_refs_entity ON proof_refs(tenant_id, entity_kind, entity_id);
CREATE INDEX idx_audit_tenant_at ON audit_log(tenant_id, at);

-- Human-readable Phase-1 review surface.
CREATE VIEW v_proposal_review AS
SELECT
  p.id                AS proposal_id,
  p.tenant_id,
  p.status,
  p.confidence,
  p.flags,
  p.proposed_txn,
  a.filename          AS source_filename,
  a.sha256            AS source_sha256,
  e.fields            AS extracted_fields,
  e.missing_fields,
  e.confidence        AS extraction_confidence,
  m.subject           AS email_subject,
  m.from_addr         AS email_from,
  p.created_at
FROM proposals p
LEFT JOIN attachments a ON a.id = p.attachment_id
LEFT JOIN extractions e ON e.id = p.extraction_id
LEFT JOIN messages m ON m.id = e.message_id;

-- CHUNK_1_SCHEMA: durable, tenant-scoped accounting intake foundation.
--
-- Composite identity indexes allow every relationship below to prove that the
-- referenced row belongs to the same tenant. They are intentionally additive.
CREATE UNIQUE INDEX messages_tenant_id_id_uq ON messages (tenant_id, id);
CREATE UNIQUE INDEX attachments_tenant_id_id_uq ON attachments (tenant_id, id);
CREATE UNIQUE INDEX connections_tenant_id_id_uq ON connections (tenant_id, id);
CREATE UNIQUE INDEX proposals_tenant_id_id_uq ON proposals (tenant_id, id);
CREATE UNIQUE INDEX users_tenant_id_id_uq ON users (tenant_id, id);

CREATE TABLE accounting_documents (
  id                        bigserial PRIMARY KEY,
  tenant_id                 bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id                bigint NOT NULL,
  attachment_id             bigint,
  kind                      text NOT NULL CHECK (kind IN ('invoice', 'bank_statement', 'unknown')),
  sha256                    text NOT NULL,
  status                    text NOT NULL DEFAULT 'received'
                              CHECK (status IN ('received', 'extracted', 'review', 'ready', 'filed', 'posted', 'held', 'rejected')),
  classification_confidence numeric(5,4) NOT NULL DEFAULT 0
                              CHECK (classification_confidence >= 0 AND classification_confidence <= 1),
  hold_reason               text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, message_id)
    REFERENCES messages (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, attachment_id)
    REFERENCES attachments (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX accounting_documents_tenant_hash_kind_uq
  ON accounting_documents (tenant_id, sha256, kind);
CREATE INDEX accounting_documents_tenant_status_idx
  ON accounting_documents (tenant_id, status, created_at DESC);
CREATE INDEX accounting_documents_tenant_message_idx
  ON accounting_documents (tenant_id, message_id);

CREATE TABLE bank_statements (
  id                bigserial PRIMARY KEY,
  tenant_id         bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id       bigint NOT NULL,
  institution_name  text,
  account_hint      text,
  currency          text,
  period_start      date,
  period_end        date,
  opening_balance   numeric(18,2),
  closing_balance   numeric(18,2),
  extracted_fields  jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'extracted'
                      CHECK (status IN ('extracted', 'unbalanced', 'review', 'ready', 'filed', 'held')),
  validation_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  filed_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (period_start IS NULL OR period_end IS NULL OR period_end >= period_start),
  UNIQUE (document_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id)
    REFERENCES accounting_documents (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX bank_statements_tenant_status_period_idx
  ON bank_statements (tenant_id, status, period_end DESC);

CREATE TABLE bank_statement_lines (
  id                   bigserial PRIMARY KEY,
  tenant_id            bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  statement_id         bigint NOT NULL,
  line_no              integer NOT NULL CHECK (line_no > 0),
  posted_on            date,
  description          text NOT NULL,
  amount               numeric(18,2) NOT NULL,
  balance              numeric(18,2),
  fingerprint          text NOT NULL,
  match_status         text NOT NULL DEFAULT 'unmatched'
                         CHECK (match_status IN ('unmatched', 'suggested', 'matched', 'excluded')),
  matched_provider_ref jsonb,
  review_reason        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, statement_id)
    REFERENCES bank_statements (tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX bank_statement_lines_statement_line_uq
  ON bank_statement_lines (statement_id, line_no);
CREATE UNIQUE INDEX bank_statement_lines_tenant_fingerprint_uq
  ON bank_statement_lines (tenant_id, fingerprint);
CREATE INDEX bank_statement_lines_tenant_statement_status_idx
  ON bank_statement_lines (tenant_id, statement_id, match_status);

CREATE TABLE provider_jobs (
  id                bigserial PRIMARY KEY,
  tenant_id         bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id     bigint NOT NULL,
  proposal_id       bigint,
  operation         text NOT NULL
                      CHECK (operation IN ('verify_company', 'query', 'post_bill', 'read_back', 'attach')),
  request_payload   jsonb NOT NULL,
  response_payload  jsonb,
  status            text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'leased', 'sent', 'succeeded', 'failed', 'held')),
  idempotency_key   text NOT NULL,
  lease_token       text,
  leased_at         timestamptz,
  lease_expires_at  timestamptz,
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code        text,
  error_detail      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES connections (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, proposal_id)
    REFERENCES proposals (tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'leased' AND lease_token IS NOT NULL AND leased_at IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR status <> 'leased'
  )
);

CREATE UNIQUE INDEX provider_jobs_idempotent_uq
  ON provider_jobs (tenant_id, connection_id, idempotency_key, operation);
CREATE INDEX provider_jobs_lease_idx
  ON provider_jobs (connection_id, status, lease_expires_at, created_at);
CREATE INDEX provider_jobs_tenant_status_idx
  ON provider_jobs (tenant_id, status, created_at);

CREATE TABLE reply_drafts (
  id              bigserial PRIMARY KEY,
  tenant_id       bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id      bigint NOT NULL,
  gmail_draft_id  text,
  thread_id       text NOT NULL,
  to_addr         text NOT NULL,
  subject         text NOT NULL,
  body_text       text NOT NULL,
  status          text NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed', 'created', 'updated', 'discarded', 'sent_external')),
  reason          text,
  created_by      bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, message_id)
    REFERENCES messages (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, created_by)
    REFERENCES users (tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX reply_drafts_one_active_per_message_uq
  ON reply_drafts (tenant_id, message_id)
  WHERE status IN ('proposed', 'created', 'updated');
CREATE INDEX reply_drafts_tenant_status_idx
  ON reply_drafts (tenant_id, status, updated_at DESC);

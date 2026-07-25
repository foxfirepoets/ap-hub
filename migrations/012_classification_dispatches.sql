CREATE TABLE IF NOT EXISTS classification_dispatches (
  id            bigserial PRIMARY KEY,
  tenant_id     bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id   bigint NOT NULL,
  job_name      text NOT NULL CHECK (job_name IN ('extract', 'extract_statement')),
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched')),
  attempts      integer NOT NULL DEFAULT 0,
  dispatched_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, document_id)
    REFERENCES accounting_documents (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, document_id)
);
CREATE INDEX IF NOT EXISTS classification_dispatches_pending_idx
  ON classification_dispatches (status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS extractions_body_message_uq
  ON extractions (tenant_id, message_id) WHERE attachment_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS extractions_attachment_uq
  ON extractions (tenant_id, attachment_id) WHERE attachment_id IS NOT NULL;
ALTER TABLE extractions
  ADD COLUMN IF NOT EXISTS processing_completed_at timestamptz;

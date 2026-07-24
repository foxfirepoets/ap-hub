-- Retained accounting-intake rows are customer financial records. Refuse the
-- rollback instead of silently deleting them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounting_documents LIMIT 1)
     OR EXISTS (SELECT 1 FROM bank_statements LIMIT 1)
     OR EXISTS (SELECT 1 FROM bank_statement_lines LIMIT 1)
     OR EXISTS (SELECT 1 FROM provider_jobs LIMIT 1)
     OR EXISTS (SELECT 1 FROM reply_drafts LIMIT 1)
  THEN
    RAISE EXCEPTION 'refusing DOWN for 008_accounting_intake: retained rows exist';
  END IF;
END
$$;

DROP TABLE reply_drafts;
DROP TABLE provider_jobs;
DROP TABLE bank_statement_lines;
DROP TABLE bank_statements;
DROP TABLE accounting_documents;

DROP INDEX users_tenant_id_id_uq;
DROP INDEX proposals_tenant_id_id_uq;
DROP INDEX connections_tenant_id_id_uq;
DROP INDEX attachments_tenant_id_id_uq;
DROP INDEX messages_tenant_id_id_uq;

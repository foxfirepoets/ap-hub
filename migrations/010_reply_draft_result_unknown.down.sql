DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM reply_drafts WHERE status = 'result_unknown') THEN
    RAISE EXCEPTION 'Cannot roll back: reply drafts have unknown provider results';
  END IF;
END $$;

DROP INDEX reply_drafts_one_active_per_message_uq;
CREATE UNIQUE INDEX reply_drafts_one_active_per_message_uq
  ON reply_drafts (tenant_id, message_id)
  WHERE status IN ('proposed', 'created', 'updated');

ALTER TABLE reply_drafts
  DROP CONSTRAINT reply_drafts_status_check;
ALTER TABLE reply_drafts
  ADD CONSTRAINT reply_drafts_status_check
  CHECK (status IN ('proposed', 'created', 'updated', 'discarded', 'sent_external'));

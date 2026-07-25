ALTER TABLE reply_drafts
  DROP CONSTRAINT reply_drafts_status_check;

ALTER TABLE reply_drafts
  ADD CONSTRAINT reply_drafts_status_check
  CHECK (status IN (
    'proposed', 'result_unknown', 'created', 'updated', 'discarded', 'sent_external'
  ));

DROP INDEX reply_drafts_one_active_per_message_uq;
CREATE UNIQUE INDEX reply_drafts_one_active_per_message_uq
  ON reply_drafts (tenant_id, message_id)
  WHERE status IN ('proposed', 'result_unknown', 'created', 'updated');

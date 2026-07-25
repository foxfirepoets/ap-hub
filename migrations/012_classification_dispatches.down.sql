DROP INDEX IF EXISTS extractions_body_message_uq;
DROP INDEX IF EXISTS extractions_attachment_uq;
ALTER TABLE extractions DROP COLUMN IF EXISTS processing_completed_at;
DROP TABLE classification_dispatches;

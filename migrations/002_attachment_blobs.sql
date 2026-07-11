-- Attachment bytes stored once, keyed by content hash (CHUNK_3). Kept out of the
-- attachments row so the same file arriving twice stores bytes only once.
CREATE TABLE attachment_blobs (
  sha256  text PRIMARY KEY,
  bytes   bytea NOT NULL,
  mime    text,
  size    bigint
);

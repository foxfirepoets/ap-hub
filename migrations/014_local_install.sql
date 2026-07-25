-- 014_local_install.sql — CHUNK_2_DATABASE
--
-- Single-row identity for this install. AP-Hub v1 is one computer, one OS account, one
-- install, many companies (packet §9), so this table is a singleton by construction: the
-- primary key is pinned to 1 by a CHECK, which makes a second install row impossible rather
-- than merely discouraged.
--
-- os_account_id is the Windows SID or the macOS UID. It is the product's identity anchor —
-- there is no password and no hosted login, because the operating system already
-- authenticated the user. A mismatch between this value and the running OS account must fail
-- closed (enforced in src/, not here).
--
-- NO SECRET, TOKEN, PASSWORD OR KEY MAY BE STORED IN THIS TABLE. Provider tokens and the
-- backup encryption key live only in the OS credential store.

CREATE TABLE local_install (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  install_id      UUID        NOT NULL,
  os_account_id   TEXT        NOT NULL,          -- Windows SID or macOS UID
  platform        TEXT        NOT NULL CHECK (platform IN ('win32','darwin')),
  app_version     TEXT        NOT NULL,
  db_port         INTEGER     NOT NULL CHECK (db_port BETWEEN 1024 AND 65535),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Redundant with the CHECK-pinned primary key, but stated in the spec and harmless: it makes
-- the singleton intent explicit to anyone reading the schema rather than the migration.
CREATE UNIQUE INDEX local_install_singleton ON local_install ((id));

-- app_version exists so P4's update delivery has the field it needs to compare against a
-- signed manifest. P1 must not foreclose auto-update (spec §11); this is part of not doing so.
COMMENT ON COLUMN local_install.app_version IS
  'Installed AP-Hub version. Read by the P4 update check; never shown to the user.';
COMMENT ON COLUMN local_install.db_port IS
  'Probed port of the bundled PostgreSQL (>=55432). Never surfaced in the UI.';

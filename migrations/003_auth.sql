-- CHUNK_1_AUTH: human identity — Google-SSO users + tenant-scoped, role-based sessions.
-- Every user belongs to exactly one tenant (UNIQUE(tenant_id,email)); every session
-- resolves to exactly one user (and therefore one tenant_id). Only the sha256 hash of a
-- session token is stored — the raw token lives only in the httpOnly cookie.

CREATE TABLE IF NOT EXISTS users (
  id          bigserial PRIMARY KEY,
  tenant_id   bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email       text NOT NULL,
  name        text,
  role        text NOT NULL DEFAULT 'cpa',        -- owner_controller | bookkeeper | cpa
  google_sub  text,                                -- Google account subject id (stable)
  status      text NOT NULL DEFAULT 'invited',     -- invited | active | disabled
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS sessions (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,                       -- sha256(raw token); raw is never stored
  expires_at  timestamptz NOT NULL,
  revoked     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

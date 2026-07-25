CREATE TABLE sso_login_states (
  token_hash  text PRIMARY KEY,
  tenant_id   bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX sso_login_states_expiry_idx
  ON sso_login_states (expires_at) WHERE consumed_at IS NULL;

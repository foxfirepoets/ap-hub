CREATE TABLE oauth_connect_states (
  token_hash  text PRIMARY KEY,
  tenant_id   bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  bigint NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider    text NOT NULL CHECK (provider IN ('gmail', 'qbo')),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_connect_states_expiry_idx
  ON oauth_connect_states (expires_at) WHERE consumed_at IS NULL;
CREATE INDEX oauth_connect_states_session_idx
  ON oauth_connect_states (session_id);

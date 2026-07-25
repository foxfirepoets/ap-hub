-- Non-secret references to Windows Credential Manager entries. Credential
-- values remain outside PostgreSQL.

CREATE OR REPLACE FUNCTION aphub_nonsecret_text_valid(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT value = btrim(value, E' \t\n\r\f\v')
     AND value !~ '[[:cntrl:]]'
     AND btrim(value, E' \t\n\r\f\v') !~* '^(bearer|basic)\s+'
     AND btrim(value, E' \t\n\r\f\v') !~* '^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$'
     AND btrim(value, E' \t\n\r\f\v') !~* '^-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE)-----'
     AND btrim(value, E' \t\n\r\f\v') !~* '^(sk|pk|api[_-]?key|access[_-]?token|private[_-]?key)[-_:]'
     AND btrim(value, E' \t\n\r\f\v') !~* '^AIza[0-9A-Za-z_-]{20,}$'
     AND btrim(value, E' \t\n\r\f\v') !~* '^gh[pousr]_[0-9A-Za-z]{20,}$'
     AND NOT (
       length(btrim(value, E' \t\n\r\f\v')) >= 48
       AND btrim(value, E' \t\n\r\f\v') ~ '^[A-Za-z0-9+/_=-]+$'
       AND btrim(value, E' \t\n\r\f\v') ~ '[A-Za-z]'
       AND btrim(value, E' \t\n\r\f\v') ~ '[0-9]'
       AND btrim(value, E' \t\n\r\f\v') !~ '^[0-9]+$'
       AND btrim(value, E' \t\n\r\f\v') !~ '^registered-[A-Za-z0-9._-]+$'
     )
$$;

CREATE OR REPLACE FUNCTION aphub_credential_metadata_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  key_name text;
  scope_item jsonb;
  refresh_status jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'object' THEN RETURN false; END IF;
  FOR key_name IN SELECT key FROM jsonb_object_keys(value) AS keys(key)
  LOOP
    IF key_name NOT IN ('scope','expires_at','provider_account_id','last_refresh_status') THEN
      RETURN false;
    END IF;
  END LOOP;
  IF value ? 'scope' THEN
    IF jsonb_typeof(value->'scope') <> 'array'
       OR jsonb_array_length(value->'scope') > 100 THEN RETURN false; END IF;
    FOR scope_item IN SELECT element FROM jsonb_array_elements(value->'scope') AS a(element)
    LOOP
      IF jsonb_typeof(scope_item) <> 'string'
         OR length(scope_item #>> '{}') NOT BETWEEN 1 AND 500
         OR NOT aphub_nonsecret_text_valid(scope_item #>> '{}') THEN RETURN false; END IF;
    END LOOP;
  END IF;
  IF value ? 'expires_at' AND (
    jsonb_typeof(value->'expires_at') <> 'string'
    OR length(value->>'expires_at') NOT BETWEEN 1 AND 64
    OR (value->>'expires_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    OR NOT aphub_nonsecret_text_valid(value->>'expires_at')
  ) THEN RETURN false; END IF;
  IF value ? 'provider_account_id' AND (
    jsonb_typeof(value->'provider_account_id') <> 'string'
    OR length(value->>'provider_account_id') NOT BETWEEN 1 AND 512
    OR NOT aphub_nonsecret_text_valid(value->>'provider_account_id')
    OR (value->>'provider_account_id') !~ '^[A-Za-z0-9][A-Za-z0-9._@:+/-]*$'
  ) THEN RETURN false; END IF;
  IF value ? 'last_refresh_status' THEN
    refresh_status := value->'last_refresh_status';
    IF jsonb_typeof(refresh_status) <> 'object' THEN RETURN false; END IF;
    FOR key_name IN SELECT key FROM jsonb_object_keys(refresh_status) AS keys(key)
    LOOP
      IF key_name NOT IN ('state','attempts','checked_at') THEN RETURN false; END IF;
    END LOOP;
    IF refresh_status ? 'state' AND (
      jsonb_typeof(refresh_status->'state') <> 'string'
      OR refresh_status->>'state' NOT IN ('healthy','refresh_required','held','error','unknown')
      OR NOT aphub_nonsecret_text_valid(refresh_status->>'state')
    ) THEN RETURN false; END IF;
    IF refresh_status ? 'attempts' AND (
      jsonb_typeof(refresh_status->'attempts') <> 'number'
      OR (refresh_status->>'attempts') !~ '^[0-9]+$'
      OR (refresh_status->>'attempts')::numeric > 1000000
    ) THEN RETURN false; END IF;
    IF refresh_status ? 'checked_at' AND (
      jsonb_typeof(refresh_status->'checked_at') <> 'string'
      OR length(refresh_status->>'checked_at') NOT BETWEEN 1 AND 64
      OR (refresh_status->>'checked_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      OR NOT aphub_nonsecret_text_valid(refresh_status->>'checked_at')
    ) THEN RETURN false; END IF;
  END IF;
  RETURN true;
END
$$;

CREATE OR REPLACE FUNCTION aphub_transport_config_valid(mode text, value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  key_name text;
  tool jsonb;
  allowed_keys text[];
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' THEN RETURN false; END IF;
  IF mode IS NULL THEN RETURN value = '{}'::jsonb; END IF;
  allowed_keys := CASE mode
    WHEN 'direct_local_oauth' THEN ARRAY['expected_company_id','timeout_ms']
    WHEN 'api_adapter' THEN ARRAY['endpoint_id','expected_company_id','timeout_ms']
    WHEN 'mcp_adapter' THEN ARRAY['transport','endpoint_id','command_id','allowed_tools','expected_company_id','timeout_ms']
    WHEN 'qb_desktop' THEN ARRAY['expected_company_id','company_file_id','timeout_ms']
    ELSE ARRAY[]::text[]
  END;
  FOR key_name IN SELECT key FROM jsonb_object_keys(value) AS keys(key)
  LOOP
    IF NOT (key_name = ANY(allowed_keys)) THEN RETURN false; END IF;
  END LOOP;
  FOREACH key_name IN ARRAY ARRAY['endpoint_id','command_id','expected_company_id','company_file_id']
  LOOP
    IF value ? key_name AND (
      jsonb_typeof(value->key_name) <> 'string'
      OR length(value->>key_name) NOT BETWEEN 1 AND 512
      OR (value->>key_name) !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
      OR NOT aphub_nonsecret_text_valid(value->>key_name)
    ) THEN RETURN false; END IF;
  END LOOP;
  IF value ? 'endpoint_id' AND (value->>'endpoint_id') !~ '^registered-[A-Za-z0-9][A-Za-z0-9._-]*$'
    THEN RETURN false; END IF;
  IF value ? 'command_id' AND (value->>'command_id') !~ '^registered-[A-Za-z0-9][A-Za-z0-9._-]*$'
    THEN RETURN false; END IF;
  IF value ? 'timeout_ms' AND (
    jsonb_typeof(value->'timeout_ms') <> 'number'
    OR (value->>'timeout_ms') !~ '^[0-9]+$'
    OR (value->>'timeout_ms')::numeric NOT BETWEEN 100 AND 300000
  ) THEN RETURN false; END IF;
  IF value ? 'transport' AND (
    jsonb_typeof(value->'transport') <> 'string'
    OR value->>'transport' NOT IN ('stdio','http')
    OR NOT aphub_nonsecret_text_valid(value->>'transport')
  ) THEN RETURN false; END IF;
  IF value ? 'allowed_tools' THEN
    IF jsonb_typeof(value->'allowed_tools') <> 'array'
       OR jsonb_array_length(value->'allowed_tools') NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
    FOR tool IN SELECT element FROM jsonb_array_elements(value->'allowed_tools') AS a(element)
    LOOP
      IF jsonb_typeof(tool) <> 'string'
         OR length(tool #>> '{}') NOT BETWEEN 1 AND 128
         OR (tool #>> '{}') !~ '^[A-Za-z][A-Za-z0-9._-]*$'
         OR (tool #>> '{}') = '*' THEN RETURN false; END IF;
      IF NOT aphub_nonsecret_text_valid(tool #>> '{}') THEN RETURN false; END IF;
    END LOOP;
  END IF;
  RETURN true;
END
$$;

CREATE TABLE credential_refs (
  id                bigserial PRIMARY KEY,
  tenant_id         bigint NOT NULL REFERENCES tenants(id),
  provider          text NOT NULL,
  purpose           text NOT NULL,
  credential_target text NOT NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, purpose),
  CONSTRAINT credential_refs_target_check
    CHECK (credential_target ~ '^APHub/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$'),
  CONSTRAINT credential_refs_metadata_no_secrets_check
    CHECK (aphub_credential_metadata_valid(metadata))
);

ALTER TABLE connections
  ADD COLUMN transport_mode text,
  ADD COLUMN transport_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT connections_transport_mode_check
    CHECK (transport_mode IS NULL OR transport_mode IN
      ('direct_local_oauth','api_adapter','mcp_adapter','qb_desktop')),
  ADD CONSTRAINT connections_transport_config_no_secrets_check
    CHECK (aphub_transport_config_valid(transport_mode, transport_config));

CREATE INDEX credential_refs_tenant_provider_idx
  ON credential_refs (tenant_id, provider);

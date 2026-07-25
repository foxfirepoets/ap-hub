DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM credential_refs LIMIT 1)
     OR EXISTS (SELECT 1 FROM connections WHERE transport_mode IS NOT NULL LIMIT 1)
  THEN
    RAISE EXCEPTION 'refusing DOWN for 013_local_runtime_credentials: retained rows exist';
  END IF;
END
$$;

DROP INDEX credential_refs_tenant_provider_idx;
ALTER TABLE connections
  DROP CONSTRAINT connections_transport_config_no_secrets_check,
  DROP CONSTRAINT connections_transport_mode_check,
  DROP COLUMN transport_config,
  DROP COLUMN transport_mode;
DROP TABLE credential_refs;
DROP FUNCTION aphub_transport_config_valid(text,jsonb);
DROP FUNCTION aphub_credential_metadata_valid(jsonb);
DROP FUNCTION aphub_nonsecret_text_valid(text);

-- 810_supabase_oauth: custody support for the Supabase OAuth connect (IH6).
--
-- Context: integrations
-- Epic: saas-integration-hub (IH6) — the PKCE code_verifier must live
--       SERVER-SIDE between the authorize redirect and the callback (putting
--       it in the signed state would hand it to every interceptor of the
--       redirect, defeating PKCE). It rides the existing custody table as its
--       own kind: enveloped like every credential, bound to the pending
--       connection, deleted the moment the exchange consumes it.
--
-- Guarded CHECK swap (the 720 lesson: inline column CHECKs are auto-named
-- {table}_{column}_check); idempotent as a unit.

ALTER TABLE integrations.provider_credentials
  DROP CONSTRAINT IF EXISTS provider_credentials_kind_check;
ALTER TABLE integrations.provider_credentials
  ADD CONSTRAINT provider_credentials_kind_check
  CHECK (kind IN (
    'slack_bot_token',
    'cloudflare_parent_token',
    'supabase_refresh_token',
    'supabase_access_token_cache',
    'supabase_pkce_verifier'
  ));

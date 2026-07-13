-- 830_cloudflare_oauth: custody support for the Cloudflare OAuth connect (IH5).
--
-- Context: integrations
-- Epic: saas-integration-hub (IH5, risks D3) — Cloudflare shipped OAuth
--       clients for the API, so the connect posture upgrades from token-paste
--       to `connectKind: "oauth"` (PKCE), exactly like Supabase (IH6). Two new
--       custody kinds ride the existing provider_credentials table:
--         * cloudflare_refresh_token — the durable OAuth grant (the twin of
--           supabase_refresh_token); mints derive a short-lived access token
--           from it and never store the access token durable.
--         * cloudflare_pkce_verifier — the PKCE code_verifier, server-side
--           between the authorize redirect and the callback, deleted the moment
--           the exchange consumes it (same rationale as 810's Supabase verifier:
--           putting it in the signed state would defeat PKCE).
--       Token-paste (cloudflare_parent_token) is retained as the fallback the
--       adapter still supports when no OAuth app is configured.
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
    'cloudflare_refresh_token',
    'cloudflare_pkce_verifier',
    'supabase_refresh_token',
    'supabase_access_token_cache',
    'supabase_pkce_verifier'
  ));

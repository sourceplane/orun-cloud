-- 840_service_identity_custody: credential classes + service-identity kinds (SI1).
--
-- Context: integrations
-- Epic: saas-integration-hub / sub-epics/service-identity-bootstrap (SI1) —
--       "OAuth establishes trust, service identities operate." The durable
--       custody for OAuth-connected providers stops being a user-derived
--       refresh token; bootstrap consent provisions a provider-side,
--       org-owned service identity instead. This migration lands the
--       substrate, dormant:
--         * kind CHECK admits the service-identity kinds:
--             - cloudflare_service_token — the durable ACCOUNT-OWNED API
--               token Orun provisions for itself at bootstrap (SI2). The
--               operating twin of the pasted cloudflare_parent_token;
--               replaces cloudflare_refresh_token as Cloudflare's custody.
--             - supabase_project_secret — per-project secret keys, enveloped
--               as ONE encrypted JSON map per connection (SI4) so the
--               (connection_id, kind) uniqueness and zeroize-on-revoke
--               discipline hold unchanged.
--         * credential_class — 'identity' (bootstrap-only: OAuth tokens,
--           PKCE verifiers; deleted when provisioning completes) vs
--           'infrastructure' (durable, platform-rotated). Backfilled from
--           kind; the repo layer stamps it on every upsert.
--         * minted_credentials.parent_kind — which custody kind authorized
--           each mint: the rollout observability for SI3 ("refresh-parented
--           mint count reaches zero") and the audit answer to "was this
--           credential minted from a user token?".
--
-- Guarded CHECK swap (the 720 lesson: inline column CHECKs are auto-named
-- {table}_{column}_check); additive + idempotent as a unit.

ALTER TABLE integrations.provider_credentials
  DROP CONSTRAINT IF EXISTS provider_credentials_kind_check;
ALTER TABLE integrations.provider_credentials
  ADD CONSTRAINT provider_credentials_kind_check
  CHECK (kind IN (
    'slack_bot_token',
    'cloudflare_parent_token',
    'cloudflare_service_token',
    'cloudflare_refresh_token',
    'cloudflare_pkce_verifier',
    'supabase_refresh_token',
    'supabase_access_token_cache',
    'supabase_pkce_verifier',
    'supabase_project_secret'
  ));

ALTER TABLE integrations.provider_credentials
  ADD COLUMN IF NOT EXISTS credential_class TEXT NOT NULL DEFAULT 'infrastructure';

ALTER TABLE integrations.provider_credentials
  DROP CONSTRAINT IF EXISTS provider_credentials_credential_class_check;
ALTER TABLE integrations.provider_credentials
  ADD CONSTRAINT provider_credentials_credential_class_check
  CHECK (credential_class IN ('identity', 'infrastructure'));

-- Backfill: user-derived/bootstrap material is identity-class. Idempotent —
-- re-running converges on the same classification.
UPDATE integrations.provider_credentials
SET credential_class = 'identity'
WHERE kind IN (
  'cloudflare_refresh_token',
  'cloudflare_pkce_verifier',
  'supabase_refresh_token',
  'supabase_access_token_cache',
  'supabase_pkce_verifier'
)
AND credential_class <> 'identity';

COMMENT ON COLUMN integrations.provider_credentials.credential_class IS
  'Service-identity bootstrap (SI1): identity = bootstrap-only material '
  '(OAuth refresh/access tokens, PKCE verifiers) that must not outlive '
  'provisioning; infrastructure = the durable org-owned operating credential '
  '(service tokens, project secrets, bot tokens).';

ALTER TABLE integrations.minted_credentials
  ADD COLUMN IF NOT EXISTS parent_kind TEXT;

COMMENT ON COLUMN integrations.minted_credentials.parent_kind IS
  'Service-identity bootstrap (SI1): the custody kind that authorized this '
  'mint (e.g. cloudflare_service_token vs cloudflare_refresh_token). Null '
  'for parentless providers and pre-SI1 rows. The SI3/SI5 deprecation '
  'metric: user-derived parent kinds must reach zero.';

-- 670_identity_oauth_grants: OAuth 2.1 authorization codes for MCP clients
-- (saas-mcp-server MCP3).
--
-- Context: identity
-- Epic: saas-mcp-server (MCP3 — OAuth 2.1 for interactive remote clients).
--       Rides the OP1 grant store rather than inventing a new persistence
--       layer (risks R5: no second token plane): an OAuth authorization code
--       is a third `flow` on identity.cli_login_grants. The code itself is
--       hashed into the existing cli_code_hash column (same single-use redeem
--       semantics as the loopback cli_code); the new columns bind the code to
--       its client_id + redirect_uri + PKCE S256 challenge per RFC 6749/7636.
--       Redeeming the code mints an ordinary CLI-kind session (rotating
--       refresh family, reuse detection, console revocation — all unchanged),
--       labeled `mcp:<clientId>` via the existing client_host column.
--
-- Client registration is a static vetted allow-list in code (risks D1,
-- Option A — decided 2026-07-09); nothing about clients is stored here.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; constraint swaps are
-- DROP IF EXISTS + ADD (Supabase autocommit safety).

ALTER TABLE identity.cli_login_grants
  ADD COLUMN IF NOT EXISTS oauth_client_id      TEXT;

ALTER TABLE identity.cli_login_grants
  ADD COLUMN IF NOT EXISTS oauth_redirect_uri   TEXT;

ALTER TABLE identity.cli_login_grants
  ADD COLUMN IF NOT EXISTS oauth_code_challenge TEXT;

-- Widen the flow vocabulary: loopback | device | oauth.
ALTER TABLE identity.cli_login_grants
  DROP CONSTRAINT IF EXISTS cli_login_grants_flow_check;

ALTER TABLE identity.cli_login_grants
  ADD CONSTRAINT cli_login_grants_flow_check
    CHECK (flow IN ('loopback', 'device', 'oauth'));

-- A row is exactly one flow. The oauth branch reuses cli_code_hash as the
-- authorization-code hash and requires the full client/redirect/PKCE binding.
ALTER TABLE identity.cli_login_grants
  DROP CONSTRAINT IF EXISTS cli_login_grants_flow_secrets_check;

ALTER TABLE identity.cli_login_grants
  ADD CONSTRAINT cli_login_grants_flow_secrets_check CHECK (
    (flow = 'loopback' AND cli_code_hash IS NOT NULL
                       AND device_code_hash IS NULL AND user_code_hash IS NULL
                       AND oauth_client_id IS NULL AND oauth_redirect_uri IS NULL
                       AND oauth_code_challenge IS NULL)
    OR
    (flow = 'device'   AND device_code_hash IS NOT NULL AND user_code_hash IS NOT NULL
                       AND cli_code_hash IS NULL
                       AND oauth_client_id IS NULL AND oauth_redirect_uri IS NULL
                       AND oauth_code_challenge IS NULL)
    OR
    (flow = 'oauth'    AND cli_code_hash IS NOT NULL
                       AND device_code_hash IS NULL AND user_code_hash IS NULL
                       AND oauth_client_id IS NOT NULL AND oauth_redirect_uri IS NOT NULL
                       AND oauth_code_challenge IS NOT NULL)
  );

COMMENT ON COLUMN identity.cli_login_grants.oauth_client_id IS 'OAuth flow: the vetted public client_id (allow-list in code, D1 Option A) the authorization code is bound to.';
COMMENT ON COLUMN identity.cli_login_grants.oauth_redirect_uri IS 'OAuth flow: the exact redirect_uri presented on authorize; the token endpoint must be given the same value (RFC 6749 §4.1.3).';
COMMENT ON COLUMN identity.cli_login_grants.oauth_code_challenge IS 'OAuth flow: the PKCE S256 code challenge (base64url(SHA-256(verifier))) the token endpoint verifies (RFC 7636).';

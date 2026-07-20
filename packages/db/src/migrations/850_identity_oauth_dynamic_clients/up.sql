-- 850_identity_oauth_dynamic_clients: RFC 7591 dynamic OAuth client registry
-- (saas-mcp-server MCP11 leg B).
--
-- Context: identity
-- Epic: saas-mcp-server (MCP11 — remote connectability). Activates the D1 →
--       Option B path exactly as documented ("DCR behind rate limits +
--       short-lived unused-client GC … additive on top of the same
--       authorize/token endpoints"): claude.ai's connector flow requires a
--       registration_endpoint, so PUBLIC clients self-register here and the
--       authorize/complete + token endpoints resolve them AFTER the static
--       vetted allow-list (a dynamic row can never shadow a vetted clientId —
--       enforced belt-and-braces by the `dcr_` id namespace CHECK below and
--       by static-first resolution in code).
--
-- PUBLIC clients only: no secret column exists ON PURPOSE — registration
-- mints client IDENTITIES, never credentials (risks R5: no second token
-- plane; token_endpoint_auth_method is always "none").
--
-- expires_at is the unused-client GC horizon (~30d from creation, refreshed
-- on token redemption). An expired row is treated as unknown at
-- authorize/token and is deleted opportunistically on later registrations
-- (identity-worker has no scheduled sweep; cleanup piggybacks on writes).
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS (Supabase autocommit safety).

CREATE TABLE IF NOT EXISTS identity.oauth_dynamic_clients (
  -- Server-minted `dcr_<hex32>` id; the namespace CHECK guarantees a dynamic
  -- row can never carry (and thus never shadow) a static allow-list clientId.
  client_id     TEXT PRIMARY KEY CHECK (client_id LIKE 'dcr\_%'),
  client_name   TEXT NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 100),
  -- JSON array of registered redirect URIs (1–10, validated server-side:
  -- https non-loopback OR http loopback per RFC 8252 §7.3).
  redirect_uris JSONB NOT NULL CHECK (jsonb_typeof(redirect_uris) = 'array'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Stamped on token redemption; null until the client completes a flow.
  last_used_at  TIMESTAMPTZ,
  -- Unused-client GC horizon: creation + 30d, pushed forward on use.
  expires_at    TIMESTAMPTZ NOT NULL
);

-- Backs the opportunistic expired-row sweep.
CREATE INDEX IF NOT EXISTS oauth_dynamic_clients_expires_at_idx
  ON identity.oauth_dynamic_clients (expires_at);

COMMENT ON TABLE identity.oauth_dynamic_clients IS 'RFC 7591 dynamically-registered PUBLIC OAuth clients (saas-mcp-server MCP11 leg B, D1 Option B). No secrets stored; rows are TTL''d and GC''d when unused.';
COMMENT ON COLUMN identity.oauth_dynamic_clients.client_id IS 'Server-minted dcr_<hex32> id — the dcr_ namespace guarantees no collision with the static vetted allow-list, which always resolves first.';
COMMENT ON COLUMN identity.oauth_dynamic_clients.redirect_uris IS 'JSON array of registered redirect URIs; matching is exact with the RFC 8252 §7.3 loopback any-port carve-out (same matcher as static clients).';
COMMENT ON COLUMN identity.oauth_dynamic_clients.expires_at IS 'Unused-client GC horizon (~30d, refreshed on token redemption). Expired rows are treated as unknown clients and deleted opportunistically.';

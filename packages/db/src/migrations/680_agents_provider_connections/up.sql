-- 680_agents_provider_connections: BYO provider accounts (saas-agents AG12).
--
-- Context: agents
-- Epic: saas-agents (specs/epics/saas-agents/ design §10). A workspace
--       connects its own Daytona account (sandbox compute) and Anthropic key
--       (model credential) as provider connections.
--
-- Design rules:
--   * The KEY IS NOT HERE. Secret material lives in the secret manager
--     (config-worker envelope encryption) under the reserved namespace
--     agents/providers/<provider>/<name>/API_KEY; this row stores only
--     secret_ref — the SD-1 carve-out, unchanged.
--   * Verification status is an infrastructure fact about the connection
--     (a cheap read-only provider ping), CHECK'd to a closed vocabulary.
--   * Tenancy: workspace-scoped (org_id). One connection name per provider
--     per workspace.
--   * Idempotent: IF NOT EXISTS throughout for Supabase autocommit safety.

CREATE TABLE IF NOT EXISTS agents.provider_connections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id        TEXT NOT NULL,                -- apc_…
  org_id           UUID NOT NULL,
  provider         TEXT NOT NULL
                     CHECK (provider IN ('daytona','anthropic')),
  name             TEXT NOT NULL DEFAULT 'default',
  -- Non-secret provider config: daytona {apiUrl?, orgId?, target?};
  -- anthropic {defaultModel?}. Never key material.
  config           JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_ref       TEXT NOT NULL,                -- reserved-namespace secret key
  key_hint         TEXT,                          -- last4 display hint, never the key
  status           TEXT NOT NULL DEFAULT 'unverified'
                     CHECK (status IN ('unverified','verified','invalid')),
  last_verified_at TIMESTAMPTZ,
  -- Redacted, human-readable verification failure ("401 from provider");
  -- never echoes key material.
  status_reason    TEXT,
  created_by       TEXT NOT NULL,                -- membership subject
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, provider, name),
  UNIQUE (public_id)
);

CREATE INDEX IF NOT EXISTS idx_agents_provider_connections_org
  ON agents.provider_connections (org_id, provider);

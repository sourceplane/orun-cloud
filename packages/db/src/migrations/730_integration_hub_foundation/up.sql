-- 730_integration_hub_foundation: the integration-hub substrate (IH0).
--
-- Context: integrations
-- Epic: saas-integration-hub (IH0) — three new providers (slack, cloudflare,
--       supabase) across three archetypes on the IG provider seam. This
--       migration lands the provider-generic substrate, dormant:
--         * provider_credentials — parent-credential custody (bot tokens,
--           pasted parent API tokens, refresh tokens) as write-only
--           AES-256-GCM envelopes. GitHub's installation_tokens cache stays
--           where it is — shipped custody is never migrated.
--         * minted_credentials — the credential-broker ledger: every
--           short-lived credential the platform mints, WITHOUT the value.
--           Doubles as the reconcile work-queue for the IH9 orphan sweep.
--         * slack_workspaces / cloudflare_accounts / supabase_orgs —
--           provider facts behind a connection (the github_installations
--           twin, one table per provider).
--
-- Design rules (see specs/epics/saas-integration-hub/design.md §3):
--   * Credential values NEVER appear here in plaintext: provider_credentials
--     holds ciphertext only; minted_credentials holds metadata only.
--   * The slack team_id ↔ org_id binding is a tenancy keystone like
--     installation_id: team_id is globally UNIQUE (one connection per
--     workspace), carried only by our signed state.
--   * Opaque ids, no foreign keys (schema convention).
--   * NOTE: the epic's design doc named this migration 700_*; slots 700–720
--     were taken by the work context between authoring and landing. Code
--     reality wins; the epic status file records the renumber.
--
-- Additive + idempotent throughout.

-- ── Parent-credential custody ──────────────────────────────
-- One row per (connection, kind). Write-only: no read path ever returns the
-- ciphertext through a public surface; rows are zeroized (deleted) when the
-- owning connection is revoked.

CREATE TABLE IF NOT EXISTS integrations.provider_credentials (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  UUID NOT NULL,
  kind           TEXT NOT NULL
                   CHECK (kind IN (
                     'slack_bot_token',
                     'cloudflare_parent_token',
                     'supabase_refresh_token',
                     'supabase_access_token_cache'
                   )),
  -- AES-256-GCM envelope under SECRET_ENCRYPTION_KEY (IG3 convention);
  -- adopts the SM2 DEK/KEK hierarchy when the secret manager ships it.
  ciphertext     TEXT NOT NULL,
  -- Verified grant/scopes at custody time (safe metadata, not the secret).
  scopes         JSONB,
  -- Provider-side identifier of the credential (e.g. Cloudflare token id),
  -- used for provider-side verification and revocation.
  external_ref   TEXT,
  expires_at     TIMESTAMPTZ,
  rotated_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_provider_credential_kind
  ON integrations.provider_credentials (connection_id, kind);

COMMENT ON TABLE integrations.provider_credentials IS
  'Parent-credential custody (saas-integration-hub IH0): write-only '
  'AES-256-GCM envelopes for durable provider credentials (Slack bot token, '
  'Cloudflare parent API token, Supabase refresh token). Never read back '
  'through a public API; zeroized on connection revoke.';

-- ── Minted-credential ledger ───────────────────────────────
-- Every broker-issued short-lived credential: metadata only, never values.
-- The audit substrate AND the reconcile work-queue (IH9 orphan sweep).

CREATE TABLE IF NOT EXISTS integrations.minted_credentials (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL,
  connection_id  UUID NOT NULL,
  provider       TEXT NOT NULL,
  -- Named, versioned scope template (contracts): 'workers-deploy', …
  template       TEXT NOT NULL,
  -- Scoped-down request params (zone ids, project refs) — never secrets.
  params         JSONB,
  purpose        TEXT NOT NULL DEFAULT 'api'
                   CHECK (purpose IN ('api', 'secret_resolve')),
  -- Actor public id (user/service principal) that requested the mint.
  requested_by   TEXT,
  -- Run/job attribution when purpose = 'secret_resolve'.
  run_id         TEXT,
  job_id         TEXT,
  ttl_seconds    INTEGER NOT NULL,
  -- Provider-side id of the minted credential (for revocation/reconcile).
  provider_ref   TEXT,
  minted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revoke_status  TEXT NOT NULL DEFAULT 'pending'
                   CHECK (revoke_status IN ('pending', 'revoked', 'expired', 'orphaned')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keyset listing per org (console mint-ledger activity).
CREATE INDEX IF NOT EXISTS idx_integrations_minted_credentials_org
  ON integrations.minted_credentials (org_id, created_at DESC, id DESC);

-- Per-connection ledger view + revoke fan-out on connection revoke.
CREATE INDEX IF NOT EXISTS idx_integrations_minted_credentials_conn
  ON integrations.minted_credentials (connection_id, created_at DESC, id DESC);

-- Sweep scan: live (unrevoked) mints, oldest expiry first.
CREATE INDEX IF NOT EXISTS idx_integrations_minted_credentials_live
  ON integrations.minted_credentials (expires_at)
  WHERE revoke_status = 'pending';

COMMENT ON TABLE integrations.minted_credentials IS
  'Credential-broker ledger (saas-integration-hub IH0/IH4): metadata for '
  'every short-lived credential the platform mints — template, params, '
  'purpose, actor/run attribution, TTL, provider ref. Never the value. '
  'Doubles as the IH9 reconcile/orphan-sweep work-queue.';

-- ── Slack workspace facts ──────────────────────────────────
-- The github_installations twin for the messaging archetype. team_id is the
-- Slack tenancy keystone: globally unique, bound to exactly one connection,
-- carried only by our signed connect state.

CREATE TABLE IF NOT EXISTS integrations.slack_workspaces (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Null = orphaned callback (recorded, never auto-bound; fail closed).
  connection_id               UUID,
  team_id                     TEXT NOT NULL,
  team_name                   TEXT,
  enterprise_id               TEXT,
  bot_user_id                 TEXT,
  app_id                      TEXT,
  granted_scopes              JSONB,
  installed_by_external_user  TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_slack_workspace_team
  ON integrations.slack_workspaces (team_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_slack_workspace_conn
  ON integrations.slack_workspaces (connection_id)
  WHERE connection_id IS NOT NULL;

COMMENT ON TABLE integrations.slack_workspaces IS
  'Slack provider facts behind a connection (saas-integration-hub IH0/IH1). '
  'team_id is the tenancy keystone (UNIQUE, signed-state-bound — the '
  'installation_id rule applied to Slack). Bot tokens live in '
  'provider_credentials, never here.';

-- ── Cloudflare account facts ───────────────────────────────

CREATE TABLE IF NOT EXISTS integrations.cloudflare_accounts (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id        UUID,
  account_external_id  TEXT NOT NULL,
  account_name         TEXT,
  -- Provider-side id of the pasted parent token (for verify/revoke).
  parent_token_ref     TEXT,
  -- The VERIFIED parent grant (policy set), refreshed by the health cron and
  -- rendered in the console so customers see exactly what they handed over.
  granted_policies     JSONB,
  token_status         TEXT NOT NULL DEFAULT 'active'
                         CHECK (token_status IN ('active', 'expiring', 'invalid')),
  parent_expires_at    TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_cloudflare_account_external
  ON integrations.cloudflare_accounts (account_external_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_cloudflare_account_conn
  ON integrations.cloudflare_accounts (connection_id)
  WHERE connection_id IS NOT NULL;

COMMENT ON TABLE integrations.cloudflare_accounts IS
  'Cloudflare provider facts behind a connection (saas-integration-hub '
  'IH0/IH5): account identity, parent-token ref + verified grant + health. '
  'The parent token itself lives in provider_credentials, never here.';

-- ── Supabase org facts ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS integrations.supabase_orgs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id    UUID,
  supabase_org_id  TEXT NOT NULL,
  org_name         TEXT,
  granted_scopes   JSONB,
  -- Cached project ref list (console + scope params), refreshed by health.
  projects         JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_supabase_org_external
  ON integrations.supabase_orgs (supabase_org_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_supabase_org_conn
  ON integrations.supabase_orgs (connection_id)
  WHERE connection_id IS NOT NULL;

COMMENT ON TABLE integrations.supabase_orgs IS
  'Supabase provider facts behind a connection (saas-integration-hub '
  'IH0/IH6): org identity, granted scopes, cached project refs. Refresh '
  'tokens live in provider_credentials, never here.';

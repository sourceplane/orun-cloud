-- 400_integrations_admission: share mode + admission grants (IT8).
--
-- Context: integrations
-- Epic: saas-integration-tenancy (IT8) — the account governs which workspaces
--       may consume a shared connection. A connection carries a share_mode:
--         * 'auto'    (default) — every workspace under the account is
--                     implicitly admitted (today's soft behavior).
--         * 'granted' — a workspace may consume the connection only if it holds
--                     an active admission grant.
--       Admission is a resolution-layer allow-list stacked BEFORE repo-link
--       ownership at the consumption points (the token broker first) — it is NOT
--       hierarchical RBAC.
--
-- Design rules (see specs/epics/saas-integration-tenancy/design.md §11):
--   * Default 'auto' so every existing connection behaves exactly as before —
--     the backfill is a no-op.
--   * connection_grants is the allow-list; one ACTIVE grant per (connection,
--     workspace org); historical 'revoked' rows remain for audit.
--   * Opaque ids, no foreign keys (schema convention).
--
-- Additive + idempotent throughout.

ALTER TABLE integrations.connections
  ADD COLUMN IF NOT EXISTS share_mode TEXT NOT NULL DEFAULT 'auto';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_integrations_connections_share_mode'
  ) THEN
    ALTER TABLE integrations.connections
      ADD CONSTRAINT chk_integrations_connections_share_mode
      CHECK (share_mode IN ('auto', 'granted'));
  END IF;
END $$;

COMMENT ON COLUMN integrations.connections.share_mode IS
  'Admission posture (saas-integration-tenancy IT8): ''auto'' = every workspace '
  'under the account is implicitly admitted (default); ''granted'' = only '
  'workspaces with an active connection_grants row may consume the connection.';

-- ── Admission grants ───────────────────────────────────────
-- The allow-list for share_mode = 'granted': which workspace orgs the account
-- has admitted to a shared connection. Unused under 'auto'.

CREATE TABLE IF NOT EXISTS integrations.connection_grants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  UUID NOT NULL,                -- the shared connection (account-owned)
  org_id         UUID NOT NULL,                -- the admitted workspace org
  granted_by     TEXT,                         -- actor public id
  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'revoked')),
  granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one ACTIVE grant per (connection, workspace); revoked rows remain.
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_connection_grant_active
  ON integrations.connection_grants (connection_id, org_id)
  WHERE status = 'active';

-- Keyset listing of a connection's grants (account admin surface).
CREATE INDEX IF NOT EXISTS idx_integrations_connection_grants_conn
  ON integrations.connection_grants (connection_id, created_at DESC, id DESC);

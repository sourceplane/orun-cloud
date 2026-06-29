-- 390_integrations_connection_scope: account-shared vs workspace-private (IT7).
--
-- Context: integrations
-- Epic: saas-integration-tenancy (IT7) — a connection now carries an explicit
--       ownership scope. An 'account' connection is the shared, resolve-up case
--       this epic is built around; a 'workspace' connection is a workspace's own
--       GitHub account, owned at the workspace and NEVER resolved up — invisible
--       to siblings and the account, reusing the pre-tenancy single-org paths.
--
-- Design rules (see specs/epics/saas-integration-tenancy/design.md §10):
--   * Default 'account' so every existing row is unchanged and standalone orgs
--     keep collapsing to themselves — the backfill is a no-op.
--   * The keystone is untouched: a given GitHub account still backs exactly one
--     connection (installation_id UNIQUE), of either scope.
--   * Scope is set by the connect surface (account vs workspace Integrations
--     page); reads stay org-scoped, so a 'workspace' connection (org = the
--     workspace) is naturally isolated from siblings and the account.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS with a NOT NULL default and a
-- CHECK constraint added defensively only when absent.

ALTER TABLE integrations.connections
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'account';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_integrations_connections_scope'
  ) THEN
    ALTER TABLE integrations.connections
      ADD CONSTRAINT chk_integrations_connections_scope
      CHECK (scope IN ('account', 'workspace'));
  END IF;
END $$;

COMMENT ON COLUMN integrations.connections.scope IS
  'Ownership scope (saas-integration-tenancy IT7): ''account'' = shared, owned '
  'at the parent account and resolved up; ''workspace'' = private to the owning '
  'org, never resolved up. Defaults to ''account'' so existing rows are unchanged.';

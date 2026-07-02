-- 500_config_secret_policies: tier-tagged SecretPolicy documents (SM3).
--
-- Context: config
-- Epic: saas-secret-manager (SM3, pairs orun-secrets SEC2). The Layer-2 store
--       behind the lease-bound resolve: portable SecretPolicy documents
--       (apiVersion orun.io/v1) pushed by `orun plan`/`orun publish`, tagged by
--       the tier they ride (composition-attached, stack-wide, intent overlay).
--       Fetch-time evaluation (config-worker, in-worker pure lib) reads exactly
--       the rules the plan displayed.
--
-- Design rules (see orun/specs/orun-secrets/data-model.md §7d, policy-model.md §5):
--   * A document's TENANCY scope is not authored inside it — it comes from where
--     it is pushed: project_id NULL = workspace-wide, else project-scoped.
--   * Push is idempotent by document_hash (content address): re-pushing the same
--     document is a no-op; a changed document at the same (org, project, tier,
--     name) coordinate updates the row in place (ON CONFLICT).
--   * tier ∈ (composition, stack, intent); source records provenance, e.g.
--     "stack:acme-platform@1.4.0" | "composition:terraform" | "intent".
--   * document is a validated SecretPolicy spec (JSONB); NEVER any secret value.
--
-- Additive + idempotent (mirrors 430/470/480 guarded style).

CREATE TABLE IF NOT EXISTS config.secret_policies (
  id            UUID        PRIMARY KEY,
  org_id        UUID        NOT NULL,
  project_id    UUID,                             -- NULL = workspace-wide
  name          TEXT        NOT NULL,
  tier          TEXT        NOT NULL CHECK (tier IN ('composition', 'stack', 'intent')),
  source        TEXT        NOT NULL,
  document      JSONB       NOT NULL,
  document_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE config.secret_policies IS
  'Tier-tagged portable SecretPolicy documents (saas-secret-manager SM3, pairs '
  'orun-secrets SEC2). The Layer-2 condition store the lease-bound resolve '
  'evaluates. NEVER contains secret values — only the who/what/where/how '
  'conditions. Push is idempotent by document_hash; a document''s tenancy scope '
  'comes from (org_id, project_id), not the document body.';
COMMENT ON COLUMN config.secret_policies.org_id IS 'Owning workspace (organizations row). Opaque reference, no cross-context FK.';
COMMENT ON COLUMN config.secret_policies.project_id IS 'NULL = workspace-wide document; else the project it is scoped to.';
COMMENT ON COLUMN config.secret_policies.tier IS 'Placement tier: composition (auto-scoped to a component.type), stack (stack-wide), or intent (adopting-repo overlay, narrow-only).';
COMMENT ON COLUMN config.secret_policies.source IS 'Provenance string, e.g. "stack:acme-platform@1.4.0" | "composition:terraform" | "intent".';
COMMENT ON COLUMN config.secret_policies.document IS 'Validated SecretPolicy spec (rules[]). NEVER any secret value.';
COMMENT ON COLUMN config.secret_policies.document_hash IS 'Content address of the document — push is idempotent by this hash.';

-- One row per (org, project-or-workspace, tier, name). COALESCE folds the
-- workspace-wide NULL project_id onto the zero-uuid so the unique key is total.
CREATE UNIQUE INDEX IF NOT EXISTS secret_policies_scope_name_idx
  ON config.secret_policies (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), tier, name);

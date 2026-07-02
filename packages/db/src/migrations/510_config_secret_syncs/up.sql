-- 510_config_secret_syncs: materialization provenance store (SM5).
--
-- Context: config
-- Epic: saas-secret-manager (SM5, pairs orun-secrets SEC6). When a deploy run's
--       materialize step pushes a resolved secret into a target platform's native
--       store (e.g. a Cloudflare Worker binding), it records here what was synced
--       where, at which version, and by which run — so the catalog facet can
--       answer "is the running Worker on the latest rotation?" and drift is
--       detectable. This table is pure provenance metadata (references only); no
--       secret value ever lands here (orun-secrets Invariant 10).
--
-- Design rules (see orun/specs/orun-secrets/data-model.md §7e, runner-integration.md §6):
--   * target      — the typed adapter id, e.g. 'cloudflare-worker'.
--   * entity_ref  — the provisioned catalog entity the value was written into,
--                   e.g. 'Resource/worker-api-prod'.
--   * run_id      — the deploy run ULID that performed the sync.
--   * status lifecycle: 'synced' (current) -> 'superseded' (a newer sync replaced
--                   it) -> 'orphaned' (the target entity was decommissioned). The
--                   app flips the prior 'synced' row to 'superseded' when a new
--                   sync lands; the partial unique index guarantees at most ONE
--                   'synced' row per (secret_id, target, entity_ref).
--   * org_id/project_id/environment_id denormalize the recording scope for
--     tenant-safe listing and the catalog join.
--
-- Additive + idempotent (mirrors 470/480/500 guarded style).

CREATE TABLE IF NOT EXISTS config.secret_syncs (
  id             UUID        PRIMARY KEY,
  secret_id      UUID        NOT NULL REFERENCES config.secret_metadata(id),
  org_id         UUID        NOT NULL,
  project_id     UUID,
  environment_id UUID,
  version        INTEGER     NOT NULL,
  target         TEXT        NOT NULL,
  entity_ref     TEXT        NOT NULL,
  run_id         TEXT        NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'synced' CHECK (status IN ('synced', 'superseded', 'orphaned')),
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE config.secret_syncs IS
  'Materialization provenance (saas-secret-manager SM5, pairs orun-secrets SEC6). '
  'One row per (secret version) pushed into a provisioned catalog entity''s native '
  'store by a deploy run''s materialize step. References/metadata ONLY — a secret '
  'value NEVER lands here (orun-secrets Invariant 10). A new sync supersedes the '
  'prior one for the same (secret_id, target, entity_ref).';
COMMENT ON COLUMN config.secret_syncs.secret_id IS 'The synced config.secret_metadata row.';
COMMENT ON COLUMN config.secret_syncs.org_id IS 'Owning workspace (organizations row). Opaque reference, no cross-context FK.';
COMMENT ON COLUMN config.secret_syncs.project_id IS 'Recording scope: NULL for an org-scope sync, else the project.';
COMMENT ON COLUMN config.secret_syncs.environment_id IS 'Recording scope: the environment when the sync is environment-scoped, else NULL.';
COMMENT ON COLUMN config.secret_syncs.version IS 'The secret version whose value was materialized into the target.';
COMMENT ON COLUMN config.secret_syncs.target IS 'Typed adapter id, e.g. ''cloudflare-worker''.';
COMMENT ON COLUMN config.secret_syncs.entity_ref IS 'The provisioned catalog entity the value was written into, e.g. ''Resource/worker-api-prod''.';
COMMENT ON COLUMN config.secret_syncs.run_id IS 'The deploy run ULID that performed the sync.';
COMMENT ON COLUMN config.secret_syncs.status IS 'synced (current), superseded (a newer sync replaced it), or orphaned (target decommissioned).';

-- Catalog join: the per-component facet resolves a secret's sync state within a
-- scope. COALESCE folds the nullable project/environment onto the zero-uuid so
-- the key is total (mirrors the secret_metadata scope-key index).
CREATE INDEX IF NOT EXISTS secret_syncs_scope_secret_idx
  ON config.secret_syncs (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'), secret_id);

-- Per-entity view: "which secrets are synced into this entity, on which target?"
CREATE INDEX IF NOT EXISTS secret_syncs_entity_idx
  ON config.secret_syncs (entity_ref, target);

-- At most ONE 'synced' row per (secret_id, target, entity_ref): a new sync
-- supersedes the prior (the app flips the old row to 'superseded' in the same
-- statement). Superseded/orphaned rows are kept for history and excluded here.
CREATE UNIQUE INDEX IF NOT EXISTS secret_syncs_live_uniq_idx
  ON config.secret_syncs (secret_id, target, entity_ref)
  WHERE status = 'synced';

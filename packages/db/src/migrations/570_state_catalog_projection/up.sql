-- 550_state_catalog_projection: durable catalog-projection outbox
-- (saas-workspace-overview — projection reliability).
--
-- Context: state
-- Why: the catalog read-model projection (state.org_catalog_entities +
--   state.repo_facet) runs off the response path via ctx.waitUntil in
--   state-worker. When state-worker is invoked over a service binding
--   (api-edge -> state-worker), that background task can be torn down before it
--   commits, so a pushed catalog head advances but the read model (and the
--   repo_facet that drives the Workspace Overview) never update — a silently
--   frozen console. Observed on the ogpic workspace: head at the latest digest,
--   org_catalog_entities frozen at an old head, repo_facet empty.
--
-- This table records the LAST successfully projected head digest per scope. The
-- cron sweep (catalog-projection-sweep) drives from state.catalog_heads (the
-- authoritative desired head) LEFT JOIN this table and re-projects any scope
-- whose projected_digest lags its current head — the reliable backstop that no
-- longer depends on the waitUntil task surviving. A manual
-- POST .../catalog/reproject forces the same projection immediately.
--
-- Because the sweep drives from catalog_heads, a scope whose head advanced
-- BEFORE this table existed (no row here yet) is still detected as pending on the
-- first cron pass (LEFT JOIN -> projected_digest NULL) and healed — no backfill.
--
-- Derived, never authored; additive + idempotent (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS state.catalog_projection (
  org_id            UUID NOT NULL,
  project_id        UUID NOT NULL,
  environment       TEXT,                        -- null = the project-wide head
  projected_digest  TEXT,                        -- last head digest successfully projected
  projected_at      TIMESTAMPTZ,
  attempts          INTEGER NOT NULL DEFAULT 0,  -- consecutive failures since last success
  last_error        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE state.catalog_projection IS 'Durable catalog-projection outbox (saas-workspace-overview). One row per (org, project, environment) recording the last head digest whose read-model projection committed. The cron sweep re-projects any scope whose projected_digest lags its current state.catalog_heads digest, so the org read model + repo_facet converge even when the on-advance ctx.waitUntil projection is torn down (service-binding invocation). Derived, never authored.';

-- Scope uniqueness on the null-normalized environment (mirrors
-- org_catalog_entities), so the upsert can ON CONFLICT on the same expression.
CREATE UNIQUE INDEX IF NOT EXISTS uq_state_catalog_projection_scope
  ON state.catalog_projection (org_id, project_id, COALESCE(environment, ''));

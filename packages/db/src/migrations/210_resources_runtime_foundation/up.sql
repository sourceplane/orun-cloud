-- 210_resources_runtime_foundation: Resources + runtime persistence (P2).
--
-- Context: resources
-- Epic: saas-resources-runtime (the differentiator/moat) — manifested project
--       resources (kind/spec/status) and the runtime that reconciles them via
--       deployments (component 06 + 08; resource-contract.schema.yaml).
--
-- Design rules:
--   * Optional, not mandatory: baseline SaaS flows work with these tables empty.
--   * Tenant isolation: org_id + project_id + environment_id NOT NULL.
--   * status is a derived projection of runtime truth (the resource phase is
--     reconciled from its deployments, never asserted directly).
--   * Only one active (queued/running) deployment may mutate a resource at a
--     time (component 08 invariant) — a partial unique index enforces it.
--   * Idempotent: IF NOT EXISTS throughout for Supabase autocommit safety.

CREATE SCHEMA IF NOT EXISTS resources;

-- ── Resources (kind/spec/status) ───────────────────────────
CREATE TABLE IF NOT EXISTS resources.resources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL,
  project_id      UUID NOT NULL,
  environment_id  UUID NOT NULL,
  resource_type   TEXT NOT NULL,                 -- e.g. 'database.instance'
  name            TEXT NOT NULL,
  labels          JSONB NOT NULL DEFAULT '{}'::jsonb,
  component_ref   JSONB,                          -- {name, version} or null
  generation      INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  spec            JSONB NOT NULL DEFAULT '{}'::jsonb,   -- desired state
  phase           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (phase IN ('draft','pending','provisioning','ready',
                                     'degraded','failed','deleting','deleted')),
  status          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- observedGeneration, conditions, outputs, failure
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,

  UNIQUE (org_id, project_id, environment_id, resource_type, name)
);

CREATE INDEX IF NOT EXISTS idx_resources_project
  ON resources.resources (org_id, project_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_resources_phase
  ON resources.resources (org_id, project_id, phase);

-- ── Deployments (runtime reconciliation runs) ──────────────
CREATE TABLE IF NOT EXISTS resources.deployments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id     UUID NOT NULL,
  org_id          UUID NOT NULL,
  project_id      UUID NOT NULL,
  environment_id  UUID NOT NULL,
  intent          TEXT NOT NULL CHECK (intent IN ('create','update','delete')),
  generation      INTEGER NOT NULL CHECK (generation >= 1),
  phase           TEXT NOT NULL DEFAULT 'queued'
                    CHECK (phase IN ('queued','running','succeeded','failed')),
  revision        TEXT,
  outputs         JSONB,
  failure         JSONB,                          -- {code, message, retriable}
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deployments_resource
  ON resources.deployments (org_id, project_id, resource_id, created_at DESC, id DESC);

-- At most one active deployment per resource (component 08: one active mutation).
CREATE UNIQUE INDEX IF NOT EXISTS uq_deployments_active_per_resource
  ON resources.deployments (resource_id)
  WHERE phase IN ('queued','running');

-- ── Deployment steps (progress detail) ─────────────────────
CREATE TABLE IF NOT EXISTS resources.deployment_steps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id   UUID NOT NULL,
  org_id          UUID NOT NULL,
  project_id      UUID NOT NULL,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','succeeded','failed','skipped')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_deployment_steps_deployment
  ON resources.deployment_steps (deployment_id, started_at);

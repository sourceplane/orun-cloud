-- 760_agents_routines: standing routines (saas-agents-fleet AF6).
--
-- Context: agents
-- Epic: saas-agents-fleet (specs/epics/saas-agents-fleet/), paired runtime
--       orun/specs/orun-agents-fleet/ (AF2 — the sealed RoutineSnapshot the
--       definition_ref pins by content hash).
--
-- Design rules (design.md §5, enforced here where SQL can):
--   * A routine SPAWNS sessions, never acts inline (locked decision 3): these
--     rows are trigger + binding configuration; every firing re-enters the
--     AG9 dispatch door and rides the full session machinery. There is no
--     execution state here beyond the park latch and the last-fired mark.
--   * Quiet by default: success is digest material; failure parks after two
--     consecutive failed firings (the AG9 retry-budget idiom) and a parked
--     routine never fires until a human resumes it.
--   * Tenancy: workspace-scoped; sessions link back via routine_id so the
--     fleet home groups firings without a join table.
--   * Idempotent: IF NOT EXISTS throughout.

CREATE TABLE IF NOT EXISTS agents.routines (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id      TEXT NOT NULL,                 -- rt_…
  org_id         UUID NOT NULL,
  name           TEXT NOT NULL,                 -- workspace-unique
  profile_id     UUID NOT NULL REFERENCES agents.agent_profiles(id),
  run_kind       TEXT NOT NULL
                   CHECK (run_kind IN ('design','implementation','interactive','fix')),
  -- Content hash of the sealed RoutineSnapshot (orun AF2) — the brief
  -- template + tool policy + quiet contract a firing pins. Optional until
  -- the runtime leg lands; a bare routine still fires with the profile's
  -- defaults.
  definition_ref TEXT,
  trigger_kind   TEXT NOT NULL CHECK (trigger_kind IN ('cron','event')),
  -- cron: { "cron": "0 7 * * *" } (5-field, hourly minimum).
  -- event: { "lane": "...", "predicate": {...} } (fires via ES1; stored now,
  -- consumed when the lane consumer lands).
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Budget stub (AF8 binds real ceilings): per-firing/per-window caps.
  caps           JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  parked         BOOLEAN NOT NULL DEFAULT false,
  parked_reason  TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_fired_at  TIMESTAMPTZ,
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, name),
  UNIQUE (public_id)
);

-- The scheduler tick scans enabled, unparked routines cross-org.
CREATE INDEX IF NOT EXISTS idx_agents_routines_live
  ON agents.routines (enabled, parked)
  WHERE enabled AND NOT parked;

-- Sessions carry their firing provenance for fleet grouping + park math.
ALTER TABLE agents.agent_sessions
  ADD COLUMN IF NOT EXISTS routine_id TEXT;
CREATE INDEX IF NOT EXISTS idx_agents_sessions_routine
  ON agents.agent_sessions (routine_id)
  WHERE routine_id IS NOT NULL;

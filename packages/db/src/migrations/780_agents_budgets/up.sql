-- 780_agents_budgets: budgets as ceilings (saas-agents-fleet AF8).
--
-- Context: agents
-- Epic: saas-agents-fleet (specs/epics/saas-agents-fleet/).
--
-- Design rules (design.md §7, enforced here where SQL can):
--   * Budgets are CEILINGS, not advisories (locked decision 6): the door
--     refuses a spawn against an exhausted envelope; ingest turns a crossing
--     into a graceful, sealed interrupt — never a hard kill.
--   * Grains: workspace (30d rolling org spend), tree (the shared envelope
--     every delegation tree draws down), session (any single run), routine
--     (per-firing, keyed to one routine). workspace/tree/session rows are
--     org-wide defaults (ref NULL); routine rows pin a routine's public id.
--   * Usage is accumulated on the session row (tokens_used, from relayed
--     cost samples) so every check is row arithmetic — no meter round-trip,
--     and the 80% attention marks are a pure fold.
--   * Idempotent: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS agents.budgets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id      TEXT NOT NULL,                 -- bud_…
  org_id         UUID NOT NULL,
  grain          TEXT NOT NULL CHECK (grain IN ('workspace','tree','session','routine')),
  -- routine grain: the routine's public id; other grains: NULL (org default).
  ref            TEXT,
  max_tokens     BIGINT NOT NULL CHECK (max_tokens > 0),
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (public_id)
);

-- One ceiling per grain+ref per workspace (NULL refs collapse to one row).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_budgets_grain_ref
  ON agents.budgets (org_id, grain, COALESCE(ref, ''));

-- Accumulated relayed spend — the row arithmetic every check reads.
ALTER TABLE agents.agent_sessions
  ADD COLUMN IF NOT EXISTS tokens_used BIGINT NOT NULL DEFAULT 0;

-- 920_agents_origin: the origin taint (saas-agent-supervision SV0).
--
-- Context: agents
-- Epic: saas-agent-supervision (specs/epics/saas-agent-supervision/, design
--       §2). The provenance every implementer carries: WHO set it running —
--       a dispatch thread, a work element, a routine, a parent session, or a
--       human. It is the join that makes "this thread's implementers" a fold
--       (SV1) rather than a table.
--
-- Design rules (design.md §2, enforced here where SQL can):
--   * Recorded ONCE, at the AG9 door, from the authenticated caller's context
--     — never from a client-supplied body field. This migration only adds the
--     column + backfills legacy rows; the door (apps/agents-worker) writes
--     origin going forward.
--   * IMMUTABLE. No mutator writes origin after insert (advanceSession and the
--     lease/token updates never touch it). A re-parented tree keeps each node's
--     original origin; the AF4 tree columns carry structure, origin carries
--     provenance.
--   * Provenance, not authority: nothing downstream GATES on origin (risks
--     R8) — it is rendered, filtered, and folded, never a permission input.
--   * Backfill is INFERENCE and says so: every row it touches is stamped
--     backfilled:true so nobody mistakes it for door-recorded truth.
--   * Idempotent: IF NOT EXISTS / WHERE guards throughout (the 750 idiom).

-- ── Origin column ──────────────────────────────────────────────────────────
-- JSONB {kind, ref?, label?, backfilled?}; kind ∈ dispatch|work|routine|
-- session|human. NOT NULL with a human default so no row is ever originless
-- (the door overrides on insert).

ALTER TABLE agents.agent_sessions
  ADD COLUMN IF NOT EXISTS origin JSONB NOT NULL DEFAULT '{"kind":"human"}'::jsonb;

-- ── Backfill legacy rows (inference, marked) ───────────────────────────────
-- Precedence mirrors the door's own structural knowledge, most-specific first:
-- a parent session ⇒ session; a routine firing ⇒ routine; a work pointer ⇒
-- work; otherwise human. Only rows still carrying the bare default are
-- rewritten (re-running this migration never re-stamps door-written rows).
UPDATE agents.agent_sessions
   SET origin = CASE
     WHEN parent_session_id IS NOT NULL
       THEN jsonb_build_object('kind', 'session', 'ref', parent_session_id, 'backfilled', true)
     WHEN routine_id IS NOT NULL
       THEN jsonb_build_object('kind', 'routine', 'ref', routine_id, 'backfilled', true)
     WHEN work_ref IS NOT NULL
       THEN jsonb_build_object('kind', 'work', 'ref', work_ref, 'backfilled', true)
     ELSE jsonb_build_object('kind', 'human', 'backfilled', true)
   END
 WHERE origin = '{"kind":"human"}'::jsonb;

-- ── The roster-fold index (SV1) ────────────────────────────────────────────
-- The fold reads "this workspace's sessions with origin kind X (and ref Y)":
-- an expression index over (org_id, origin kind, origin ref).
CREATE INDEX IF NOT EXISTS idx_agents_sessions_origin
  ON agents.agent_sessions (org_id, (origin->>'kind'), (origin->>'ref'));

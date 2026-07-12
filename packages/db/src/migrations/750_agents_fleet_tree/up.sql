-- 750_agents_fleet_tree: the delegation plane (saas-agents-fleet AF4).
--
-- Context: agents
-- Epic: saas-agents-fleet (specs/epics/saas-agents-fleet/), paired runtime
--       orun/specs/orun-agents-fleet/ (AF0 — the agent_spawn/agent_await
--       tools whose cloud door these columns back).
--
-- Design rules (design.md §3, enforced here where SQL can):
--   * Sessions gain parent/root/depth linkage — a TREE, never a graph. The
--     columns reference public_id (the cross-boundary session identifier the
--     DO relay and the orun runtime already key on), so reads need no
--     self-joins and the wire shape carries them verbatim.
--   * The tree only NARROWS: the applied capability ceiling lives on the
--     child's sandbox JSONB (an infrastructure fact); intersection math is
--     application code (packages/contracts), not SQL.
--   * The session-event vocabulary grows child_spawned/child_completed/
--     child_failed — the parent owns its children's story as sealed events
--     (emitted by the runtime, relayed like everything else). There is STILL
--     no status/lifecycle kind; the honesty invariant holds.
--   * Idempotent: IF NOT EXISTS / drop-then-add named CHECK (the 720 lesson:
--     one constraint, one canonical name).

-- ── Tree columns ───────────────────────────────────────────────────────────

ALTER TABLE agents.agent_sessions
  ADD COLUMN IF NOT EXISTS parent_session_id TEXT
    REFERENCES agents.agent_sessions(public_id),
  ADD COLUMN IF NOT EXISTS root_session_id TEXT,
  ADD COLUMN IF NOT EXISTS depth INTEGER NOT NULL DEFAULT 0
    CHECK (depth >= 0);

-- Existing rows are their own roots.
UPDATE agents.agent_sessions
   SET root_session_id = public_id
 WHERE root_session_id IS NULL;

-- Tree reads: children of a parent; every node of a tree (kill, width caps).
CREATE INDEX IF NOT EXISTS idx_agents_sessions_parent
  ON agents.agent_sessions (parent_session_id)
  WHERE parent_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_sessions_root
  ON agents.agent_sessions (root_session_id);

-- ── Event vocabulary: the parent's story of its children ───────────────────
-- 650 created the kind CHECK inline (auto-named session_events_kind_check).
-- Drop-by-canonical-name then re-add as ONE named constraint with the three
-- child_* kinds appended (the 720 repair discipline).

ALTER TABLE agents.session_events
  DROP CONSTRAINT IF EXISTS session_events_kind_check;
ALTER TABLE agents.session_events
  ADD CONSTRAINT session_events_kind_check
  CHECK (kind IN ('state_changed','harness_event','message_user','message_agent',
                  'tool_call','tool_result','approval_requested','approval_resolved',
                  'artifact_produced','cost_sample','error',
                  'child_spawned','child_completed','child_failed'));

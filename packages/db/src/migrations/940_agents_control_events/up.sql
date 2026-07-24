-- 940_agents_control_events: the takeover control vocabulary (saas-agent-
-- supervision SV5, design §5).
--
-- Context: agents
-- Epic: saas-agent-supervision (specs/epics/saas-agent-supervision/, design §5).
-- Control is a per-implementer, presence-adjacent fact — unheld, or held by a
-- principal. Two sealed event kinds record the takeover story: `control_taken`
-- {principal, mode: explicit|implicit} and `control_returned` {principal,
-- reason}. RELAY-authored (the relay decides implicit windows + enforces the
-- refusal), unlike the runtime-emitted kinds — but part of the closed session-
-- event vocabulary all the same, so the durable log column must accept them.
--
-- Design rules (enforced where SQL can):
--   * The closed kind vocabulary is enforced by a named CHECK on
--     agents.session_events. 650 created it inline; 750 widened it for the AF4
--     child_* kinds via drop-by-canonical-name + re-add (the 720 repair
--     discipline). This migration follows that same idiom, appending the two
--     control kinds — one constraint, one canonical name.
--   * Additive + idempotent: the guarded drop makes re-running a no-op.

ALTER TABLE agents.session_events
  DROP CONSTRAINT IF EXISTS session_events_kind_check;
ALTER TABLE agents.session_events
  ADD CONSTRAINT session_events_kind_check
  CHECK (kind IN ('state_changed','harness_event','message_user','message_agent',
                  'tool_call','tool_result','approval_requested','approval_resolved',
                  'artifact_produced','cost_sample','error',
                  'child_spawned','child_completed','child_failed',
                  'control_taken','control_returned'));

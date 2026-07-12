-- 770_agents_trust: earned autonomy (saas-agents-fleet AF7).
--
-- Context: agents
-- Epic: saas-agents-fleet (specs/epics/saas-agents-fleet/), paired runtime
--       orun/specs/orun-agents-fleet/ (AF3 — the track-record fold over
--       sealed sessions this plane joins with cloud facts).
--
-- Design rules (design.md §6, enforced here where SQL can):
--   * The record itself is NEVER stored — it is a computed read over session
--     rows + relayed events (attention-plane epistemology). What IS stored is
--     the ADDRESS of the last autonomy movement: who moved it, when, which
--     direction, on what evidence — so every non-default autonomy renders
--     with its provenance ("promoted @ 47 runs · 89% clean · by elena").
--   * Movement is asymmetric: promotion is human-acked (the console PATCH),
--     demotion is automatic and loud (the scheduler tick). Both land here.
--   * Idempotent: IF NOT EXISTS.

ALTER TABLE agents.agent_profiles
  ADD COLUMN IF NOT EXISTS autonomy_evidence JSONB;

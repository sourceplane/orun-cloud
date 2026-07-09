-- 650_agents_foundation: the agent-session control plane (saas-agents AG5/AG6).
--
-- Context: agents
-- Epic: saas-agents (specs/epics/saas-agents/), paired runtime
--       orun/specs/orun-agents/. This is the DORMANT foundation: the schema
--       the control plane projects onto. No worker consumes it until AG6.
--
-- Design rules (design.md, enforced here where SQL can):
--   * The runtime is the orun binary; this plane hosts it. These tables hold
--     INFRASTRUCTURE facts about sessions (is there a sandbox, is it healthy)
--     and agent-plane configuration — never work-plane truth. There is no
--     work lifecycle/status column here; the work fold owns that.
--   * No new identity plane: an agent is a membership service principal with a
--     mandatory responsible owner. agent_profiles binds a principal; it does
--     not mint one.
--   * Tenancy: workspace-scoped — org_id is the workspace's organizations row.
--   * session_events is the control-plane RELAY mirror of the orun runtime's
--     append-only session log (a projection for console reads); the system of
--     record is the sealed AgentSessionSnapshot in orun's object graph. Closed
--     event vocabulary, dedupe on (session_id, seq) — no status/lifecycle kind.
--   * Idempotent: IF NOT EXISTS throughout for Supabase autocommit safety.

CREATE SCHEMA IF NOT EXISTS agents;

-- ── Agent profiles ─────────────────────────────────────────────────────────
-- A workspace's binding of an orun agent TYPE to a service principal, with a
-- mandatory responsible owner. The capability contract may only narrow the
-- sealed agent-type ceiling.

CREATE TABLE IF NOT EXISTS agents.agent_profiles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id      TEXT NOT NULL,                 -- agp_…
  org_id         UUID NOT NULL,
  name           TEXT NOT NULL,                 -- workspace-unique
  principal_id   TEXT NOT NULL,                 -- sp_… (a membership service principal)
  owner          TEXT NOT NULL,                 -- responsible owner (usr_/team_); MANDATORY
  agent_type     TEXT NOT NULL,                 -- the orun agent-type (sealed id or name)
  harness        TEXT NOT NULL,
  model          TEXT NOT NULL,
  autonomy_default TEXT NOT NULL DEFAULT 'assist'
                   CHECK (autonomy_default IN ('manual','assist','auto-dispatch','full')),
  -- Narrowing-only capability overrides (tools/mayAffect/secrets); {} = inherit.
  capability     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, name),
  UNIQUE (public_id)
);

-- ── Agent sessions ─────────────────────────────────────────────────────────
-- One hosted run of the orun runtime in a sandbox. state is an infrastructure
-- fact; the derived work rung lives in the work fold, never here.

CREATE TABLE IF NOT EXISTS agents.agent_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id      TEXT NOT NULL,                 -- as_… (matches the orun-side sessionId)
  org_id         UUID NOT NULL,
  profile_id     UUID NOT NULL REFERENCES agents.agent_profiles(id),
  run_kind       TEXT NOT NULL
                   CHECK (run_kind IN ('design','implementation','interactive','fix')),
  state          TEXT NOT NULL DEFAULT 'requested'
                   CHECK (state IN ('requested','provisioning','running','awaiting_approval',
                                    'suspended','completing','completed','failed','canceled','expired')),
  work_ref       TEXT,                          -- work://… pointer
  task_key       TEXT,                          -- ORN-142
  pr_url         TEXT,
  snapshot_id    TEXT,                          -- sealed AgentSessionSnapshot id (terminal)
  sandbox        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- provider ref, non-secret
  spawned_by     TEXT NOT NULL,                 -- membership subject
  lease_expires_at TIMESTAMPTZ,                 -- the session lease (heartbeat/refresh gate)
  started_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (public_id)
);

CREATE INDEX IF NOT EXISTS idx_agents_sessions_org_state
  ON agents.agent_sessions (org_id, state);
CREATE INDEX IF NOT EXISTS idx_agents_sessions_profile
  ON agents.agent_sessions (profile_id);
-- The sweep reclaims sessions whose lease lapsed while still non-terminal.
CREATE INDEX IF NOT EXISTS idx_agents_sessions_lease
  ON agents.agent_sessions (lease_expires_at)
  WHERE state NOT IN ('completed','failed','canceled','expired');

-- ── Session event relay ────────────────────────────────────────────────────
-- The control-plane mirror of the runtime's append-only session log, for
-- console snapshot+replay. Closed vocabulary; dedupe on (session_id, seq).
-- Bulk payloads live in R2 (payload carries refs + small metadata).

CREATE TABLE IF NOT EXISTS agents.session_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL,
  session_id     UUID NOT NULL REFERENCES agents.agent_sessions(id),
  seq            INTEGER NOT NULL,
  kind           TEXT NOT NULL
                   CHECK (kind IN ('state_changed','harness_event','message_user','message_agent',
                                   'tool_call','tool_result','approval_requested','approval_resolved',
                                   'artifact_produced','cost_sample','error')),
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ref            TEXT,                           -- R2 transcript-chunk ref for bulk content
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_agents_session_events_session
  ON agents.session_events (session_id, seq);

-- ── Autonomy policies ──────────────────────────────────────────────────────
-- Per-spec (fallback per-workspace) autonomy configuration (AG9). Agent-plane
-- config, NOT work truth — the closed work vocabularies stay closed.

CREATE TABLE IF NOT EXISTS agents.autonomy_policies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL,
  spec_key       TEXT,                           -- NULL = workspace default
  level          TEXT NOT NULL DEFAULT 'manual'
                   CHECK (level IN ('manual','assist','auto-dispatch','full')),
  -- Hard caps: max concurrent sessions, per-spec parallelism, per-task retry budget.
  caps           JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, spec_key)
);

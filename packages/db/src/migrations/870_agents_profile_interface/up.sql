-- 870_agents_profile_interface: the delegation interface (saas-dispatch DX7).
--
-- Context: agents
-- Epic: saas-dispatch (specs/epics/saas-dispatch/ design §10). A profile now
--       names HOW its runs execute: `orun-sandbox` (the sealed Daytona +
--       `orun agent serve` path, the default and prior behavior) or
--       `anthropic-managed` (a Claude Managed Agents cloud session spawned
--       via API). One dispatch door governs both; the tier renders.
--
-- Design rules:
--   * Additive + idempotent: existing profiles default to orun-sandbox, so
--     nothing changes behavior until a profile opts in.
--   * Closed vocabulary, CHECK'd; widening it is a migration, mirrored in
--     @saas/db/agents DELEGATION_INTERFACES and the contracts vocabulary.

ALTER TABLE agents.agent_profiles
  ADD COLUMN IF NOT EXISTS interface TEXT NOT NULL DEFAULT 'orun-sandbox';

DO $$
BEGIN
  ALTER TABLE agents.agent_profiles
    DROP CONSTRAINT IF EXISTS agent_profiles_interface_check;
  ALTER TABLE agents.agent_profiles
    ADD CONSTRAINT agent_profiles_interface_check
      CHECK (interface IN ('orun-sandbox','anthropic-managed'));
END $$;

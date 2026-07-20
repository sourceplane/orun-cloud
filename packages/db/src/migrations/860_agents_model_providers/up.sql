-- 860_agents_model_providers: broaden the connectable model providers.
--
-- Context: agents
-- Epic: saas-agents (specs/epics/saas-agents/ design §10). AG12 shipped BYO
--       provider connections for Daytona (compute) and Anthropic (model). This
--       migration widens the model side so a workspace can also connect an
--       OpenAI or OpenRouter key, saved and verified the same way — the key
--       stays in the secret manager under the reserved namespace; only the
--       CHECK vocabulary changes here.
--
-- Design rules:
--   * Storage path only. Custody (config-worker), the reserved namespace, and
--     the connection row shape are unchanged; this just relaxes the closed
--     provider vocabulary the row is CHECK'd against.
--   * OpenAI/OpenRouter are OpenAI-compatible; a connection MAY carry a
--     non-secret {baseUrl?, defaultModel?} in config. No new column.
--   * Idempotent + autocommit-safe: drop-if-exists then re-add inside a DO
--     block so a partial re-run converges.

DO $$
BEGIN
  ALTER TABLE agents.provider_connections
    DROP CONSTRAINT IF EXISTS provider_connections_provider_check;
  ALTER TABLE agents.provider_connections
    ADD CONSTRAINT provider_connections_provider_check
      CHECK (provider IN ('daytona','anthropic','openai','openrouter'));
END $$;

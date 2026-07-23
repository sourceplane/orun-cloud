-- 910_integration_registry_rehome: AI/compute connections join the registry
-- (saas-integration-registry IR5).
--
-- Context: agents
-- Epic: saas-integration-registry (specs/epics/saas-integration-registry/
--       design §8). Identity unifies, planes stay put: every
--       agents.provider_connections row (BYO Anthropic/OpenAI/OpenRouter keys,
--       the Daytona compute account) gains a sibling row in
--       integrations.connections so the unified hub, the provider spaces, and
--       the audit trail see one connection vocabulary. Custody does NOT move —
--       secret_ref keeps pointing at the reserved agents/providers/* namespace
--       and session provisioning reads it over the same seam as before.
--
-- Design rules:
--   * agents.provider_connections becomes the FACTS table for the apikey
--     adapters (the cloudflare_accounts pattern): the new connection_id column
--     points at the identity row in integrations.connections.
--   * Status mapping is mechanical: verified→active, unverified→pending,
--     invalid→suspended. connected_at carries last_verified_at for verified
--     rows (a key is "connected" once it proved itself).
--   * Tenancy (IR-D4): re-homed connections default to scope='workspace'
--     (private) with share_mode='auto' — account-sharing an AI key is a real
--     cost/quota decision and stays an explicit opt-in.
--   * Dual-read tolerance (risks R3): the worker tolerates NULL connection_id
--     for one release (pre-backfill rows, deploy-order races); rollback is
--     dropping nothing — the column and the identity rows are additive.
--   * Idempotent: IF NOT EXISTS guards; the backfill only touches rows whose
--     connection_id IS NULL, so a re-run converges without duplicating
--     identity rows.

ALTER TABLE agents.provider_connections
  ADD COLUMN IF NOT EXISTS connection_id UUID;

CREATE INDEX IF NOT EXISTS idx_agents_provider_connections_connection
  ON agents.provider_connections (connection_id);

-- Backfill: one integrations.connections identity row per facts row, then
-- stamp the pointer — a single statement pair via CTE so the join key
-- (org_id, provider, name/display_name) can never drift between the two.
WITH inserted AS (
  INSERT INTO integrations.connections
    (id, org_id, provider, status, scope, share_mode, display_name,
     created_by, connected_at, created_at, updated_at)
  SELECT
    gen_random_uuid(),
    pc.org_id,
    pc.provider,
    CASE pc.status
      WHEN 'verified' THEN 'active'
      WHEN 'invalid'  THEN 'suspended'
      ELSE 'pending'
    END,
    'workspace',
    'auto',
    pc.name,
    pc.created_by,
    CASE WHEN pc.status = 'verified' THEN pc.last_verified_at END,
    pc.created_at,
    pc.updated_at
  FROM agents.provider_connections pc
  WHERE pc.connection_id IS NULL
  RETURNING id, org_id, provider, display_name
)
UPDATE agents.provider_connections pc
   SET connection_id = i.id
  FROM inserted i
 WHERE pc.connection_id IS NULL
   AND pc.org_id   = i.org_id
   AND pc.provider = i.provider
   AND pc.name     = i.display_name;

COMMENT ON COLUMN agents.provider_connections.connection_id IS
  'saas-integration-registry IR5 (the facts-table turn): points at the '
  'identity row in integrations.connections. This table now carries the '
  'provider FACTS (secret_ref custody pointer, verification status, config) '
  'behind that connection — the cloudflare_accounts pattern. NULL = '
  'pre-backfill row; the worker dual-reads for one release (risks R3).';

-- 740_repo_link_one_to_one: one active workspace link per provider repo.
--
-- Context: state
-- Epic: saas-orun-platform v2 (OV2 federation hardening) — "adding a repo to a
--       workspace binds it": GitHub App deliveries federate from
--       integrations.repo_links to state.workspace_links on the rename-stable
--       (provider, provider_repo_id) identity (260_state_link_provider). For
--       that federation to attribute a delivery to exactly ONE workspace, the
--       state plane must enforce the same strict one-to-one claim the
--       integrations plane already has (380_integrations_repo_single_claim):
--       a repo actively linked in one workspace cannot be linked in another
--       until unlinked. First claim wins.
--
-- Two steps, in order:
--   1. Deterministic dedupe of pre-existing double-claims, so the unique index
--      below cannot fail on live data.
--   2. The partial UNIQUE index — the race-proof backstop behind the
--      state-worker's friendly 409 pre-flight.
--
-- Idempotent: the dedupe matches nothing once each (provider,
-- provider_repo_id) group holds a single active row, and the index creation
-- is IF NOT EXISTS-guarded. Same-context references only; no DROPs.

-- ---------------------------------------------------------------------------
-- Step 1 — dedupe: for every (provider, provider_repo_id) group with more than
-- one ACTIVE link (provider_repo_id present), keep the EARLIEST claim active
-- (lowest created_at, tiebreak lowest id — "first claim wins", matching the
-- product rule and the drain's federation semantics) and soft-unlink the rest.
-- Soft (status = 'unlinked'), never DELETE: unlinked rows remain for audit,
-- exactly as an explicit unlink would leave them. Re-running is a no-op — once
-- a group has one active row the EXISTS finds no earlier active sibling.
-- ---------------------------------------------------------------------------
UPDATE state.workspace_links wl
   SET status = 'unlinked',
       updated_at = now()
 WHERE wl.status = 'active'
   AND wl.provider_repo_id IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM state.workspace_links first_claim
      WHERE first_claim.provider = wl.provider
        AND first_claim.provider_repo_id = wl.provider_repo_id
        AND first_claim.provider_repo_id IS NOT NULL
        AND first_claim.status = 'active'
        AND (first_claim.created_at < wl.created_at
             OR (first_claim.created_at = wl.created_at AND first_claim.id < wl.id))
   );

-- ---------------------------------------------------------------------------
-- Step 2 — the backstop: at most one ACTIVE link per rename-stable provider
-- repo identity, across ALL orgs. Partial on a present provider_repo_id so
-- App-less links (no provider identity yet) stay unconstrained, and historical
-- 'unlinked' rows stay free — a repo can be re-claimed after an explicit
-- unlink, same shape as uq_integrations_repo_claim (380).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_state_workspace_link_provider_repo
  ON state.workspace_links (provider, provider_repo_id)
  WHERE status = 'active' AND provider_repo_id IS NOT NULL;

COMMENT ON INDEX state.uq_state_workspace_link_provider_repo IS
  'One-to-one repo claim (first claim wins): at most one ACTIVE workspace link per rename-stable (provider, provider_repo_id), across all orgs. Race-proof backstop behind the state-worker 409 pre-flight; twin of integrations.uq_integrations_repo_claim.';

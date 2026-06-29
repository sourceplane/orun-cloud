-- 380_integrations_repo_single_claim: one active claim per repo per connection (IT2).
--
-- Context: integrations
-- Epic: saas-integration-tenancy (IT2) — under a shared (account-owned) GitHub
--       connection, two workspaces of one customer must not both hold an active
--       link to the same repo: a double-claim would let both receive the repo's
--       events and mint tokens for it. This adds a single-claim guard scoped to
--       the connection (the credential boundary), complementing the existing
--       per-project guard.
--
-- Design rules (see specs/epics/saas-integration-tenancy/design.md §4):
--   * Single-claim is now CONNECTION-scoped, not org-scoped — the connection is
--     the credential boundary that may be shared across workspaces.
--   * This is intra-account coordination ("first claim wins"), not cross-tenant
--     isolation — much lower stakes than the token broker's controls.
--   * The existing uq_integrations_repo_link_project_repo (project_id,
--     repo_external_id) partial unique STAYS — it stops one project from
--     double-linking; this stops two workspaces from double-claiming.
--
-- Additive + idempotent: a partial UNIQUE over (connection_id, repo_external_id)
-- on active rows only; historical 'unlinked' rows are unconstrained, so a repo
-- can be re-claimed after an explicit unlink. Back-compatible: every existing
-- org is standalone, so connection_id already isolates each org's links and no
-- current row violates the new constraint.

CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_repo_claim
  ON integrations.repo_links (connection_id, repo_external_id)
  WHERE status = 'active';

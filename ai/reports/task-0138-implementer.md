# Task 0138 — IG0 integrations foundation — Implementer Report

## Summary

- `specs/components/17-integrations.md`: durable component contract for the
  `integrations` bounded context (intent/scope/capabilities/events/data
  ownership/extraction seam), distilled from the epic design.
- `packages/contracts/src/integrations.ts`: PublicConnection / PublicRepoLink /
  PublicInboundDelivery safe projections; connect, repo-link, delivery-log,
  replay, and token-broker request/response shapes; versioned `scm.*` payload
  projections (v1, additive-only); `INTEGRATION_EVENT_TYPES` / `SCM_EVENT_TYPES`
  / policy + entitlement constants. Wired into `package.json` exports + barrel.
- `packages/db`: `180_integrations_foundation` migration (schema +
  connections, github_installations, repo_links, inbound_deliveries,
  installation_tokens; keyset indexes; partial-unique tenancy/idempotency
  constraints), manifest entry with checksum, `src/integrations` repo layer
  (branded Uuid inputs, Result<T> unions, org-scoped queries, single-use
  connect-state consumption, idempotent inbox insert), BOUNDED_CONTEXTS +
  `./integrations` export.
- `apps/integrations-worker`: dormant skeleton — `/health` only, cron stub for
  the IG2 drain, ids (`int_`/`repl_`/`igd_`), component.yaml (Orun discovery),
  wrangler.jsonc with dev/stage/prod Hyperdrive + service bindings and the D1
  secret set documented but unset.
- Tests: `tests/db/src/integrations.test.ts` (repo layer; 24 tests),
  `tests/db/src/integrations-migration.test.ts` (manifest checksum, idempotent
  DDL, no credential columns), `tests/integrations-worker` (router + ids; 10
  tests).

## Files Changed

Grouped: specs/components (new 17), specs/epics/saas-integrations
(IMPLEMENTATION-STATUS.md new), packages/contracts (integrations.ts + wiring),
packages/db (migration, manifest, types, integrations/*, package.json),
apps/integrations-worker (new), tests/db (+2 suites),
tests/integrations-worker (new package), ai/ (task 0138, this report,
state.json).

## Checks Run

- `pnpm exec turbo run typecheck lint test` (full workspace): 110 tasks
  successful. db-tests 572 passed (18 suites), integrations-worker-tests 10
  passed, web-console-next 207+, all others green.
- Rebased on main twice during the run (#303–#305 landed mid-flight); re-ran
  filtered typecheck/test post-rebase, green.

## Assumptions

- Hyperdrive binding ids reuse the platform-wide stage/prod ids (same
  database, same pattern as every other worker).
- `github_installations.connection_id` is nullable to represent orphaned
  installations (recorded, never auto-bound) — consistent with design §4 fail-
  closed posture; the connections.status enum stays exactly per design §3.

## Spec Proposals

None — `components/01-edge-api.md` ingress rules intentionally deferred to IG1
per the epic plan.

## Remaining Gaps

- Stage verification of the two deploy-time done-when items (migration apply,
  `/health` on the deployed worker) happens on the main-push pipeline after
  merge; the worker is dormant so risk is config-shaped only.
- D1/D2/D4 human gates block IG1 live paths (see IMPLEMENTATION-STATUS.md).

## PR Number

#307

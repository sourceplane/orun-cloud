# Task 0140 — IG2 inbound events — Implementer Report

## Summary

- api-edge: public `POST /ingress/github/webhook` joins the allowlisted
  bearer-less ingress — streams the RAW body plus only the GitHub signature
  headers to integrations-worker (same posture as the Polar billing webhook),
  per-source rate limit, no resolveActor.
- Worker ingest: HMAC-SHA256 verify over raw bytes BEFORE any parse
  (constant-time, in the provider adapter), 5 MiB body cap, immediate 401 on
  signature failure with zero DB work, idempotent inbox insert keyed by
  `X-GitHub-Delivery` (redeliveries ack as no-ops), fast ack (202 new / 200
  duplicate).
- Drain (`src/drain.ts`, wired into `scheduled()`): attributes installation →
  connection → org; processes lifecycle events (provider uninstall →
  connection `revoked` + token-cache purge + `integration.revoked`,
  suspend/unsuspend → `integration.suspended`/`.reactivated`,
  repo-selection + permissions updates); normalizes everything else through
  the fixture-tested taxonomy (`src/normalize.ts`: push, PR
  opened/updated/merged/closed, check completed, release published,
  branch/tag create, branch delete) and emits into event_log **in the same
  transaction that marks the delivery `emitted`** (exactly-once, R3).
  Bounded retries (5 attempts, exponential backoff) → terminal `failed` with
  a safe reason. Unattributed installations are recorded orphaned and
  skipped — never bound (R1 posture).
- Migration `190_integrations_delivery_attribution`: nullable
  `connection_id` + partial index on the inbox; repo layer gained the
  pointer, a per-connection list filter, and the internal-only
  `getConnectionById` the drain needs.
- Delivery log API (`GET .../integrations/{id}/deliveries`, safe projection —
  no raw payload, no delivery key) + replay (`POST
  .../deliveries/{id}/replay` re-runs the pipeline from the persisted row;
  never re-trusts the wire). SDK: `integrations.listDeliveries` /
  `replayDelivery`.

## Files Changed

apps/api-edge (integrations-facade webhook branch), apps/integrations-worker
(normalize, drain, handlers/ingest, handlers/deliveries, router, index,
mappers), packages/db (migration 190 + manifest, integrations types/repo),
packages/sdk, tests/{integrations-worker,api-edge,db}, ai/.

## Checks Run

`pnpm exec turbo run typecheck lint test`: 110/110 tasks green.
integrations-worker-tests 56 passed across 8 suites (normalizer fixture
matrix, ingest signature/idempotency/caps, drain attribution + lifecycle +
retry/terminal paths, delivery log scoping + replay tenancy).

## Assumptions

- The drain stays cron-shaped per the platform no-Queues stance; the
  schedule itself cannot attach until the operator frees a Cloudflare cron
  slot (account at the 5-trigger limit) — `scheduled()` is ready and idle.
- IG2 emits org-scoped `scm.*` only; per-project enrichment (projectId +
  environment from branch maps) is IG3 by design.

## Spec Proposals

`components/01-edge-api.md` should gain the two ingress rules
(setup + webhook) as a normative addition — deferred to a docs-only PR or
IG3 to keep this diff code-focused. The rules are documented in
`specs/components/17-integrations.md` already.

## Remaining Gaps

- Cron attach (one-line wrangler change) blocked on the account cron slot.
- Live push → `scm.push` → customer-webhook walkthrough blocked on D1.

## PR Number

#322

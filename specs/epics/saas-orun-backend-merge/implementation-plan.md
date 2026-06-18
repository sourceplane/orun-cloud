# saas-orun-backend-merge — Implementation Plan (BM0–BM7)

Status: Draft. Milestones are PR-sized coherent units. BM0–BM4 are
human-independent (parity, shim, compat surfaces); BM5–BM6 carry the operational
gates (migration rehearsal, DNS cutover) named in `risks-and-open-questions.md`.
The strict spine is **BM0 → BM1 → BM2 → BM5 → BM6 → BM7**; BM3 and BM4 ride on
BM2 and can land in either order before BM6.

## BM0 — Parity audit + legacy-compat contract annex — 🗓️ Planned

The contract-and-inventory slice, zero runtime behavior, safe to land any time.

- **Parity matrix** (`design.md` §2) captured as an executable spec stub: every
  `orun-backend` coordinator invariant (`packages/coordinator/src/coordinator.ts`)
  paired with its `state-worker` counterpart (`apps/state-worker/src/handlers/runs.ts`,
  `sweep.ts`, `constants.ts`), with divergences flagged as the BM1 backlog.
- **Route map**: every `orun-backend` V1 route (`apps/worker/src/router.ts`) →
  scoped `state-worker` route or explicit gap (the BM3/BM4 backlog).
- `packages/contracts/src/state.ts`: a versioned **`state-legacy-v0`** projection
  (legacy request/response + error/status field reconciliation), exported but
  unreferenced by any live route.
- A `legacy-compat` annex appended to / cross-linked from
  `saas-orun-platform/state-api-contract.md` documenting the unscoped surface as
  a frozen, additive, deprecation-dated compatibility layer.

**Done when:** typecheck/lint/test green; the parity matrix and route map are
reviewed and their gaps enumerated as concrete BM1–BM4 work items; no public
behavior changes; the `state-legacy-v0` projection is fixture-tested in isolation.

## BM1 — Coordinator parity hardening — 🗓️ Planned

Make the Postgres plane behave identically to the Durable Object reference.

- Reconcile every divergence found in BM0: deps-blocked vs deps-waiting
  distinction, takeover on stale heartbeat, init idempotency by
  `runId+scope+planDigest`, run-status propagation, cancel, sweep/GC.
- **Constant reconciliation (R4)**: align `HEARTBEAT_TIMEOUT_MS` (300 s) with
  `state-worker`'s `LEASE_SECONDS` / `HEARTBEAT_INTERVAL_SECONDS` so a migrated
  in-flight run is never falsely swept; document the chosen values.
- **Shared golden vectors**: the scenario set `orun-backend`'s
  `coordinator.test.ts` asserts (concurrent claim, takeover, deps cascade, sweep,
  idempotent replay) re-expressed against `state-worker` and run in CI.

**Done when:** the golden-vector suite passes against `state-worker` on stage;
the parity matrix is all-green with documented constant choices; a fuzzed
concurrent-claim test shows exactly-one-winner and no deps-gate escape.

## BM2 — Legacy compatibility shim — 🗓️ Planned

The unscoped → scoped translation ingress; no coordination logic of its own.

- api-edge **`legacy-state-facade`**: accepts `orun-backend`'s unscoped
  `/v1/runs/*` (create, get, list, jobs, runnable, claim, update, heartbeat,
  job-status, logs up/down) and rewrites to scoped `state-worker` calls; maps
  bodies via the `state-legacy-v0` projection; treats absent
  `Orun-Contract-Version` as legacy (R5).
- **Auth adapters** reproducing `orun-backend`'s three doors
  (`apps/worker/src/auth/*`) onto the platform `ActorContext`: GitHub OIDC by
  `repository_id`, HMAC CLI session (`allowedNamespaceIds`,
  `local:user:<id>:repo:<id>`), deploy token.
- **`repository_id` → `{orgId, projectId}`** resolution via OV2 project==repo +
  IG connection trust, with **auto-materialized default org/project** per D2;
  fail-closed, resource-hiding 404 on cross-tenant (R2).
- Routed through existing edge machinery (idempotency, rate-limit, error
  envelope); every mutation audited.

**Done when:** an **unmodified** old CLI and a standing GitHub Actions workflow
pointed at the shim run a full DAG end-to-end on stage — create run, claim with
deps gating (blocked + waiting + granted), heartbeat, update, poll runnable,
upload + read logs — with the data landing in `state-worker` Postgres under the
resolved org/project; a second tenant cannot see or claim those runs (404);
parity SLOs (claim latency, deps-gate correctness) hold under concurrency.

## BM3 — Catalog sync compat — 🗓️ Planned (rides on BM2)

- Map `/v1/catalog/sync` (OIDC) onto OV6's projector as a **derived source** —
  never authoring catalog rows directly (preserves the `18-state` git-derived
  invariant; R6); idempotent by `uploadId`.
- Reshape the legacy read endpoints (`/v1/catalog/components`,
  `…/{id}/history|runs|dependencies`, `/v1/repos/{repoId}/components`) from the
  org-global projection.

**Done when:** a catalog sync from the legacy endpoint projects into the org
catalog and the legacy reads return equivalent shapes on stage; redelivered
uploads do not double-project; no path writes the catalog as authored truth.

## BM4 — Accounts + GitHub OAuth compat — 🗓️ Planned (rides on BM2)

- Map `/v1/accounts/*` (create, repo link/list/unlink) and `/v1/auth/github`
  (+ callback) onto identity-worker sessions, `state.workspace_links`, and IG
  `repo_links`; return legacy-shaped responses where old clients expect them.
- Where a legacy flow has no platform analogue, return a clear, versioned
  deprecation error rather than a silent 404.

**Done when:** legacy account, repo-link, and GitHub-login flows resolve against
Orun Cloud identity + tenancy on stage (or return a documented deprecation
error); no legacy client is left with an unhandled route.

## BM5 — Data migration — 🗓️ Planned (rides on BM1–BM4)

- `tooling/migrate-orun-backend`: idempotent, resumable importer reading
  `orun-backend` DO `runState` + D1 (`runs`/`jobs`/`namespaces`, catalog) + R2
  (plans/logs), writing `@saas/db/state` rows + Orun Cloud R2 under resolved
  `{orgId, projectId}` (namespace resolution per `design.md` §3.2).
- **Dry-run + verify** (row + object counts and digests), **checkpointed** by
  `(namespace, runId)`, **read-only** on the source.
- Rehearse against a prod snapshot; record the measured window for D3.

**Done when:** a full stage export/import verifies row-for-row and
object-for-object; a prod-snapshot rehearsal completes within the proposed
cutover budget; re-running the importer is a no-op (idempotent).

## BM6 — Cutover — 🗓️ Planned (gated on D3)

- Put `orun-backend` into **read-only**; drain in-flight runs; run the final
  delta import (BM5) and verify.
- Repoint `orun-api.sourceplane.ai` at the Orun Cloud edge behind the shim;
  **canary** a traffic slice; watch claim-success / deps-gating / log SLOs.
- Update `orun-cloud/intent.yaml` `execution.state.backendUrl` and coordinate the
  CLI default backend URL if the host changes.
- **Rollback** rehearsed: DNS flip back + un-freeze (source untouched until BM7).

**Done when:** production traffic — including Orun Cloud's own CI — is served by
Orun Cloud with **zero client changes**; the old backend takes no new writes; a
rollback drill succeeds on stage; the cutover + rollback runbook is recorded in
`IMPLEMENTATION-STATUS.md`.

## BM7 — Decommission + deprecation — 🗓️ Planned (gated on D1)

- Tear down `orun-backend` hosted Cloudflare resources (Worker, DO, D1, R2) after
  the dual-run window closes clean.
- Publish the legacy `/v1/runs` deprecation date; after the window the shim
  returns `410` + upgrade guidance (D4).
- Resolve the **OSS self-host** disposition (D1): freeze the repo as the OSS
  reference, or re-derive self-host from Orun Cloud's `_local/_local` mode.

**Done when:** the standalone hosted backend is torn down; the legacy surface has
a published deprecation timeline live in the contract annex; the OSS self-host
decision is recorded and actioned (or explicitly deferred to its own follow-on).

## Sequencing note

BM0 → BM1 is the parity spine and strictly ordered (no shim before the Postgres
plane provably matches the reference). BM2 unlocks BM3/BM4 (either order; BM3
first restores the catalog story sooner, BM4 first restores accountless-login
parity). BM5 can build against the source any time after BM2's resolution logic
lands, but its **rehearsal** gates BM6. BM6 is the only hard operational gate
(D3 window); BM7 trails a clean dual-run window (D1). BM0/BM1 and the worker-side
of BM2–BM4 are human-independent; only BM6 (cutover scheduling) and BM7 (OSS
disposition) need a human call.

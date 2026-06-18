# Epic: saas-orun-backend-merge

**Fold the standalone `orun-backend` control plane into Orun Cloud.** Today the
hosted run-coordination / dependency-checking backend that Orun CLIs hit in CI
lives in a separate repo (`sourceplane/orun-backend`) — a Cloudflare **Durable
Object** coordinator + D1 index + R2, namespaced by GitHub `repository_id`,
serving the **unscoped `/v1/runs/...`** API at `orun-api.sourceplane.ai`. This
epic makes Orun Cloud's already-shipped `state-worker` the single
implementation, **keeps the old API working byte-for-byte** behind a
compatibility shim, migrates the live data, cuts `orun-api.sourceplane.ai` over,
and decommissions the standalone backend.

Paired/parent epic: [`saas-orun-platform`](../saas-orun-platform/) (cluster
**OP/OV**) — it owns `state-worker`, the tenancy spine, and the normative
[`state-api-contract.md`](../saas-orun-platform/state-api-contract.md). This epic
does **not** introduce a second coordinator; it consolidates onto that one and
adds a legacy-compat surface as an additive annex to that contract.

> **Why not a literal port.** `orun-backend`'s coordinator is a faithful,
> well-tested reference — but Orun Cloud already re-implemented the same
> dependency-checking run-coordination plane on Postgres/Hyperdrive (OP2), fully
> wired to org/project tenancy, deny-by-default policy, OIDC + `sk_` auth (OV3),
> metering, catalog, and console (OV1–OV9). Lifting the Durable Object in would
> duplicate OP2 and bolt a **second source of truth** onto a repo that
> standardized on Postgres. So we take `orun-backend` as the **reference spec
> for parity** and reduce the "move" to: parity-harden → compat shim → migrate →
> cut over → decommission.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** (not started) |
| Cluster | **BM** (BM0–BM7) |
| Owner(s) | `state-worker`, `api-edge`, `identity-worker`, `integrations-worker`, `packages/{db,contracts}`, `infra/terraform`, tooling/migrate (new) |
| Target branch | `main` (PRs merged incrementally, milestone-sized) |
| Builds on | `saas-orun-platform` (OP2 run coordination, OV2 project==repo, OV3 credential-agnostic CI auth, OV6 catalog projection), `saas-integrations` (connection trust binding, `repo_links`), `core/domain-model.md` (one tenancy spine) |
| Reference | `sourceplane/orun-backend` — coordinator semantics, V1 wire surface, auth model, storage shapes are taken from there as the parity target (see [Provenance](#provenance--what-we-take-from-orun-backend)) |
| Pairs with | `orun/specs/orun-cloud/` (CLI side; the client already speaks the scoped contract — the shim serves older pinned clients) |
| Decisions locked | one coordinator (Orun Cloud `state-worker`, Postgres), not a ported Durable Object; legacy unscoped `/v1/runs` stays a **transitional** compat surface (deprecation-dated, not permanent); `repository_id` resolves to org/project through the existing trust bindings (OV2/OV3/IG), never auto-bound without proof of ownership; freeze-and-drain cutover (no dual-write); no client changes required at cutover |

## Thesis

`orun-backend` and Orun Cloud's `state-worker` solve the same problem twice. The
backend is the **original** hosted answer (Durable Object as the single-threaded
serialization point, `repository_id` as the namespace, accountless OIDC); the
`state-worker` is the **multi-tenant** answer the platform was built for (atomic
Postgres conditional-UPDATE claim, org→project→environment spine, policy +
metering + catalog for free). Both implement the same `statebackend.Backend`
shape the Orun CLI ships — that is the whole reason the consolidation is cheap.

So we don't rebuild and we don't run two planes. We (1) prove the Postgres
coordinator matches the Durable Object's invariants exactly, (2) wrap it in a
**legacy compatibility shim** that accepts `orun-backend`'s unscoped
`/v1/runs/...` + `repository_id`-OIDC API and translates it onto org/project
tenancy, (3) port the few surfaces the shim is missing (catalog sync, accounts,
GitHub OAuth), (4) migrate the live runs/jobs/logs/catalog out of DO+D1+R2 into
Postgres+R2, (5) cut `orun-api.sourceplane.ai` over to Orun Cloud, and (6) tear
the standalone backend down. Existing CI workflows and pinned CLIs keep working
through the whole sequence — the only thing that changes is who answers the URL.

## Read order

1. `README.md` (this file) — status, thesis, milestone-at-a-glance, provenance, dependency map.
2. `design.md` — the parity matrix, the unscoped→scoped translation, `repository_id`→org/project resolution, data migration, cutover & rollback, decommission.
3. `implementation-plan.md` — BM0–BM7, each with goal, owner, dependencies, "done when".
4. `risks-and-open-questions.md` — human-gated decisions (OSS self-host future, default-org materialization, cutover window) and engineering risks.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| BM0 | Parity audit + legacy-compat contract annex (dormant, no code) | 🗓️ Planned |
| BM1 | Coordinator parity hardening (Postgres == Durable Object semantics; shared golden vectors) | 🗓️ Planned |
| BM2 | Legacy compatibility shim — unscoped `/v1/runs/*` + `repository_id`-OIDC + CLI-session/deploy-token → org/project | 🗓️ Planned |
| BM3 | Catalog sync compat (`/v1/catalog/*` → OV6 org-global projection) | 🗓️ Planned |
| BM4 | Accounts + GitHub OAuth compat (`/v1/accounts/*`, `/v1/auth/github`) | 🗓️ Planned |
| BM5 | Data migration (DO + D1 + R2 → Postgres + R2), idempotent/resumable/verified | 🗓️ Planned |
| BM6 | Cutover `orun-api.sourceplane.ai` → Orun Cloud (freeze-and-drain, canary, rollback) | 🗓️ Planned |
| BM7 | Decommission `orun-backend` hosted deploy + legacy-surface deprecation timeline | 🗓️ Planned |

## Cross-repo dependency map

The Orun CLI already implements the scoped contract (`internal/remotestate/client.go`),
so no CLI milestone is required for correctness — the shim exists for **older,
pinned** clients and standing CI workflows. The seams this epic verifies against:

| Orun Cloud (this epic) | Counterpart | Seam |
|------------------------|-------------|------|
| BM1 coordinator parity | `orun-backend` `packages/coordinator/src/coordinator.ts` | claim/deps/heartbeat/GC golden vectors ↔ `state-worker` `handlers/runs.ts` + `sweep.ts` |
| BM2 legacy shim | `orun-backend` `apps/worker/src/router.ts` (V1) + `auth/*` | unscoped `/v1/runs/*` + OIDC `repository_id` ↔ api-edge state-facade → scoped `state-worker` |
| BM2 tenancy resolution | OV2 project==repo, OV3 ActorContext, IG connection trust | `repository_id` → `{orgId, projectId}` |
| BM3 catalog compat | `orun-backend` `/v1/catalog/*` + `migrations/0005_catalog_index.sql` | legacy sync envelope ↔ OV6 catalog projector |
| BM4 accounts/OAuth compat | `orun-backend` `/v1/accounts/*`, `/v1/auth/github` | identity-worker sessions + `state.workspace_links`/IG `repo_links` |
| BM5 data migration | `orun-backend` DO state + D1 (`0001_init.sql`) + R2 | `@saas/db/state` rows + Orun Cloud R2 |
| BM6 cutover | `orun-cloud/intent.yaml` `execution.state.backendUrl`, CLI default backend URL | DNS/route of `orun-api.sourceplane.ai` |

## Provenance — what we take from `orun-backend`

This epic is explicitly **reference-driven**: the durable behavior of the hosted
backend is the acceptance bar, and we lift it from `orun-backend` rather than
re-deriving it. Taken as the parity target (not as code to copy):

- **Coordinator state machine** (`packages/coordinator/src/coordinator.ts`):
  `JobStatus` set (`pending|running|success|failed|skipped`), `ClaimResult`
  fields (`claimed`, `takeover`, `currentStatus`, `depsBlocked`, `depsWaiting`),
  init idempotency by `runId + namespace + plan.checksum`, deps-blocked vs
  deps-waiting distinction, **`HEARTBEAT_TIMEOUT_MS = 300_000`** liveness +
  takeover, run-status propagation, GC sweep, runnable frontier. These become
  BM1's golden vectors against `state-worker`.
- **Public V1 wire surface** (`apps/worker/src/router.ts`): the exact unscoped
  path templates (`/v1/runs/...`, `/v1/catalog/*`, `/v1/accounts/*`,
  `/v1/auth/*`) are the byte-for-byte backward-compat target for BM2–BM4.
- **Auth model** (`apps/worker/src/auth/{oidc,session,index}.ts`): OIDC issuer +
  claim→namespace extraction (`repository_id`), HMAC CLI session
  (`allowedNamespaceIds`, `local:user:<githubUserId>:repo:<repoId>`), deploy
  token. BM2 reproduces these as authentication adapters that resolve to the
  platform `ActorContext`.
- **Storage shapes** (`migrations/0001_init.sql`, `0005_catalog_index.sql`,
  `packages/storage/*`): the run/job index + catalog tables + R2 key layout are
  the source schema BM5's importer reads.

What we deliberately **do not** take: the Durable Object as a runtime primitive
(superseded by the Postgres conditional-UPDATE claim), and `orun-backend`'s own
in-flight "V2" org/project layer (Tasks 0021–0023) — that was the backend
starting to grow toward the tenancy Orun Cloud already has; it is superseded,
not ported.

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| Coordinator parity hardening; legacy unscoped `/v1/runs` + OIDC/session/deploy-token shim; `repository_id`→org/project resolution; catalog-sync + accounts + OAuth compat; DO+D1+R2 → Postgres+R2 migration; `orun-api.sourceplane.ai` cutover + rollback; standalone backend decommission; legacy-surface deprecation plan | CLI-side changes (the client already speaks scoped; → `orun/specs/orun-cloud/`); the OSS self-host backend's long-term home (→ this epic's **D1** open question); executing jobs on platform-hosted runners (still customer-side; → future epic); the catalog *model* itself (→ `orun/specs/orun-service-catalog`); new product surfaces beyond restoring backend parity |

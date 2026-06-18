# saas-orun-backend-merge — Design

Status: Draft. How Orun Cloud absorbs the standalone `orun-backend` hosted
control plane without breaking a single existing client. The normative wire
seam stays [`saas-orun-platform/state-api-contract.md`](../saas-orun-platform/state-api-contract.md);
this doc adds the **legacy-compatibility annex** behind it and the migration /
cutover mechanics.

## 1. The two implementations, side by side

| Concern | `orun-backend` (today, hosted) | Orun Cloud `state-worker` (target) |
|---|---|---|
| Serialization point | Durable Object per run (single-threaded) | Single atomic Postgres conditional `UPDATE` (`handlers/runs.ts`) |
| Source of truth | DO storage (`"runState"` key) + D1 index | Postgres via Hyperdrive (`@saas/db/state`) |
| Namespace | GitHub `repository_id` (numeric) | `org_id + project_id` (path-scoped) |
| Wire surface | unscoped `/v1/runs/...` | `/v1/organizations/{orgId}/projects/{projectId}/state/...` |
| Auth | OIDC `repository_id`, HMAC CLI session, deploy token | OIDC + `sk_` key + CLI session → one `ActorContext` (OV3) |
| Liveness | `HEARTBEAT_TIMEOUT_MS = 300_000`, DO alarm sweep | `LEASE_SECONDS` / `HEARTBEAT_INTERVAL_SECONDS` (`constants.ts`) + `sweep.ts` |
| Deps gating | claim returns `depsBlocked` / `depsWaiting` / `claimed` | runnable frontier + deps guard in the claim UPDATE |
| Governance | none (accountless) | policy (`state.run.read/write`), metering, audit, catalog |

Both already satisfy Orun's `statebackend.Backend` method set. The job is to
make the right column behave **exactly** like the left for legacy callers, then
move the traffic and the data.

## 2. Parity matrix (the BM1 acceptance bar)

Each invariant below is lifted from `orun-backend`'s coordinator and must hold
identically in `state-worker`. BM1 encodes them as a shared scenario suite
(the same cases `coordinator.test.ts` asserts, replayed against the Postgres
plane).

| Invariant | Reference behavior | Parity check |
|---|---|---|
| Init idempotency | same `runId`+namespace+`plan.checksum` ⇒ re-return; different checksum ⇒ 409 | replay create → 200 same run; mutated plan → conflict |
| Claim — deps blocked | any dep `failed` ⇒ `{claimed:false, depsBlocked:true}` | downstream never claims past a failed upstream |
| Claim — deps waiting | any dep not `success` ⇒ `{claimed:false, depsWaiting:true}` | poll `/runnable` until ready |
| Claim — granted | all deps `success` ⇒ `running`, set runner+lease | exactly one runner wins under concurrency |
| Takeover | `running` + heartbeat age > 300s ⇒ re-claim `{takeover:true}` | stale runner is displaced, not deadlocked |
| Heartbeat ownership | only owning `runnerId` may heartbeat/update; else abort | lease-lost surfaces as `409 lease_lost` |
| Status propagation | all jobs `success` ⇒ run `completed`; any `failed` ⇒ run `failed` | terminal run state matches |
| Sweep / GC | stale `running` → `failed` "runner heartbeat timeout"; terminal run reaped | sweep cadence reconciled to `state-worker` lease window |
| Runnable frontier | `pending` jobs whose deps are all `success` | identical set for identical state |

**Constant reconciliation (R4).** `orun-backend`'s 300 s timeout and
`state-worker`'s `LEASE_SECONDS` must be set so a run migrated mid-flight is not
falsely swept; BM1 aligns them and BM6 freezes in-flight runs at cutover so the
window is moot in practice.

## 3. The legacy compatibility shim (BM2)

A thin ingress on **api-edge** (a sibling of the existing `state-facade`) accepts
`orun-backend`'s unscoped surface and rewrites each call to a scoped
`state-worker` call. It owns **no coordination logic** — it is translation only.

```
old CLI / standing CI  ──►  api-edge  ──►  legacy-state-facade  ──►  state-worker
  POST /v1/runs/{id}/jobs/{j}/claim     │  resolve repository_id → {orgId, projectId}
  (OIDC repository_id / session / token)│  rewrite → /v1/orgs/{o}/projects/{p}/state/runs/{id}/jobs/{j}/claim
                                        │  map ClaimResult ⇄ legacy claim JSON
```

### 3.1 Path + payload translation

Every legacy route maps 1:1 to a scoped route (the contract was deliberately
shaped as a multi-tenant **superset** of the same `Backend` methods, so the
bodies are already compatible up to the scope prefix and field names):

| Legacy (`orun-backend`) | Scoped (`state-worker`) |
|---|---|
| `POST /v1/runs` | `POST …/state/runs` |
| `GET /v1/runs/{id}` | `GET …/state/runs/{id}` |
| `GET /v1/runs` | `GET …/state/runs` |
| `GET /v1/runs/{id}/jobs` | `GET …/state/runs/{id}/jobs` |
| `GET /v1/runs/{id}/runnable` | `GET …/state/runs/{id}/runnable` |
| `POST /v1/runs/{id}/jobs/{j}/claim` | `POST …/state/runs/{id}/jobs/{j}/claim` |
| `POST /v1/runs/{id}/jobs/{j}/update` | `POST …/state/runs/{id}/jobs/{j}/update` |
| `POST /v1/runs/{id}/jobs/{j}/heartbeat` | `POST …/state/runs/{id}/jobs/{j}/heartbeat` |
| `GET /v1/runs/{id}/jobs/{j}/status` | derive from `GET …/state/runs/{id}/jobs` |
| `POST /v1/runs/{id}/logs/{j}` | `POST …/state/runs/{id}/logs/{j}` |
| `GET /v1/runs/{id}/logs/{j}` | `GET …/state/runs/{id}/logs/{j}` |
| `/v1/catalog/*` | OV6 catalog routes (BM3) |
| `/v1/accounts/*`, `/v1/auth/github` | identity + tenancy (BM4) |

Field reconciliation is mechanical and versioned in `packages/contracts` as a
**`state-legacy-v0`** projection: e.g. legacy `success`/`failed` job status ⇄
contract status, `depsWaiting`/`depsBlocked` flags ⇄ `deps_not_ready` error +
runnable polling, legacy flat error body ⇄ the platform error envelope. The shim
treats an **absent `Orun-Contract-Version`** header as `legacy-v0` and never
rejects on version for that surface (R5).

### 3.2 `repository_id` → `{orgId, projectId}` resolution

This is the heart of "backward compatible auth." Three inbound identities, all
resolving to a platform `ActorContext` + a `{orgId, projectId}` scope:

1. **GitHub Actions OIDC** (the CI path). Verify the token exactly as
   `orun-backend` does (issuer `token.actions.githubusercontent.com`, JWKS,
   `repository_id` claim). Resolve `repository_id` → project via OV2's
   **project == repo** materialization and the IG **connection trust binding**
   (`installation_id ↔ org_id`, signed/single-use). The project's org is the
   scope. This reuses OV3's credential-agnostic actor resolution — the legacy
   path is just a fourth door into the same `ActorContext`.
2. **CLI session** (HMAC). `allowedNamespaceIds` already carries the user's org
   IDs in the platform model; the legacy `local:user:<githubUserId>:repo:<repoId>`
   namespace maps to that user's default org + the repo's project, sandboxed so
   a CLI session can never address a canonical repo it hasn't proven.
3. **Deploy token.** System actor; unchanged.

**Materialization policy (D2).** When OIDC/key traffic arrives for a repo with
no link yet, the default is to **auto-materialize** a per-owner default org +
`project == repo` (preserving `orun-backend`'s accountless CI experience),
upgradeable to a named org later. The stricter alternative (require explicit
`orun cloud link` first) is the human-gated decision in
`risks-and-open-questions.md` D2. Binding is **fail-closed** and never auto-binds
a repo to an org that didn't prove ownership (R2).

## 4. Catalog, accounts, OAuth (BM3–BM4)

- **Catalog (BM3).** `orun-backend`'s `/v1/catalog/sync` (OIDC) + read endpoints
  map onto OV6's **org-global catalog projection**. Critically, the legacy sync
  is fed in as a **derived source** into the projector — it must not write
  catalog rows as authored truth, preserving the `18-state` invariant that the
  catalog is git-derived and never console/API-authored (R6). The read endpoints
  (`components`, `…/history`, `…/runs`, `…/dependencies`) are reshaped from the
  projection.
- **Accounts + OAuth (BM4).** `/v1/accounts/*` (create, repo link/list/unlink)
  and `/v1/auth/github` (OAuth login) resolve against identity-worker sessions +
  the tenancy resolution above. Much of this is already richer in Orun Cloud
  (dashboard OAuth, `state.workspace_links`, IG `repo_links`); BM4's job is to
  expose **legacy-shaped** responses where an old client expects them, and to
  return a clear deprecation error where a flow has no platform analogue.

## 5. Data migration (BM5)

A standalone, idempotent, resumable importer (`tooling/migrate-orun-backend`)
reads the source plane and writes the platform plane:

| Source (`orun-backend`) | Target (Orun Cloud) | Notes |
|---|---|---|
| DO `runState` (live runs/jobs) | `@saas/db/state` run + job rows | only non-terminal runs need care; terminal runs import as history |
| D1 `runs`/`jobs`/`namespaces` | run/job index rows under resolved `{orgId, projectId}` | namespace → org/project via §3.2 |
| D1 catalog tables | OV6 projection inputs | re-projected, not copied as truth |
| R2 plans + logs (`ns/runs/{id}/…`) | Orun Cloud R2 under org/project key layout | content-addressed; re-key only |

Properties: **dry-run + verify** (row-for-row and object-for-object counts +
digests), **resumable** (checkpoint by `(namespace, runId)`), and **read-only on
the source** (the backend stays serving until BM6). Rehearsed against a prod
snapshot to size the cutover window.

## 6. Cutover & rollback (BM6)

**Freeze-and-drain**, not dual-write (dual-write would reintroduce the exact
cross-writer race the Durable Object existed to prevent — R1/D3):

1. Announce + put `orun-backend` into **read-only** (reject new run/claim writes
   with a retryable status); let in-flight runs drain (bounded by the heartbeat
   window).
2. Run BM5's final delta import; verify.
3. Repoint `orun-api.sourceplane.ai` at the Orun Cloud edge (behind the BM2
   shim). Canary a slice of traffic first; watch claim-success, deps-gating, and
   log round-trips against the parity SLOs.
4. Update `orun-cloud/intent.yaml` `execution.state.backendUrl` if the host
   changes; coordinate the CLI's default backend URL so fresh installs point at
   the consolidated plane.
5. **Rollback**: because the source stayed read-only (not destroyed) and the
   import is additive, rollback is a DNS flip back + un-freeze, valid until BM7.

## 7. Decommission & deprecation (BM7)

- Tear down `orun-backend`'s hosted Cloudflare resources (Worker, DO namespace,
  D1, R2) once the dual-run window closes clean.
- Publish a **deprecation date** for the legacy unscoped `/v1/runs` surface: the
  CLI already speaks scoped, so the shim only serves old pinned clients; after
  the window it returns `410` with upgrade guidance (D4).
- Resolve the **OSS self-host** story (D1): `orun-backend` also doubles as the
  `orun backend init` single-tenant reference. Either keep the repo as the OSS
  reference (hosted deploy frozen) or re-derive self-host from Orun Cloud's
  `_local/_local` fixed-scope mode (the contract already says it serves the same
  paths) — a human-gated call, tracked as a follow-on, not blocking BM6.

## 8. Boundary invariants (must hold)

- One coordinator. The shim never serializes claims itself; all concurrency goes
  through the single Postgres conditional `UPDATE`.
- No new tenancy noun. `repository_id` resolves onto the existing
  org→project→environment spine; there is no "namespace" entity.
- Tenant isolation is resource-hiding: cross-tenant access **404s**, never 403s,
  on the legacy surface too.
- The catalog stays git-derived: legacy sync feeds the projector, never authors
  rows.
- The source backend is read-only-then-retired, never written by both planes at
  once.

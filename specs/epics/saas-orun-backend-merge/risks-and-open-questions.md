# saas-orun-backend-merge — Risks & Open Questions

Status: Draft. D1–D4 are human-gated product/operational decisions; R1–R6 are
engineering risks owned by the milestones. Each default recommendation is the
proposed posture unless the operator overrides.

## Human-gated decisions

### D1 — The OSS self-host backend's future (blocks BM7 final teardown only)

`orun-backend` does double duty: the **hosted** plane at
`orun-api.sourceplane.ai` *and* the `orun backend init` **OSS single-tenant
reference** that the CLI detects via `ManagedBy == "orun-backend-init"`. This
epic absorbs the hosted role; the OSS role needs a home. Options: (a) keep the
`orun-backend` repo as the OSS reference with its hosted deploy frozen; (b)
re-derive self-host from Orun Cloud's `_local/_local` fixed-scope mode (the
contract already states the OSS backend "serves the same paths with a fixed
`_local/_local` scope", so one codebase could serve both). **Default
recommendation:** (a) for BM6/BM7 (freeze the hosted deploy, keep the repo as
the OSS reference so nothing self-hosted breaks), with (b) as a tracked follow-on
once Orun Cloud's single-tenant mode is proven — do **not** block cutover on it.

### D2 — Default org/project materialization for accountless CI (blocks BM2 auth)

`orun-backend` works with no account: OIDC `repository_id` *is* the namespace.
On the platform every run needs an `{orgId, projectId}`. When OIDC/key traffic
arrives for an unlinked repo, do we **auto-materialize** a per-owner default org
+ `project == repo` (frictionless, preserves today's CI experience), or
**require** an explicit `orun cloud link` first (stricter tenancy, but breaks
standing workflows at cutover)? **Default recommendation:** auto-materialize into
a per-owner default org (OV2 project==repo), upgradeable to a named org later, so
no existing CI workflow needs a human in the loop. This has billing/entitlement
attribution implications (whose org owns the usage) — confirm with the
multi-org-billing owners before BM2 ships.

### D3 — Cutover window & in-flight runs (blocks BM6)

Freeze-and-drain (short read-only window while in-flight runs finish, then flip)
vs. a dual-write bridge (no window, but two writers). **Default recommendation:**
freeze-and-drain — a dual-write bridge reintroduces the exact cross-writer race
the Durable Object was built to prevent (R1). The window size comes from BM5's
prod-snapshot rehearsal + the heartbeat drain bound; operator picks the calendar
slot and the customer-comms posture.

### D4 — Legacy `/v1/runs` deprecation horizon (blocks BM7 deprecation notice)

How long the unscoped shim is supported before it returns `410`. The Orun CLI
already speaks the scoped contract, so the shim mostly serves **old pinned**
clients and standing CI. **Default recommendation:** support for a fixed window
(e.g. ≥ 2 CLI minor releases / one published calendar quarter), announced at BM6,
enforced at the window's end — long enough that a `kiox` provider-pin bump
carries clients across without a fire drill.

## Engineering risks

### R1 — Coordinator semantic drift (severity: critical; owner BM1)

If the Postgres conditional-`UPDATE` claim does not reproduce the Durable
Object's single-threaded guarantees exactly — deps-blocked vs deps-waiting,
takeover on stale heartbeat, idempotent init, GC — a migrated client sees subtly
different behavior (double-claims, deps-gate escapes, false sweeps). Mitigation:
BM1's shared golden vectors (the reference `coordinator.test.ts` scenarios) plus
fuzzed concurrent-claim tests; the single atomic `UPDATE` is the serialization
point and must be the *only* claim path. No shim-side coordination.

### R2 — `repository_id` mis-binding / tenant crossover (severity: critical; owner BM2)

The legacy OIDC path turns a numeric `repository_id` into an `{orgId, projectId}`.
A forged or raced binding leaks one tenant's runs/logs into another. Mitigation:
bind only through the IG **connection trust** (signed, single-use,
`installation_id ↔ org_id`, fail-closed) and OV2 materialization; never auto-bind
a repo to an org that hasn't proven ownership; resource-hiding 404 on every
cross-tenant access. Test plan must include: OIDC for repo A redeemed under a
session for org B, replayed/expired bindings, and an unlinked-repo first push.

### R3 — Data-migration fidelity (severity: high; owner BM5)

The DO `runState` object shape, the D1 index rows, and the R2 key layout differ
from `@saas/db/state` + Orun Cloud R2. A lossy import silently drops runs/logs or
mis-scopes them. Mitigation: idempotent, resumable importer with **dry-run +
row/object verification** (counts + digests), checkpointed by `(namespace,
runId)`, **read-only on the source**, rehearsed against a prod snapshot;
`orun-backend` stays available as a fallback through the dual-run window (BM6).

### R4 — Heartbeat/lease constant mismatch (severity: medium; owner BM1/BM6)

`orun-backend`'s `HEARTBEAT_TIMEOUT_MS = 300_000` vs `state-worker`'s
`LEASE_SECONDS` / `HEARTBEAT_INTERVAL_SECONDS`: if they disagree, a run migrated
mid-flight can be falsely swept to `failed` (or a dead runner held too long).
Mitigation: reconcile the constants in BM1 and **freeze in-flight runs** at
cutover (D3) so no lease straddles the migration boundary.

### R5 — Contract-version skew on the legacy surface (severity: medium; owner BM2)

Old clients send no `Orun-Contract-Version` header (or a v0-shaped body); the
scoped plane rejects unknown majors with `409 contract_version_unsupported`. If
the shim forwards that strictness, every legacy client breaks at cutover.
Mitigation: the shim pins the legacy surface to `state-legacy-v0`, treats an
absent version header as legacy, and only fails loud on genuinely unknown *new*
majors — version skew stays actionable, not fatal, for the surface whose whole
job is backward compatibility.

### R6 — Catalog-model divergence (severity: medium; owner BM3)

`orun-backend` stores catalog rows directly (flat D1 tables); Orun Cloud's
catalog is **git-derived** and never console/API-authored (`components/18-state.md`,
OV6). Importing the legacy catalog as authored truth would violate that
invariant and create un-reprojectable state. Mitigation: BM3 feeds the legacy
sync into the OV6 **projector** as a derived source; the catalog is always
re-derivable from the object graph, never written as truth by the compat layer.

## Explicitly deferred

- **Platform-hosted runners.** Job execution stays customer-side, as in
  `saas-orun-platform`. This epic moves coordination + state, not execution.
- **`orun-backend`'s in-flight V2 org/project layer** (Tasks 0021–0023). It was
  the backend converging toward Orun Cloud's tenancy; superseded by the real
  thing, not ported.
- **OSS self-host re-derivation from `_local/_local`** (D1 option b). Tracked as a
  follow-on; cutover does not depend on it.
- **Renaming the CLI's `allowedNamespaceIds` field.** A client-contract rev owned
  by `orun/specs/orun-cloud/`; the shim satisfies the field as-is in the interim.

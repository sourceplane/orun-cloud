# Epic: saas-orun-backend-merge

**Replace the standalone `orun-backend` coordination plane with a coordination
model native to Orun Cloud's content-addressed state store — event-sourced, run
state rooted at the source hash, sharded per run on a Durable Object, with
Postgres as a delayed projection.** `orun-backend`'s `runs/jobs/claim` REST plane
was designed *before* the object store existed; it is a relational coordination
layer bolted beside the store. This epic does not preserve it. It redesigns job
coordination as **append-only events over the Merkle object graph** and spans
**both repos**: the server (this repo) and the Orun CLI client
(`orun/specs/orun-native-coordination/`, cluster **NC**).

> **This epic was re-scoped.** It began as "absorb `orun-backend` behind a
> backward-compatible shim." With the CLI now in scope (cross-repo) and the
> design discussion settled on a greenfield, content-addressed, event-sourced
> model with a Durable-Object coordination shard, **backward compatibility is no
> longer the spine.** The legacy unscoped `/v1/runs` surface is dropped; the only
> concession is a short read-only **drain bridge** for in-flight runs at cutover.
> `orun-backend` remains the **parity reference** for the coordination invariants,
> not an API to keep.

Paired CLI epic: `orun/specs/orun-native-coordination/` (cluster **NC**). The two
share one normative wire contract — [`coordination-api.md`](./coordination-api.md),
owned here, vendored into the CLI repo with a checksum drift guard (the same
mechanism `orun/specs/orun-cloud/vendored/` already uses).

## The bet (locked decisions)

These are the recommended calls, taken as decisions rather than options:

1. **Greenfield, no permanent backward-compat.** Because we control the client,
   the CLI moves to the new contract directly. No legacy `/v1/runs` surface
   survives; a time-boxed read-only drain bridge covers in-flight runs at cutover
   only.
2. **Coordination is event-sourced.** A run is an **append-only, per-run event
   stream** rooted at `planDigest → sourceHash`. Authoritative job/lease state is
   a **fold** over the stream; a claim is a **conditional append**, not a row
   `UPDATE`. Postgres tables become a derived read model.
3. **The per-run coordination shard is a Durable Object.** One DO per run is the
   single writer of that run's event stream — in-memory single-threaded
   serialization, DO-storage-durable appends, an alarm for lease expiry. This is
   the strong-consistency primitive *and* the horizontal-scale unit (one tiny DO
   per concurrent run). **Postgres is a delayed projection** (lists, status,
   frontier cache, catalog, metering). Strong consistency is spent only on
   per-run append and on run-create/quota.
4. **Job results are content-addressed objects** (`job-result` kind), which makes
   a successful job **memoizable across tenants and repos** (a content-addressed
   build cache). Memoization is **opt-in per job via a hermetic/purity
   declaration in the plan; default off** (safe).
5. **One contract, two server implementations.** Hosted (DO-sharded) and OSS
   self-host (plain-Postgres conditional-append) implement the same wire
   contract; the CLI is implementation-agnostic. (OSS self-host stays parked per
   `orun/specs/orun-cloud` D5, but the contract remains implementable on plain
   Postgres — no Cloudflare-only primitive leaks into the wire.)
6. **Logs and run records fold into the same substrate** — log chunks are events,
   sealed into a content-addressed `log` object referenced by the `job-result`;
   a terminal run can be sealed as a `run-record` object for immutable provenance.
7. **DO durability/recovery.** DO storage is authoritative for the live stream;
   periodic **snapshot objects** + a projected checkpoint in Postgres are the
   backstop. On permanent DO loss, rebuild from the last snapshot + replay.

## Status

| Field | Value |
|-------|-------|
| Status | **Draft** (not started) |
| Cluster | **BM** (BM0–BM7) |
| Owner(s) | `state-worker` (coordination shard + projections + object plane), `api-edge`, `identity-worker`, `packages/{db,contracts}`, `infra/terraform`; CLI side owned by `orun` (cluster **NC**) |
| Target branch | `main` (PRs merged incrementally, milestone-sized) |
| Builds on | `saas-orun-platform` (OP3 object/CAS plane, OV1 `ModelReader` seam, OV6 catalog projection, OV3 credential-agnostic CI auth), `core/domain-model.md` (one tenancy spine) |
| Reference | `sourceplane/orun-backend` — coordinator **invariants** (deps gating, 5-min liveness, takeover, idempotency) are the parity target; its API is **not** preserved |
| Pairs with | `orun/specs/orun-native-coordination/` (cluster **NC**) — the CLI client |
| Contract | [`coordination-api.md`](./coordination-api.md) — owned here, vendored into `orun` |

## Thesis

The store already has the right substrate and uses it the wrong way round for
coordination. Objects are content-addressed and immutable (`PUT /objects/{digest}`,
kinds `plan | catalog-snapshot | …`); catalog **heads** are mutable refs into
that graph that **emit events** (`catalog.head.advanced`). But job coordination
is the one plane still living in mutable `run_jobs` rows, with events emitted as
*exhaust*. We invert that: **events become the authority, the relational tables
become a projection, and job results become first-class content-addressed
objects.**

Concretely, a claim stops being `UPDATE run_jobs SET status='claimed'` and becomes
"**append `JobClaimed` to the run's event stream iff the job's latest event
permits it and its deps are satisfied**" — a conditional append serialized by the
run's Durable Object. Completion appends `JobSucceeded{ result: sha256:… }`,
where the result is a content-addressed object. This unifies three things we have
been treating separately — coordination, the scaling story, and provenance — into
one design: the per-run event stream **is** the partition boundary (so it scales
by run), conditional append **is** the cheap strong-consistency primitive, and
the `sourceHash → plan → job → result` Merkle chain **is** provenance and a build
cache for free.

## Read order

1. `README.md` (this file) — the bet, status, milestone-at-a-glance, dependency map.
2. `design.md` — the three planes, the event model + fold, the DO coordination shard, the scalability tiers, memoization, recovery.
3. `coordination-api.md` — the **normative** redesigned wire contract (owned here, vendored into `orun`).
4. `implementation-plan.md` — BM0–BM7 with "done when".
5. `risks-and-open-questions.md` — remaining open questions behind the locked bet.

## Milestones at a glance

| ID | Milestone | Status |
|----|-----------|--------|
| BM0 | Coordination contract v2 (`coordination-api.md`) + vendor into `orun`; object kinds + event vocab frozen (dormant, no behavior) | 🗓️ Planned |
| BM1 | Object-plane extensions: `job-result` + `log` kinds, digest negotiation, memoization lookup (opt-in purity) | 🗓️ Planned |
| BM2 | Per-run coordination shard (Durable Object): event log, conditional append, claim/heartbeat/complete, lease-expiry alarm, snapshots | 🗓️ Planned |
| BM3 | Projections: Postgres read models (run list/status/frontier/metering) derived from the stream; DO alarms replace the cron sweep | 🗓️ Planned |
| BM4 | CLI adoption (pairs **NC**): new `statebackend.Backend` shape (append/fold/read-the-log + result push), offline event log + cloud sync, cockpit/status/logs | 🗓️ Planned |
| BM5 | Auth + tenancy + quota on the new surface: OIDC/key/session → ActorContext; run-create + quota strong-consistent in Postgres; policy actions | 🗓️ Planned |
| BM6 | Migration & cutover: retire the legacy plane; read-only drain bridge for in-flight; provenance migration; `orun-api.sourceplane.ai` cutover | 🗓️ Planned |
| BM7 | Decommission `orun-backend`; OSS self-host plain-Postgres conformance (parked); closeout | 🗓️ Planned |

## Cross-repo dependency map

| Orun Cloud (this epic) | Orun CLI (`orun-native-coordination`, **NC**) | Seam |
|---|---|---|
| BM0 contract v2 | NC0 vendor + drift guard | `coordination-api.md` ↔ `specs/.../vendored/` + checksum test |
| BM1 object kinds + memoization | NC1 result push + cache-aware claim | `job-result`/`log` objects ↔ object-model sync |
| BM2 DO coordination shard | NC2 event-log client (append + fold) | conditional-append verbs ↔ `internal/remotestate` |
| BM3 projections | NC3 read-the-log status/frontier | event stream + projections ↔ `bridge.Source`/cockpit |
| BM4 CLI adoption | NC2–NC4 | new `statebackend.Backend` interface |
| BM5 auth/quota | NC4 OIDC golden path | exchange + ActorContext ↔ `OIDCTokenSource` |

## Scope boundary

| In scope | Out of scope |
|----------|--------------|
| The redesigned `coordination-api.md`; `job-result`/`log`/`run-record` object kinds + memoization; per-run DO coordination shard (event log, conditional append, lease alarms, snapshots); Postgres projections; auth/tenancy/quota on the new surface; CLI client move (paired **NC**); migration off the legacy plane + cutover + decommission | A permanent legacy `/v1/runs` surface (dropped); the catalog *model* (→ `orun-service-catalog`); platform-hosted runners (still customer-side); the CLI's internal refactor detail (→ `orun-native-coordination`); secrets (→ `orun-secrets`/OV8) |

# saas-orun-backend-merge — Implementation Plan (BM0–BM7)

Status: Draft. Milestones are PR-sized coherent units. The spine is **BM0 → BM1
→ BM2 → BM3**, then **BM4** (CLI, paired with cluster **NC**) rides on BM2/BM3,
**BM5** hardens auth/quota, and **BM6/BM7** migrate + decommission. BM0–BM3 are
human-independent; BM6 (cutover) and BM7 (decommission) carry the operational
gates.

## BM0 — Coordination contract v2 + vendor — 🗓️ Planned

Contract-only, dormant, safe to land any time.

- `coordination-api.md` finalized (event vocab, object kinds, conditional-append
  verbs, consistency contract); frozen list of `state.*` event kinds added to
  `packages/contracts/src/state.ts` (`JobReady`, `JobClaimed`, `LeaseRenewed`,
  `LeaseExpired`, `JobSucceeded`, `JobMemoized`, `JobFailed`, `LogChunk`,
  `RunCreated`, `RunCompleted`, `RunFailed`, `RunCanceled`) with versioned,
  fixture-tested payload schemas.
- The **fold** (`reduce(events) → run/jobs/frontier`) as a pure, shared,
  unit-tested function in `packages/contracts` (so server, projector, and CLI all
  reduce identically).
- Vendor the contract into `orun/specs/orun-native-coordination/vendored/` +
  `CHECKSUM` + drift-guard test (pairs **NC0**).

**Done when:** typecheck/lint/test green; the event schemas + fold are
fixture-tested in isolation; the vendored copy + checksum guard are in place;
no runtime behavior.

## BM1 — Object-plane extensions + memoization lookup — 🗓️ Planned

- New object kinds `job-result`, `log`, `run-record` in the CAS handlers
  (`apps/state-worker/src/handlers/objects.ts`), digest-verified and idempotent;
  `objects/missing` negotiation covers them.
- Memoization lookup: given a job's `jobInputHash`, resolve an existing
  `job-result` (object existence). Opt-in: only consulted when the plan marks the
  job `hermetic`; default off.
- `jobInputHash` derivation specified + tested (covers resolved step defs, input
  digests, declared env); non-hermetic jobs never hash-skip.

**Done when:** a `job-result`/`log` round-trips through the CAS on stage; a
memoization lookup returns hit/miss correctly; non-hermetic jobs are never
reported cacheable; no coordination behavior yet.

## BM2 — Per-run coordination shard (Durable Object) — 🗓️ Planned

The concurrency heart. The DO is the single writer of a run's event stream.

- `RunCoordinator` DO keyed by `runId`: in-memory fold (authoritative live
  state), append-only event log in DO storage, **conditional append** for
  `:claim`/`:heartbeat`/`:complete`/`:cancel` enforcing the
  deps/lease/terminal/cache invariants.
- Lease lifecycle via the DO **alarm**: 60s lease / 20s heartbeat, `LeaseExpired`
  → `JobReady` re-queue (attempt+1, bounded), then `JobFailed{timed_out}`. No
  cron sweep on this path.
- Snapshotting: every N appends / on terminal transition, write a snapshot object
  + DO-storage checkpoint (recovery substrate).
- **Parity suite**: the `orun-backend` `coordinator.test.ts` scenarios
  (concurrent claim → exactly one winner, takeover, deps cascade, idempotent
  replay, timeout) re-expressed against the DO and run in CI.

**Done when:** the parity suite passes on stage; a fuzzed concurrent-claim test
shows exactly-one-winner and no deps-gate escape; killing a runner re-queues its
job within the lease window via the DO alarm (no cron); the event log + snapshots
survive a forced DO restart.

## BM3 — Projections (read models) — 🗓️ Planned

- Async projector consumes the DO's append/checkpoint stream into Postgres read
  models (run list, status, job counts, frontier cache) + metering; batched, so
  write volume is ∝ runs, not ∝ heartbeats.
- `GET …/runs`, `…/runs/{id}`, `…/log`, `…/frontier` served from
  projections/DO; `…/log` supports SSE + long-poll.
- The legacy cron sweep is removed (liveness now lives in the DO alarm); the
  single cron slot is freed/repurposed.

**Done when:** console + CLI reads reflect a run within the projection SLA
(seconds) on stage; the projection is rebuildable from the event log (drop +
replay); no reader depends on a synchronous coordination write.

## BM4 — CLI adoption (pairs cluster NC) — 🗓️ Planned

The Orun CLI moves to the event-log client; owned in `orun`
(`orun-native-coordination`), gated here on BM2/BM3.

- New `statebackend.Backend` shape: `AppendClaim/Heartbeat/Complete`,
  `ReadLog(from)` + local fold, `PutResult` (content-addressed), cache-aware
  claim (skip on `cached`).
- Offline-first: the CLI keeps a **local event log**; cloud sync ships appends —
  same fold local and remote.
- Cockpit/`status`/`logs` render cloud runs by folding the stream through
  `bridge.Source`.

**Done when:** a full DAG runs end-to-end on stage via the new client (claim with
deps gating, heartbeat, complete-with-result, memoized skip, live `logs
--follow`); cockpit/status parity with local; conformance suite green vs stage.

## BM5 — Auth, tenancy & quota on the new surface — 🗓️ Planned

- OIDC / `sk_` key / CLI session → one `ActorContext` (reuse OV3); every event
  attributed; resource-hiding 404 on cross-tenant.
- Run-create enforces quota/entitlement **strongly in Postgres** (the choke point
  for per-tenant concurrent fan-out); soft per-run caps in the DO.
- Policy actions (`state.run.read/write`, `state.object.*`) wired deny-by-default
  on every route in `coordination-api.md` §6.

**Done when:** an unauthorized actor cannot append to or read another tenant's
run (404); over-quota run-create is rejected with upgrade UX; every coordination
event carries a verified actor; policy gates fail closed.

## BM6 — Migration & cutover — 🗓️ Planned (operational gate)

- Provenance backfill: terminal legacy `orun-backend` runs → `run-record` objects
  + projection rows (history continuity); live legacy coordination state is **not**
  migrated.
- Drain bridge: put `orun-backend` read-only; in-flight legacy runs finish on the
  old plane; new runs start only on the new plane.
- Cut `orun-api.sourceplane.ai` to Orun Cloud; update `intent.yaml`
  `execution.state.backendUrl` + the CLI default; canary + rollback drill (DNS
  flip back, old plane still read-only-intact).

**Done when:** production traffic (incl. Orun Cloud's own CI) runs on the new
plane; the old plane takes no new runs; a rollback drill succeeds on stage; the
runbook is recorded in `IMPLEMENTATION-STATUS.md`.

## BM7 — Decommission + conformance — 🗓️ Planned

- Tear down `orun-backend` hosted resources after a clean dual-run window.
- OSS self-host conformance: a plain-Postgres conditional-append implementation
  passes the same contract conformance suite (parked per `orun/specs/orun-cloud`
  D5, but the gate is defined so the contract stays implementable off-DO).

**Done when:** the standalone backend is torn down; the conformance suite is
green against the hosted (DO) server, and defined (if parked) for the OSS server;
closeout recorded.

## Sequencing note

BM0 → BM1 → BM2 → BM3 is the strict server spine (no DO before the contract +
object kinds; no projections before the DO emits the stream). BM4 (CLI) needs
BM2/BM3 and is co-developed with cluster **NC**. BM5 can land alongside BM2–BM4.
BM6 is the only hard operational gate; BM7 trails a clean window. Everything
through BM5 is human-independent.

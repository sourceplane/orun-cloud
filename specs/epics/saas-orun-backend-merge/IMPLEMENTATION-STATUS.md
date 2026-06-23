# saas-orun-backend-merge — Implementation Status

Rolled-up state of cluster **BM** (and the paired CLI cluster **NC** in `orun`).
Authoritative over the prose in `README.md`/`implementation-plan.md` when they
disagree. Full evidence + per-criterion analysis: [`GAPS.md`](./GAPS.md).

**Last audited:** 2026-06-20 (source review of both repos + executed test suites
+ live probes). **Branch:** `claude/sleepy-edison-99y58a` (PRs #127–#146 here,
#386–#395 in `orun`; not yet on `main`).

## Legend
✅ Done · 🟡 Partial · ⛔ Missing

## Platform (BM)

| ID | Status | Landed | Outstanding |
|----|--------|--------|-------------|
| BM0 | ✅ | event vocab, pure `reduce()`, golden vectors, vendored contract + checksum drift guard (in `orun`) | kind-naming reconcile; converge the two event taxonomies; CI-enforce cross-repo vectors |
| BM1 | 🟡 | object kinds registered, digest-verified PUT, `canonicalizeJobInput` + opt-in memo gate | **server-side memo lookup by `jobInputHash`**; exercise new kinds through CAS; `jobInputHash` producer; `run-record` writer |
| BM2 | 🟡 | `RunCoordinator` DO, conditional append, lease alarm, parity + diamond conformance (22/22 green) | **snapshotting/checkpoint + recovery test**; fuzz concurrent-claim; alarm-timeout integration test; seal logs on `:complete`; stop trusting client memo digest |
| BM3 | 🟡 | pure projector, idempotency-by-seq (mig `350`), projection sweep cron, reads from Postgres | **remove legacy OP2 cron sweep**; expose `…/log` (SSE/long-poll) + `…/frontier`; async outbox projector; metering; drop+replay rebuild |
| BM4 | 🟡 | DO bound/deployed; per-run-sticky flag; diamond conformance; **native §3 wire now routed** (`:claim`/`:heartbeat`/`:complete`/`:cancel` + `…/log` + `…/frontier`, contract major 2) — see Progress log | `…/events` append primitive (§5); SSE/long-poll on `…/log`; native `POST …/runs` create shape; CLI adoption (NC) |
| BM5 | 🟡 | authz + deny-by-default + cross-tenant 404; **verified actor now stamped on every coordination event** (OP2 facade + native verbs) — see Progress log | real run-create quota choke (off-by-default/fail-open); DO soft per-run cap |
| BM6 | ⛔ | flag pre-set `do` (stage+prod), projector + fail-closed gate | backfill, drain bridge, **delete OP2 claim/sweep**, recovery drill vs O3 SLOs, update `intent.yaml`/CLI default, record runbook here |
| BM7 | ⛔ | — | decommission `orun-backend` (`orun-api.sourceplane.ai` still serves the legacy bundle); parameterized OSS plain-Postgres conformance harness; closeout |

## CLI (NC, repo `orun`)

| ID | Status | Landed | Outstanding |
|----|--------|--------|-------------|
| NC0 | ✅ | vendored contract + checksum guard, pure `Fold` + golden vectors | CI-enforce vector parity (currently hand-transcribed) |
| NC1 | 🟡 | `JobInputHash`/canonicalization + memo gate | result push (`job-result`/`log`); `--no-cache`; `hermetic` plan field; cockpit "memoized"; **wire it** |
| NC2 | 🟡 | claim/heartbeat→action core | **reshape `statebackend.Backend`**; `remotestate` §3 verbs + `…/events`; heartbeat goroutine; lease-loss abort; **wire it** |
| NC3 | ⛔ | — | `bridge.Source` stream fold; SSE/long-poll `status`/`logs --follow`; offline `.orun/` event log + cloud sync |
| NC4 | 🟡 | `OIDCTokenSource` (aud `orun-cloud`) wired to legacy client | point OIDC at `CoordClient`; stage conformance suite |
| NC5 | 🟡 | single-runner deps-gated memo-aware DAG driver | heartbeat; real lease-loss abort; object/result push; incremental log reads; **wire to `internal/runner`** |

## The two facts that gate "done"

1. **Native v2 wire** — ✅ **server side now exposed** (Progress log 2026-06-20):
   `:claim`/`:heartbeat`/`:complete`/`:cancel`, `GET …/log?from=`, and
   `…/frontier` are routed to the DO on the public `state-worker` surface, gated
   by the same auth/policy/contract-version as OP2, and the server advertises
   contract major 2. Still open: the `…/events` append primitive (§5), SSE +
   long-poll on `…/log`, and a §2-native `POST …/runs` create shape.
2. **CLI adoption** — 🟡 **coordination cycle now wired (opt-in)** (Progress log
   2026-06-20): `orun`'s `CoordBackend` drives claim/heartbeat/complete + the
   runnable frontier over the §3 wire (lease epoch threaded), selected with
   `ORUN_COORDINATION=v2`. Still open: an async heartbeat goroutine, §3-native
   create/logs, the offline event log + cloud sync (NC3), and result push (NC1).

See `GAPS.md` §"Prioritized remaining work".

## Progress log

### 2026-06-20 — BM4 native v2 wire exposed + BM5 actor attribution
- **Exposed the native §3 coordination wire** on `state-worker`'s public router
  (`coordination-native.ts` + `router.ts`): `:claim`/`:heartbeat`/`:complete`/
  `:cancel`, `GET …/runs/{id}/log?from=`, `GET …/runs/{id}/frontier`. Routed to
  the `RunCoordinator` DO via the (previously unused) proxy helpers; each route is
  authz-gated (`state.run.read|write`, deny-by-default), resource-hiding 404 for
  cross-tenant or non-DO-backed runs. Additive — the OP2 slash-verb surface is
  untouched. (The `api-edge` `STATE_PLANE_RE` already forwards the whole `/state/`
  prefix, verified live, so no edge change was needed.)
- **BM5 actor attribution:** the verified actor is now stamped on every appended
  coordination event — both on the native verbs and through the OP2↔DO facade
  (`coordinatorClaimOP2`/`HeartbeatOP2`/`CompleteOP2` now forward the actor instead
  of defaulting to `system:coordinator`).
- **Contract version → 2** (`STATE_CONTRACT_VERSION`), so the server accepts the
  v2 client (`CoordClient` sends major 2) while still accepting OP2's major 1.
- **Tests:** new `coordination-native.test.ts` (5) drives the native wire end to
  end against the real DO in miniflare — claim/heartbeat/complete/cancel, deps
  gating, exactly-one-winner, lease-loss 409, frontier advance, event-log read,
  verified-actor stamping, and cross-tenant/non-DO-backed 404s. Full suites green:
  contracts 61, state-worker 30, state-worker-tests 177.
- **Still open for BM4:** `…/events` (§5), `…/log` SSE/long-poll, §2-native create;
  and the CLI adoption (NC). BM5 remainder: quota choke + DO soft per-run cap.

### 2026-06-20 — BM2 log sealing (§4: seal on `:complete`)
- On a successful native `:complete`, `handleNativeComplete` now seals the job's
  log into a content-addressed `log` object before the DO append. `sealJobLog`
  lists the job's R2 chunks (`logChunkPrefix`), assembles them in **numeric** seq
  order (lexical R2 order would mis-sort "10" before "2"), `computeDigest`s the
  concatenation, and writes it to the CAS. The digest rides on the `JobSucceeded`
  event as `logsDigest` (`JobSucceededPayload.logsDigest?` + `CompleteRequest` +
  `decideComplete`, conditional so the no-log event shape is byte-identical to
  before). Reads R2 directly (no Postgres index, so it works in the native
  harness), best-effort (a seal failure is swallowed — completion never blocks),
  idempotent (content-addressed re-seal is a no-op).
- Tests: contracts — decider carries `logsDigest` onto `JobSucceeded` only when
  provided (65 total). state-worker — assembled-stream seal + `logsDigest` on the
  event read (out-of-order seeds prove numeric ordering), and empty-log → no
  `logsDigest` (39 total). All green; typecheck clean.
- Remaining (BM2/§4): project `logsDigest` into the `…/runs/{id}` read model and
  reference it from the client-built `job-result`; a DO `LogChunk` consumer is a
  separate (heavier) model not pursued here.

### 2026-06-20 — NC1 CLI memoization (producer half, in `sourceplane/orun`)
- Pairs with the server-resolved index below to close memoization end-to-end. On
  the `ORUN_COORDINATION=v2` path, `CoordBackend` now: marks a job memoizable from
  the `orun.dev/hermetic` label (opt-in; labels already flow source → `PlanJob`),
  computes a deterministic `jobInputHash` (steps + env-var KEYS; values/clock/runner
  excluded per C5), sends it as the KEY on `:claim`, treats a `cached` hit as
  adopt-by-skip, and on a hermetic success pushes a `job-result` (`EnsureObject`) +
  reports `jobInputHash`+`resultDigest` on `:complete`. `CoordClient.Claim` takes a
  `ClaimRequest`; `CompleteRequest` carries `jobInputHash`.
- Tests: hermetic claim carries the recomputed hash; hermetic success pushes a
  job-result + matching memo key/digest; non-hermetic sends nothing. orun
  statebackend suite green.
- Cross-cutting #4 (memoization trust hole) is now closed end-to-end. Remaining
  NC1 polish: output adoption on a hit, real input-artifact digests, `--no-cache`,
  cockpit "memoized", `log` sealing.

### 2026-06-20 — BM1 server-side memoization (jobInputHash → digest index)
- **Server-resolved memoization** — the central BM1 deliverable. The native claim
  now **resolves** the result digest from the job's `jobInputHash` via a
  **project-scoped memo index** (`memoIndexKey` → `state/{org}/{proj}/memo/{hash}`,
  an R2 marker holding the digest), written best-effort on a successful hermetic
  `:complete` (`recordMemoResult`) and existence-verified on claim
  (`resolveMemoDigest`; a GC'd result resolves to a re-run). The client supplies
  only the key — it can neither fabricate a hit nor choose which result is reused.
  The legacy client-supplied `memoResultDigest` path stays but is existence-verified
  (**412 `object_missing`**) — closing the phantom-hit hole.
- Tests (`coordination-native.test.ts`, R2 bound in the harness): cross-run memo
  hit (server-resolved digest), no index entry → re-execute, missing object → 412,
  legacy existing-digest → `cached`. state-worker 37, all green; typecheck clean.
- Still open (BM1, the CLI half / NC1): produce `jobInputHash` for real jobs and
  push the `job-result`/`log` objects the index points at. Refinement: threading
  `jobInputHash` into `JobSucceeded` would let the projector build the index from
  the event log (provenance); a `run-record` writer is still absent.

### 2026-06-20 — BM2 DO snapshotting + incremental fold
- **`reduceFrom(prev, events, plan)`** added to `@saas/contracts/coordination` — a
  pure continuation of `reduce` (`reduce(events) === reduceFrom(initialFold, events)`),
  so the golden vectors still pin both. Lets a long-lived fold holder apply newly
  appended events incrementally and resume from a checkpoint.
- **`RunCoordinator` storage reshaped** (`apps/state-worker/src/run-coordinator.ts`):
  the log is append-only per-event keys `e:<paddedSeq>` (an append is O(events
  appended) writes, not a full-array rewrite); the fold is held in memory and
  advanced with `reduceFrom` (no verb re-reads/re-folds the whole log); a `snap`
  checkpoint every 64 events (and at a terminal phase) bounds cold-start replay.
  Events are retained — `GET /log?from=` still serves the full authoritative
  stream — so this is checkpointing, not destructive compaction. A one-time
  migration folds a legacy `"log"` array into per-event keys on first access.
- Tests: contracts `reduceFrom` incrementality (16 in `coordination.test.ts`, 64
  total) + a DO integration test crossing the snapshot boundary (82 events; live
  fold == from-scratch re-fold of `/log`; `/log?from=` slice). Contracts 64,
  state-worker 31 — all green; both packages typecheck.
- Also added (BM2 test "Done when"): a **concurrent-claim race** test (8 claims via
  `Promise.all` → exactly one winner, one `JobClaimed`) and a **forced-restart
  recovery** test (persisted DO storage; a fresh runtime cold-starts and the
  rebuilt fold matches + the run completes) — the latter exercises the snapshot
  `load()`/`reduceFrom(tail)` path end-to-end. state-worker 33, all green.
- Still open (BM2): alarm-driven timeout integration test (needs
  `runDurableObjectAlarm`), log sealing on `:complete`, destructive compaction
  (needs a snapshot-aware `/log` read).

### 2026-06-20 — CLI adoption (NC2, in `sourceplane/orun`)
- **`CoordBackend`** (`internal/statebackend/coordbackend.go`) implements the CLI's
  `Backend` over the native §3 wire: claim/heartbeat/complete + the runnable
  frontier are conditional appends/reads against the per-run shard, with the lease
  epoch from `:claim` threaded into `:heartbeat`/`:complete`. `cmd/orun run`
  selects it under **`ORUN_COORDINATION=v2`** (default off → legacy `remotestate`);
  run create, logs, and read-model loads still delegate to the v1 client.
- Tests: `coordbackend_test.go` drives it against a fake §3 server (outcome
  mapping, lease-epoch threading, succeeded/failed, frontier). Go suites green.
- Still open (NC): async heartbeat goroutine, §3-native create/logs, the offline
  event log + cloud sync (NC3), result push (NC1).

## Cutover / operational gate (BM6) — runbook record

No cutover has been executed against the live wire. `COORDINATION_BACKEND=do` is
committed for stage/prod, but the drain bridge, provenance backfill, and
forced-DO-loss recovery drill do not exist, and `orun-api.sourceplane.ai` still
serves the legacy `orun-backend`. The fail-closed `projectorReady` gate means an
unapplied migration `350` silently falls back to OP2. **Do not treat the epic as
cut over.**

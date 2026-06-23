# saas-orun-backend-merge — Implementation Status

Rolled-up state of cluster **BM** (and the paired CLI cluster **NC** in `orun`).
Authoritative over the prose in `README.md`/`implementation-plan.md` when they
disagree. Full evidence + per-criterion analysis: [`GAPS.md`](./GAPS.md).

**Last audited:** 2026-06-23 (source review of both repos + executed test suites
+ live probes). **Branch:** `claude/sleepy-edison-99y58a` (PRs #127–#163 here,
#386–#401 in `orun`; #157/#159/#160/#161/#162/#163 merged here, #400/#401
merged in `orun`).

## Legend
✅ Done · 🟡 Partial · ⛔ Missing

## Platform (BM)

| ID | Status | Landed | Outstanding |
|----|--------|--------|-------------|
| BM0 | ✅ | event vocab, pure `reduce()`, golden vectors, vendored contract + checksum drift guard (in `orun`) | kind-naming reconcile; converge the two event taxonomies; CI-enforce cross-repo vectors |
| BM1 | 🟡 | object kinds registered, digest-verified PUT, `canonicalizeJobInput` + opt-in memo gate | **server-side memo lookup by `jobInputHash`**; exercise new kinds through CAS; `jobInputHash` producer; `run-record` writer |
| BM2 | 🟡 | `RunCoordinator` DO, conditional append, lease alarm, parity + diamond conformance; snapshotting + recovery test; concurrent-claim fuzz; log sealing on `:complete`; **alarm-driven timeout integration test** (PR #161 — `__test/alarm-now` route + per-DO `leaseSeconds`); server-side memo lookup (no longer trusts client digest) | project `logsDigest` into `…/runs/{id}` read model (needs DB migration) |
| BM3 | 🟡 | pure projector, idempotency-by-seq (mig `350`), projection sweep cron, reads from Postgres; **`…/log?wait=` long-poll exposed**; **heartbeat no longer projects** (write volume now ∝ runs, not ∝ heartbeats — PR #159); **post-verb projection deferred to `ctx.waitUntil`** (DB roundtrip off the request critical path — PR #163) | **remove legacy OP2 cron sweep** (cutover gate); SSE framing on `…/log`; durable outbox for projection (currently best-effort + sweep safety net); metering; drop+replay rebuild |
| BM4 | 🟡 | DO bound/deployed; per-run-sticky flag; diamond conformance; **native §3 wire now routed** (`:claim`/`:heartbeat`/`:complete`/`:cancel` + `…/log` + `…/frontier`, contract major 2) — see Progress log | `…/events` append primitive (§5); SSE/long-poll on `…/log`; native `POST …/runs` create shape; CLI adoption (NC) |
| BM5 | 🟡 | authz + deny-by-default + cross-tenant 404; **verified actor now stamped on every coordination event** (OP2 facade + native verbs); **soft per-run job cap** (1000 jobs/run; rejected at the edge before any DO storage is allocated — PR #162) | real run-create quota choke (off-by-default/fail-open); per-tenant rate-limit on run creation |
| BM6 | ⛔ | flag pre-set `do` (stage+prod), projector + fail-closed gate | backfill, drain bridge, **delete OP2 claim/sweep**, recovery drill vs O3 SLOs, update `intent.yaml`/CLI default, record runbook here |
| BM7 | ⛔ | — | decommission `orun-backend` (`orun-api.sourceplane.ai` still serves the legacy bundle); parameterized OSS plain-Postgres conformance harness; closeout |

## CLI (NC, repo `orun`)

| ID | Status | Landed | Outstanding |
|----|--------|--------|-------------|
| NC0 | ✅ | vendored contract + checksum guard, pure `Fold` + golden vectors | CI-enforce vector parity (currently hand-transcribed) |
| NC1 | 🟡 | `JobInputHash`/canonicalization + memo gate; **producer wired (`job-result` push + memo key/digest on `:complete`)**; **cockpit "memoized" surface** (PR #401: `Cached`/`ResultDigest` on `ClaimResult` + `orun run` prints the hit) | `--no-cache`; `hermetic` plan field surface; `log` sealing on the CLI side; real input-artifact digests |
| NC2 | 🟡 | `CoordBackend` drives claim/heartbeat/complete/frontier over §3; **lease epoch threaded**; **async heartbeat goroutine + `lease_lost` abort wired** (`command_run.go:628` + `runHeartbeat` with `onLeaseLost`, server-supplied interval at `:699`); selected under `ORUN_COORDINATION=v2` | `…/events` (§5); §3-native create/logs (run create + log read still delegate to v1) |
| NC3 | 🟡 | **`status --watch` event-driven via `ReadLog(wait=)` long-poll** (`#400`, `orun`); CLI consumes BM3's `…/log?wait=` | `logs --follow` event-driven tail (deferred — per-job re-query in worker would dominate DB at scale); cockpit live-tail; offline `.orun/` event log + cloud sync |
| NC4 | 🟡 | `OIDCTokenSource` (aud `orun-cloud`) wired to legacy client; **also wired to `CoordClient`** (`command_run.go:511` passes `tokenSrc` into `CoordClient`) | stage conformance suite |
| NC5 | 🟡 | single-runner deps-gated memo-aware DAG driver; heartbeat + lease-loss abort wired through `RunnerHooks.OnJobStart`/`BeforeJob` in `command_run.go` | object/result push beyond memo path; incremental log reads via native surface |

## The two facts that gate "done"

1. **Native v2 wire** — ✅ **server side now exposed** (Progress log 2026-06-20):
   `:claim`/`:heartbeat`/`:complete`/`:cancel`, `GET …/log?from=`, and
   `…/frontier` are routed to the DO on the public `state-worker` surface, gated
   by the same auth/policy/contract-version as OP2, and the server advertises
   contract major 2. Still open: the `…/events` append primitive (§5), SSE +
   long-poll on `…/log`, and a §2-native `POST …/runs` create shape.
2. **CLI adoption** — 🟡 **coordination cycle fully wired (opt-in)** (audit
   2026-06-23): `orun`'s `CoordBackend` drives claim/heartbeat/complete + the
   runnable frontier over the §3 wire (lease epoch threaded), selected with
   `ORUN_COORDINATION=v2`. The **async heartbeat goroutine + `lease_lost`
   abort + OIDC** are all wired (`command_run.go:511,628`; tracker was stale).
   Memoization is end-to-end with the producer + the visible cockpit hit (PR
   #401). Still open: the **default flip** off the env-var opt-in (a BM6
   cutover decision), §3-native create/logs (run create + log read still
   delegate to v1), and the offline event log + cloud sync (NC3).

See `GAPS.md` §"Prioritized remaining work".

## Progress log

### 2026-06-23 — BM3 defer post-verb projection to `ctx.waitUntil` (PR #163)
- After #159 removed per-heartbeat projection, `claim`/`complete`/`cancel`
  were still projecting **synchronously** — the verb's HTTP response blocked
  on a DB roundtrip (DO `/state` fetch + `SELECT last_seq` + read-model
  upsert, ~50ms). At burst load (1000 jobs claiming simultaneously), that
  serializes every claim behind Postgres latency on the request's critical
  path. The projection itself is necessary; awaiting it in-band is not.
- `projectAfterVerb` now hands the projection to `ctx.waitUntil` when an
  `ExecutionContext` is supplied; the worker keeps the request alive until
  the deferred promise settles. The bounded projection sweep is the safety
  net. Threaded `ctx?` through the 6 verb handlers + router call sites;
  follows the `handleAdvanceCatalogHead` precedent.
- Trade-off: the post-verb read model is now eventually consistent on the
  order of the deferred-promise drain (typically <100ms); CLI doesn't
  read-after-claim from the projection (uses the DO log).
- Tests: a new deferred-path test (claim returns 200 with zero DB queries on
  the request path; projection runs once `waitUntil`'s promise drains).
  state-worker 44/44, state-worker-tests 178/178.

### 2026-06-23 — BM5 soft per-run job cap (PR #162)
- A coordination shard's storage scales with the job count (event log,
  snapshots, in-memory fold). A runaway plan (100k-job POST) would inflate
  a DO beyond healthy operating bounds and starve neighbor shards on the
  same colocation. There was no backstop.
- `MAX_JOBS_PER_RUN = 1000` constant; enforced in `handleCreateRun`
  immediately after `parsePlanJobs` and **before any DB executor or DO
  storage is allocated**. Returns 422 with a clear field error pointing at
  the cap. Generous for real workloads; raise in `constants.ts` if needed.
- Test asserts a 1001-job plan is rejected with the cap message in
  `error.details.fields.jobs`. state-worker-tests 178/178 green.

### 2026-06-23 — BM2 alarm-driven timeout integration test (PR #161)
- BM2's "Done when" included _"killing a runner re-queues its job within the
  lease window via the DO alarm."_ `sweepLeases` was unit-tested but the
  alarm-wakeup → sweep → append chain was untested end-to-end. Miniflare 4
  has no public alarm-now or clock-advance API, so closing it required:
  (1) **`InitBody.leaseSeconds?`** — per-DO lease tunable persisted on init
  (default `DEFAULT_LEASE_SECONDS`; the test sets `0` to make the lease
  expirable in test time); threaded through `decideClaim`/`decideHeartbeat`/
  the alarm reschedule + response payloads. (2) **`POST /__test/alarm-now`**
  — internal-only DO route that synchronously invokes `this.alarm()`; the
  DO is reached only via the stub (never from the public router), so the
  route is unreachable externally.
- Integration test drives: `init(leaseSeconds: 0)` → r1 claims (attempt 1) →
  trigger-alarm → assert `LEASE_EXPIRED` event → r2 re-claims at attempt 2.
- state-worker 43/43 green; typecheck + lint clean.

### 2026-06-23 — NC1 cockpit "memoized" surface (PR #401, `orun`)
- `ClaimResult` gained `Cached` + `ResultDigest`; `CoordBackend.ClaimJob`
  populates them on `OutcomeCached` (the existing `CurrentStatus="success"`
  adopt-by-skip behavior is unchanged). `orun run`'s `BeforeJob` now prints
  `✓ memoized <job> — cache hit, skipped execution (<digest>)` when a hermetic
  job is adopted from the server-resolved memo index. Previously the hit was
  silent (the headline v2 feature was invisible to the user).
- Test: a cached `:claim` response surfaces `Cached`/`ResultDigest` with
  adopt-by-skip semantics. Full `internal/statebackend` + `cmd/orun` suites
  pass; build/vet clean.
- **Audit correction:** while scoping this we verified the heartbeat goroutine,
  `lease_lost` abort, and OIDC token source are all wired on the v2 path
  (`command_run.go:511,628`). The 2026-06-20 tracker listed them as pending —
  they are not. NC2/NC4 rows above reflect the verified state.

### 2026-06-23 — BM3 stop projecting on heartbeat (DB-protection at scale, PR #159)
- Removed the per-heartbeat `projectAfterVerb` from both heartbeat handlers
  (`handleNativeHeartbeat` on the native wire and the DO-backed branch of
  `handleHeartbeatJob` in the OP2 facade). Each was doing a DO `/state` fold +
  `SELECT last_seq` + read-model upsert on every beat — at ~1000 concurrent
  jobs that path dominated Postgres load for **zero correctness gain** (a
  heartbeat only renews the DO-owned lease). The bounded projection sweep
  reconciles `leaseExpiresAt` for non-terminal runs; lifecycle verbs
  (claim/complete/cancel) still project immediately.
- Directly advances BM3's "write volume ∝ runs, not ∝ heartbeats" criterion.
- The legacy non-DO branch of `handleHeartbeatJob` is untouched (it writes the
  lease directly because in the pre-DO model the read model *is* the source of
  truth). Regression test: heartbeat issues zero DB queries while claim
  projects (counting `SqlExecutor`). state-worker 42/42 green; typecheck +
  lint clean.

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

### 2026-06-20 — BM3 `…/log?wait=` long-poll (live-tail)
- `GET …/runs/{id}/log?from=&wait=<seconds>` now long-polls: when no event sits
  past the cursor, the `RunCoordinator` DO holds the request (capped at 25s,
  re-reading every 250ms) and returns the moment an event is appended, else an
  empty page when the wait lapses. The DO is single-threaded but yields at the
  `setTimeout` await, so a concurrent `:claim`/`:complete` is processed and becomes
  visible on the next poll — verified by a test that races a claim against a held
  read and gets the new event back (no busy polling). `handleNativeLog` parses
  `wait`; `proxyCoordinatorLog` threads it to the DO.
- This is the server side of NC3 live-tail (`status --watch`/`logs --follow`); the
  CLI consuming it + SSE framing remain. Tests: wake-on-append + timeout-empty
  (state-worker 41). Typecheck clean.

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

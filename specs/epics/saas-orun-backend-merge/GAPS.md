# saas-orun-backend-merge — Gaps & Progress Audit

**Audit date:** 2026-06-20
**Method:** full source review of both repos (`sourceplane/orun-cloud` cluster **BM**,
`sourceplane/orun` cluster **NC**), executed test suites, and unauthenticated live
probes of `orun-api.sourceplane.ai`. Verdicts are against each milestone's
literal "Done when" in `implementation-plan.md` and the normative
`coordination-api.md`.

> **Why this document exists.** The epic `README.md` and `implementation-plan.md`
> marked every milestone "🗓️ Planned / not yet started," but a large body of
> work is merged on branch `claude/sleepy-edison-99y58a` (PRs #127–#146 here,
> #386–#395 in `orun`). This audit replaces the stale "not started" framing with
> an evidence-based status. The companion `IMPLEMENTATION-STATUS.md` carries the
> rolled-up state going forward.

---

## TL;DR

The **coordination cores are real, correct, and tested**; the **product is not
wired together**. Two facts dominate everything below:

1. **The native v2 wire contract is never exposed.** Neither `api-edge` nor
   `state-worker`'s router serves the `coordination-api.md` surface
   (`:claim`/`:heartbeat`/`:complete`/`:cancel`, `…/events`, the `…/log?from=`
   event stream, `…/frontier`). The `RunCoordinator` Durable Object is reached
   **only internally**, through an **OP2↔DO compatibility facade** inside the
   legacy path-style handlers (`/jobs/{id}/claim`, `/heartbeat`, `/update`,
   `/cancel`, `/logs/{id}`). The server still speaks OP2 on the wire; the DO is
   an implementation detail behind it.

2. **The CLI never adopted the new client.** In `orun`, the entire new
   append/fold stack (`CoordClient`, `Fold`, `RunLoop`, `JobInputHash`,
   `ActionForClaim`) is a **dead-code island** — zero references outside
   `internal/statebackend/` and its own tests. `cmd/orun/command_run.go:502-504`
   constructs `remotestate.NewClientWithScope(...)` → `NewRemoteStateBackend`,
   the **legacy relational** client (`/claim`, `/update`, `/runnable`).

So "the CLI moved to the event-sourced contract" did not happen on **either**
side. What landed: a frozen contract + pure fold + golden vectors (BM0/NC0), a
working DO with conditional append + lease alarm (BM2), Postgres projections
(BM3), and well-tested pure cores on the CLI (NC1/NC2/NC5) — all behind a flag,
bridged under the old OP2 wire, with the new surface and the CLI adoption still
unbuilt.

---

## Verification performed (this audit)

| Check | Result |
|---|---|
| `packages/contracts` coordination suite (`vitest run coordination`) | ✅ **61/61 pass** (fold, golden vectors, deciders, projector, memo) |
| `state-worker` DO + conformance (`run-coordinator`, `conformance`, `facade`, `coordination-route`, `projection-sweep`) | ✅ **22/22 pass** (real DO in miniflare; diamond-DAG conformance) |
| `orun` `go test ./internal/statebackend/...` | ✅ **pass** (Go fold, canonicalization, coord client, run loop) |
| Live `GET https://orun-api.sourceplane.ai/` | `200 {"status":"ok","service":"orun-api"}` — **the legacy `orun-backend` bundle** (matches `orun/internal/backendbundle/embed/worker/index.js:3299`) |
| Live coordination paths (`/v1/organizations/.../state/runs...`, colon- and slash-verbs) | All `404 {"error":"Not found","code":"NOT_FOUND"}` — the legacy bundle's catch-all; **the v2 surface is not served at the CLI's default backend URL** |

The implemented code **works** — the gaps below are missing exposure, wiring,
and recovery substrate, not broken internals. No `throw new Error("not
implemented")`, `@ts-ignore`, `.skip`, or `panic(...)` stubs were found in any
BM/NC coordination source.

---

## Status at a glance

| Milestone | Verdict | One-line |
|---|---|---|
| **BM0** contract v2 + fold + vendor | ✅ **Done** | Event vocab, pure `reduce()`, golden vectors; vendored + `CHECKSUM` + drift guard live in `orun` (NC0). Naming diverges (`state.*` vs plan's CamelCase); two event taxonomies coexist. |
| **BM1** object kinds + memoization | 🟡 **Partial** | Kinds registered + canonicalization + opt-in gate tested. **Server-side memo lookup missing** (DO trusts a client-supplied digest); new kinds untested through the CAS; no `jobInputHash` producer; no `run-record` writer. |
| **BM2** RunCoordinator DO | 🟡 **Partial** | DO + deciders + conditional append + lease alarm + parity/conformance green. **Snapshotting + incremental fold done** (append-only per-event keys, in-memory `reduceFrom` cache, periodic `snap` checkpoint), **concurrent-claim race + forced-restart recovery tested**. Remaining: alarm-driven timeout integration test; logs not sealed; destructive compaction. |
| **BM3** projections | 🟡 **Partial** | Pure projector + idempotency-by-seq + projection sweep cron; reads served from Postgres. **Legacy cron sweep NOT removed**; `…/log` & `…/frontier` not exposed; no SSE/long-poll; projector is sync-after-verb, not the async outbox; no metering. |
| **BM4** DO routing / CLI adoption | 🟡 **Partial** | DO bound + deployed; per-run-sticky backend flag; diamond-DAG conformance green. **§3 verbs not routed** (OP2 facade only); no public `…/log`/`…/frontier`/live-tail. |
| **BM5** auth / tenancy / quota | 🟡 **Partial** | Auth + deny-by-default policy + cross-tenant 404 enforced on every *existing* route (DO runs inside OP2 handlers, after authz). **Quota off-by-default & fail-open**; **no DO soft per-run cap**; **DO-bridged claim/heartbeat/complete lose the verified actor** (stamped `system:coordinator`). No BM5 commit. |
| **BM6** migration & cutover | ⛔ **Missing** (scaffolding only) | Flag pre-set `do` for stage/prod; projector + fail-closed gate exist. **No backfill, no drain bridge, OP2 claim/sweep path not deleted, no recovery drill, `intent.yaml`/CLI default unchanged, no runbook recorded.** Cutover flag pre-flipped ahead of prerequisites = risk. |
| **BM7** decommission + OSS conformance | ⛔ **Missing** | No `orun-backend` teardown; no OSS plain-Postgres conformance impl; conformance harness hard-wired to the DO; no closeout. Live `orun-api.sourceplane.ai` still serves the legacy bundle. |
| **NC0** vendor + Go fold | ✅ **Done** | Vendored `coordination-api.md` + `CHECKSUM` + `TestVendoredCoordinationChecksum`; pure `Fold` + 9 golden vectors. |
| **NC1** result plane + cache-aware claim | 🟡 **Partial** | `jobInputHash`/canonicalization + memo gate tested. No result push, no `--no-cache`, no `hermetic` plan field, no cockpit "memoized"; unwired. |
| **NC2** event-log client | 🟡 **Partial → Missing** | Pure claim/heartbeat→action core tested. **`Backend` not reshaped**; `remotestate` still legacy verbs; no `…/events`; **no heartbeat goroutine**; unwired. |
| **NC3** read-the-log UX + offline log | ⛔ **Missing** | `status`/`logs` still row-read + poll; no `bridge.Source` stream fold; no SSE/long-poll; no offline event log + cloud sync. |
| **NC4** CI OIDC golden path + conformance | 🟡 **Partial** | `OIDCTokenSource` (audience `orun-cloud`) exists and is wired — but to the **legacy** client; `CoordClient.TokenSource` never set in prod; no stage conformance suite. |
| **NC5** runner orchestration loop | 🟡 **Partial** | Single-runner deps-gated, memo-aware DAG driver, fake-tested. No heartbeat, no real lease-loss abort, no object/result push, full-log re-read per tick; unwired from `internal/runner`. |

---

## Platform (BM) — detail

### BM0 — Coordination contract v2 + vendor — ✅ Done
- **Satisfied:** 12 event kinds (`COORDINATION_EVENT_TYPES`, `packages/contracts/src/coordination.ts:26-39`); pure `reduce()` (`:201-312`, defensive seq sort, terminal-sticky, ignores unknown kinds); 9 golden vectors (`coordination-vectors.ts`) run in `coordination.test.ts`; vendored copy + `CHECKSUM` + `TestVendoredCoordinationChecksum` in `orun` (`specs/orun-native-coordination/vendored/`, drift guard green).
- **Gaps / nits:**
  - Event kinds are namespaced `state.run.created` / `state.job.claimed`, **not** the plan's literal `RunCreated`/`JobClaimed`. Internally consistent, but the wire-kind naming must be reconciled with the CLI decoder and the server emitter (see cross-cutting #2).
  - **Two event taxonomies coexist**: `COORDINATION_EVENT_TYPES` (new) vs `STATE_EVENT_TYPES` (`state.ts`, still emitted by the OP2 path). The "frozen vocab" is not yet the single emitted vocab.
  - Cross-repo vector parity is **transcribed, not enforced**: `fold_test.go` hand-copies the vectors; the checksum guard covers only the prose `.md`, not the vector data.

### BM1 — Object-plane extensions + memoization lookup — 🟡 Partial
- **Satisfied:** kinds `job-result`/`log`/`run-record` registered (`object-store.ts:126-140`, `state.ts:210-219`); PUT digest-verified + idempotent (`handlers/objects.ts:188-221`); `objects/missing` covers them by digest; canonicalization `canonicalizeJobInput` spec'd + golden-tested (`coordination-memo.test.ts`); opt-in gate (`coordination-core.ts:124`, hermetic-only).
- **Gaps:**
  - **No server-side `job-result`-by-`jobInputHash` lookup** — the central BM1 deliverable. `decideClaim` consumes a **client-supplied** `memoResultDigest`; the server never resolves object existence by hash. `memoizationHit()` (`coordination.ts:410-416`) is **dead code** (only its own test calls it).
  - New kinds are **never exercised through the CAS** in tests (every PUT/GET test uses `kind:"plan"`); the "round-trips on stage" criterion is unverified.
  - **No `jobInputHash` producer** anywhere (server or, in prod, CLI) — derivation is spec-only.
  - **No `run-record` writer** — kind registered, never emitted.

### BM2 — Per-run coordination shard (Durable Object) — 🟡 Partial
- **Satisfied:** `RunCoordinator` DO keyed by `runId` (`run-coordinator.ts`), append-only log in DO storage, in-memory fold, single-writer seq; deciders enforce deps/lease/terminal/cache (`coordination-core.ts`); lease alarm (`alarm()`→`sweepLeases`, 60s/20s, attempt+1 bounded to 5); parity + diamond conformance suites green in miniflare.
- **Gaps (each an explicit "Done when"):**
  - ~~**Snapshotting absent.**~~ ✅ **Done.** The log is now append-only per-event keys (`e:<paddedSeq>`), not a single rewritten array, so an append is O(events appended) writes. The fold is held in memory and advanced with `reduceFrom` (a pure continuation of `reduce`, golden-tested), so no verb re-reads or re-folds the whole log. A `snap` checkpoint every 64 events (and at a terminal phase) bounds cold-start replay — the recovery substrate BM6's drill needs. Tests: contracts `reduceFrom` incrementality (`reduce(all) == reduceFrom(reduce(prefix), suffix)`, non-mutation, canceled-carry-forward) + a DO integration test crossing the snapshot boundary (82 events; live fold == from-scratch re-fold of `/log`; `/log?from=` slice). **Remaining:** destructive compaction needs a snapshot-aware `/log` read protocol (events are retained today since `/log?from=0` must serve the full stream).
  - ~~**No fuzz concurrent-claim test.**~~ ✅ **Done** — 8 claims raced with `Promise.all` against one DO; asserts exactly one winner, 7 `job_held`, and a single `JobClaimed` in the log.
  - ~~**No forced-DO-restart / recovery test.**~~ ✅ **Done** — a persisted-storage test (`durableObjectsPersist`) inits + claims + 70 heartbeats (crossing the snapshot), disposes the runtime, then a **fresh** runtime cold-starts: the rebuilt fold equals the pre-restart state and a from-scratch re-fold of `/log`, and the run continues its seq line to completion.
  - **Alarm-driven timeout never integration-tested** (only pure `sweepLeases`; raw-miniflare harness has no alarm-fire hook — needs `@cloudflare/vitest-pool-workers`'s `runDurableObjectAlarm`).
  - **Logs not sealed on `:complete`** (contract §4); the DO has no `LogChunk` path — logs stay on the disjoint OP2 per-job R2 path.
  - **Memo digest is client-trusted** (carried from BM1) — false-reuse hole.

### BM3 — Projections (read models) — 🟡 Partial
- **Satisfied:** pure `planProjection`/`projectRun` (`coordination-projector.ts`, `coordination-projection.ts`); idempotency-by-seq (`WHERE last_seq < $5`, migration `350_state_run_last_seq`); projection sweep cron phase (`projection-sweep.ts`); `…/runs` & `…/runs/{id}` served from Postgres; reads never block on a coordination write (`projectAfterVerb` best-effort).
- **Gaps:**
  - **Legacy OP2 cron sweep NOT removed** — `index.ts:31` still runs `runSweep(env)` as Phase 1; BM3 *added* a phase rather than replacing the cron. Dual liveness paths (DO alarm **and** cron).
  - **`…/log` (event stream) and `…/frontier` not exposed**; no `Accept: text/event-stream` SSE; no `?wait=` long-poll. The DO's internal `GET /log?from=` and `proxyCoordinatorLog` exist but are never routed.
  - Projector is **synchronous-after-verb + cron fold**, not the async/outbox/batched consumer the plan specifies; `LeaseRenewed` bumps seq, so heartbeat-frequency projections aren't fully eliminated.
  - **No metering** wired into projections.
  - **Rebuild-from-event-log is DO-dependent and untested** — no Postgres event-log table, no global replay routine, no drop+replay test.

### BM4 — DO routing / CLI adoption — 🟡 Partial
- **Satisfied:** DO re-exported + bound + migrated (`index.ts:11`, `wrangler.template.jsonc` per-env `COORDINATOR` + `new_sqlite_classes`); per-run-sticky flag (`useDoCoordination`, `runIsDoBacked`, fails closed to OP2); diamond-DAG conformance drives the real DO (`conformance.test.ts`).
- **Gaps:**
  - **§3 native verbs not routed.** The flag routes the **OP2 path-style** verbs through the facade (`coordinatorClaimOP2`/`HeartbeatOP2`/`CompleteOP2`/`CancelOP2`); no colon-verbs, no public `…/log`/`…/frontier`. The runbook's "forward `…:{claim,heartbeat,complete}` and `GET …/log` to the DO" is not done as written.
  - `proxyCoordinatorVerb`/`proxyCoordinatorLog` are unused relative to the OP2 path (only `initCoordinator` is wired).
  - Conformance proves the **DO**, not the deployed HTTP surface clients hit.

### BM5 — Auth, tenancy & quota on the new surface — 🟡 Partial
- **Satisfied (inherited from OP2 handlers):** every route that exists is deny-by-default gated — run create/read, claim/heartbeat/complete/cancel (authz precedes the DO branch), log read/write, object read/write (route-by-route map in the BM4–BM7 review). Cross-tenant **resource-hiding 404** is enforced and ordered safely (authz before any DO read), so the DO cannot leak cross-tenant existence.
- **Gaps:**
  - **Run-create quota is off-by-default and fail-open** (`handlers/runs.ts:254-278`): blocks only when a `hard` `state.runs` quota is configured and exceeded, and swallows any check error. Not the per-tenant fan-out choke point BM5 specifies.
  - **No soft per-run cap in the DO** — `run-coordinator.ts`/`coordination-core.ts` admit unlimited concurrent claims.
  - **DO-bridged events lose the verified actor.** `coordinatorClaimOP2`/`HeartbeatOP2`/`CompleteOP2` don't forward the authenticated actor; claim/heartbeat/complete are stamped `SYSTEM_ACTOR` (`system:coordinator`). Only `initCoordinator` and cancel carry the real actor. Undercuts "every event attributed."
  - The bearer→actor exchange (OIDC/`sk_`/session) lives at the **edge** (`api-edge/state-facade.ts`), not on a distinct "new surface"; §6's `…/log`/`…/frontier`/`…/events` bindings are unexercised because those routes don't exist.

### BM6 — Migration & cutover — ⛔ Missing (scaffolding only)
- **Exists:** DO bound; `COORDINATION_BACKEND=do` **pre-set for stage and prod** (`wrangler.template.jsonc:51,99`); migration `350`; projector apply + `projectorReady` fail-closed gate (unapplied migration → silent OP2 fallback).
- **Missing (all BM6 "Done when"):**
  - **Provenance backfill** — runbook references `tooling/migrations/backfill-run-records.mjs`; the file and `tooling/migrations/` **do not exist**. Nothing writes `run-record` provenance.
  - **Read-only drain bridge** — no drain/read-only mode anywhere; `COORDINATION_BACKEND` only selects OP2-vs-DO.
  - **Delete the OP2 `run_jobs` claim/sweep path** — still defined and live (`claimRunJob`/`heartbeatRunJob`/`updateRunJob`, `sweepLapsedLeases` + cron).
  - **Recovery drill / O3 SLO instrumentation** — none (and BM2 snapshots, which the drill needs, don't exist).
  - **`intent.yaml`/CLI default unchanged** — still `backendUrl: https://orun-api.sourceplane.ai`.
  - **No runbook recorded** in `IMPLEMENTATION-STATUS.md`.
- **Risk:** the cutover flag is pre-flipped for stage/prod **ahead of** the drain/backfill/drill prerequisites. The per-run stickiness + fail-closed gate is the only safety net.

### BM7 — Decommission + OSS conformance — ⛔ Missing
- No `orun-backend` teardown (`infra/terraform/` has no such component; it's a separate repo). Live `orun-api.sourceplane.ai` **still serves the legacy bundle**.
- No second (OSS plain-Postgres conditional-append) contract implementation; the conformance suite is hard-wired to the miniflare DO, not a parameterized harness a second impl could plug into. Parking is by design (D5), but the reusable gate isn't encoded.
- No closeout.

---

## CLI (NC) — detail

> **Overarching:** none of NC's "Done when" stage behaviors are reachable from
> `orun run` — the new stack is unwired (see TL;DR #2). `statebackend.Backend`
> (`backend.go:69-102`) was **not reshaped**; it retains `ClaimJob`/`UpdateJob`/
> `RunnableJobs`/`LoadRunState`. The new `Claim`/`Complete`/`ReadLog`/`RunLoop`
> exist only on the concrete `CoordClient`, which does not implement `Backend`.

- **NC0 — ✅ Done.** Vendored contract + `CHECKSUM` + drift guard; pure `Fold` (`fold.go`) + 9 golden vectors + determinism/terminal-sticky/idempotent tests. (Vector parity with the TS source is hand-transcribed, not CI-enforced — same nit as BM0.)
- **NC1 — 🟡 Partial.** `JobInputHash`/`canonicalizeJobInput` + `MemoizationHit` gate tested. **No result push** (`RunLoop` trusts an executor digest, never builds/uploads `job-result`/`log`); **no `--no-cache`**; **no `hermetic` field** in the plan/model; **no cockpit "memoized"** rendering; `jobInputHash` never computed for a real job.
- **NC2 — 🟡 Partial → Missing.** `ActionForClaim`/`ActionForHeartbeat`/`ClaimableJobs=Frontier` tested. But `Backend` not reshaped; `internal/remotestate` still speaks `/claim`,`/update`,`/runnable` (no `:claim`, no `…/events`, no `expectedSeq`); **no heartbeat goroutine** (`RunLoop` executes inline; lease tunables aren't even decoded); `lease_lost` mid-execution isn't actively halted; full-log re-read from seq 0 each tick.
- **NC3 — ⛔ Missing.** `status`→`LoadRunState` row reads; `logs --follow`→polls the old per-job `/logs/{id}?fromSeq=`; no `bridge.Source` stream fold, no SSE/long-poll, no `.orun/` offline event log, no cloud sync/reconcile.
- **NC4 — 🟡 Partial.** `OIDCTokenSource` (audience `orun-cloud`, `→ POST /v1/auth/oidc/exchange`) exists and is wired in `command_run.go` — but feeds the **legacy** `RemoteStateBackend`. `CoordClient.TokenSource` is correct but **never set in prod**. No stage conformance suite (only in-process fake-coordinator loop tests).
- **NC5 — 🟡 Partial.** `RunLoop` drives a deps-gated, memo-aware diamond DAG to completion against a fake coordinator (3 tests green). No heartbeat, no real lease-loss abort, no object/result push, full-log re-read per tick, unwired from `internal/runner`.

---

## Cross-cutting gaps

1. **Two coordination planes coexist and both are live** — the new DO (behind
   `COORDINATION_BACKEND=do`, per-run sticky) and the legacy OP2 relational path +
   its cron sweep (still wired, Phase 1). BM2/BM3 added the DO *alongside* OP2.
2. **Wire-kind naming risk.** The contract §8.1 example shows CamelCase
   (`"kind":"JobClaimed"`); both repos implement dotted `state.*`. Server emitter,
   CLI decoder (`coordlog.go`), and contract must be reconciled, or a server
   emitting CamelCase would fall through the CLI's decode → empty fold.
3. **Contract-version mismatch.** Server `STATE_CONTRACT_VERSION = 1`
   (`packages/contracts/src/state.ts:26`), so `enforceContractVersion` rejects
   major > 1 with `409`. The CLI `CoordClient` hard-sends `Orun-Contract-Version:
   2` (`coordclient.go:54`). Latent today (neither is wired), but the new CLI
   would be 409'd by the new server. Bump the server major to 2 (with the v2
   surface) **or** align the client.
4. **Memoization trust hole** (BM1→BM2→NC1): the contract requires the server to
   store/look-up `job-result` by `jobInputHash` and to 412 on a missing object;
   instead the DO memoizes on an unverified client digest, and the CLI never
   uploads the result it references.
5. **Recovery substrate missing** (BM2 snapshots) — BM6's forced-DO-loss drill
   has nothing to replay from.
6. **Docs lagged reality** — fixed by this audit + `IMPLEMENTATION-STATUS.md` +
   the updated status tables.

---

## Live findings (`orun-api.sourceplane.ai`, unauthenticated)

- `GET /` → `200 {"status":"ok","service":"orun-api"}` — the **legacy
  `orun-backend` worker** (root handler at `backendbundle/embed/worker/index.js:3299`;
  error shape `{"error":"Not found","code":"NOT_FOUND"}` matches `:112`).
- Every coordination path (both `…/state/runs…` colon- and slash-verbs) → the
  legacy bundle's `404 NOT_FOUND`. **The v2 contract is not served at the CLI's
  default/`intent.yaml` backend URL**, and `orun-api.sourceplane.ai` is still the
  un-decommissioned legacy backend (consistent with BM6/BM7 = Missing).
- **Correction (deployed edge).** `orun-api.sourceplane.ai` is the **old**
  standalone backend, deployed separately. The real deployed edge is
  `api-edge-{stage,prod}.oruncloud.workers.dev`. Re-probed live: `/health` →
  `{"service":"api-edge",…,"database":{"reachable":true}}`, and unauthenticated
  coordination paths (both `:claim` colon-verbs and `/claim` slash-verbs) →
  **`401 unauthenticated`** with the edge's error envelope — i.e. the edge facade
  is live and correctly auth-gating the `/state/` plane (resource-hiding). The
  native §3 verbs route past the edge to `state-worker` once authenticated.
- Behavioral verification of the implemented pieces is via the local suites
  (contracts 61, state-worker 30, state-worker-tests 177, Go `statebackend` — all
  green) plus the new `coordination-native.test.ts`.

> **Progress (2026-06-20):** P0 #1 partially landed — the native v2 wire
> (`:claim`/`:heartbeat`/`:complete`/`:cancel`, `…/log`, `…/frontier`) is now
> routed on `state-worker`, the contract major is bumped to 2, and the verified
> actor is stamped on every event (BM5). See `IMPLEMENTATION-STATUS.md`
> §"Progress log". Remaining P0: wire the CLI (`cmd/orun` → `CoordClient`), the
> `…/events` primitive + SSE/long-poll, and server-side memoization lookup.

---

## Prioritized remaining work

**P0 — close the loop (make the new plane usable):**
1. **Expose the v2 wire** on `state-worker` + `api-edge`: route `:claim`/
   `:heartbeat`/`:complete`/`:cancel`, `…/events`, `GET …/log?from=` (SSE +
   long-poll), `…/frontier` (BM4/BM3). Bump `STATE_CONTRACT_VERSION` to 2 in lockstep.
2. **Wire the CLI** to the new client: reshape `statebackend.Backend`, make
   `cmd/orun` construct the `CoordClient`-backed backend, add the heartbeat
   goroutine and `lease_lost` abort (NC2/NC5), set `CoordClient.TokenSource` from
   the OIDC source (NC4).
3. **Server-side memoization lookup** by `jobInputHash` + 412 on missing
   `job-result`; CLI result push (`job-result`/`log` objects) before `:complete`
   (BM1/NC1).

**P1 — durability & correctness:**
4. ✅ DO **snapshotting** + checkpoint landed (incremental `reduceFrom` fold +
   per-event keys + `snap` every 64 events), plus **concurrent-claim race** and
   **forced-restart recovery** tests. Still open: alarm-driven timeout integration
   test (needs `runDurableObjectAlarm`) (BM2).
5. Forward the **verified actor** through the DO-bridged verbs; turn the quota
   gate into a real strong-consistent choke + DO soft per-run cap (BM5).
6. Seal logs into a `log` object on `:complete`; consume `LogChunk` in the DO (BM2/§4).

**P2 — cutover & cleanup:**
7. Provenance **backfill**, **drain bridge**, **delete the OP2 claim/sweep + legacy
   cron**, recovery drill against O3 SLOs, update `intent.yaml`/CLI default (BM6).
8. **Decommission** `orun-backend` (`orun-api.sourceplane.ai`); encode a
   parameterized conformance harness for the OSS plain-Postgres impl (BM7).
9. NC3: `bridge.Source` stream fold, SSE/long-poll `status`/`logs --follow`,
   offline `.orun/` event log + cloud sync.

**P3 — hygiene:**
10. Reconcile wire-kind naming (dotted vs CamelCase) and converge the two event
    taxonomies; enforce cross-repo golden-vector parity in CI (not hand-transcription).

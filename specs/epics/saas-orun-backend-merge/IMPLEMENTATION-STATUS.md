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
2. **CLI new client is unwired** — `cmd/orun` still uses the legacy `remotestate`
   client; `CoordClient`/`Fold`/`RunLoop` are a dead-code island. **This is now
   the primary blocker** — the server wire exists; the CLI must adopt it (NC2/NC5
   wiring + `statebackend.Backend` reshape).

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

## Cutover / operational gate (BM6) — runbook record

No cutover has been executed against the live wire. `COORDINATION_BACKEND=do` is
committed for stage/prod, but the drain bridge, provenance backfill, and
forced-DO-loss recovery drill do not exist, and `orun-api.sourceplane.ai` still
serves the legacy `orun-backend`. The fail-closed `projectorReady` gate means an
unapplied migration `350` silently falls back to OP2. **Do not treat the epic as
cut over.**

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
| BM4 | 🟡 | DO bound/deployed, per-run-sticky backend flag, diamond-DAG conformance | **route the §3 colon-verbs + `…/log`/`…/frontier` publicly** (currently OP2 facade only); live-tail |
| BM5 | 🟡 | auth + deny-by-default policy + cross-tenant 404 on every existing route | **real run-create quota choke** (currently off-by-default/fail-open); **DO soft per-run cap**; **forward verified actor through DO-bridged verbs** |
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

1. **Native v2 wire is unexposed** — server reaches the DO only via the OP2↔DO
   facade; `:claim`/`:heartbeat`/`:complete`/`:cancel`/`…/events`/`…/log`/`…/frontier`
   are not routed.
2. **CLI new client is unwired** — `cmd/orun` uses the legacy `remotestate`
   client; `CoordClient`/`Fold`/`RunLoop` are a dead-code island.

Until both are closed, the epic delivers tested cores behind a flag under the old
wire, not the event-sourced coordination plane it set out to ship. See `GAPS.md`
§"Prioritized remaining work".

## Cutover / operational gate (BM6) — runbook record

No cutover has been executed against the live wire. `COORDINATION_BACKEND=do` is
committed for stage/prod, but the drain bridge, provenance backfill, and
forced-DO-loss recovery drill do not exist, and `orun-api.sourceplane.ai` still
serves the legacy `orun-backend`. The fail-closed `projectorReady` gate means an
unapplied migration `350` silently falls back to OP2. **Do not treat the epic as
cut over.**

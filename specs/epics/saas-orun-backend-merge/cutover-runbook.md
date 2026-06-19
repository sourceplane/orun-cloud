# Cutover & decommission runbook (BM6 / BM7)

Operator playbook for migrating run coordination from the **OP2 relational path**
(`apps/state-worker/src/handlers/runs.ts` → `StateRepository.claimRunJob` /
`heartbeatRunJob` / `updateRunJob` / `sweepLapsedLeases` in Postgres) to the
**event-sourced Durable Object path** (`RunCoordinator`), with Postgres demoted
to a read-model projection.

> **Ownership.** This runbook is *prepared* for the operator. Every step here is
> executed by a human with infra access against live environments — the
> implementation work never runs these. Each cut is canaried and has an
> explicit rollback. Treat the SLO gates as hard.

---

## 1. Architecture: before → after

```
BEFORE (OP2)                          AFTER (event-sourced)
  CLI ─▶ state-worker                   CLI ─▶ state-worker
         └▶ runs.ts handlers                   └▶ RunCoordinator DO (1 per run)
              └▶ Postgres run_jobs                   │  append-only log + deciders + alarm
                 (claim = guarded UPDATE)            └▶ outbox ─▶ projector ─▶ Postgres
                                                                    (read model only)
```

The authority for "who runs what" moves from a Postgres guarded `UPDATE` to the
DO's single-threaded log. Postgres stops being a source of truth and becomes a
delayed projection (`state.runs` / `state.run_jobs` are read-model rows).

## 2. What is already merged (safe, dormant)

| Capability | Where | Status |
|---|---|---|
| Coordination contract v2 + fold | `@saas/contracts` `coordination*`, Go `internal/statebackend` | ✅ merged, parity-pinned TS⇄Go |
| Object kinds + memoization gate | `@saas/contracts` `coordination` (BM1) | ✅ merged |
| Coordinator deciders | `@saas/contracts/coordination-core` (BM2) | ✅ merged |
| `RunCoordinator` Durable Object | `apps/state-worker/src/run-coordinator.ts` (BM2b) | ✅ merged, miniflare-tested, **§3-wire-conformant** |
| Projection mapping + projector decision layer | `@saas/contracts` `coordination-projection` / `coordination-projector` (BM3) | ✅ merged |
| CLI client + runner loop | Go `CoordClient` / `RunLoop` (NC3/NC5) | ✅ merged, httptest-driven |

The DO class exists but is **not bound in `wrangler.template.jsonc`** and nothing
routes to it yet — it ships dormant, so none of the above changes production
behavior.

## 3. Prerequisites before any cut (remaining wiring — must land first)

These are code changes, not operations; they gate BM6 and must be merged +
deployed (dormant) before the drain bridge opens:

1. **Bind the DO** — add the `durable_objects` binding + a `new_sqlite_classes`
   migration for `RunCoordinator` to `wrangler.template.jsonc`; export it from
   `index.ts`; add `COORDINATOR` to `Env`. *(Additive migration; creates an
   unused namespace on deploy.)*
2. **Route the §3 verbs** — in `state-worker` (or api-edge), forward
   `…/state/runs/{runId}/jobs/{jobId}:{claim,heartbeat,complete}`,
   `…/runs/{runId}:cancel`, and `GET …/runs/{runId}/log` to the DO stub
   (`env.COORDINATOR.idFromName(runId)`), behind a per-environment
   **`coordination_backend = op2 | do`** flag so traffic can be flipped without a
   redeploy.
3. **Projector runtime shell** — a consumer that drains each DO's outbox and
   applies `planProjection(fold, appliedSeq)` via one seq-guarded UPSERT into
   `state.runs` / `state.run_jobs` (add a `last_seq` column as the high-water
   guard). The decision layer is merged; only the SQL apply + trigger remain.
4. **Forced-DO-loss recovery drill** green on stage (rebuild fold from the log
   after evicting the DO).

Exit criteria: all four merged; the `do` backend passes the contract suite on
stage with the flag flipped for a synthetic project.

## 4. Backfill (O2 — provenance, not live state)

Live legacy coordination state is **not** migrated (G0/O2). Only terminal
provenance:

- For terminal legacy runs in the last **90 days**: emit `run-record` objects +
  projection rows on the new plane. Script skeleton:
  `tooling/migrations/backfill-run-records.mjs` (read-only against legacy;
  idempotent by `runUlid`; writes objects + `state.runs` rows; **dry-run first**,
  reconcile counts, then apply per environment).
- Older history: archived, not projected.
- In-flight legacy runs: **left on the legacy plane to finish** (see drain).

## 5. Cutover sequence (per environment: dev → stage → prod)

For each environment, in order, never skipping the canary:

1. **Pre-flight** — backfill reconciled; `coordination_backend=op2` still serving;
   dashboards for the O3 SLOs live.
2. **Drain bridge open** — set the legacy plane **read-only for new runs**:
   in-flight legacy runs continue to completion; new runs are admitted only on
   the new plane. (`orun-backend` + OP2 both stop accepting *new* runs.)
3. **Canary** — flip `coordination_backend=do` for a single internal project
   (Orun Cloud's own CI). Watch one full run lifecycle: claim → heartbeat →
   complete → projection appears; cancel + lease-takeover paths.
4. **SLO gate (O3 — all must hold on the canary before widening):**
   - claim **p99 ≤ 150 ms**
   - **zero** deps-gate escapes (no job runs before its deps are `succeeded`)
   - projection lag **p99 ≤ 2 s**
   - forced-DO-loss recovery drill **passed**
5. **Widen** — flip `coordination_backend=do` for the environment. Then cut
   `orun-api.sourceplane.ai` (this env) to the new plane.
6. **Update defaults** — `intent.yaml` `execution.state.backendUrl` + the CLI
   default for the environment.
7. **Soak** — one full drain window with both planes up (legacy read-only).

## 6. Rollback (at every step)

- **Before DNS cut:** set `coordination_backend=op2` (instant; no redeploy). New
  runs return to OP2; the legacy plane is still read-write-capable until step 5.
- **After DNS cut:** **DNS flip back** to the legacy plane (kept read-only-intact
  through the soak). Legacy coordination state was never deleted, so in-flight
  new-plane runs are abandoned/retried, not corrupted.
- Rollback **must be drilled on stage** before the prod cut (BM6 done-criterion).

## 7. Decommission (BM7 — only after a clean dual-run window)

1. **Delete the OP2 claim/sweep path** — remove `claimRunJob` / `heartbeatRunJob`
   / `updateRunJob` / `sweepLapsedLeases` usage from
   `apps/state-worker/src/handlers/runs.ts` and the cron sweep phase; keep the
   read-model repository methods (`getRun`, `listRuns`, counts) — those now serve
   the projection.
2. **Tear down `orun-backend`** hosted resources after the clean window.
3. **OSS conformance** — a plain-Postgres conditional-append implementation
   passes the same contract suite (parked per `orun/specs/orun-cloud` D5; gate
   defined so the contract stays implementable off-DO).
4. **Closeout** — record completion + the executed runbook in
   `IMPLEMENTATION-STATUS.md`.

## 8. Done criteria

- **BM6:** production traffic (incl. Orun Cloud CI) runs on the new plane; legacy
  planes take no new runs; OP2's claim path removed; stage rollback drill passed;
  runbook recorded.
- **BM7:** `orun-backend` torn down; conformance suite green against the DO
  server (and defined, if parked, for OSS); closeout recorded.

## 9. Safety invariants (do not violate)

- Never delete legacy coordination state until BM7 closeout — it is the rollback
  floor.
- Never widen past a failing O3 gate; canary failure = flag back to `op2`.
- The projection is derived: if Postgres read models diverge, **rebuild from the
  DO log**, never hand-edit rows.
- One cron slot budget (R9) still holds — the projector trigger and the (now
  removed) OP2 sweep must not both occupy the single `state-worker` cron.

# saas-orun-backend-merge — Decisions (locked) & residual risks

Status: **Locked — ready for implementation.** Every design and product decision
behind this epic is resolved below (the recommended defaults, taken as
decisions). What remains are **residual engineering risks** the milestones own,
not open choices. The contract specifics (event envelope, fold, `runId`,
`jobInputHash`, delivery) are frozen in [`coordination-api.md`](./coordination-api.md)
§8.

## Locked decisions

### G0 — Replace OP2 directly (no staged strangler)

The greenfield event-sourced + Durable-Object coordination plane **replaces
orun-cloud's shipped OP2 relational coordination outright** (and the separate
`orun-backend`). We do **not** run a long shadow/dual-run: build the new plane
behind the contract, prove it on stage with the parity + fuzz suites (BM2), cut
each environment over in one move (BM6), then **delete the OP2 `run_jobs`
claim/sweep path**. The only transient compatibility is a read-only **drain
bridge** for in-flight legacy runs at cutover. `orun-backend` and OP2 remain
parity references for the claim/lease invariants, not code to keep.

### Contract freeze (BM0)

- **C1 Event envelope** — `{ seq, kind, runId, jobId?, actor, at, idempotencyKey,
  v, payload }`; `seq` gap-free monotonic per run (writer-assigned); additive
  forever; readers tolerate unknown kinds/fields. (`coordination-api.md` §8.1)
- **C2 Fold** — deterministic left-fold by `seq`, last-writer-by-seq; one shared
  pure `reduce()` in `packages/contracts`, ported to Go, pinned by a shared
  golden-vector suite run in both CIs. (§8.2)
- **C3 `runId` binding** — bound to `planDigest` at create; same-id/different-plan
  ⇒ 409; coordination appends idempotent by `(jobId,kind,leaseEpoch)`. (§8.3)
- **C4 Contract change-control** — the platform repo owns the normative
  `coordination-api.md` + the golden vectors; the CLI vendors with a checksum
  guard; a **major bump requires a coordinated re-vendor with CLI sign-off** —
  neither repo bumps unilaterally. Owner: `state-worker` maintainers.

### Correctness (BM1/BM2)

- **C5 `jobInputHash`** — resolved steps + input digests + declared env **keys** +
  composition-lock digest; excludes clock/secrets/runner; client is sole hasher;
  golden-vectored. (§8.4)
- **C6 `hermetic` declaration** — opt-in per job via `hermetic: true` in the
  composition/plan schema (author-annotated, never inferred); default **off**;
  non-hermetic jobs always execute. Cross-repo: adds a field to the orun
  composition schema (paired NC1).
- **C7 Projection delivery** — per-run **outbox** → projector into Postgres +
  metering, idempotent by `(runId, seq)` (effectively exactly-once); never on the
  claim path. (§8.5)
- **C8 run-create ↔ DO-init ordering** — api-edge does the strong Postgres
  run-row insert + quota check **first**, then inits the DO; a run is not live
  until the DO acks `RunCreated`; a reconcile sweep GCs orphan rows if DO init
  fails. Quota is the single strong gate, at create, not per job.
- **C9 Object-existence + memoization lookup** — `:complete` requires the
  `resultDigest` to exist in the CAS (else `object_missing`); the runner PUTs
  `job-result`/`log` before `:complete`. Memoization lookup goes through the CAS
  **object index** (a projection), not R2 HEAD on the hot path; a miss falls
  through to execution.
- **C10 Lease constants** — lease 60s, heartbeat 20s, `MAX_JOB_ATTEMPTS = 5`
  (re-queue then `JobFailed{timed_out}`), driven by the DO alarm (cadence ≤
  lease); server returns tunables, client never hardcodes.

### Product & security

- **D1 Memoization scope** — default **per-project**; **org-shared opt-in**;
  **global never** without explicit publish. Keyed by `jobInputHash` (no implicit
  cross-tenant leak). GC: TTL + refcount on `job-result`/`log`, folded into OV9
  object-GC.
- **D2 Quota/entitlement** — enforced strongly at run-create:
  `limit.runs.concurrent` (per org), `limit.jobs.per_run`, `limit.state.storage`
  (reuse the OV9 stock gauge); over-limit ⇒ 412 + upgrade UX, **off by default**
  initially (mirrors OV9 over-quota posture).
- **D3 Accountless OIDC CI** — frictionless: a runner with only OIDC and no prior
  link **auto-materializes** a per-owner default org + `project == repo` (OV2),
  upgradeable to a named org; binding fail-closed via the IG connection trust,
  never auto-bound to an org that hasn't proven ownership.
- **D4 DO placement** — accept default Cloudflare placement; add location hints
  only if claim p99 breaches the SLO (not a blocker).

### Ops / cutover (BM6)

- **O1 Direct cutover** — per G0: build + validate on stage, cut
  `orun-api.sourceplane.ai` per environment, drain in-flight legacy runs
  read-only (window = one max-run-duration), delete OP2's claim path after the
  window. Rollback = DNS flip back while legacy stays read-only-intact, valid
  until BM7.
- **O2 Provenance backfill** — backfill the last **90 days** of terminal legacy
  runs as `run-record` objects + projection rows; older history stays in an
  archived projection, not migrated live; live legacy coordination state is never
  migrated (it drains).
- **O3 Cutover SLOs** — cut over only when, on stage: claim p99 ≤ 150 ms, zero
  deps-gate escapes in the fuzz suite, projection lag p99 ≤ 2 s, and a successful
  forced-DO-loss recovery drill. Canary first; rollback on any regression.

### Program

- **D5 OSS self-host** — define the plain-Postgres **conformance gate** at BM7;
  build the OSS server only when self-host is unparked (`orun/specs/orun-cloud`
  D5). The contract stays DO-free so it remains buildable off-DO.

## Residual engineering risks

These are owned and mitigated by the milestones; they are *risks*, not unresolved
decisions.

- **R1 Conditional-append correctness (critical; BM2).** One `:claim` append must
  win. Mitigation: single writer per run; BM2 parity + fuzzed concurrent-claim
  suite is the gate; the predicate is evaluated atomically under the writer.
- **R2 DO durability/recovery (high; BM2).** Mitigation: snapshot objects every N
  appends + projected checkpoints; rebuild = snapshot + replay; unrecoverable
  tail re-driven from `planDigest` with `Succeeded` jobs short-circuited by their
  `job-result` (memoization doubles as crash recovery); forced-loss drill in O3.
- **R3 Projection lag seen as "lost" work (medium; BM3).** Mitigation: `…/log`
  (SSE/long-poll) is live truth; console reads the stream for active runs; the
  consistency contract documents expected staleness.
- **R4 Event-schema immutability (medium; BM0).** Mitigation: versioned,
  additive-only; the fold tolerates unknowns; majors only via C4.
- **R5 At-least-once execution (medium; BM2/BM4).** Lease takeover can re-run a
  job. Mitigation: documented in the contract §7; the cockpit labels re-runs;
  memoization is opt-in, never a correctness crutch.
- **R6 Cross-repo contract skew (medium; BM0/BM4).** Mitigation: owned copy +
  vendored checksum guard + shared fold vectors (C4); no unilateral major.

## Out of scope (per the locked bet)

- A permanent legacy `/v1/runs` surface — dropped; only the transient O1 drain
  bridge exists.
- Lifting `orun-backend`'s Durable Object code or its V2 (Tasks 0021–0023) layer,
  or keeping OP2's relational claim path — all superseded.
- Platform-hosted runners — execution stays customer-side.
